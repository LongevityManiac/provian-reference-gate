/**
 * THE REFERENCE GATE — the complete outsider path over a Provian presentation, in one file.
 *
 * A gate is any system that must decide what to do with an instruction from an agent (or a
 * person) it has never met. It holds no Provian account, no API key, no wallet, and pays nothing.
 * It needs a domain it controls and an HTTPS endpoint. The path, start to finish:
 *
 *   STEP 0 · IDENTITY     The gate owns an Ed25519 key. Its public half is published at
 *                         https://<domain>/.well-known/provian-requester.json  →  { keys: [jwk] }
 *                         (see wellKnownDocument). That URL IS the gate's identity: the relay
 *                         fetches it when a presenter presents against the gate's challenge, so
 *                         the presentation names a requester the relay verified.
 *
 *   STEP 1 · CHALLENGE    The gate issues a SIGNED challenge (`provian-challenge-v1`, Ed25519):
 *                           { v: 1, audience: <domain>, challenge: <32 random bytes, hex>,
 *                             predicates: [...], disclosures?: [...], issuedAt, expiresAt, presenter?,
 *                             requester: { type: 'domain', id: <domain>, kid }, sig }
 *                         `disclosures` (2026-10-10) names specific RECORDS beyond the predicates —
 *                         a PE by output digest, or PEs under a named issuer or signer, with the
 *                         fields and content the gate elects to see; the presenter elects what to
 *                         disclose and signs either answer. Its digest rides the signing string.
 *                         `audience` MUST equal the domain (the presentation's `aud` is then the
 *                         verified requester identity). `predicates` are the gate's questions in the
 *                         frozen grammar. `presenter` (optional) addresses one presenter. The gate
 *                         keeps the envelope; it hands the presenter a copy over any channel.
 *
 *   STEP 2 · PRESENT      The presenter verifies the signature against the well-known key, burns
 *                         PVT, and presents to the Provian relay, which computes every predicate
 *                         from the presenter's live record, co-signs, and hands back a TOKEN —
 *                         base64url(JSON { tier, payload, provian_jws }). The presenter returns the
 *                         token to the gate. The gate paid nothing and called nothing.
 *
 *   STEP 3 · VERIFY       Two independent verifications, both required:
 *                           (a) stateless relay verify — POST https://api.provian.ai/v1/present/verify
 *                               { token, challenge_envelope }  →  { valid, presentation_id, ... }
 *                               The relay records nothing; the same token verifies again. It is a
 *                               second opinion from the issuer, not the gate's memory.
 *                           (b) local verify — Provian's public keys (GET /v1/present/jwks, cached)
 *                               check the EdDSA signature over the presentation; the presenter's own
 *                               signature over the binding proves live key possession; audience,
 *                               nonce, deadline, version and tier are checked; a PE fact also reads
 *                               the PEAnchor contract on Base. ONE-SHOT: the presentation id (the
 *                               burn id) is claimed in a seen-store; a second arrival is `replayed`.
 *                         The two must agree on the presentation, the presenter and every answer.
 *
 *   STEP 4 · DECIDE       Every predicate the gate asked must be answered `true`; the gate's own
 *                         rule runs over Standing (always present, never redactable); the presenter
 *                         must be the one addressed, if one was. Anything unknown, failed, or false
 *                         is BLOCKED, never warned.
 *
 * Nothing here is Provian policy. The questions, the thresholds and the consequence are the gate's.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  issuePresentationChallenge,
  verifyPresentationToken,
  verifyChallengeEnvelope,
  decodePresentationToken,
  parseChallengeEnvelope,
  fetchProvianPresentationKeys,
  generateRequesterKey,
  requesterWellKnownDocument,
  createMemorySeenStore,
  REQUESTER_WELL_KNOWN_PATH,
  CHALLENGE_DEFAULT_TTL_SECONDS,
  type ChallengeEnvelope,
  type PresentationJwk,
  type PresentationSeenStore,
  type VerifyPresentationResult,
} from '@provian/agent-sdk';
import type { AnsweredPredicate, Decision, GateKey, GatePolicy, Predicate, VerificationRecord, VerifiedView } from './types.js';
import { adverseStandingOf, describePredicate, evaluatePredicates, samePredicate, samePredicateSet, sameDisclosureSet } from './policy.js';
import type { DisclosureAnswer } from '@provian/agent-sdk';
import { buildReport } from './report.js';
import { captureAnchorObservations, anchorFetch } from './anchor-evidence.js';
import { AdmissionLogError, publicPresentationKeys, sealAdmission, type AdmissionLog, type AdmissionRecord } from './admission.js';

export const DEFAULT_RELAY_URL = 'https://api.provian.ai';
/** Mirrors the relay: a token is checked inside ±60 s of clock skew. */
const CLOCK_SKEW_SECONDS = 60;

interface DecisionEvidence {
  challenge: ChallengeEnvelope | null;
  local: VerifyPresentationResult | null;
  jwks: readonly PresentationJwk[];
}

export interface GateOptions {
  /** Optional operator-owned receipts; independent of the seen-store. */
  readonly admissionLog?: AdmissionLog;
  /** The gate's domain — a lowercase DNS hostname it controls and serves HTTPS on. */
  readonly domain: string;
  /** The gate's Ed25519 key (`generateGateKey()`), whose public half the domain publishes. */
  readonly key: GateKey;
  /** The Provian relay. Default: the public relay. */
  readonly relayUrl?: string;
  /** Also ask the relay's stateless verify as a second opinion. Default true. */
  readonly relayVerify?: boolean;
  /** Provian's presentation keys, if already fetched (offline / tests). Else fetched once from the relay. */
  readonly jwks?: readonly PresentationJwk[];
  /** Where accepted presentation ids are remembered. Default: in memory (one process). Use the SDK's
   *  `createFileSeenStore(path)` when more than one process may decide. */
  readonly seenStore?: PresentationSeenStore;
  /** Challenge lifetime in seconds (60..604800). Default 900. */
  readonly challengeTtlSeconds?: number;
  /** Base RPC for the PE-fact anchor read. Default: the SDK's canonical Base RPC. */
  readonly rpcUrl?: string;
  /** Injected fetch (tests). */
  readonly fetchFn?: typeof fetch;
  /** Injected clock in unix seconds (tests). */
  readonly nowSeconds?: () => number;
}

interface IssuedChallenge {
  readonly envelope: ChallengeEnvelope;
  readonly policy: string;
  consumedAt: number | null;
}

/** Generate the gate's Ed25519 key. Keep `privateKeyPem` secret; publish `publicJwk`. */
export function generateGateKey(kid?: string): GateKey {
  const k = kid !== undefined ? generateRequesterKey({ kid }) : generateRequesterKey();
  return { kid: k.kid, privateKeyPem: k.privateKeyPem, publicJwk: k.publicJwk };
}

/** The response shape of `POST /v1/present/verify` that the gate reads (the fields it compares). */
interface RelayVerifyResponse {
  valid?: unknown;
  reason?: unknown;
  error?: unknown;
  tier?: unknown;
  presentation_id?: unknown;
  presenter_address?: unknown;
  sub?: unknown;
  predicates?: unknown;
  disclosures?: unknown;
}

export class Gate {
  readonly domain: string;
  readonly key: GateKey;
  readonly relayUrl: string;
  private readonly relayVerify: boolean;
  private readonly admissionLog: AdmissionLog | undefined;
  private jwks: readonly PresentationJwk[];
  private readonly seenStore: PresentationSeenStore;
  private readonly challengeTtl: number;
  private readonly rpcUrl: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly anchorFetchFn: typeof fetch;
  private readonly now: () => number;
  /** Challenges this gate issued and has not yet consumed, by nonce. */
  private readonly issued = new Map<string, IssuedChallenge>();

  private constructor(opts: GateOptions, jwks: readonly PresentationJwk[]) {
    if (!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(opts.domain)) {
      throw new Error('domain must be a lowercase DNS hostname (the requester identity)');
    }
    this.admissionLog = opts.admissionLog;
    this.domain = opts.domain;
    this.key = opts.key;
    this.relayUrl = (opts.relayUrl ?? DEFAULT_RELAY_URL).replace(/\/+$/, '');
    this.relayVerify = opts.relayVerify !== false;
    this.jwks = jwks;
    this.seenStore = opts.seenStore ?? createMemorySeenStore();
    this.challengeTtl = opts.challengeTtlSeconds ?? CHALLENGE_DEFAULT_TTL_SECONDS;
    this.rpcUrl = opts.rpcUrl;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.anchorFetchFn = opts.fetchFn ?? anchorFetch;
    this.now = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Build a gate. Fetches Provian's presentation keys once unless `jwks` is given. */
  static async create(opts: GateOptions): Promise<Gate> {
    const jwks = opts.jwks ?? await fetchProvianPresentationKeys((opts.relayUrl ?? DEFAULT_RELAY_URL), opts.fetchFn);
    if (jwks.length === 0) throw new Error('the relay published no presentation keys');
    return new Gate(opts, jwks);
  }

  // ── STEP 0 · identity ──────────────────────────────────────────────────────

  /** The document to serve at `https://<domain>/.well-known/provian-requester.json`. */
  wellKnownDocument(): { keys: GateKey['publicJwk'][] } {
    return requesterWellKnownDocument([this.key.publicJwk]) as { keys: GateKey['publicJwk'][] };
  }

  /** Where the gate's identity is published. */
  wellKnownUrl(): string {
    return `https://${this.domain}${REQUESTER_WELL_KNOWN_PATH}`;
  }

  // ── STEP 1 · challenge ─────────────────────────────────────────────────────

  /**
   * Issue a SIGNED challenge for `policy`, optionally addressed to one presenter (its 0x address).
   * The returned envelope is what the presenter receives — `JSON.stringify` it onto any channel.
   * The gate remembers it until it expires or is answered.
   */
  issueChallenge(policy: GatePolicy, opts: { presenter?: string } = {}): ChallengeEnvelope {
    this.prune();
    const presenter = opts.presenter?.trim().toLowerCase();
    const envelope = issuePresentationChallenge({
      requester: { domain: this.domain, kid: this.key.kid, privateKeyPem: this.key.privateKeyPem },
      predicates: policy.predicates as Predicate[],
      ...(policy.disclosures && policy.disclosures.length > 0 ? { disclosures: policy.disclosures } : {}),
      ttlSeconds: this.challengeTtl,
      nowSeconds: this.now(),
      ...(presenter ? { presenter } : {}),
    });
    // A nonce of our own making can never collide with one we already hold; refuse rather than overwrite.
    if (this.issued.has(envelope.challenge)) throw new Error('challenge nonce collision');
    this.admissionLog?.rememberChallenge(envelope);
    this.issued.set(envelope.challenge, { envelope, policy: policy.slug, consumedAt: null });
    return envelope;
  }

  /** A fresh nonce the way the SDK makes one — exposed so a port in another language can compare. */
  static freshNonce(): string {
    return randomBytes(32).toString('hex');
  }

  // ── STEPS 3 + 4 · verify, then decide ──────────────────────────────────────

  /**
   * Decide over a presentation token for `policy`. The challenge the token answers is looked up
   * among those this gate issued (service mode), or supplied explicitly (CLI mode); either way its
   * signature is re-checked against this gate's own key — THE KEY CHECK — before anything else.
   *
   * Verification failures return block. An attached log must durably append before a decision is
   * returned; storage failure throws AdmissionLogError (the service returns 503, never admission).
   */
  async decide(policy: GatePolicy, token: string, opts: { challenge?: ChallengeEnvelope | string } = {}): Promise<Decision> {
    const receivedAt = new Date().toISOString();
    const now = this.now();
    const evidence: DecisionEvidence = { challenge: null, local: null, jwks: publicPresentationKeys(this.jwks) };
    let decision: Decision;
    try {
      const decoded = decodePresentationToken(token.trim());
      const nonce = decoded?.payload?.chal;
      evidence.challenge = opts.challenge !== undefined ? parseChallengeEnvelope(opts.challenge)
        : typeof nonce === 'string' ? this.issued.get(nonce)?.envelope ?? this.admissionLog?.findChallenge(nonce) ?? null : null;
      decision = await this.decideOrThrow(policy, token, opts, evidence, now);
    } catch (err) {
      decision = this.block(policy, [`error: ${err instanceof Error ? err.message : String(err)}`], null, [], null, null);
    }
    if (this.admissionLog) {
      const record: AdmissionRecord = {
        kind: 'provian-gate-admission.v1', id: randomUUID(), received_at: receivedAt, verified_at_seconds: now,
        token, challenge: evidence.challenge,
        policy: { slug: policy.slug, name: policy.name, action: policy.action, description: policy.description,
          predicates: policy.predicates, ...(policy.disclosures ? { disclosures: policy.disclosures } : {}) },
        verification: { local: evidence.local, jwks: evidence.jwks },
        anchor_observations: evidence.local && (evidence.local.valid ? evidence.local.onchainChecked
          : ['replayed', 'disclosure_record_invalid', 'pe_fact_proof_onchain_invalid'].includes(evidence.local.reason))
          ? await captureAnchorObservations(token, this.rpcUrl, this.anchorFetchFn, evidence.local.valid || evidence.local.reason === 'replayed') : [], decision,
        gate_public_jwk: { kty: 'OKP', crv: 'Ed25519', kid: this.key.publicJwk.kid, x: this.key.publicJwk.x },
      };
      try { await this.admissionLog.append(sealAdmission(record, this.key)); }
      catch { throw new AdmissionLogError(); }
    }
    return decision;
  }

  private async decideOrThrow(policy: GatePolicy, token: string, opts: { challenge?: ChallengeEnvelope | string }, evidence: DecisionEvidence, now: number): Promise<Decision> {
    this.prune();

    // The token must at least be a presentation. (Its contents are not trusted until verified.)
    const presentation = typeof token === 'string' ? decodePresentationToken(token.trim()) : null;
    if (!presentation || (presentation.tier !== 'reputation' && presentation.tier !== 'pe_fact')) {
      return this.block(policy, ['token: not a Provian presentation'], null, [], null, null);
    }

    // Which challenge does it answer? Service mode: one we issued, by the token's nonce. CLI mode:
    // the envelope handed back to us. In both modes the envelope is re-verified below.
    const nonce = typeof presentation.payload?.chal === 'string' ? presentation.payload.chal : null;
    let envelope: ChallengeEnvelope | null = null;
    let issued: IssuedChallenge | null = null;
    if (opts.challenge !== undefined) {
      envelope = parseChallengeEnvelope(opts.challenge);
      if (!envelope) return this.block(policy, ['challenge: not a well-formed challenge envelope'], null, [], null, null);
    } else if (nonce !== null) {
      issued = this.issued.get(nonce) ?? null;
      if (!issued) return this.block(policy, ['challenge: not one this gate issued, or already answered or expired'], null, [], null, null);
      if (issued.policy !== policy.slug) return this.block(policy, [`challenge: issued for policy "${issued.policy}", not "${policy.slug}"`], null, [], null, null);
      envelope = issued.envelope;
    } else {
      return this.block(policy, ['token: carries no challenge nonce'], null, [], null, null);
    }

    // THE KEY CHECK — the challenge must be one THIS gate signed: audience = our domain, requester =
    // our domain, signature verifies under our own published key, deadline not passed.
    const verdict = await verifyChallengeEnvelope(envelope, {
      fetchRequesterKeys: async (domain) => (domain === this.domain ? [this.key.publicJwk] : []),
      nowSeconds: now,
    });
    if (verdict.status !== 'verified') {
      const why = verdict.status === 'invalid' ? `${verdict.status} (${verdict.reason})` : verdict.status;
      return this.block(policy, [`challenge: not a live challenge signed by ${this.domain} — ${why}`], null, [], null, null);
    }
    if (verdict.requester.type !== 'domain' || verdict.requester.id !== this.domain || envelope.audience !== this.domain) {
      return this.block(policy, ['challenge: not addressed to this gate'], null, [], null, null);
    }
    // The envelope must ask exactly this policy's questions (a token for another policy's challenge
    // answers other questions).
    if (!samePredicateSet(policy.predicates, envelope.predicates ?? [])) {
      return this.block(policy, [`challenge: its predicates are not policy "${policy.slug}"'s`], null, [], null, null);
    }
    if (!sameDisclosureSet(policy.disclosures ?? [], envelope.disclosures ?? [])) {
      return this.block(policy, [`challenge: its disclosure requests are not policy "${policy.slug}"'s`], null, [], null, null);
    }

    // STEP 3a — the stateless relay verify (a second opinion; the relay records nothing).
    let relayStatus: VerificationRecord['relay'] = 'skipped';
    let relay: RelayVerifyResponse | null = null;
    if (this.relayVerify) {
      const r = await this.relayVerifyToken(token, envelope);
      relayStatus = r.status;
      relay = r.body;
      if (r.status !== 'valid') {
        const detail = r.status === 'invalid'
          ? (typeof relay?.reason === 'string' ? relay.reason : typeof relay?.error === 'string' ? relay.error : 'refused')
          : 'the relay could not be reached';
        return this.block(policy, [`relay verify: ${detail}`], null, [], null, { relay: relayStatus, local: 'not_run', onchain_checked: false, replay: 'n/a' });
      }
    }

    // STEP 3b — the local verify: Provian's keys, the presenter's live-key signature, binding,
    // freshness, deadline, tier, predicates answered, Standing present — and ONE-SHOT acceptance.
    let local = await this.localVerify(token, envelope, now, evidence);
    if (!local.valid && (local.reason === 'reputation_jws_unknown_kid' || local.reason === 'pe_fact_cosign_unknown_kid')) {
      // Key rotation: refresh Provian's keys once and try again.
      this.jwks = await fetchProvianPresentationKeys(this.relayUrl, this.fetchFn);
      local = await this.localVerify(token, envelope, now, evidence);
    }
    if (!local.valid) {
      const replay: VerificationRecord['replay'] = local.reason === 'replayed' ? 'replayed' : 'n/a';
      return this.block(policy, [`local verify: ${local.reason}`], null, [], null, { relay: relayStatus, local: 'invalid', onchain_checked: false, replay });
    }

    // The two verifiers must agree about what they verified.
    if (relay !== null) {
      const disagreement = this.disagreement(relay, local);
      if (disagreement) {
        return this.block(policy, [`relay and local verify disagree: ${disagreement}`], null, [], null, { relay: 'invalid', local: 'valid', onchain_checked: local.onchainChecked, replay: 'first' });
      }
    }

    // What the gate may now read. Every number is co-signed.
    const view: VerifiedView = {
      tier: local.tier,
      presentationId: local.presentationId,
      presenterAddress: local.presenterAddress.toLowerCase(),
      presenterWalletId: local.sub,
      requester: local.requester ? { type: local.requester.type, id: local.requester.id } : null,
      predicates: (local.predicates ?? []) as AnsweredPredicate[],
      standing: local.standing ?? {},
      disclosed: local.disclosed ?? {},
      disclosures: local.disclosures ?? [],
      challengeExpiresAt: local.challengeExpiresAt,
    };
    const verification: VerificationRecord = { relay: relayStatus, local: 'valid', onchain_checked: local.onchainChecked, replay: 'first' };

    // STEP 4 — the decision. The addressed presenter, if any, must be this one (the verifier already
    // refused a mismatch; restated as the gate's own rule). The requester the relay verified at
    // issuance must be this gate. Every predicate asked must be true. Then the gate's own rule.
    const reasons: string[] = [];
    if (envelope.presenter !== undefined && envelope.presenter.toLowerCase() !== view.presenterAddress) {
      reasons.push(`presenter ${view.presenterAddress} is not the one addressed (${envelope.presenter})`);
    }
    if (!view.requester || view.requester.type !== 'domain' || view.requester.id !== this.domain) {
      reasons.push('the presentation was not issued against a challenge the relay verified as ours');
    }
    reasons.push(...evaluatePredicates(policy.predicates, view.predicates));
    reasons.push(...policy.standing(view));
    // The gate's own rule over the named disclosures (the verifier already refused an unanswered
    // request and an unproven record; this is what the gate makes of the answers it got).
    if (policy.disclosed) reasons.push(...policy.disclosed(view));

    // The challenge is answered: it cannot be answered again (the presentation id is separately
    // one-shot in the seen-store).
    if (issued) issued.consumedAt = now;

    const presentationBlock = {
      id: view.presentationId,
      tier: view.tier,
      presenter: { address: view.presenterAddress, wallet_id: view.presenterWalletId },
      requester: view.requester,
      challenge_expires_at: view.challengeExpiresAt,
    };
    if (reasons.length > 0) {
      return this.block(policy, reasons, presentationBlock, view.predicates, adverseStandingOf(view.standing), verification, view, view.disclosures);
    }
    const allowReasons = policy.predicates.map((p) => `true: ${describePredicate(p)}`);
    return {
      decision: 'allow',
      gate: this.domain,
      policy: policy.slug,
      action: policy.action,
      at: new Date(now * 1000).toISOString(),
      reasons: allowReasons,
      presentation: presentationBlock,
      predicates: view.predicates,
      disclosures: view.disclosures,
      standing: adverseStandingOf(view.standing),
      verification,
      report: buildReport({ policy, view, decision: 'allow', reasons: allowReasons, nowSeconds: now }),
    };
  }

  /** `POST <relay>/v1/present/verify { token, challenge_envelope }` — the exact body, visible. */
  private async relayVerifyToken(token: string, envelope: ChallengeEnvelope): Promise<{ status: 'valid' | 'invalid' | 'unreachable'; body: RelayVerifyResponse | null }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.relayUrl}/v1/present/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ token, challenge_envelope: envelope }),
      });
    } catch {
      return { status: 'unreachable', body: null };
    }
    let body: RelayVerifyResponse | null = null;
    try { body = (await res.json()) as RelayVerifyResponse; } catch { body = null; }
    if (res.status >= 500 || body === null) return { status: 'unreachable', body };
    return { status: body.valid === true ? 'valid' : 'invalid', body };
  }

  /** The SDK's local verifier, with this gate's expectations folded in from the envelope it issued. */
  private async localVerify(token: string, envelope: ChallengeEnvelope, now: number, evidence: DecisionEvidence): Promise<VerifyPresentationResult> {
    const jwks = publicPresentationKeys(this.jwks);
    evidence.jwks = jwks;
    const result = await verifyPresentationToken(token, {
      challenge: envelope,          // audience, nonce, predicates, deadline, requester — all from our envelope
      jwks,              // Provian's published keys (cached)
      seenStore: this.seenStore,    // accept each presentation id ONCE
      acceptOnce: true,
      requireOnchain: true,         // a PE fact must verify against the PEAnchor on Base
      ...(this.rpcUrl !== undefined ? { rpcUrl: this.rpcUrl } : {}),
      nowSeconds: now,
      fetchFn: this.fetchFn,
    });
    evidence.local = result;
    return result;
  }

  /** Why the relay's answer and the local answer differ, or null when they agree. */
  private disagreement(relay: RelayVerifyResponse, local: Extract<VerifyPresentationResult, { valid: true }>): string | null {
    if (relay.tier !== local.tier) return 'tier';
    if (relay.presentation_id !== local.presentationId) return 'presentation id';
    if (typeof relay.presenter_address !== 'string' || relay.presenter_address.toLowerCase() !== local.presenterAddress.toLowerCase()) return 'presenter';
    if (local.tier === 'reputation') {
      const answered = Array.isArray(relay.predicates) ? (relay.predicates as AnsweredPredicate[]) : [];
      for (const p of local.predicates ?? []) {
        const hit = answered.find((a) => samePredicate(a, p));
        if (!hit || hit.result !== p.result) return `predicate ${describePredicate(p)}`;
      }
      // The same disclosure elections and record identities on both sides.
      const relayAnswers = Array.isArray(relay.disclosures) ? (relay.disclosures as DisclosureAnswer[]) : [];
      for (const a of local.disclosures ?? []) {
        const hit = relayAnswers.find((b) => JSON.stringify(b.request) === JSON.stringify(a.request));
        const ids = (x: DisclosureAnswer | undefined) => (x?.records ?? []).map((r) => `${r.pe_id}:${r.pe_hash}`).sort().join(',');
        if (!hit || hit.election !== a.election || ids(hit) !== ids(a)) return 'disclosure answers';
      }
    }
    return null;
  }

  private block(
    policy: GatePolicy,
    reasons: readonly string[],
    presentation: Decision['presentation'],
    predicates: readonly AnsweredPredicate[],
    standing: Decision['standing'],
    verification: VerificationRecord | null,
    view: VerifiedView | null = null,
    disclosures: readonly DisclosureAnswer[] = [],
  ): Decision {
    return {
      decision: 'block',
      gate: this.domain,
      policy: policy.slug,
      action: policy.action,
      at: new Date(this.now() * 1000).toISOString(),
      reasons,
      presentation,
      predicates,
      disclosures,
      standing,
      verification,
      report: buildReport({ policy, view, decision: 'block', reasons, nowSeconds: this.now() }),
    };
  }

  /** Forget expired and answered challenges. */
  private prune(): void {
    const now = this.now();
    for (const [nonce, c] of this.issued) {
      const exp = typeof c.envelope.expiresAt === 'number' ? c.envelope.expiresAt : 0;
      if (c.consumedAt !== null || now > exp + CLOCK_SKEW_SECONDS) this.issued.delete(nonce);
    }
  }
}
