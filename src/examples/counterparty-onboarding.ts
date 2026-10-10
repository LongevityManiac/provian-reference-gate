/**
 * WORKED EXAMPLE 1 — counterparty onboarding.
 *
 * The first gate most systems need: an agent they have never met asks to act — to open an account,
 * call an API with write access, join a marketplace, take a task. Nothing sector-specific is at
 * stake yet, so the gate asks only the general questions every door asks of a stranger: has this
 * actor been here a while, has its work been witnessed, has anyone independent built on it, does a
 * person answer for it, and does anything stand against it right now.
 *
 * The thresholds, and why an onboarding gate would set them:
 *
 *   continuity.active_days gte 30         A month of distinct days under witness. A key minted this
 *                                         afternoon reads 0; a month of days cannot be made in one.
 *   continuity.active_days_90d gte 10     It is still active. A record that went quiet a year ago
 *                                         says less about the actor knocking today.
 *   work.witnessed_90d gte 25             Recent work that something other than the actor observed
 *                                         (a daemon lane, a forge, the chain, a hardware witness).
 *                                         About one witnessed act every few days: a floor, not a bar.
 *   consumption.independent_parties gte 3 At least three parties it does not control built on its
 *                                         output. Three, not one, so a single partner — or a single
 *                                         colluding wallet — cannot vouch it in.
 *   accountability.human_beneficiary eq 1 A person is linked and answers for the agent.
 *   standing.adverse_events_90d in {0}    Nothing adverse in the last 90 days. An onboarding gate
 *                                         admits to a first, low-stakes relationship; an old event is
 *                                         shown in every report but does not bar the door forever.
 *                                         The sector gates that guard more (merges, privileged
 *                                         actions) ask the lifetime count instead.
 *   standing.open_bond_claims_against eq 0  No claim pending against it now.
 *   standing.invalidation_active eq 0     No active invalidation.
 *
 * Its own rule over Standing: a slashed reputation, at any time, is disqualifying — a slash is the
 * network's most serious finding, and onboarding is where a gate refuses to start that relationship.
 *
 * Money is not asked here: whether a stranger has been paid is a sector question (see the
 * payment-rail example). Every report still shows what the presenter disclosed about it.
 */
import type { GatePolicy, VerifiedView } from '../types.js';
import { standingValue } from '../policy.js';

export const counterpartyOnboarding: GatePolicy = {
  slug: 'counterparty-onboarding',
  name: 'Counterparty onboarding',
  action: 'Let an agent this system has never met act for the first time',
  description:
    'Admit a stranger when it has been active under witness for a month and is active now, its recent work was witnessed, independent parties have built on its output, a person answers for it, and nothing adverse stands against it in the last 90 days.',
  predicates: [
    // Continuity: time under witness, and still active.
    { field: 'continuity.active_days', op: 'gte', threshold: 30 },
    { field: 'continuity.active_days_90d', op: 'gte', threshold: 10 },
    // Witnessed work: observed by something other than the actor.
    { field: 'work.witnessed_90d', op: 'gte', threshold: 25 },
    // Independent counterparties: parties it does not control built on its output.
    { field: 'consumption.independent_parties', op: 'gte', threshold: 3 },
    // An accountable human.
    { field: 'accountability.human_beneficiary', op: 'eq', threshold: 1 },
    // Standing — always present, never redactable; asked so the answers are co-signed.
    { field: 'standing.adverse_events_90d', op: 'in', set: [0] },
    { field: 'standing.open_bond_claims_against', op: 'eq', threshold: 0 },
    { field: 'standing.invalidation_active', op: 'eq', threshold: 0 },
  ],
  standing(view: VerifiedView): string[] {
    const reasons: string[] = [];
    if (standingValue(view.standing, 'standing.reputation_slashed') > 0) reasons.push('this presenter’s reputation has been slashed');
    return reasons;
  },
};
