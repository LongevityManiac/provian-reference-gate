/**
 * ILLUSTRATIVE ISSUANCE — a Provian-shaped issuer and presenters, so the whole verify path runs
 * offline: the tests use it, and so does the illustrative contrast (`npm run contrast`).
 *
 * The issuer key here is NOT Provian's. A gate built for these fixtures is handed this key's public
 * half as its JWKS, exactly as a live gate is handed the real one fetched from the relay — and then
 * every token goes through the same SDK verifier the live path uses (`verifyPresentationToken`):
 * the issuer's EdDSA signature, the presenter's live-key signature over the binding, audience,
 * nonce, deadline, predicates answered, Standing present, one-shot acceptance. Only the relay's
 * second opinion is absent (the public relay would refuse a token this issuer signed).
 *
 * The presentation is shaped the way the relay issues one: every predicate the challenge asks is
 * answered from the facts; every other fact is disclosed raw (reveal-all-minus-redactions) except
 * the predicate fields themselves, which are withheld behind their answers; Standing is always
 * disclosed; a predicate-only field (witnessed payment volume) is never disclosed raw.
 */
import crypto from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  presentationBindingString,
  presentationClaimsDigest,
  deriveAddressFromPrivateKey,
  peHashOf, actRecordOf, actLeafOf, actsRootOf, batchLeafOf, merkleProofOf,
  PE_V2_SCHEMA, METER_GENESIS_PREV_HASH,
  type PresentationJwk, type CanonicalDisclosureRequest, type DisclosureAnswer, type DisclosedRecord, type PeV2,
} from '@provian/agent-sdk';
import type { AnsweredPredicate, Predicate } from '../types.js';

// ── Requester-named disclosure (2026-10-10): the records a presenter holds ────────────────────

/** A record a fixture presenter holds, in the shape the relay would derive it from the PE. */
export interface HeldRecord {
  readonly pe_id: string;
  readonly timestamp: number;
  readonly action_type: string;
  readonly description: string;
  readonly metadata: Record<string, unknown>;
  readonly output_digests: ReadonlyArray<{ readonly hash: string; readonly kind: string }>;
  /** The admitted hardware report's facts (the relay derives these; the forge seals them on the PE). */
  readonly hardware?: { readonly scheme: string; readonly issuer: string; readonly signer: string; readonly measurement: string; readonly region: string };
}

/** The illustrative device every fixture record was sealed by. */
export const ILLUSTRATIVE_DEVICE_ID = `dev_${'7a'.repeat(32)}`;

function anchoredLeafOf(batchLeafHex: string): string {
  return `0x${Buffer.from(keccak_256(Buffer.concat([Buffer.from([0]), Buffer.from(batchLeafHex, 'hex')]))).toString('hex')}`;
}

/** Build the PE v2 a held record stands for, its disclosed record for `request`, and its two-hop proof. */
export function discloseHeld(held: HeldRecord, request: CanonicalDisclosureRequest, walletId: string): { record: DisclosedRecord; proof: Record<string, unknown> } {
  const base = {
    schema: PE_V2_SCHEMA, pe_id: held.pe_id, device_id: ILLUSTRATIVE_DEVICE_ID, prev_hash: METER_GENESIS_PREV_HASH,
    timestamp: held.timestamp, action_type: held.action_type, description: held.description, metadata: held.metadata, compute: null,
    output_digests: held.output_digests.map((d) => ({ hash: d.hash, kind: d.kind })),
    ...(held.hardware ? { hardware_witness: { scheme: held.hardware.scheme, report: 'illustrative', chain: [] } } : {}),
  } as unknown as PeV2;
  const pe = { ...base, pe_hash: peHashOf(base) } as PeV2 & { pe_hash: string };
  const act = actRecordOf(pe);
  const acts = [act];
  const actsRoot = actsRootOf(acts);
  const batch = { device_id: ILLUSTRATIVE_DEVICE_ID, actor_id: walletId, seq: 1, batch_hash: crypto.createHash('sha256').update(`illustrative-batch/${held.pe_id}`).digest('hex') };
  const batchLeaf = batchLeafOf({ ...batch, acts_root: actsRoot });
  const leafValue = anchoredLeafOf(batchLeaf);
  const witness: DisclosedRecord['witness'] = held.hardware
    ? { kind: 'hardware', scheme: held.hardware.scheme, issuer: held.hardware.issuer, signer: held.hardware.signer, measurement: held.hardware.measurement, region: held.hardware.region }
    : { kind: 'device', signer: ILLUSTRATIVE_DEVICE_ID };
  const content: { description?: string | null; intent?: string | null; artifacts?: unknown[]; fact_tier?: Record<string, unknown> } = {};
  for (const c of request.content ?? []) {
    if (c === 'description') content.description = held.description;
    if (c === 'intent') content.intent = null;
    if (c === 'artifacts') content.artifacts = act.pricing.output_digests as unknown[];
    if (c === 'fact_tier') content.fact_tier = act as unknown as Record<string, unknown>;
  }
  const fields: Record<string, unknown> = {};
  for (const path of request.fields ?? []) {
    let cur: unknown = act.pricing;
    for (const seg of path.split('.')) cur = typeof cur === 'object' && cur !== null ? (cur as Record<string, unknown>)[seg] : undefined;
    fields[path] = cur === undefined ? null : cur;
  }
  const record: DisclosedRecord = {
    pe_id: pe.pe_id, pe_hash: pe.pe_hash, action_type: pe.action_type, timestamp: pe.timestamp, witness,
    ...(request.kind === 'pe' ? { output_digest: request.output_digest } : {}),
    ...(request.fields && request.fields.length > 0 ? { fields } : {}),
    ...(request.content && request.content.length > 0 ? { content } : {}),
  };
  const proof = {
    pe_id: pe.pe_id, envelope_hash: pe.pe_hash, anchored: true,
    anchor: { kind: 'meter_day', batch_id: `0x${crypto.createHash('sha256').update(`illustrative-anchor/${held.pe_id}`).digest('hex')}`, day: new Date(held.timestamp).toISOString().slice(0, 10), chain_id: 8453 },
    leaf: { kind: 'meter_act', leaf_value: leafValue, act, act_index: 0, act_proof: merkleProofOf(acts.map(actLeafOf), 0), acts_root: actsRoot, batch, batch_leaf: batchLeaf },
    merkle_proof: [`0x${'22'.repeat(32)}`],
  };
  return { record, proof };
}

/** Does a held record answer the request? (Mirrors the relay's selection: digest, then issuer.) */
export function heldAnswers(held: HeldRecord, request: CanonicalDisclosureRequest): boolean {
  if (request.kind === 'pe') {
    if (!held.output_digests.some((d) => d.hash.toLowerCase() === request.output_digest)) return false;
    if (request.issuer !== undefined && held.hardware?.issuer !== request.issuer) return false;
    return true;
  }
  if (request.issuer !== undefined && held.hardware?.issuer !== request.issuer) return false;
  if (request.signer !== undefined && held.hardware?.signer !== request.signer && request.signer !== ILLUSTRATIVE_DEVICE_ID) return false;
  return true;
}

export const DOMAIN = 'gate.example.com';
export const ISSUER = 'https://provian.ai';

/** The Standing facts every reputation presentation must carry (a verifier refuses otherwise). */
export const STANDING_ALWAYS_PRESENT: Record<string, number> = {
  'standing.adverse_events': 0, 'standing.adverse_events_30d': 0, 'standing.adverse_events_90d': 0, 'standing.adverse_events_365d': 0,
  'standing.bond_active': 0, 'standing.open_bond_claims_against': 0, 'standing.invalidation_active': 0,
};

/** Fields the relay never discloses raw — they exist only as predicate answers. */
const PREDICATE_ONLY = /^money\.witnessed_payment_volume_usd(_\d+d)?$/;

export interface Issuer { kid: string; privateKey: crypto.KeyObject; jwks: PresentationJwk[] }

/** An Ed25519 issuer — random, or from a 32-byte seed (a fixed, published TEST key). */
export function makeIssuer(kid = 'test-provian-k1', seed?: Buffer): Issuer {
  const privateKey = seed
    ? crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
    : crypto.generateKeyPairSync('ed25519').privateKey;
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string };
  return { kid, privateKey, jwks: [{ kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid, alg: 'EdDSA' }] };
}

export interface Presenter { privateKeyHex: string; privateKey: crypto.KeyObject; pubkeyHex: string; address: string; walletId: string }

/** A secp256k1 presenter — random, or from a 32-byte private key (a fixed, published TEST key). */
export function makePresenter(walletId = 'wallet_aw_test', secret?: Buffer): Presenter {
  const privateKey = secret
    ? crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e0201010420', 'hex'), secret, Buffer.from('a00706052b8104000a', 'hex')]), format: 'der', type: 'sec1' })
    : crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).privateKey;
  const pub = crypto.createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string; y: string };
  const priv = privateKey.export({ format: 'jwk' }) as { d: string };
  const hex = (b64url: string) => Buffer.from(b64url, 'base64url').toString('hex').padStart(64, '0');
  const privateKeyHex = hex(priv.d);
  return { privateKeyHex, privateKey, pubkeyHex: hex(pub.x) + hex(pub.y), address: deriveAddressFromPrivateKey(privateKeyHex).toLowerCase(), walletId };
}

function evalPredicate(value: number, p: Predicate): boolean {
  switch (p.op) {
    case 'gte': return value >= (p.threshold as number);
    case 'gt': return value > (p.threshold as number);
    case 'lte': return value <= (p.threshold as number);
    case 'lt': return value < (p.threshold as number);
    case 'eq': return value === p.threshold;
    case 'in': return (p.set ?? []).includes(value);
  }
}

export interface ForgeOptions {
  issuer: Issuer;
  presenter: Presenter;
  /** The challenge envelope the presentation answers (signed by the gate). */
  challenge: { audience: string; challenge: string; expiresAt?: number; predicates?: readonly Predicate[]; disclosures?: readonly CanonicalDisclosureRequest[]; requester?: { type: 'domain' | 'wallet'; id: string } };
  facts: Record<string, number>;
  nowSeconds: number;
  ttlSeconds?: number;
  /** Drop these facts from the disclosed block AFTER evaluating (e.g. to withhold Standing). */
  withhold?: string[];
  /** Override the `aud` the issuer signs (an audience mismatch). */
  audOverride?: string;
  burnId?: string;
  /** The records this presenter holds (answers the challenge's named disclosures from them). */
  held?: readonly HeldRecord[];
  /** `declined`: decline every named disclosure. Default: disclose what is held. */
  disclosure?: 'disclose' | 'declined';
  /** Tamper with the DISCLOSED records after the presenter signed (a forged value a verifier must catch). */
  tamperDisclosed?: (records: DisclosedRecord[]) => DisclosedRecord[];
}

/** A reputation presentation token the way the relay would issue one, signed by the given issuer. */
export function forgeReputationToken(o: ForgeOptions): string {
  const asked = o.challenge.predicates ?? [];
  const answered: AnsweredPredicate[] = asked.map((p) => ({
    ...(p.op === 'in' ? { field: p.field, op: 'in' as const, set: [...new Set(p.set ?? [])].sort((a, b) => a - b) } : { field: p.field, op: p.op, threshold: p.threshold as number }),
    result: evalPredicate(o.facts[p.field] ?? 0, p),
  }));
  const directive = { redact: [] as string[], predicates: asked.map((p) => (p.op === 'in' ? { field: p.field, op: 'in' as const, set: [...(p.set ?? [])] } : { field: p.field, op: p.op, threshold: p.threshold as number })) };
  // The named disclosures: one answer per request — disclosed with the held records that answer
  // it (possibly none), or declined. The presenter's PoP commits to the elections + record
  // identities; the issuer's signature covers the derived records.
  const named = o.challenge.disclosures ?? [];
  const proofs: Record<string, unknown>[] = [];
  const answers: DisclosureAnswer[] = named.map((request) => {
    if (o.disclosure === 'declined') return { request, election: 'declined' as const };
    const limit = request.kind === 'witness' ? request.limit : 1;
    const records: DisclosedRecord[] = [];
    for (const h of o.held ?? []) {
      if (records.length >= limit) break;
      if (!heldAnswers(h, request)) continue;
      const built = discloseHeld(h, request, o.presenter.walletId);
      records.push(built.record);
      proofs.push(built.proof);
    }
    return { request, election: 'disclosed' as const, records };
  });
  const digest = presentationClaimsDigest({ tier: 'reputation', directive, ...(answers.length > 0 ? { disclosures: answers } : {}) });
  const iat = o.nowSeconds;
  const exp = iat + (o.ttlSeconds ?? 300);
  const jti = `pres_${crypto.randomBytes(8).toString('hex')}`;
  const burnId = o.burnId ?? crypto.randomBytes(32).toString('hex');
  const aud = o.audOverride ?? o.challenge.audience;
  const requester = o.challenge.requester ? { type: o.challenge.requester.type, id: o.challenge.requester.id } : undefined;
  const chalExp = o.challenge.expiresAt;
  const signed = requester !== undefined && chalExp !== undefined;
  const binding = presentationBindingString({
    tier: 'reputation', presenterAddress: o.presenter.address, aud, chal: o.challenge.challenge, iat, exp, jti, burnId, claimsDigest: digest,
    ...(signed ? { requester, chalExp } : {}),
  });
  const signature = crypto.createSign('SHA256').update(binding).sign(o.presenter.privateKey, 'hex');
  const facts: Record<string, number> = { ...o.facts };
  // A predicate's field is withheld raw (answered as a boolean) — except standing, always disclosed.
  for (const p of asked) if (!p.field.startsWith('standing.')) delete facts[p.field];
  // A predicate-only field is never disclosed raw.
  for (const f of Object.keys(facts)) if (PREDICATE_ONLY.test(f)) delete facts[f];
  for (const f of o.withhold ?? []) delete facts[f];
  const payload = {
    v: signed ? 2 : 1, tier: 'reputation', iss: ISSUER, sub: o.presenter.walletId, presenter_address: o.presenter.address,
    aud, chal: o.challenge.challenge, iat, exp, jti, burn_id: burnId,
    presenter_pop: { scheme: 'ecdsa_sha256_secp256k1', signature, pubkey: o.presenter.pubkeyHex },
    reputation: { facts, predicates: answered, redacted: [] },
    ...(answers.length > 0 ? { disclosures: o.tamperDisclosed ? answers.map((a) => (a.election === 'disclosed' ? { ...a, records: o.tamperDisclosed!([...(a.records ?? [])]) } : a)) : answers } : {}),
    ...(signed ? { chal_exp: chalExp, requester } : {}),
  };
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
  const header = b64({ alg: 'EdDSA', kid: o.issuer.kid, typ: 'provian-presentation+jwt' });
  const body = b64(payload);
  const sig = crypto.sign(null, Buffer.from(`${header}.${body}`, 'utf8'), o.issuer.privateKey).toString('base64url');
  return b64({ tier: 'reputation', payload, provian_jws: `${header}.${body}.${sig}`, ...(proofs.length > 0 ? { disclosure_proofs: proofs } : {}) });
}

/** A fake `fetch` answering the relay's verify route with the SAME verdict the local verifier reaches
 *  (or a forced one), so the agreement check can be exercised. */
export function fakeRelayFetch(answer: (body: Record<string, unknown>) => { status?: number; json: unknown }): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const r = answer(body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

/** The relay-shaped verify response for a token the LOCAL verifier would accept — built from the token itself. */
export function relayShapedAnswer(token: string): Record<string, unknown> {
  const p = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { payload: Record<string, unknown> };
  const payload = p.payload;
  const rep = payload.reputation as { predicates: AnsweredPredicate[]; facts: Record<string, number> };
  const standing: Record<string, number> = {};
  for (const [k, v] of Object.entries(rep.facts)) if (k.startsWith('standing.')) standing[k] = v;
  return {
    valid: true, tier: 'reputation', onchain_checked: false, presentation_id: payload.burn_id, presenter_address: payload.presenter_address,
    sub: payload.sub, requester: payload.requester ?? null, challenge_expires_at: payload.chal_exp ?? null,
    predicates: rep.predicates, standing, disclosed: rep.facts, redacted: [],
    ...(Array.isArray(payload.disclosures) ? { disclosures: payload.disclosures } : {}),
  };
}
