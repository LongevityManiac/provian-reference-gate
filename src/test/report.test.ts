/**
 * The report, the onboarding example, and the illustrative contrast. Every RED case is a control
 * beside the green it mirrors.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gate, generateGateKey } from '../gate.js';
import { after } from 'node:test';
import { counterpartyOnboarding, examplePolicies, repositoryMerge, missionCriticalAction, paymentRail, sensitiveSite } from '../examples/index.js';
import { startAnchorStub } from '../illustrative/anchor-stub.js';
import { REPORT_HEADINGS, buildReport, formatReport } from '../report.js';
import type { Decision, GatePolicy } from '../types.js';
import { DOMAIN, forgeReputationToken, makeIssuer, type Issuer } from '../illustrative/forge.js';
import { ILLUSTRATIVE_NOW, establishedPresenter, freshPresenter, illustrativeIssuer, type IllustrativePresenter } from '../illustrative/presenters.js';
import { runContrast } from '../contrast.js';

const ANCHOR = await startAnchorStub();
after(async () => { await ANCHOR.close(); });

/** `signer` signs the token; the gate trusts only the illustrative issuer. */
async function decideFor(policy: GatePolicy, who: IllustrativePresenter, facts: Record<string, number> = { ...who.facts }, signer: Issuer = illustrativeIssuer()): Promise<Decision> {
  const gate = await Gate.create({ domain: DOMAIN, key: generateGateKey('k1'), jwks: illustrativeIssuer().jwks, relayVerify: false, nowSeconds: () => ILLUSTRATIVE_NOW, rpcUrl: ANCHOR.url });
  const issuer = signer;
  const c = gate.issueChallenge(policy);
  const token = forgeReputationToken({ issuer, presenter: who.presenter, nowSeconds: ILLUSTRATIVE_NOW, facts, held: who.held,
    challenge: { audience: c.audience, challenge: c.challenge, expiresAt: c.expiresAt as number, predicates: c.predicates ?? [], disclosures: c.disclosures ?? [], requester: { type: 'domain', id: DOMAIN } } });
  return gate.decide(policy, token);
}

const allText = (d: Decision): string => d.report.sections.flatMap((s) => s.lines.map((l) => l.text)).join('\n');

test('REPORT — six headings, in order, each with at least one sentence, then a decision with a reason', async () => {
  for (const who of [freshPresenter(), establishedPresenter()]) {
    const d = await decideFor(counterpartyOnboarding, who);
    assert.deepEqual(d.report.sections.map((s) => s.heading), ['Identity', 'Accountable human', 'Witnessed history', 'Standing', 'Counterparties', 'Money witnessed']);
    assert.deepEqual([...REPORT_HEADINGS], d.report.sections.map((s) => s.heading));
    for (const s of d.report.sections) assert.ok(s.lines.length > 0 && s.lines.every((l) => l.text.length > 0), s.heading);
    assert.equal(d.report.decision, d.decision === 'allow' ? 'ALLOW' : 'BLOCK');
    assert.ok(d.report.reason.length > 10, 'never a bare ALLOW/BLOCK');
    const text = formatReport(d.report);
    assert.ok(text.indexOf('Identity') < text.indexOf('Money witnessed') && text.endsWith(d.report.reasons.at(-1) ?? '?'));
    assert.equal(d.report.reason, d.report.reasons.join(' '));
  }
});

test('REPORT — an asked fact reads as its co-signed answer, never its raw number; an unasked one as disclosed', async () => {
  const d = await decideFor(counterpartyOnboarding, establishedPresenter());
  const line = d.report.sections.find((s) => s.heading === 'Witnessed history')?.lines.find((l) => l.fields.includes('work.witnessed_90d'));
  assert.equal(line?.source, 'answer');
  assert.equal(line?.text, 'At least 25 acts in the last 90 days witnessed by something other than the actor.');
  assert.ok(!allText(d).includes('9,412 acts in the last 90 days witnessed'), 'the raw value of an asked field is withheld');
  assert.ok(!(line?.text ?? '').includes('9,412'));
  const forge = d.report.sections.find((s) => s.heading === 'Witnessed history')?.lines.find((l) => l.fields.includes('work.compute.forge_witnessed'));
  assert.equal(forge?.source, 'disclosed');
  assert.equal(forge?.text, '1,284 commits a code forge witnessed.');
});

test('REPORT RED — witnessed payment volume is never disclosed raw: absent when not asked, an answer when asked', async () => {
  const notAsked = await decideFor(counterpartyOnboarding, establishedPresenter());
  assert.ok(!allText(notAsked).includes('USD'), allText(notAsked));
  assert.ok(!allText(notAsked).includes('48,250'));
  // The payment rail no longer asks the volume either; a gate that does reads only the answer.
  const volumeGate: GatePolicy = { ...paymentRail, slug: 'volume', predicates: [...paymentRail.predicates, { field: 'money.witnessed_payment_volume_usd_365d', op: 'gte', threshold: 100 }] };
  const asked = await decideFor(volumeGate, establishedPresenter());
  assert.ok(allText(asked).includes('At least 100 USD of witnessed payment volume in the last 365 days.'), allText(asked));
  assert.ok(!allText(asked).includes('48,250'));
  assert.ok(examplePolicies()['payment-rail'] !== undefined);
});

test('REPORT RED — a presentation that does not verify reports nothing as evidence, under every heading', async () => {
  const rogue = makeIssuer('rogue');
  const d = await decideFor(counterpartyOnboarding, establishedPresenter(), { ...establishedPresenter().facts }, rogue);
  assert.equal(d.decision, 'block');
  assert.equal(d.report.decision, 'BLOCK');
  assert.equal(d.report.sections.length, 6);
  for (const s of d.report.sections) assert.deepEqual(s.lines.map((l) => l.source), ['unverified']);
  assert.ok(!allText(d).includes('1,284'));
});

test('REPORT — the adverse event stays visible even where the gate admits the presenter', async () => {
  const d = await decideFor(counterpartyOnboarding, establishedPresenter());
  assert.equal(d.decision, 'allow', JSON.stringify(d.reasons));
  const standing = d.report.sections.find((s) => s.heading === 'Standing');
  assert.match(standing?.lines[0]?.text ?? '', /^One adverse event on record: a bond it posted expired — none in the last 90 days/);
});

test('ONBOARDING — the fresh key is blocked, the established agent admitted', async () => {
  const fresh = await decideFor(counterpartyOnboarding, freshPresenter());
  assert.equal(fresh.decision, 'block');
  assert.deepEqual(fresh.reasons, [
    'false: continuity.active_days gte 30', 'false: continuity.active_days_90d gte 10', 'false: work.witnessed_90d gte 25',
    'false: consumption.independent_parties gte 3', 'false: accountability.human_beneficiary eq 1',
  ]);
  assert.equal((await decideFor(counterpartyOnboarding, establishedPresenter())).decision, 'allow');
});

test('ONBOARDING RED — each general question blocks on its own', async () => {
  const base = { ...establishedPresenter().facts };
  const cases: Array<[Record<string, number>, string]> = [
    [{ 'continuity.active_days': 29 }, 'false: continuity.active_days gte 30'],
    [{ 'continuity.active_days_90d': 9 }, 'false: continuity.active_days_90d gte 10'],
    [{ 'work.witnessed_90d': 24 }, 'false: work.witnessed_90d gte 25'],
    [{ 'consumption.independent_parties': 2 }, 'false: consumption.independent_parties gte 3'],
    [{ 'accountability.human_beneficiary': 0 }, 'false: accountability.human_beneficiary eq 1'],
    [{ 'standing.adverse_events_90d': 1, 'standing.adverse_events_30d': 1 }, 'false: standing.adverse_events_90d in {0}'],
    [{ 'standing.open_bond_claims_against': 1 }, 'false: standing.open_bond_claims_against eq 0'],
    [{ 'standing.invalidation_active': 1 }, 'false: standing.invalidation_active eq 0'],
    [{ 'standing.reputation_slashed': 1 }, 'this presenter’s reputation has been slashed'],
  ];
  for (const [patch, reason] of cases) {
    const d = await decideFor(counterpartyOnboarding, establishedPresenter(), { ...base, ...patch });
    assert.equal(d.decision, 'block', reason);
    assert.deepEqual(d.reasons, [reason]);
    assert.equal(d.report.decision, 'BLOCK');
  }
});

test('CONTRAST — five examples, both presenters, every signature valid, every replay refused', async () => {
  const record = await runContrast();
  assert.equal(record.illustrative, true);
  assert.deepEqual(record.examples.map((e) => e.policy.slug), ['counterparty-onboarding', 'payment-rail', 'repository-merge', 'mission-critical-action', 'sensitive-site']);
  const runs = record.examples.flatMap((e) => e.runs);
  assert.equal(runs.length, 10, 'evaluated ten runs, not zero');
  for (const r of runs) {
    assert.equal(r.signature_check, 'valid');
    assert.equal(r.replay.decision, 'block');
    assert.equal(r.replay.verification?.replay, 'replayed');
  }
  const outcome = Object.fromEntries(record.examples.map((e) => [e.policy.slug, e.runs.map((r) => `${r.presenter}:${r.decision.decision}`).join(' ')]));
  assert.deepEqual(outcome, {
    'counterparty-onboarding': 'fresh:block established:allow',
    'payment-rail': 'fresh:block established:allow',
    'repository-merge': 'fresh:block established:block',
    'mission-critical-action': 'fresh:block established:block',
    'sensitive-site': 'fresh:block established:allow',
  });
  // The established agent is held at the merge and mission-critical gates by its one adverse event, and nothing else.
  for (const slug of ['repository-merge', 'mission-critical-action']) {
    const est = record.examples.find((e) => e.policy.slug === slug)?.runs.find((r) => r.presenter === 'established');
    assert.deepEqual(est?.decision.reasons, ['false: standing.adverse_events in {0}']);
  }
  // The sensitive site: the fresh key has nothing to show; the established agent disclosed its credential and the anchor was read.
  const site = record.examples.find((e) => e.policy.slug === 'sensitive-site');
  assert.deepEqual(site?.policy.disclosures?.length, 1);
  const fresh = site?.runs.find((r) => r.presenter === 'fresh');
  assert.deepEqual(fresh?.decision.reasons, ['the presenter holds no record carrying the named credential']);
  const est = site?.runs.find((r) => r.presenter === 'established');
  assert.equal(est?.decision.verification?.onchain_checked, true);
  assert.equal(est?.decision.disclosures[0]?.records?.length, 1);
  // The mission-critical report reads the attestation facts as answers, never the class.
  const mission = record.examples.find((e) => e.policy.slug === 'mission-critical-action')?.runs.find((r) => r.presenter === 'established');
  const history = mission?.decision.report.sections.find((s) => s.heading === 'Witnessed history')?.lines.map((l) => l.text) ?? [];
  assert.ok(history.some((t) => t.startsWith('At least 100% of its work in the last 90 days ran on hardware attested under issuer root')), history.join('\n'));
  assert.ok(history.some((t) => t.includes('attested in region us-central1')), history.join('\n'));
  assert.ok(history.some((t) => t === '100% of its work in the last 90 days is hardware-rooted.'), 'the class share is disclosed, not asked');
});

test('CONTRAST RED — without its adverse event the established agent clears the merge and mission-critical gates', async () => {
  const clean = { ...establishedPresenter().facts, 'standing.adverse_events': 0, 'standing.adverse_events_365d': 0, 'standing.bond_expired': 0 };
  assert.equal((await decideFor(repositoryMerge, establishedPresenter(), clean)).decision, 'allow');
  assert.equal((await decideFor(missionCriticalAction(), establishedPresenter(), clean)).decision, 'allow');
  // And the sensitive site admits it on its credential alone: with the credential gone it is blocked.
  const noCredential: IllustrativePresenter = { ...establishedPresenter(), held: [] };
  assert.equal((await decideFor(sensitiveSite(), noCredential)).decision, 'block');
});

test('FORGE RED — the illustrative token never discloses a predicate-only field raw (as the relay never does)', () => {
  const who = establishedPresenter();
  const token = forgeReputationToken({ issuer: illustrativeIssuer(), presenter: who.presenter, nowSeconds: ILLUSTRATIVE_NOW, facts: { ...who.facts },
    challenge: { audience: DOMAIN, challenge: 'a'.repeat(64), predicates: counterpartyOnboarding.predicates } });
  const facts = (JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { payload: { reputation: { facts: Record<string, number> } } }).payload.reputation.facts;
  assert.ok(Object.keys(facts).length > 20, 'the other facts are disclosed');
  assert.equal(facts['money.witnessed_payment_volume_usd_365d'], undefined);
  assert.equal(facts['work.witnessed_90d'], undefined, 'an asked field is withheld behind its answer');
  assert.equal(facts['work.compute.forge_witnessed'], 1284);
});

test('REPORT RED — even if a raw payment volume reached the gate, the report would not print it', () => {
  const r = buildReport({
    policy: counterpartyOnboarding, decision: 'block', reasons: ['x'], nowSeconds: ILLUSTRATIVE_NOW,
    view: { tier: 'reputation', presentationId: 'p', presenterAddress: '0x', presenterWalletId: null, requester: null, predicates: [], disclosures: [], challengeExpiresAt: null,
      standing: { 'standing.adverse_events': 0 }, disclosed: { 'money.witnessed_payment_volume_usd_365d': 48250, 'money.witnessed_inbound': 7 } },
  });
  const money = r.sections.find((s) => s.heading === 'Money witnessed')?.lines.map((l) => l.text) ?? [];
  assert.deepEqual(money, ['7 inbound payments the chain witnessed.']);
});
