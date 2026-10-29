import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { keccak256, encodePacked, type Hex } from 'viem';
import https from 'node:https';
import http, { type RequestOptions, type IncomingMessage } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { createFileSeenStore, buildAgentPresentationRequest, deriveAddressFromPrivateKey, PROVIAN_BASE_PE_ANCHOR } from '@provian/agent-sdk';
import { Gate, generateGateKey } from '../gate.js';
import { createFileAdmissionLog, reverifyAdmission, AdmissionLogError, type AdmissionEntry } from '../admission.js';
import { readEnv } from '../config.js';
import { counterpartyOnboarding, sensitiveSite } from '../examples/index.js';
import { REPORT_HEADINGS } from '../report.js';
import { anchorFetch, outerProofRoot } from '../anchor-evidence.js';
import { DOMAIN, fakeRelayFetch, relayShapedAnswer, forgeReputationToken, makeIssuer, makePresenter } from '../illustrative/forge.js';
import { establishedPresenter, ILLUSTRATIVE_NOW as NOW } from '../illustrative/presenters.js';
import { startAnchorStub } from '../illustrative/anchor-stub.js';

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function temp(): string { const dir = mkdtempSync(path.join(tmpdir(), 'admission-test-')); dirs.push(dir); return dir; }
function entries(dir: string): AdmissionEntry[] {
  return readdirSync(path.join(dir, 'entries')).map((name) => JSON.parse(readFileSync(path.join(dir, 'entries', name), 'utf8')) as AdmissionEntry);
}
const noNetwork: typeof fetch = async () => { throw new Error('network forbidden'); };

async function setup() {
  const dir = temp(); const key = generateGateKey(); const issuer = makeIssuer();
  let now = NOW;
  const log = createFileAdmissionLog(dir);
  const gate = await Gate.create({ domain: DOMAIN, key, jwks: issuer.jwks, relayVerify: false,
    fetchFn: noNetwork, nowSeconds: () => now, admissionLog: log });
  const token = (challenge: ReturnType<Gate['issueChallenge']>, over: Partial<Parameters<typeof forgeReputationToken>[0]> = {}) => forgeReputationToken({
    issuer, presenter: makePresenter(), nowSeconds: NOW, facts: { ...establishedPresenter().facts },
    challenge: { audience: challenge.audience, challenge: challenge.challenge, expiresAt: challenge.expiresAt as number,
      predicates: challenge.predicates ?? [], disclosures: challenge.disclosures ?? [], requester: { type: 'domain', id: DOMAIN } }, ...over,
  });
  return { dir, key, issuer, log, gate, token, setNow: (value: number) => { now = value; } };
}

test('service is enabled by default; one switch disables just the admission log', () => {
  assert.equal(readEnv({ GATE_DOMAIN: DOMAIN }).admissionLog, true);
  const on = readEnv({ GATE_DOMAIN: DOMAIN }); const off = readEnv({ GATE_DOMAIN: DOMAIN, GATE_ADMISSION_LOG: 'false' });
  assert.deepEqual({ ...on, admissionLog: false }, off);
});

test('ALLOW receipt: exact token, issued challenge, keys, verification, six headings, independent signature; RED edits refused', async () => {
  const s = await setup(); const challenge = s.gate.issueChallenge(counterpartyOnboarding);
  const token = `  ${s.token(challenge)}\n`;
  const decision = await s.gate.decide(counterpartyOnboarding, token);
  assert.equal(decision.decision, 'allow', JSON.stringify(decision.reasons));
  const stored = entries(s.dir); assert.equal(stored.length, 1);
  const entry = stored[0]!;
  assert.equal(entry.record.token, token); assert.deepEqual(entry.record.challenge, challenge);
  assert.deepEqual(entry.record.decision, decision); assert.equal(entry.record.verification.local?.valid, true);
  assert.deepEqual(entry.record.verification.jwks, s.issuer.jwks);
  assert.deepEqual(entry.record.decision.report.sections.map((section) => section.heading), [...REPORT_HEADINGS]);
  assert.ok(Number.isFinite(Date.parse(entry.record.received_at)));
  assert.ok(!JSON.stringify(entry).includes('PRIVATE KEY'));
  const result = await reverifyAdmission(entry, s.key.publicJwk, counterpartyOnboarding);
  assert.equal(result.policy_check, 'matches');
  assert.equal(result.verification_matches, true);
  assert.equal(result.receipt_valid, true); assert.equal(result.challenge, 'verified'); assert.equal(result.presentation?.valid, true);
  const changed = structuredClone(entry); (changed.record.decision as { decision: string }).decision = 'block';
  await assert.rejects(reverifyAdmission(changed, s.key.publicJwk), /signature invalid/);
  await assert.rejects(reverifyAdmission(entry, generateGateKey().publicJwk), /untrusted gate key/);
  const file = path.join(s.dir, 'entries', readdirSync(path.join(s.dir, 'entries'))[0]!);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('one receipt for every refusal: unsigned, expired, presenter mismatch, tier, predicate false, malformed', async () => {
  const s = await setup(); const c = s.gate.issueChallenge(counterpartyOnboarding);
  const unsigned = JSON.parse(Buffer.from(s.token(c), 'base64url').toString('utf8')) as { provian_jws?: string };
  delete unsigned.provian_jws;
  const cases: Array<[string, ReturnType<Gate['issueChallenge']> | undefined, RegExp]> = [
    [Buffer.from(JSON.stringify(unsigned)).toString('base64url'), c, /reputation_not_signed/],
    ['not-a-token', undefined, /not a Provian presentation/],
    [Buffer.from(JSON.stringify({ tier: 'pe_fact', payload: { chal: c.challenge } })).toString('base64url'), c, /predicates_require_reputation_tier/],
    [s.token(c, { facts: { ...establishedPresenter().facts, 'continuity.active_days': 0 } }), c, /false:/],
  ];
  for (const [token, challenge, reason] of cases) {
    const d = await s.gate.decide(counterpartyOnboarding, token, challenge ? { challenge } : {});
    assert.equal(d.decision, 'block'); assert.match(d.reasons.join(' '), reason);
  }
  const addressed = s.gate.issueChallenge(counterpartyOnboarding, { presenter: `0x${'11'.repeat(20)}` });
  const mismatch = await s.gate.decide(counterpartyOnboarding, s.token(addressed));
  assert.match(mismatch.reasons.join(' '), /presenter_mismatch/);
  s.setNow(NOW + 2000);
  const expired = await s.gate.decide(counterpartyOnboarding, s.token(c));
  assert.match(expired.reasons.join(' '), /expired/);
  assert.equal(entries(s.dir).length, 6);
  assert.deepEqual(entries(s.dir).find((entry) => entry.record.decision.at === expired.at)?.record.challenge, c);
  // A fresh gate with the same log can still recover the expired challenge for its refusal receipt.
  const restart = await Gate.create({ domain: DOMAIN, key: s.key, jwks: s.issuer.jwks, relayVerify: false, admissionLog: s.log, nowSeconds: () => NOW + 2000 });
  await restart.decide(counterpartyOnboarding, s.token(c));
  const all = entries(s.dir); assert.equal(all.length, 7);
  for (const entry of all) {
    assert.equal(entry.record.decision.decision, 'block');
    if (entry.record.token !== 'not-a-token') assert.ok(entry.record.challenge);
    assert.equal((await reverifyAdmission(entry, s.key.publicJwk)).receipt_valid, true);
  }
});

test('log on/off have identical decisions and persistent one-shot strength, including concurrent acceptance and service replays', async () => {
  const s = await setup(); const c = s.gate.issueChallenge(counterpartyOnboarding); const token = s.token(c);
  for (const logged of [false, true]) {
    const seenPath = path.join(temp(), 'seen.json');
    const options = { domain: DOMAIN, key: s.key, jwks: s.issuer.jwks, relayVerify: false, nowSeconds: () => NOW,
      seenStore: createFileSeenStore(seenPath), ...(logged ? { admissionLog: s.log } : {}) };
    const gate = await Gate.create(options);
    const decisions = await Promise.all(Array.from({ length: 6 }, () => gate.decide(counterpartyOnboarding, token, { challenge: c })));
    assert.equal(decisions.filter((d) => d.decision === 'allow').length, 1);
    assert.equal(decisions.filter((d) => d.verification?.replay === 'replayed').length, 5);
    const restarted = await Gate.create(options);
    assert.equal((await restarted.decide(counterpartyOnboarding, token, { challenge: c })).verification?.replay, 'replayed');
  }
  assert.equal(entries(s.dir).length, 7);
  const c2 = s.gate.issueChallenge(counterpartyOnboarding); const t2 = s.token(c2);
  await s.gate.decide(counterpartyOnboarding, t2);
  for (let i = 0; i < 3; i++) {
    assert.equal((await s.gate.decide(counterpartyOnboarding, t2)).decision, 'block');
  }
  const stored = entries(s.dir).filter((entry) => entry.record.token === t2);
  assert.equal(stored.length, 4);
  for (const entry of stored) assert.deepEqual(entry.record.challenge, c2);
});

test('log write failure never returns ALLOW, never appends a fallback BLOCK, never releases the replay claim', async () => {
  const s = await setup(); let calls = 0;
  const broken = { ...s.log, append: async () => { calls++; throw new Error('disk full'); } };
  const gate = await Gate.create({ domain: DOMAIN, key: s.key, jwks: s.issuer.jwks, relayVerify: false, nowSeconds: () => NOW, admissionLog: broken });
  const c = gate.issueChallenge(counterpartyOnboarding); const token = s.token(c);
  await assert.rejects(gate.decide(counterpartyOnboarding, token), AdmissionLogError);
  assert.equal(calls, 1);
  await assert.rejects(gate.decide(counterpartyOnboarding, token, { challenge: c }), AdmissionLogError);
  assert.equal(calls, 2); assert.equal(entries(s.dir).length, 0);
});

test('receipt survives issuer rotation and gate restart; sensitive disclosure rechecks without any network', async () => {
  const s = await setup(); const anchor = await startAnchorStub();
  let entry: AdmissionEntry;
  try {
    const gate = await Gate.create({ domain: DOMAIN, key: s.key, jwks: s.issuer.jwks, relayVerify: false,
      nowSeconds: () => NOW, admissionLog: s.log, rpcUrl: anchor.url, fetchFn: fetch });
    const policy = sensitiveSite(); const c = gate.issueChallenge(policy);
    const token = s.token(c, { held: establishedPresenter().held });
    const d = await gate.decide(policy, token); assert.equal(d.decision, 'allow', JSON.stringify(d.reasons));
    assert.equal(d.verification?.onchain_checked, true); entry = entries(s.dir)[0]!;
  } finally { await anchor.close(); }
  // No live anchor or issuer exists now; this uses only the independently pinned gate key and receipt.
  const result = await reverifyAdmission(entry, s.key.publicJwk);
  assert.equal(result.presentation?.valid, true); assert.equal(result.anchor_check, 'valid');
  assert.equal(result.verification_matches, true);
  const empty = structuredClone(entry); (empty.record.verification as { jwks: readonly unknown[] }).jwks = [];
  await assert.rejects(reverifyAdmission(empty, s.key.publicJwk), /signature invalid/);
});


test('RED — false anchor stays false offline; outer-proof mutation changes its root', async () => {
  const s = await setup(); const anchor = await startAnchorStub('false');
  let entry: AdmissionEntry;
  try {
    const gate = await Gate.create({ domain: DOMAIN, key: s.key, jwks: s.issuer.jwks, relayVerify: false,
      nowSeconds: () => NOW, admissionLog: s.log, rpcUrl: anchor.url, fetchFn: fetch });
    const policy = sensitiveSite(); const c = gate.issueChallenge(policy);
    const d = await gate.decide(policy, s.token(c, { held: establishedPresenter().held }));
    assert.equal(d.decision, 'block'); assert.deepEqual(d.reasons, ['local verify: disclosure_record_invalid']);
    entry = entries(s.dir)[0]!;
    assert.equal(entry.record.anchor_observations[0]?.status, 'observed');
  } finally { await anchor.close(); }
  const result = await reverifyAdmission(entry, s.key.publicJwk);
  assert.equal(result.anchor_check, 'invalid'); assert.equal(result.presentation?.valid, false);
  assert.equal(result.verification_matches, true);
  const leaf = `0x${'ab'.repeat(32)}`;
  assert.equal(outerProofRoot(leaf, []), leaf);
  assert.notEqual(outerProofRoot(leaf, [`0x${'cd'.repeat(32)}`]), leaf);
  assert.equal(outerProofRoot(leaf, ['not-a-hash']), null);
});

test('relay refusals and unexpected policy errors each produce one receipt, with no unrequested relay fields', async () => {
  const s = await setup();
  const gate = await Gate.create({ domain: DOMAIN, key: s.key, jwks: s.issuer.jwks, relayVerify: true,
    nowSeconds: () => NOW, admissionLog: s.log,
    fetchFn: fakeRelayFetch(() => ({ json: { valid: false, reason: 'refused', undisclosed_secret: 'MUST-NOT-LOG' } })) });
  const c = gate.issueChallenge(counterpartyOnboarding);
  assert.equal((await gate.decide(counterpartyOnboarding, s.token(c))).decision, 'block');
  const throwing = { ...counterpartyOnboarding, standing: () => { throw new Error('policy exception'); } };
  assert.equal((await s.gate.decide(throwing, s.token(s.gate.issueChallenge(throwing)))).decision, 'block');
  const all = entries(s.dir); assert.equal(all.length, 2);
  assert.ok(!JSON.stringify(all).includes('MUST-NOT-LOG'));
});


test('rotation refresh preserves the exact key set actually used, never private JWK fields', async () => {
  const s = await setup(); const next = makeIssuer('rotated-issuer');
  const withPrivate = next.jwks.map((key) => ({ ...key, d: 'PRIVATE-DO-NOT-RETAIN' }));
  const gate = await Gate.create({ domain: DOMAIN, key: s.key, jwks: s.issuer.jwks, relayVerify: false,
    nowSeconds: () => NOW, admissionLog: s.log, fetchFn: fakeRelayFetch(() => ({ json: { keys: withPrivate } })) });
  const c = gate.issueChallenge(counterpartyOnboarding);
  const token = s.token(c, { issuer: next });
  const decision = await gate.decide(counterpartyOnboarding, token);
  assert.equal(decision.decision, 'allow', JSON.stringify(decision.reasons));
  const entry = entries(s.dir)[0]!;
  assert.equal(entry.record.verification.jwks[0]?.kid, next.kid);
  assert.equal(entry.record.verification.jwks[0]?.x, next.jwks[0]?.x);
  assert.ok(!JSON.stringify(entry).includes('PRIVATE-DO-NOT-RETAIN'));
  const result = await reverifyAdmission(entry, s.key.publicJwk, counterpartyOnboarding);
  assert.equal(result.presentation?.valid, true); assert.equal(result.verification_matches, true);
});


test('unused outer proofs cannot create observed roots or invalidate an otherwise valid receipt (RED)', async () => {
  const s = await setup(); const c = s.gate.issueChallenge(counterpartyOnboarding);
  const raw = JSON.parse(Buffer.from(s.token(c), 'base64url').toString('utf8')) as Record<string, unknown>;
  const bogus = { pe_id: 'unused', anchor: { batch_id: `0x${'aa'.repeat(32)}` }, leaf: { leaf_value: `0x${'bb'.repeat(32)}` }, merkle_proof: [] };
  raw.proofs = [bogus]; raw.disclosure_proofs = [bogus];
  const token = Buffer.from(JSON.stringify(raw)).toString('base64url');
  assert.equal((await s.gate.decide(counterpartyOnboarding, token)).decision, 'allow');
  const entry = entries(s.dir)[0]!;
  assert.deepEqual(entry.record.anchor_observations, []);
  const result = await reverifyAdmission(entry, s.key.publicJwk, counterpartyOnboarding);
  assert.equal(result.presentation?.valid, true); assert.equal(result.anchor_check, 'not_needed');
  assert.equal(result.verification_matches, true); assert.equal(result.policy_check, 'matches');
});

test('RED — default anchor transport refuses private addresses before a socket is opened', async () => {
  await assert.rejects(anchorFetch('https://127.0.0.1:1', { method: 'POST', body: '{}' }), /egress refused/);
  await assert.rejects(anchorFetch('https://169.254.169.254/latest/meta-data', { method: 'POST', body: '{}' }), /egress refused/);
});


test('RED — slow response bytes cannot evade the anchor transport total deadline', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    const interval = setInterval(() => response.write(' '), 2);
    response.on('close', () => clearInterval(interval));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const localUrl = `http://127.0.0.1:${address.port}`;
  const original = http.request;
  // Only the test substitutes the socket destination. Production validates/pins the public IP.
  const transport = mock.method(https, 'request', (...args: unknown[]) => original(localUrl,
    args[1] as RequestOptions, args[2] as (response: IncomingMessage) => void));
  syncBuiltinESMExports();
  const started = Date.now();
  try {
    await assert.rejects(async () => {
      const response = await anchorFetch('https://93.184.216.34', { method: 'POST', body: '{}', signal: AbortSignal.timeout(40) });
      await response.text();
    }, /abort/i);
  } finally {
    transport.mock.restore(); syncBuiltinESMExports(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.ok(Date.now() - started < 1000, 'total deadline, not idle-byte timeout');
});


test('PE-fact receipts preserve valid inclusion and exact untrusted/false-anchor refusals offline', async () => {
  const s = await setup(); const good = await startAnchorStub(); const bad = await startAnchorStub('false');
  const policy = { slug: 'pe-fact', name: 'PE fact', action: 'Check an anchored fact', description: 'Test policy', predicates: [], standing: () => [] };
  try {
    for (const which of ['valid', 'untrusted', 'false'] as const) {
      const gate = await Gate.create({ domain: DOMAIN, key: s.key, jwks: s.issuer.jwks, relayVerify: false,
        nowSeconds: () => NOW, admissionLog: s.log, rpcUrl: which === 'false' ? bad.url : good.url, fetchFn: fetch });
      const c = gate.issueChallenge(policy); const hash = `0x${'ab'.repeat(32)}` as Hex;
      const privateKeyHex = 'a'.repeat(64); const address = deriveAddressFromPrivateKey(privateKeyHex).toLowerCase();
      const claims = [{ pe_id: 'pe_fact_test', envelope_hash: hash }];
      const { body } = buildAgentPresentationRequest({ privateKeyHex, tier: 'pe_fact', burnId: 'b'.repeat(64),
        audience: c.audience, challenge: c.challenge, challengeEnvelope: c, nowSeconds: NOW,
        peFacts: [{ peId: claims[0]!.pe_id, envelopeHash: hash }] });
      const requester = { type: 'domain', id: DOMAIN };
      const common = { v: 2, presenter_address: address, burn_id: body.burn_id, pe_facts: claims,
        jti: body.jti, iat: body.iat, exp: body.exp, requester, chal_exp: c.expiresAt };
      const h = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'provian-presentation-pefact+jwt', kid: s.issuer.kid })).toString('base64url');
      const p = Buffer.from(JSON.stringify({ ...common, iss: 'https://provian.ai', ctx: 'pe_fact_cosign' })).toString('base64url');
      const signature = crypto.sign(null, Buffer.from(`${h}.${p}`), s.issuer.privateKey).toString('base64url');
      const token = Buffer.from(JSON.stringify({ tier: 'pe_fact',
        payload: { ...common, tier: 'pe_fact', iss: address, sub: 'wallet_test', aud: c.audience, chal: c.challenge, presenter_pop: body.pop },
        provian_jws: `${h}.${p}.${signature}`, proofs: [{ ...claims[0], anchored: true,
          anchor: { batch_id: `0x${'11'.repeat(32)}`, contract_address: which === 'untrusted' ? `0x${'88'.repeat(20)}` : PROVIAN_BASE_PE_ANCHOR },
          leaf: { leaf_value: keccak256(encodePacked(['bytes1', 'bytes32'], ['0x00', hash])) }, merkle_proof: [`0x${'22'.repeat(32)}`] }],
      })).toString('base64url');
      const decision = await gate.decide(policy, token);
      assert.equal(decision.decision, which === 'valid' ? 'allow' : 'block', JSON.stringify(decision.reasons));
      if (which === 'untrusted') assert.deepEqual(decision.reasons, ['local verify: pe_fact_anchor_untrusted']);
      if (which === 'false') assert.deepEqual(decision.reasons, ['local verify: pe_fact_proof_onchain_invalid']);
      const entry = entries(s.dir).find((value) => value.record.token === token)!;
      const result = await reverifyAdmission(entry, s.key.publicJwk, policy);
      assert.equal(result.presentation?.valid, which === 'valid'); assert.equal(result.verification_matches, true);
      assert.equal(result.anchor_check, which === 'valid' ? 'valid' : which === 'untrusted' ? 'untrusted' : 'invalid');
    }
  } finally { await good.close(); await bad.close(); }
});


test('RED — empty 204 anchor responses are handled without escaping the async request', async () => {
  const server = http.createServer((_request, response) => { response.writeHead(204); response.end(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const original = http.request;
  const transport = mock.method(https, 'request', (...args: unknown[]) => original(`http://127.0.0.1:${address.port}`,
    args[1] as RequestOptions, args[2] as (response: IncomingMessage) => void));
  syncBuiltinESMExports();
  try {
    const response = await anchorFetch('https://93.184.216.34', { method: 'POST', body: '{}', signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 204); assert.equal(response.body, null);
    await assert.rejects(response.json(), /JSON/);
  } finally {
    transport.mock.restore(); syncBuiltinESMExports(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
