/**
 * WORKED EXAMPLE 2 — a payment-rail commitment.
 *
 * A payment rail is about to enable instant settlement for a payee it has never met. Before it
 * commits, it asks the payee to present. The question a rail actually has is not "has money moved"
 * but "have INDEPENDENT parties paid this payee, lately, and does it keep showing up". So the gate
 * asks for witnessed inbound payments from independent parties over a window, plus continuity, and
 * the Standing every door asks.
 *
 * The thresholds, and why a rail would set them:
 *
 *   money.independent_payers_90d gte 3    At least three DISTINCT parties paid it in the last 90
 *                                         days. The relay counts a payer only from a chain-witnessed
 *                                         `receive` whose counterparty its same-owner fence could not
 *                                         resolve to the payee's own wallets or linked identities —
 *                                         so a single operator moving money between its own wallets
 *                                         reads 0 here however many transfers it makes, and FAILS.
 *   money.witnessed_inbound_90d gte 5     At least five witnessed inbound payments in the window: it
 *                                         is being paid, not merely was once.
 *   continuity.active_days_90d gte 10     Continuity: it was present on at least ten distinct days
 *                                         in the window. A record that lit up for one day of
 *                                         self-dealing is not a payee a rail commits to.
 *   money.promises_defaulted eq 0         Never defaulted on a promise.
 *   standing.adverse_events_90d in {0}    Nothing adverse in the last 90 days; an older event is
 *                                         shown in every report but does not bar settlement.
 *   standing.open_bond_claims_against eq 0 / standing.invalidation_active eq 0
 *
 * Nothing here asks the raw amounts: `money.witnessed_payment_volume_usd*` is predicate-only and
 * this rail does not even ask it. Its own rule over Standing: a lost hire dispute or a slashed bond
 * anywhere in the record is disqualifying for a settlement commitment.
 */
import type { GatePolicy, VerifiedView } from '../types.js';
import { standingValue } from '../policy.js';

export const paymentRail: GatePolicy = {
  slug: 'payment-rail',
  name: 'Payment-rail commitment',
  action: 'Enable instant settlement for a payee',
  description:
    'Commit a settlement rail to a payee only when independent parties the chain witnessed have paid it in the last 90 days, it has been paid repeatedly and been present throughout, it has never defaulted on a promise, and nothing adverse stands against it. An operator paying itself from its own wallets reads zero independent payers and is refused.',
  predicates: [
    // Independent payers: distinct counterparties of chain-witnessed receives the same-owner fence passed.
    { field: 'money.independent_payers_90d', op: 'gte', threshold: 3 },
    // Being paid, in the window.
    { field: 'money.witnessed_inbound_90d', op: 'gte', threshold: 5 },
    // Continuity through the window.
    { field: 'continuity.active_days_90d', op: 'gte', threshold: 10 },
    // Never defaulted on a promise.
    { field: 'money.promises_defaulted', op: 'eq', threshold: 0 },
    // Standing — always present, never redactable; asked explicitly so the answers are co-signed.
    { field: 'standing.adverse_events_90d', op: 'in', set: [0] },
    { field: 'standing.open_bond_claims_against', op: 'eq', threshold: 0 },
    { field: 'standing.invalidation_active', op: 'eq', threshold: 0 },
  ],
  standing(view: VerifiedView): string[] {
    const reasons: string[] = [];
    if (standingValue(view.standing, 'standing.hire_disputes_lost') > 0) reasons.push('a hire dispute was lost against this presenter');
    if (standingValue(view.standing, 'standing.bond_slashed') > 0) reasons.push('this presenter has had a bond slashed');
    return reasons;
  },
};
