/**
 * The shapes a gate reads and produces.
 *
 * The WIRE shapes — the challenge envelope, the presentation token, the verify result — belong
 * to the Provian protocol and come from `@provian/agent-sdk`. The shapes here are the gate's own:
 * the predicates it asks, the policy it applies, and the decision it renders.
 */
import type { CanonicalDisclosureRequest, DisclosureAnswer } from '@provian/agent-sdk';
import type { GateReport } from './report.js';

/** The frozen predicate grammar: five comparisons and one set membership. Nothing else exists. */
export type PredicateOp = 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'in';

/**
 * One predicate over one vocabulary field. `threshold` for a comparison, `set` for `in`.
 * The relay evaluates it against the presenter's live record at issuance; Provian co-signs the
 * boolean; the gate reads the boolean. A field the vocabulary does not know is refused at issuance,
 * so a predicate over a misspelt field can never be "answered".
 */
export interface Predicate {
  readonly field: string;
  readonly op: PredicateOp;
  readonly threshold?: number;
  readonly set?: readonly number[];
}

/** A predicate as the relay answered it: the request plus the co-signed result. */
export interface AnsweredPredicate extends Predicate {
  readonly result: boolean;
}

/** The gate's own Ed25519 identity: the private half signs challenges, the public half is published
 *  at `https://<domain>/.well-known/provian-requester.json`. No Provian account is involved. */
export interface GateKey {
  readonly kid: string;
  readonly privateKeyPem: string;
  readonly publicJwk: { readonly kty: 'OKP'; readonly crv: 'Ed25519'; readonly x: string; readonly kid: string };
}

/** What a verified presentation lets the gate read. Every number is a fact Provian co-signed. */
export interface VerifiedView {
  readonly tier: 'reputation' | 'pe_fact';
  /** The dedupe key: the burn id. One burn backs exactly one presentation, network-wide. */
  readonly presentationId: string;
  readonly presenterAddress: string;
  readonly presenterWalletId: string | null;
  readonly requester: { readonly type: 'domain' | 'wallet'; readonly id: string } | null;
  readonly predicates: readonly AnsweredPredicate[];
  /** Standing — always present on a reputation presentation; the presenter cannot withhold it. */
  readonly standing: Readonly<Record<string, number>>;
  /** Every other raw fact the presenter chose to disclose (may be empty). */
  readonly disclosed: Readonly<Record<string, number>>;
  /**
   * The requester-named disclosure answers (2026-10-10): one per request the challenge named, each
   * `disclosed` (with the records the presenter holds, proven against their anchored acts) or
   * `declined`. Empty when the challenge named nothing.
   */
  readonly disclosures: readonly DisclosureAnswer[];
  readonly challengeExpiresAt: number | null;
}

/**
 * A gate policy: the questions (predicates in the frozen grammar) and the gate's OWN rule over
 * the verified view. Provian defines no policy vocabulary — what to ask and what to do with the
 * answers is entirely the gate's. The five worked examples are instances of this interface.
 */
export interface GatePolicy {
  /** URL-safe id, e.g. `payment-rail`. */
  readonly slug: string;
  readonly name: string;
  /** The consequential action this policy guards, in one line. */
  readonly action: string;
  readonly description: string;
  readonly predicates: readonly Predicate[];
  /**
   * Requester-named disclosures (2026-10-10): the specific records the challenge asks the presenter
   * to put forward — a PE by output digest, or PEs under a named issuer or signer — with the fields
   * and content it elects to see. Distinct from the predicates; the presenter elects per request.
   */
  readonly disclosures?: readonly CanonicalDisclosureRequest[];
  /**
   * The gate's own rules beyond "every predicate answered true" — typically over Standing, which
   * is always present. Returns the reasons that BLOCK (empty = no objection).
   */
  standing(view: VerifiedView): string[];
  /** The gate's own rule over the disclosure answers (a declined request is a signed no). Reasons that BLOCK. */
  disclosed?(view: VerifiedView): string[];
}

/** Adverse standing as the decision shows it — read from the always-present `standing.*` facts. */
export interface AdverseStanding {
  readonly adverse_events: number;
  readonly adverse_events_30d: number;
  readonly adverse_events_90d: number;
  readonly adverse_events_365d: number;
  readonly bond_active: boolean;
  readonly open_bond_claims_against: number;
  readonly invalidation_active: boolean;
  /** Every per-type adverse count that is not zero, e.g. `{ "standing.promises_defaulted": 1 }`. */
  readonly by_type: Readonly<Record<string, number>>;
}

/** How the presentation was verified. Both verifiers must agree for a decision to allow. */
export interface VerificationRecord {
  /** The stateless public relay verify (`POST /v1/present/verify`), when enabled. */
  readonly relay: 'valid' | 'invalid' | 'unreachable' | 'skipped';
  /** The local verify against Provian's published keys (and Base, for a PE fact). */
  readonly local: 'valid' | 'invalid' | 'not_run';
  readonly onchain_checked: boolean;
  /** `first` when this presentation id had never been accepted here; `replayed` when it had. */
  readonly replay: 'first' | 'replayed' | 'n/a';
}

/** The decision a gate renders. `block` is the answer to anything unknown, failed, or false.
 *  Every decision carries its `report`: the six headings, then the decision and its reason. */
export interface Decision {
  readonly decision: 'allow' | 'block';
  /** The gate's domain (the audience every challenge binds to). */
  readonly gate: string;
  readonly policy: string;
  readonly action: string;
  readonly at: string;
  /** Why. On `block`, every objection; on `allow`, what was satisfied. */
  readonly reasons: readonly string[];
  readonly presentation: {
    readonly id: string;
    readonly tier: 'reputation' | 'pe_fact';
    readonly presenter: { readonly address: string; readonly wallet_id: string | null };
    readonly requester: { readonly type: 'domain' | 'wallet'; readonly id: string } | null;
    readonly challenge_expires_at: number | null;
  } | null;
  /** Every predicate the relay answered, with its co-signed result. */
  readonly predicates: readonly AnsweredPredicate[];
  /** The requester-named disclosure answers, as verified (empty when none were named or nothing verified). */
  readonly disclosures: readonly DisclosureAnswer[];
  /** Adverse standing — shown in every decision over a verified presentation. */
  readonly standing: AdverseStanding | null;
  readonly verification: VerificationRecord | null;
  /** The decision read as sentences — Identity, Accountable human, Witnessed history, Standing,
   *  Counterparties, Money witnessed — then the decision and its reason. Never a bare allow/block. */
  readonly report: GateReport;
}
