/**
 * WORKED EXAMPLE 5 — a sensitive site.
 *
 * A site that handles something sensitive — a clinic's records, a bank's back office, a power
 * operator's control plane — is asked to let an agent in. Its question is not "how much has this
 * agent done" but "can it prove THE specific thing we require": a credential a named issuer
 * witnessed, and what that credential says. The yes/no vocabulary cannot carry that; the signed
 * challenge NAMES the record instead.
 *
 * The challenge carries one disclosure request beside the predicates:
 *
 *   { kind: 'pe', output_digest: <the credential's hash>, issuer: <the root the attestation must
 *     chain to>, content: ['description', 'artifacts'] }
 *
 * — the one PE carrying that output digest, witnessed under that issuer root, with its elected
 * content: the description the record carries and the artifacts (its output digests). The
 * presenter ELECTS: it discloses the record it holds, or declines, and either answer is signed. The
 * relay derives the witness facts from the PE it hash-checked and signs the record; the verifier
 * checks the record against its anchored act on Base (two-hop proof to PEAnchor) and refuses a
 * mismatch; the gate reads only what was disclosed.
 *
 * The gate's own rule over the answer (`disclosed(view)`):
 *   - the request was answered `disclosed` (a declined request is a signed no, and the gate says so);
 *   - exactly one record came back, carrying the named digest under the named issuer, with a
 *     hardware witness (a credential vouched for by the actor's own say-so is no credential);
 *   - its description is present — the site reads it and shows it in the report.
 *
 * Plus the general Standing questions. A presenter that holds no such record — a fresh key, or a
 * mature agent without this credential — has nothing to show and is blocked on that alone.
 *
 * `credential` names the digest and issuer root your site requires; the defaults are the
 * illustrative fixture's credential.
 */
import type { CanonicalDisclosureRequest, DisclosureAnswer } from '@provian/agent-sdk';
import type { GatePolicy, VerifiedView } from '../types.js';
import { describeDisclosure, standingValue } from '../policy.js';

export interface NamedCredential {
  /** The credential's output digest (64 hex). */
  readonly digest: string;
  /** sha256 fingerprint (64 hex) of the pinned issuer root the credential's witness must chain to. */
  readonly issuer: string;
}

/** The illustrative credential: a clearance record attested under the Google Cloud EK/AK CA root. */
export const ILLUSTRATIVE_CREDENTIAL: NamedCredential = {
  digest: '7c4e1b9d2a6f8c0e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e',
  issuer: '594759594b9b61524f6c8ef668f7177f7b9066bc0674f2f49fe9e052be78beb2',
};

/** The one disclosure request the sensitive-site challenge carries. */
export function credentialRequest(credential: NamedCredential): CanonicalDisclosureRequest {
  return { kind: 'pe', output_digest: credential.digest, issuer: credential.issuer, content: ['artifacts', 'description'] };
}

/** Why a disclosure answer does not satisfy the site, or null when it does. */
export function credentialObjection(answer: DisclosureAnswer | undefined, credential: NamedCredential): string | null {
  const request = credentialRequest(credential);
  if (!answer) return `the named credential was not answered (${describeDisclosure(request)})`;
  if (answer.election !== 'disclosed') return `the presenter declined to disclose the named credential (${describeDisclosure(request)})`;
  const records = answer.records ?? [];
  if (records.length === 0) return 'the presenter holds no record carrying the named credential';
  if (records.length !== 1) return 'more than one record came back for a single named credential';
  const r = records[0] as NonNullable<DisclosureAnswer['records']>[number];
  if (r.output_digest !== credential.digest) return 'the disclosed record does not carry the named credential digest';
  if (r.witness.kind !== 'hardware' || r.witness.issuer !== credential.issuer) return 'the disclosed record is not hardware-witnessed under the named issuer';
  if (typeof r.content?.description !== 'string' || r.content.description.trim().length === 0) return 'the disclosed record carries no description';
  return null;
}

/** Build the policy for the credential your site requires. */
export function sensitiveSite(credential: NamedCredential = ILLUSTRATIVE_CREDENTIAL): GatePolicy {
  if (!/^[0-9a-f]{64}$/.test(credential.digest)) throw new Error('credential.digest must be 64 hex');
  if (!/^[0-9a-f]{64}$/.test(credential.issuer)) throw new Error('credential.issuer must be the 64-hex sha256 fingerprint of a pinned root');
  const request = credentialRequest(credential);
  return {
    slug: 'sensitive-site',
    name: 'Sensitive site',
    action: 'Admit an agent to a site that requires a specific credential',
    description:
      'Admit only when the presenter discloses the one record carrying the named credential — witnessed in hardware under the named issuer root, with its description — and nothing adverse stands against it in the last 90 days. A presenter with nothing to show, or one that declines, is refused.',
    predicates: [
      // Standing — always present, never redactable; asked so the answers are co-signed.
      { field: 'standing.adverse_events_90d', op: 'in', set: [0] },
      { field: 'standing.open_bond_claims_against', op: 'eq', threshold: 0 },
      { field: 'standing.invalidation_active', op: 'eq', threshold: 0 },
    ],
    disclosures: [request],
    standing(view: VerifiedView): string[] {
      const reasons: string[] = [];
      if (standingValue(view.standing, 'standing.reputation_slashed') > 0) reasons.push('this presenter’s reputation has been slashed');
      return reasons;
    },
    disclosed(view: VerifiedView): string[] {
      const answer = view.disclosures.find((a) => a.request.kind === 'pe' && a.request.output_digest === credential.digest);
      const objection = credentialObjection(answer, credential);
      return objection ? [objection] : [];
    },
  };
}
