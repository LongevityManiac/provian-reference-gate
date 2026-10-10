/**
 * The gate's behaviour, offline, with a forged issuer and presenter (fixtures.ts). Every RED case
 * is a control: the same path that allows is shown refusing when exactly one thing is wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gate, generateGateKey } from '../gate.js';
import { after } from 'node:test';
import { counterpartyOnboarding, paymentRail, repositoryMerge, missionCriticalAction, sensitiveSite, ILLUSTRATIVE_ATTESTATION, ILLUSTRATIVE_CREDENTIAL } from '../examples/index.js';
import { REPORT_HEADINGS } from '../report.js';
import type { GatePolicy } from '../types.js';
import { DOMAIN, STANDING_ALWAYS_PRESENT, fakeRelayFetch, forgeReputationToken, makeIssuer, makePresenter, relayShapedAnswer } from '../illustrative/forge.js';
import { establishedCredential } from '../illustrative/presenters.js';
import { startAnchorStub } from '../illustrative/anchor-stub.js';

const NOW = 1_800_000_000;
/** The anchor read a disclosed record needs, answered locally (illustrative; the live gate reads Base). */
const ANCHOR = await startAnchorStub();
const ANCHOR_FALSE = await startAnchorStub('false');
after(async () => { await ANCHOR.close(); await ANCHOR_FALSE.close(); });

/** Facts that satisfy every example (a well-standing, paid-by-many, forge-witnessed actor whose whole window ran on the illustrative attested fleet). */
const GOOD_FACTS: Record<string, number> = {
  ...STANDING_ALWAYS_PRESENT,
  'money.witnessed_inbound': 4, 'money.witnessed_inbound_90d': 9, 'money.independent_payers_90d': 6, 'money.witnessed_financial_90d': 12, 'money.witnessed_payment_volume_usd_365d': 2500, 'money.promises_defaulted': 0,
  'work.compute.forge_witnessed': 40, 'work.witnessed_90d': 60, 'continuity.active_days_90d': 30, 'coupling.independent_owners': 3, 'accountability.human_beneficiary': 1,
  'continuity.active_days': 120, 'consumption.independent_parties': 5,
  'work.hardware_rooted_90d': 60, 'share.witness_90d.hardware_rooted': 10_000,
  [`share.issuer_90d.${ILLUSTRATIVE_ATTESTATION.issuerRoot}`]: 10_000,
  [`share.measurement_90d.${ILLUSTRATIVE_ATTESTATION.launchMeasurement}`]: 10_000,
  [`share.region_90d.${ILLUSTRATIVE_ATTESTATION.region}`]: 10_000,
};

async function gateWith(issuer = makeIssuer(), extra: Partial<Parameters<typeof Gate.create>[0]> = {}): Promise<Gate> {
  return Gate.create({ domain: DOMAIN, key: generateGateKey('k1'), jwks: issuer.jwks, relayVerify: false, nowSeconds: () => NOW, rpcUrl: ANCHOR.url, ...extra });
}

function tokenFor(gate: Gate, policy: GatePolicy, issuer: ReturnType<typeof makeIssuer>, facts: Record<string, number>, over: Partial<Parameters<typeof forgeReputationToken>[0]> = {}) {
  const presenter = makePresenter();
  const challenge = gate.issueChallenge(policy);
  const token = forgeReputationToken({
    issuer, presenter, nowSeconds: NOW, facts, held: [establishedCredential()],
    challenge: { audience: challenge.audience, challenge: challenge.challenge, expiresAt: challenge.expiresAt as number, predicates: challenge.predicates ?? [], disclosures: challenge.disclosures ?? [], requester: { type: 'domain', id: DOMAIN } },
    ...over,
  });
  return { presenter, challenge, token };
}

test('STEP 0 — the well-known document publishes the gate key', async () => {
  const gate = await gateWith();
  const doc = gate.wellKnownDocument();
  assert.equal(doc.keys.length, 1);
  assert.equal(doc.keys[0]?.kid, 'k1');
  assert.equal(doc.keys[0]?.kty, 'OKP');
  assert.equal(gate.wellKnownUrl(), `https://${DOMAIN}/.well-known/provian-requester.json`);
});

test('STEP 1 — a challenge is signed by the gate, bound to its domain, and asks the policy’s predicates', async () => {
  const gate = await gateWith();
  const c = gate.issueChallenge(paymentRail, { presenter: '0x' + 'AB'.repeat(20) });
  assert.equal(c.v, 1);
  assert.equal(c.audience, DOMAIN);
  assert.equal(c.requester?.type, 'domain');
  assert.equal(c.requester?.id, DOMAIN);
  assert.equal(c.requester?.kid, 'k1');
  assert.equal(typeof c.sig, 'string');
  assert.equal(c.presenter, '0x' + 'ab'.repeat(20));
  assert.equal((c.predicates ?? []).length, paymentRail.predicates.length);
  assert.equal((c.expiresAt as number) - (c.issuedAt as number), 900);
});

for (const policy of [counterpartyOnboarding, paymentRail, repositoryMerge, missionCriticalAction(), sensitiveSite()]) {
  test(`ALLOW — ${policy.slug}: every predicate true, standing clean`, async () => {
    const issuer = makeIssuer();
    const gate = await gateWith(issuer);
    const { token, presenter } = tokenFor(gate, policy, issuer, GOOD_FACTS);
    const d = await gate.decide(policy, token);
    assert.equal(d.decision, 'allow', JSON.stringify(d.reasons));
    assert.equal(d.presentation?.presenter.address, presenter.address);
    assert.equal(d.presentation?.requester?.id, DOMAIN);
    assert.equal(d.predicates.length, policy.predicates.length);
    assert.ok(d.predicates.every((p) => p.result === true));
    assert.deepEqual(d.standing?.by_type, {});
    assert.equal(d.standing?.adverse_events, 0);
    assert.equal(d.verification?.local, 'valid');
    assert.equal(d.verification?.replay, 'first');
    assert.equal(d.report.decision, 'ALLOW');
    assert.deepEqual(d.report.sections.map((x) => x.heading), [...REPORT_HEADINGS]);
  });
}

test('RED — one predicate false blocks, and the decision names it', async () => {
  const issuer = makeIssuer();
  const gate = await gateWith(issuer);
  const { token } = tokenFor(gate, paymentRail, issuer, { ...GOOD_FACTS, 'money.independent_payers_90d': 2 });
  const d = await gate.decide(paymentRail, token);
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r === 'false: money.independent_payers_90d gte 3'), JSON.stringify(d.reasons));
  // The other answers are still shown, co-signed, beside the one that failed.
  assert.equal(d.predicates.length, paymentRail.predicates.length);
});

test('RED — adverse standing blocks and is shown in the decision', async () => {
  const issuer = makeIssuer();
  const gate = await gateWith(issuer);
  const facts = { ...GOOD_FACTS, 'standing.adverse_events': 1, 'standing.adverse_events_365d': 1, 'standing.reputation_slashed': 1 };
  const { token } = tokenFor(gate, repositoryMerge, issuer, facts);
  const d = await gate.decide(repositoryMerge, token);
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.includes('false: standing.adverse_events in {0}'));
  assert.ok(d.reasons.includes('this presenter’s reputation has been slashed'));
  assert.deepEqual(d.standing?.by_type, { 'standing.reputation_slashed': 1 });
  assert.equal(d.standing?.adverse_events, 1);
});

test('RED — the same presentation a second time is replayed (one-shot acceptance)', async () => {
  const issuer = makeIssuer();
  const gate = await gateWith(issuer);
  const { token, challenge } = tokenFor(gate, paymentRail, issuer, GOOD_FACTS);
  const first = await gate.decide(paymentRail, token);
  assert.equal(first.decision, 'allow');
  // Service mode: the challenge was consumed, so the nonce is unknown now.
  const second = await gate.decide(paymentRail, token);
  assert.equal(second.decision, 'block');
  assert.ok(second.reasons[0]?.startsWith('challenge: not one this gate issued'), JSON.stringify(second.reasons));
  // CLI mode: the envelope is handed back explicitly and verifies — the presentation id is still refused.
  const third = await gate.decide(paymentRail, token, { challenge });
  assert.equal(third.decision, 'block');
  assert.ok(third.reasons.includes('local verify: replayed'), JSON.stringify(third.reasons));
  assert.equal(third.verification?.replay, 'replayed');
});

test('RED — Standing withheld is refused even though every predicate is true', async () => {
  const issuer = makeIssuer();
  const gate = await gateWith(issuer);
  const { token } = tokenFor(gate, paymentRail, issuer, GOOD_FACTS, { withhold: ['standing.bond_active'] });
  const d = await gate.decide(paymentRail, token);
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.includes('local verify: standing_withheld'));
});

test('RED — a PE-fact token presented to a predicate gate is refused before any crypto', async () => {
  const issuer = makeIssuer();
  const gate = await gateWith(issuer);
  const challenge = gate.issueChallenge(paymentRail);
  const token = Buffer.from(JSON.stringify({ tier: 'pe_fact', payload: { tier: 'pe_fact', chal: challenge.challenge, pe_facts: [] }, proofs: [] }), 'utf8').toString('base64url');
  const d = await gate.decide(paymentRail, token);
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.includes('local verify: predicates_require_reputation_tier'));
});

test('RED — a challenge signed by another gate (or unsigned) is not ours', async () => {
  const issuer = makeIssuer();
  const gate = await gateWith(issuer);
  const other = await Gate.create({ domain: DOMAIN, key: generateGateKey('k1'), jwks: issuer.jwks, relayVerify: false, nowSeconds: () => NOW });
  const foreign = other.issueChallenge(paymentRail);
  const presenter = makePresenter();
  const token = forgeReputationToken({ issuer, presenter, nowSeconds: NOW, facts: GOOD_FACTS,
    challenge: { audience: foreign.audience, challenge: foreign.challenge, expiresAt: foreign.expiresAt as number, predicates: foreign.predicates ?? [], requester: { type: 'domain', id: DOMAIN } } });
  const d = await gate.decide(paymentRail, token, { challenge: foreign });
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons[0]?.includes('bad_signature'), JSON.stringify(d.reasons));
  const unsigned = { audience: DOMAIN, challenge: 'f'.repeat(64), predicates: paymentRail.predicates };
  const d2 = await gate.decide(paymentRail, token, { challenge: unsigned as unknown as typeof foreign });
  assert.equal(d2.decision, 'block');
  assert.ok(d2.reasons[0]?.includes('unverified'), JSON.stringify(d2.reasons));
});

test('RED — a token for another policy’s challenge answers the wrong questions', async () => {
  const issuer = makeIssuer();
  const gate = await gateWith(issuer);
  const { token } = tokenFor(gate, repositoryMerge, issuer, GOOD_FACTS);
  const d = await gate.decide(paymentRail, token);
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons[0]?.includes('issued for policy "repository-merge"'), JSON.stringify(d.reasons));
});

test('RED — an audience the gate did not issue, an expired challenge, a wrong presenter', async () => {
  const issuer = makeIssuer();
  const key = generateGateKey('k1');
  const gate = await Gate.create({ domain: DOMAIN, key, jwks: issuer.jwks, relayVerify: false, nowSeconds: () => NOW });
  const { token } = tokenFor(gate, paymentRail, issuer, GOOD_FACTS, { audOverride: 'other.example.com' });
  const d = await gate.decide(paymentRail, token);
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.includes('local verify: audience_mismatch'), JSON.stringify(d.reasons));

  // The same gate (same key), a little later: its own challenge has lapsed.
  const late = await Gate.create({ domain: DOMAIN, key, jwks: issuer.jwks, relayVerify: false, nowSeconds: () => NOW + 2000 });
  const { token: t2, challenge } = tokenFor(gate, paymentRail, issuer, GOOD_FACTS);
  const d2 = await late.decide(paymentRail, t2, { challenge });
  assert.equal(d2.decision, 'block');
  assert.ok(d2.reasons[0]?.includes('expired'), JSON.stringify(d2.reasons));

  const addressed = gate.issueChallenge(paymentRail, { presenter: '0x' + '11'.repeat(20) });
  const presenter = makePresenter();
  const t3 = forgeReputationToken({ issuer, presenter, nowSeconds: NOW, facts: GOOD_FACTS,
    challenge: { audience: addressed.audience, challenge: addressed.challenge, expiresAt: addressed.expiresAt as number, predicates: addressed.predicates ?? [], requester: { type: 'domain', id: DOMAIN } } });
  const d3 = await gate.decide(paymentRail, t3);
  assert.equal(d3.decision, 'block');
  assert.ok(d3.reasons.includes('local verify: presenter_mismatch'), JSON.stringify(d3.reasons));
});

test('RED — not a presentation, or a token signed by a key the relay did not publish', async () => {
  const issuer = makeIssuer();
  const gate = await gateWith(issuer);
  assert.equal((await gate.decide(paymentRail, 'not-a-token')).decision, 'block');
  const rogue = makeIssuer('rogue');
  const { token } = tokenFor(gate, paymentRail, rogue, GOOD_FACTS);
  const d = await gate.decide(paymentRail, token);
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.includes('local verify: reputation_jws_unknown_kid'), JSON.stringify(d.reasons));
});

test('STEP 3a — the relay verify is called with the token and the envelope, and must agree', async () => {
  const issuer = makeIssuer();
  const seen: { body: Record<string, unknown> | null } = { body: null };
  const agreeing = await gateWith(issuer, { relayVerify: true, fetchFn: fakeRelayFetch((body) => { seen.body = body; return { json: relayShapedAnswer(String(body.token)) }; }) });
  const { token, challenge } = tokenFor(agreeing, paymentRail, issuer, GOOD_FACTS);
  const d = await agreeing.decide(paymentRail, token);
  assert.equal(d.decision, 'allow', JSON.stringify(d.reasons));
  assert.equal(d.verification?.relay, 'valid');
  assert.equal(seen.body?.token, token);
  assert.deepEqual(seen.body?.challenge_envelope, challenge);

  const refusing = await gateWith(issuer, { relayVerify: true, fetchFn: fakeRelayFetch(() => ({ json: { valid: false, reason: 'bad_presenter_pop' } })) });
  const r = tokenFor(refusing, paymentRail, issuer, GOOD_FACTS);
  const d2 = await refusing.decide(paymentRail, r.token);
  assert.equal(d2.decision, 'block');
  assert.ok(d2.reasons.includes('relay verify: bad_presenter_pop'));
  assert.equal(d2.verification?.relay, 'invalid');
  assert.equal(d2.verification?.local, 'not_run');

  const lying = await gateWith(issuer, { relayVerify: true, fetchFn: fakeRelayFetch((body) => ({ json: { ...relayShapedAnswer(String(body.token)), presenter_address: '0x' + '22'.repeat(20) } })) });
  const l = tokenFor(lying, paymentRail, issuer, GOOD_FACTS);
  const d3 = await lying.decide(paymentRail, l.token);
  assert.equal(d3.decision, 'block');
  assert.ok(d3.reasons[0]?.includes('disagree: presenter'), JSON.stringify(d3.reasons));

  const down = await gateWith(issuer, { relayVerify: true, fetchFn: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch });
  const x = tokenFor(down, paymentRail, issuer, GOOD_FACTS);
  const d4 = await down.decide(paymentRail, x.token);
  assert.equal(d4.decision, 'block');
  assert.equal(d4.verification?.relay, 'unreachable');
});

test('RED — payment rail: a single operator moving money between its own wallets is BLOCKED however much moved', async () => {
  const issuer = makeIssuer();
  const gate = await gateWith(issuer);
  // Forty inbound transfers in the window, every one from a wallet the same-owner fence resolved to
  // the payee itself: the relay counts 0 independent payers, and the rail refuses.
  const selfDealing = { ...GOOD_FACTS, 'money.witnessed_inbound_90d': 40, 'money.witnessed_inbound': 40, 'money.independent_payers_90d': 0, 'money.independent_payers': 0 };
  const { token } = tokenFor(gate, paymentRail, issuer, selfDealing);
  const d = await gate.decide(paymentRail, token);
  assert.equal(d.decision, 'block', JSON.stringify(d.reasons));
  assert.deepEqual(d.reasons, ['false: money.independent_payers_90d gte 3']);
  assert.ok(d.report.reasons[0]?.startsWith('Fewer than 3 independent parties paid it in the last 90 days'), JSON.stringify(d.report.reasons));
});

// ---------------------------------------------------------------------------------------------
// The mission-critical example gates on the attestation FACTS of every act in the window — the
// issuer root, the launch measurement, the region — never on the witness class. Each fact is a
// share of ALL the presenter's recent work, so one attested act among ordinary ones reads a
// fraction and fails; a presenter whose work carries no admitted hardware report reads 0 on all.
// ---------------------------------------------------------------------------------------------

test('mission-critical: every act under the named root, measurement and region is ALLOWED; each fact blocks on its own (RED)', async () => {
  const issuer = makeIssuer();
  const gate = await gateWith(issuer);
  const policy = missionCriticalAction();
  assert.ok(!policy.predicates.some((p) => p.field.startsWith('share.witness')), 'the gate asks the facts, not the class');
  const ok = await gate.decide(policy, tokenFor(gate, policy, issuer, GOOD_FACTS).token);
  assert.equal(ok.decision, 'allow', JSON.stringify(ok.reasons));
  const cases: Array<[Record<string, number>, string]> = [
    [{ [`share.issuer_90d.${ILLUSTRATIVE_ATTESTATION.issuerRoot}`]: 9_999 }, `false: share.issuer_90d.${ILLUSTRATIVE_ATTESTATION.issuerRoot} gte 10000`],
    [{ [`share.measurement_90d.${ILLUSTRATIVE_ATTESTATION.launchMeasurement}`]: 5_000 }, `false: share.measurement_90d.${ILLUSTRATIVE_ATTESTATION.launchMeasurement} gte 10000`],
    [{ [`share.region_90d.${ILLUSTRATIVE_ATTESTATION.region}`]: 0 }, `false: share.region_90d.${ILLUSTRATIVE_ATTESTATION.region} gte 10000`],
    [{ 'work.witnessed_90d': 0 }, 'false: work.witnessed_90d gte 1'],
  ];
  for (const [patch, reason] of cases) {
    const d = await gate.decide(policy, tokenFor(gate, policy, issuer, { ...GOOD_FACTS, ...patch }).token);
    assert.equal(d.decision, 'block', reason);
    assert.deepEqual(d.reasons, [reason]);
  }
});

test('RED — mission-critical: a top-class presenter with NO attestation facts (App Attest only) is BLOCKED — the class is not the facts', async () => {
  const issuer = makeIssuer();
  const gate = await gateWith(issuer);
  const policy = missionCriticalAction();
  const appAttestOnly: Record<string, number> = { ...GOOD_FACTS, 'work.hardware_rooted_90d': 60, 'share.witness_90d.hardware_rooted': 10_000 };
  for (const k of Object.keys(appAttestOnly)) if (/^share\.(issuer|measurement|region)_90d\./.test(k)) delete appAttestOnly[k];
  const d = await gate.decide(policy, tokenFor(gate, policy, issuer, appAttestOnly).token);
  assert.equal(d.decision, 'block');
  assert.equal(d.reasons.length, 3, JSON.stringify(d.reasons));
  assert.ok(d.reasons.every((r) => /^false: share\.(issuer|measurement|region)_90d\./.test(r)), JSON.stringify(d.reasons));
});

test('mission-critical: another fleet’s facts are a different gate (RED: the illustrative presenter reads 0 under them)', async () => {
  const issuer = makeIssuer();
  const gate = await gateWith(issuer);
  const other = missionCriticalAction({ issuerRoot: '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b', launchMeasurement: 'sha384:' + 'ab'.repeat(48), region: 'eu-west-1' });
  const d = await gate.decide(other, tokenFor(gate, other, issuer, GOOD_FACTS).token);
  assert.equal(d.decision, 'block');
  assert.equal(d.reasons.length, 3);
  assert.throws(() => missionCriticalAction({ issuerRoot: 'nope', launchMeasurement: 'sha256:00', region: 'x' }), /issuerRoot/);
});

// ---------------------------------------------------------------------------------------------
// The sensitive site NAMES a record: the challenge carries a disclosure request for one PE by
// output digest under one issuer root, with elected content. The presenter elects; the verifier
// proves each disclosed record against its anchored act; the gate reads the answer.
// ---------------------------------------------------------------------------------------------

test('sensitive site: the challenge names the credential; a presenter that discloses it is ALLOWED and the report shows what it says', async () => {
  const issuer = makeIssuer();
  const gate = await gateWith(issuer);
  const policy = sensitiveSite();
  const { token, challenge } = tokenFor(gate, policy, issuer, GOOD_FACTS);
  assert.equal(challenge.disclosures?.length, 1, 'the signed challenge carries the named disclosure');
  assert.equal(challenge.disclosures?.[0]?.kind, 'pe');
  const d = await gate.decide(policy, token);
  assert.equal(d.decision, 'allow', JSON.stringify(d.reasons));
  assert.equal(d.verification?.onchain_checked, true, 'the disclosed record’s anchor was read');
  assert.equal(d.disclosures.length, 1);
  assert.equal(d.disclosures[0]?.election, 'disclosed');
  assert.equal(d.disclosures[0]?.records?.[0]?.output_digest, ILLUSTRATIVE_CREDENTIAL.digest);
  assert.equal(d.disclosures[0]?.records?.[0]?.witness.issuer, ILLUSTRATIVE_CREDENTIAL.issuer);
  const history = d.report.sections.find((s) => s.heading === 'Witnessed history')?.lines.map((l) => l.text).join('\n') ?? '';
  assert.match(history, /Disclosed: compute_session on 2026-07-14, witnessed in hardware \(tpm2_quote\) under issuer root 594759594b9b6152…, in us-central1, carrying 7c4e1b9d2a6f8c0e…\./);
  assert.ok(history.includes('Described as: “Clearance issued'), history);
  assert.ok(history.includes('1 artifact disclosed.'), history);
});

test('RED — sensitive site: declined is a signed no; nothing held is nothing to show; a credential under another issuer does not answer', async () => {
  const issuer = makeIssuer();
  const gate = await gateWith(issuer);
  const policy = sensitiveSite();
  const declined = await gate.decide(policy, tokenFor(gate, policy, issuer, GOOD_FACTS, { disclosure: 'declined' }).token);
  assert.equal(declined.decision, 'block');
  assert.equal(declined.disclosures[0]?.election, 'declined');
  assert.ok(declined.reasons[0]?.startsWith('the presenter declined to disclose the named credential'), JSON.stringify(declined.reasons));
  assert.ok(declined.report.reasons[0]?.startsWith('The presenter declined'), JSON.stringify(declined.report.reasons));

  const empty = await gate.decide(policy, tokenFor(gate, policy, issuer, GOOD_FACTS, { held: [] }).token);
  assert.equal(empty.decision, 'block');
  assert.deepEqual(empty.reasons, ['the presenter holds no record carrying the named credential']);
  assert.ok(empty.report.sections.find((s) => s.heading === 'Witnessed history')?.lines.some((l) => l.text.startsWith('Holds no record answering the named request')));

  const otherIssuer = sensitiveSite({ digest: ILLUSTRATIVE_CREDENTIAL.digest, issuer: '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b' });
  const wrong = await gate.decide(otherIssuer, tokenFor(gate, otherIssuer, issuer, GOOD_FACTS).token);
  assert.equal(wrong.decision, 'block');
  assert.deepEqual(wrong.reasons, ['the presenter holds no record carrying the named credential']);
});

test('RED — sensitive site: a disclosed record tampered after signing, or whose anchor does not hold, is refused by the verifier', async () => {
  const issuer = makeIssuer();
  const gate = await gateWith(issuer);
  const policy = sensitiveSite();
  // The record's digest rewritten after the presenter signed: the record no longer matches its proof.
  const forged = await gate.decide(policy, tokenFor(gate, policy, issuer, GOOD_FACTS, {
    tamperDisclosed: (records) => records.map((r) => ({ ...r, action_type: 'human_approval' })),
  }).token);
  assert.equal(forged.decision, 'block');
  assert.ok(forged.reasons.includes('local verify: disclosure_record_invalid'), JSON.stringify(forged.reasons));
  // A witness claim the proof does not carry (the issuer root rewritten) is refused the same way
  // before the gate's own rule ever runs — the fake issuer cannot be read as the required one.
  const reissued = await gate.decide(policy, tokenFor(gate, policy, issuer, GOOD_FACTS, {
    tamperDisclosed: (records) => records.map((r) => ({ ...r, pe_hash: 'ab'.repeat(32) })),
  }).token);
  assert.equal(reissued.decision, 'block');
  assert.ok(reissued.reasons.includes('local verify: disclosure_record_invalid') || reissued.reasons.includes('local verify: bad_presenter_pop'), JSON.stringify(reissued.reasons));
  // The anchor read answers false: the record is not on Base, and nothing it says is evidence.
  const unanchoredGate = await gateWith(issuer, { rpcUrl: ANCHOR_FALSE.url });
  const unanchored = await unanchoredGate.decide(policy, tokenFor(unanchoredGate, policy, issuer, GOOD_FACTS).token);
  assert.equal(unanchored.decision, 'block');
  assert.ok(unanchored.reasons.includes('local verify: disclosure_record_invalid'), JSON.stringify(unanchored.reasons));
});

test('RED — sensitive site: a challenge that does not name the credential is not this policy’s; an unanswered request is refused', async () => {
  const issuer = makeIssuer();
  const gate = await gateWith(issuer);
  const policy = sensitiveSite();
  // A challenge this gate signed for another policy carries no disclosure request.
  const { token: other } = tokenFor(gate, counterpartyOnboarding, issuer, GOOD_FACTS);
  const d = await gate.decide(policy, other);
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons[0]?.includes('issued for policy "counterparty-onboarding"'), JSON.stringify(d.reasons));
  // The presentation answers the right challenge but drops the disclosure answer entirely.
  const presenter = makePresenter();
  const challenge = gate.issueChallenge(policy);
  const token = forgeReputationToken({ issuer, presenter, nowSeconds: NOW, facts: GOOD_FACTS, held: [establishedCredential()],
    challenge: { audience: challenge.audience, challenge: challenge.challenge, expiresAt: challenge.expiresAt as number, predicates: challenge.predicates ?? [], requester: { type: 'domain', id: DOMAIN } } });
  const silent = await gate.decide(policy, token);
  assert.equal(silent.decision, 'block');
  assert.ok(silent.reasons.includes('local verify: disclosures_unanswered'), JSON.stringify(silent.reasons));
});
