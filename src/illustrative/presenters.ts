/**
 * THE TWO ILLUSTRATIVE PRESENTERS. Neither is a real actor; both are fixtures the reference signs
 * with its own published TEST keys (below), so anyone can regenerate the contrast byte for byte in
 * every value except the gate's fresh challenge nonces and signatures.
 *
 *   FRESH        a new identity: a valid key and nothing behind it. Every count is zero; Standing
 *                is clean because nothing has happened yet.
 *   ESTABLISHED  an agent with the record the network produces at maturity: over a year under
 *                witness, commits a code forge witnessed, payments the chain witnessed from
 *                independent parties, independent parties building on its output, every act of its
 *                last 90 days run on a GCE Confidential VM under the measured Provian observer (so
 *                attested under the Google root, one launch measurement, one region — and sealed in
 *                the top witness class), a person who answers for it, a clearance credential it can
 *                disclose — and one adverse event, a bond it posted that expired, more than 90 and
 *                fewer than 365 days ago. That event is in every presentation it makes and every
 *                report a gate writes.
 *
 * Both answer the same challenge with a token the same verifier accepts. Only the record differs.
 */
import crypto from 'node:crypto';
import { STANDING_ALWAYS_PRESENT, makeIssuer, makePresenter, type HeldRecord, type Issuer, type Presenter } from './forge.js';
import { ILLUSTRATIVE_ATTESTATION } from '../examples/mission-critical-action.js';
import { ILLUSTRATIVE_CREDENTIAL } from '../examples/sensitive-site.js';

/** The moment the illustrative run is pinned to: 2026-10-10T00:00:00Z, in unix seconds. */
export const ILLUSTRATIVE_NOW = Date.UTC(2026, 9, 10) / 1000;

const DAY_MS = 86_400_000;
const seed = (label: string): Buffer => crypto.createHash('sha256').update(`provian-reference-gate/illustrative/${label}`).digest();

/** The illustrative issuer. A TEST key derived from a public label — it signs nothing real. */
export function illustrativeIssuer(): Issuer {
  return makeIssuer('illustrative-issuer-k1', seed('issuer'));
}

export interface IllustrativePresenter {
  readonly id: 'fresh' | 'established';
  readonly label: string;
  readonly summary: string;
  readonly presenter: Presenter;
  /** The presenter's full vocabulary. The token discloses it the way the relay would. */
  readonly facts: Readonly<Record<string, number>>;
  /** The records this presenter holds and can put forward when a challenge names them. */
  readonly held: readonly HeldRecord[];
}

export function freshPresenter(): IllustrativePresenter {
  return {
    id: 'fresh',
    label: 'Fresh key',
    summary: 'A new identity: a valid key and nothing behind it.',
    presenter: makePresenter('wallet_aw_illustrative_fresh', seed('presenter/fresh')),
    facts: {
      ...STANDING_ALWAYS_PRESENT,
      'actor.is_agent': 1,
      'continuity.first_seen_ms': 0, 'continuity.last_seen_ms': 0, 'continuity.chain_depth': 0,
      'continuity.active_days': 0, 'continuity.active_days_30d': 0, 'continuity.active_days_90d': 0, 'continuity.active_days_365d': 0,
      'continuity.streak_days': 0, 'continuity.registered_devices': 0,
      'accountability.human_beneficiary': 0, 'accountability.supervised_turns': 0,
      'work.total': 0, 'work.witnessed': 0, 'work.witnessed_90d': 0, 'work.hardware_rooted': 0, 'work.hardware_rooted_90d': 0,
      'consumption.independent_parties': 0, 'consumption.edges': 0,
      'coupling.distinct_owners': 0, 'coupling.independent_owners': 0,
      'money.witnessed_inbound': 0, 'money.witnessed_inbound_90d': 0, 'money.independent_payers': 0, 'money.independent_payers_90d': 0,
      'money.witnessed_financial': 0, 'money.witnessed_financial_90d': 0,
      'money.witnessed_payment_volume_usd_365d': 0,
      'money.promises_fulfilled': 0, 'money.promises_defaulted': 0, 'money.escrows_completed_as_provider': 0,
      'composition.attested_issuers': 0, 'composition.measurements': 0, 'composition.attested_regions': 0,
    },
    held: [],
  };
}

/** The one credential the established agent holds: a clearance record attested on its Confidential VM. */
export function establishedCredential(): HeldRecord {
  return {
    pe_id: 'pe_illustrative_clearance_2026-07-14',
    timestamp: Date.UTC(2026, 6, 14, 9, 30),
    action_type: 'compute_session',
    description: 'Clearance issued by the operator’s security office for control-plane access, tier 2, valid through 2027-07-14.',
    metadata: { kind: 'clearance', tier: 2, valid_through: '2027-07-14' },
    output_digests: [{ hash: ILLUSTRATIVE_CREDENTIAL.digest, kind: 'credential' }],
    hardware: {
      scheme: 'tpm2_quote',
      issuer: ILLUSTRATIVE_ATTESTATION.issuerRoot,
      signer: crypto.createHash('sha256').update('provian-reference-gate/illustrative/ak-key').digest('hex'),
      measurement: ILLUSTRATIVE_ATTESTATION.launchMeasurement,
      region: ILLUSTRATIVE_ATTESTATION.region,
    },
  };
}

export function establishedPresenter(): IllustrativePresenter {
  const now = ILLUSTRATIVE_NOW * 1000;
  return {
    id: 'established',
    label: 'Established agent',
    summary: 'An agent with the record the network produces at maturity — and one adverse event it carries.',
    presenter: makePresenter('wallet_aw_illustrative_established', seed('presenter/established')),
    facts: {
      ...STANDING_ALWAYS_PRESENT,
      // One adverse event: a bond it posted expired, 90 to 365 days ago. Visible for good.
      'standing.adverse_events': 1, 'standing.adverse_events_365d': 1, 'standing.bond_expired': 1,
      'standing.bond_active': 1,
      'actor.is_agent': 1,
      'continuity.first_seen_ms': now - 431 * DAY_MS, 'continuity.last_seen_ms': now - 3_600_000, 'continuity.chain_depth': 48_210,
      'continuity.active_days': 372, 'continuity.active_days_30d': 29, 'continuity.active_days_90d': 84, 'continuity.active_days_365d': 318,
      'continuity.streak_days': 41, 'continuity.registered_devices': 3,
      'accountability.human_beneficiary': 1, 'accountability.supervised_turns': 15_312,
      'work.total': 48_210, 'work.witnessed': 47_964, 'work.witnessed_90d': 9_412,
      'work.compute.forge_witnessed': 1_284,
      // Every act of the last 90 days ran on its Confidential VM under the measured observer: the
      // facts (issuer root, launch measurement, region) at 100% of the window, and therefore the
      // top witness class at 100% too.
      'work.hardware_rooted': 21_640, 'work.hardware_rooted_90d': 9_412, 'share.witness_90d.hardware_rooted': 10_000,
      'composition.attested_issuers': 1, 'composition.measurements': 1, 'composition.attested_regions': 1,
      [`composition.issuer.${ILLUSTRATIVE_ATTESTATION.issuerRoot}`]: 21_640,
      [`composition.measurement.${ILLUSTRATIVE_ATTESTATION.launchMeasurement}`]: 21_640,
      [`composition.region.${ILLUSTRATIVE_ATTESTATION.region}`]: 21_640,
      [`share.issuer_90d.${ILLUSTRATIVE_ATTESTATION.issuerRoot}`]: 10_000,
      [`share.measurement_90d.${ILLUSTRATIVE_ATTESTATION.launchMeasurement}`]: 10_000,
      [`share.region_90d.${ILLUSTRATIVE_ATTESTATION.region}`]: 10_000,
      'consumption.independent_parties': 87, 'consumption.edges': 2_941,
      'coupling.distinct_owners': 230, 'coupling.independent_owners': 212,
      // Paid by independent parties: 640 inbound payments lifetime from 118 distinct payers the
      // same-owner fence passed; 71 payments from 19 payers in the last 90 days.
      'money.witnessed_inbound': 640, 'money.witnessed_inbound_90d': 71, 'money.independent_payers': 118, 'money.independent_payers_90d': 19,
      'money.witnessed_financial': 1_122, 'money.witnessed_financial_90d': 184,
      'money.witnessed_payment_volume_usd_365d': 48_250,
      'money.promises_fulfilled': 31, 'money.promises_defaulted': 0, 'money.escrows_completed_as_provider': 44,
    },
    held: [establishedCredential()],
  };
}
