/** Operator-owned admission receipts. No transport and no replay authority. */
import { createHash, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  decodePresentationToken, parseChallengeEnvelope, verifyChallengeEnvelope, verifyPresentationToken,
  type ChallengeEnvelope, type PresentationJwk, type VerifyPresentationResult,
} from '@provian/agent-sdk';
import { evaluatePredicates, adverseStandingOf } from './policy.js';
import { buildReport } from './report.js';
import type { VerifiedView } from './types.js';
import { offlineAnchorCheck, type AnchorObservation } from './anchor-evidence.js';
import type { Decision, GateKey, GatePolicy } from './types.js';

/** All fields are receipt-time snapshots. No HTTP headers, IPs, owner lookup or undisclosed facts. */
export interface AdmissionRecord {
  readonly kind: 'provian-gate-admission.v1';
  readonly id: string;
  readonly received_at: string;
  readonly verified_at_seconds: number;
  /** Exact token argument, including whitespace; never decoded and re-encoded for storage. */
  readonly token: string;
  /** Null only when the arrival could not be associated with an issued challenge. */
  readonly challenge: ChallengeEnvelope | null;
  readonly policy: Pick<GatePolicy, 'slug' | 'name' | 'action' | 'description' | 'predicates' | 'disclosures'>;
  readonly verification: {
    readonly local: VerifyPresentationResult | null;
    readonly jwks: readonly PresentationJwk[];
  };
  readonly anchor_observations: readonly AnchorObservation[];
  readonly decision: Decision;
  readonly gate_public_jwk: GateKey['publicJwk'];
}
export interface AdmissionEntry {
  readonly record: AdmissionRecord;
  /** Signature over SHA-256(canonical JSON(record)), domain separated from challenges. */
  readonly sha256: string;
  readonly signature: string;
}

/** Attach to Gate.create, or omit entirely. Implementations must durably append before resolving.
 * Challenge retention is for receipts only; it must never authorize acceptance. */
export interface AdmissionLog {
  rememberChallenge(challenge: ChallengeEnvelope): void;
  findChallenge(nonce: string): ChallengeEnvelope | null;
  append(entry: AdmissionEntry): Promise<void>;
}

export class AdmissionLogError extends Error {
  constructor() { super('admission log unavailable; no admission decision returned'); this.name = 'AdmissionLogError'; }
}

/** JSON objects sorted recursively; array order and string bytes are preserved. */
export function admissionCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(admissionCanonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((k) => object[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${admissionCanonicalJson(object[k])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('not JSON');
  return encoded;
}
const digest = (value: unknown): string => createHash('sha256').update(admissionCanonicalJson(value)).digest('hex');
const signingBytes = (hash: string): Buffer => Buffer.from(`provian-gate-admission:v1:${hash}`, 'utf8');

export function sealAdmission(record: AdmissionRecord, key: GateKey): AdmissionEntry {
  const snapshot = JSON.parse(admissionCanonicalJson(record)) as AdmissionRecord;
  const sha256 = digest(snapshot);
  return { record: snapshot, sha256, signature: sign(null, signingBytes(sha256), key.privateKeyPem).toString('base64url') };
}

/** Create-only files, fsynced before returning, one UUID-named JSON per decision. No overwrite,
 * update or delete API. Mount this directory on the operator's durable volume. */
export function createFileAdmissionLog(directory: string): AdmissionLog {
  const root = path.resolve(directory);
  const challenges = path.join(root, 'challenges');
  const entries = path.join(root, 'entries');
  for (const dir of [root, challenges, entries]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const create = (file: string, value: unknown): void => {
    const fd = openSync(file, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    const parent = openSync(path.dirname(file), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  };
  const challengeFile = (nonce: string): string => path.join(challenges, `${createHash('sha256').update(nonce).digest('hex')}.json`);
  return {
    rememberChallenge(challenge) {
      const file = challengeFile(challenge.challenge);
      try { create(file, challenge); } catch (err) {
        // Another process may have filed the identical challenge. Never overwrite it.
        if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST') ||
          admissionCanonicalJson(JSON.parse(readFileSync(file, 'utf8'))) !== admissionCanonicalJson(challenge)) throw err;
      }
    },
    findChallenge(nonce) {
      const file = challengeFile(nonce);
      if (!existsSync(file)) return null;
      const challenge = parseChallengeEnvelope(readFileSync(file, 'utf8'));
      if (!challenge || challenge.challenge !== nonce) throw new Error('invalid retained challenge');
      return challenge;
    },
    async append(entry) {
      // IDs are generated here as filenames too: untrusted/custom IDs never become paths.
      create(path.join(entries, `${randomUUID()}.json`), entry);
    },
  };
}

/** No private key fields can enter a receipt, even when an injected JWK carries extra properties. */
export function publicPresentationKeys(keys: readonly PresentationJwk[]): PresentationJwk[] {
  return keys.map((key) => ({ kty: key.kty, kid: key.kid,
    ...(key.crv !== undefined ? { crv: key.crv } : {}), ...(key.x !== undefined ? { x: key.x } : {}),
    ...(key.alg !== undefined ? { alg: key.alg } : {}),
  }));
}

/** Recheck the receipt against an independently retained gate key and recheck the token at the
 * original verification time. Never fetch keys, contact Provian, or claim a replay slot.
 * The gate's signed on-chain observation is historical evidence, not a fresh Base read. */
export async function reverifyAdmission(entry: AdmissionEntry, trustedGateKey: GateKey['publicJwk'], policy?: GatePolicy): Promise<{
  receipt_valid: boolean;
  challenge: string;
  presentation: VerifyPresentationResult | null;
  recorded_decision: Decision['decision'];
  recorded_replay: Decision['verification'];
  anchor_check: ReturnType<typeof offlineAnchorCheck>;
  verification_matches: boolean | null;
  policy_check: 'matches' | 'mismatch' | 'not_run';
}> {
  const record = entry.record;
  let receiptValid = false;
  try {
    receiptValid = record.kind === 'provian-gate-admission.v1' && digest(record) === entry.sha256 &&
      admissionCanonicalJson(record.gate_public_jwk) === admissionCanonicalJson(trustedGateKey) &&
      verify(null, signingBytes(entry.sha256), createPublicKey({ key: trustedGateKey, format: 'jwk' }), Buffer.from(entry.signature, 'base64url'));
  } catch { receiptValid = false; }
  if (!receiptValid) throw new Error('admission receipt signature invalid (or untrusted gate key)');
  const noNetwork: typeof fetch = async () => { throw new Error('offline admission verification forbids network'); };
  let challenge = 'unavailable';
  let presentation: VerifyPresentationResult | null = null;
  if (record.challenge) {
    const verdict = await verifyChallengeEnvelope(record.challenge, {
      fetchRequesterKeys: async (domain) => domain === record.decision.gate ? [trustedGateKey] : [],
      nowSeconds: record.verified_at_seconds,
    });
    challenge = verdict.status === 'invalid' ? `invalid:${verdict.reason}` : verdict.status;
    presentation = await verifyPresentationToken(record.token.trim(), {
      challenge: record.challenge, jwks: record.verification.jwks, nowSeconds: record.verified_at_seconds,
      acceptOnce: false, requireOnchain: false, fetchFn: noNetwork,
    });
  } else if (!decodePresentationToken(record.token.trim())) {
    presentation = { valid: false, reason: 'malformed' };
  }
  const anchorCheck = offlineAnchorCheck(record.token, record.anchor_observations);
  if (presentation?.valid && (anchorCheck === 'invalid' || anchorCheck === 'unavailable' || anchorCheck === 'untrusted')) {
    presentation = { valid: false, reason: presentation.tier === 'reputation' ? 'disclosure_record_invalid' : anchorCheck === 'untrusted' ? 'pe_fact_anchor_untrusted' : 'pe_fact_proof_onchain_invalid' };
  }
  let policyCheck: 'matches' | 'mismatch' | 'not_run' = 'not_run';
  if (policy && presentation?.valid && record.verification.local?.valid) {
    const descriptor = { slug: policy.slug, name: policy.name, action: policy.action, description: policy.description,
      predicates: policy.predicates, ...(policy.disclosures ? { disclosures: policy.disclosures } : {}) };
    if (admissionCanonicalJson(descriptor) !== admissionCanonicalJson(record.policy)) policyCheck = 'mismatch';
    else {
      const view: VerifiedView = { tier: presentation.tier, presentationId: presentation.presentationId,
        presenterAddress: presentation.presenterAddress.toLowerCase(), presenterWalletId: presentation.sub,
        requester: presentation.requester, predicates: presentation.predicates ?? [], standing: presentation.standing ?? {},
        disclosed: presentation.disclosed ?? {}, disclosures: presentation.disclosures ?? [], challengeExpiresAt: presentation.challengeExpiresAt };
      const reasons = evaluatePredicates(policy.predicates, view.predicates);
      reasons.push(...policy.standing(view), ...(policy.disclosed?.(view) ?? []));
      if (view.requester?.type !== 'domain' || view.requester.id !== record.decision.gate) reasons.push('the presentation was not issued against a challenge the relay verified as ours');
      const outcome = reasons.length ? 'block' : 'allow';
      const report = buildReport({ policy, view, decision: outcome, reasons: outcome === 'allow' ? record.decision.reasons : reasons, nowSeconds: record.verified_at_seconds });
      policyCheck = outcome === record.decision.decision && admissionCanonicalJson(report) === admissionCanonicalJson(record.decision.report) &&
        admissionCanonicalJson(adverseStandingOf(view.standing)) === admissionCanonicalJson(record.decision.standing) ? 'matches' : 'mismatch';
    }
  }
  const original = record.verification.local;
  const matches = original === null || presentation === null ? null : original.valid ? presentation.valid
    : original.reason === 'replayed' ? presentation.valid && record.decision.verification?.replay === 'replayed'
    : !presentation.valid && original.reason === presentation.reason;
  return {
    receipt_valid: receiptValid, challenge, presentation,
    recorded_decision: record.decision.decision, recorded_replay: record.decision.verification,
    anchor_check: anchorCheck, verification_matches: matches, policy_check: policyCheck,
  };
}
