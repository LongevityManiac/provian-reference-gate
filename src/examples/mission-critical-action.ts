/**
 * WORKED EXAMPLE 4 — a mission-critical action.
 *
 * A system is about to let an agent take an action it cannot take back: sign a release, run a
 * privileged job, provision a machine. It does not ask for a witness CLASS; it asks for the
 * attestation FACTS it would check on its own fleet — and it asks them of every act in the window:
 *
 *   share.issuer_90d.<root> gte 10000          Every act in the last 90 days ran on hardware whose
 *                                              attestation chained to the named issuer root (the
 *                                              sha256 fingerprint of a root the relay pins — the
 *                                              Google Cloud EK/AK CA, the AWS Nitro root, …). A
 *                                              share is bps of ALL the presenter's work in the
 *                                              window, so 10000 means all of it.
 *   share.measurement_90d.<digest> gte 10000   … under the named launch measurement / PCR digest,
 *                                              which the platform produces at launch and the
 *                                              operator cannot choose.
 *   share.region_90d.<region> gte 10000        … in the one region this system allows. (A fleet
 *                                              confined to one region is the mission-critical
 *                                              posture; to allow several, name the share of the one
 *                                              you run and keep the others out of the fleet.)
 *   work.witnessed_90d gte 1                   The window is not empty — a share of nothing is 0,
 *                                              and the three shares above would otherwise be asked
 *                                              of no work at all.
 *   standing.adverse_events in {0}             Nothing adverse, ever. An action that cannot be
 *   standing.invalidation_active eq 0          taken back admits no history.
 *
 * Every fact comes from the SEALED, ADMITTED hardware report on each act — the relay derives the
 * issuer, the measurement and the region from the attestation it verified, never from anything the
 * actor typed. A presenter whose work carries no such report reads 0 on every share and is blocked.
 *
 * The witness class is NOT asked. It is carried anyway: when the named measurement is one the relay
 * pins for a signed Provian observer release (the measured observer), every one of those acts also
 * sealed in the top witness class, `hardware_rooted`, and the presentation discloses that share
 * (`share.witness_90d.hardware_rooted`) beside the facts. A gate that wants the class may add
 * `share.witness_90d.hardware_rooted gte 10000`; this one gates on what it can name.
 *
 * `attestation` names the root, the measurement and the region your fleet runs; the defaults are
 * the illustrative fixture's (a GCE Confidential VM under the pinned Google root, in us-central1).
 */
import type { GatePolicy, Predicate, VerifiedView } from '../types.js';
import { standingValue } from '../policy.js';

export interface AttestationFacts {
  /** sha256 fingerprint (64 hex) of the pinned issuer root every act must chain to. */
  readonly issuerRoot: string;
  /** The launch measurement / PCR digest every act must carry, e.g. `sha256:<hex>` or `sha384:<hex>`. */
  readonly launchMeasurement: string;
  /** The coarse attested region every act must carry, e.g. `us-central1`. */
  readonly region: string;
}

/** The illustrative fleet: a GCE Confidential VM under the Google Cloud EK/AK CA root, in us-central1. */
export const ILLUSTRATIVE_ATTESTATION: AttestationFacts = {
  issuerRoot: '594759594b9b61524f6c8ef668f7177f7b9066bc0674f2f49fe9e052be78beb2',
  launchMeasurement: 'sha256:9f2c1a7e0d4b6c8e3a5f7d9b1c3e5a7f2d4b6c8e0a1f3d5b7c9e1a3f5d7b9c1e',
  region: 'us-central1',
};

/** Build the policy for the attestation facts your fleet runs. */
export function missionCriticalAction(attestation: AttestationFacts = ILLUSTRATIVE_ATTESTATION): GatePolicy {
  if (!/^[0-9a-f]{64}$/.test(attestation.issuerRoot)) throw new Error('issuerRoot must be the 64-hex sha256 fingerprint of a pinned root');
  if (!/^[a-z0-9:]{1,110}$/.test(attestation.launchMeasurement)) throw new Error('launchMeasurement must look like sha256:<hex> or sha384:<hex>');
  if (!/^[a-z0-9_:-]{1,64}$/.test(attestation.region)) throw new Error('region must be a coarse region token such as us-central1');
  const predicates: Predicate[] = [
    // The window is not empty.
    { field: 'work.witnessed_90d', op: 'gte', threshold: 1 },
    // Every act in the window: the named issuer root, the named launch measurement, the allowed region.
    { field: `share.issuer_90d.${attestation.issuerRoot}`, op: 'gte', threshold: 10_000 },
    { field: `share.measurement_90d.${attestation.launchMeasurement}`, op: 'gte', threshold: 10_000 },
    { field: `share.region_90d.${attestation.region}`, op: 'gte', threshold: 10_000 },
    // Standing — nothing adverse, ever; asked so the answers are co-signed.
    { field: 'standing.adverse_events', op: 'in', set: [0] },
    { field: 'standing.invalidation_active', op: 'eq', threshold: 0 },
  ];
  return {
    slug: 'mission-critical-action',
    name: 'Mission-critical action',
    action: 'Authorize an action that cannot be taken back (sign a release, run a privileged job, provision a machine)',
    description:
      'Authorize only when every act in the presenter’s last 90 days ran on attested hardware chaining to the named issuer root, under the named launch measurement, in the allowed region — facts the relay derived from each act’s verified attestation — and nothing adverse has ever stood against it.',
    predicates,
    standing(view: VerifiedView): string[] {
      const reasons: string[] = [];
      if (standingValue(view.standing, 'standing.reputation_slashed') > 0) reasons.push('this presenter’s reputation has been slashed');
      if (standingValue(view.standing, 'standing.bond_slashed') > 0) reasons.push('this presenter has had a bond slashed');
      return reasons;
    },
  };
}
