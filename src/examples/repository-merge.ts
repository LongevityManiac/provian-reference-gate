/**
 * WORKED EXAMPLE 3 — a repository merge gate.
 *
 * A code forge is about to merge a pull request an agent authored. Before it does, it asks the
 * agent to present. It wants a record of commits the forge itself witnessed (not the agent's own
 * say-so), steady recent work, sources cited from independent owners, a human accountable behind
 * the agent, and nothing adverse — ever — against it.
 *
 * The forge-witnessed commit count is `work.compute.forge_witnessed`: PEs in the `compute` family
 * (the forge webhook's `service:github_commit` and its siblings) under the `forge_witnessed`
 * class. An agent whose commits no forge ever witnessed reads 0 there and is blocked.
 */
import type { GatePolicy, VerifiedView } from '../types.js';
import { standingValue } from '../policy.js';

export const repositoryMerge: GatePolicy = {
  slug: 'repository-merge',
  name: 'Repository merge gate',
  action: 'Merge a pull request authored by an agent',
  description:
    'Merge only when the forge has witnessed this author’s commits, it has worked steadily of late, it cites independent sources, a person is accountable for it, and nothing adverse has ever stood against it.',
  predicates: [
    // Commits a code forge witnessed through its own webhook — never the agent's declaration.
    { field: 'work.compute.forge_witnessed', op: 'gte', threshold: 10 },
    // Steady recent work, witnessed by something other than the agent.
    { field: 'work.witnessed_90d', op: 'gte', threshold: 25 },
    { field: 'continuity.active_days_90d', op: 'gte', threshold: 10 },
    // It builds on sources owned by someone other than itself.
    { field: 'coupling.independent_owners', op: 'gte', threshold: 1 },
    // A human is accountable: the agent has a linked beneficiary.
    { field: 'accountability.human_beneficiary', op: 'eq', threshold: 1 },
    // Standing — always present; asked so the answers are co-signed.
    { field: 'standing.adverse_events', op: 'in', set: [0] },
    { field: 'standing.invalidation_active', op: 'eq', threshold: 0 },
  ],
  standing(view: VerifiedView): string[] {
    const reasons: string[] = [];
    if (standingValue(view.standing, 'standing.challenges_upheld_against') > 0) reasons.push('a Commons challenge was upheld against this presenter');
    if (standingValue(view.standing, 'standing.reputation_slashed') > 0) reasons.push('this presenter’s reputation has been slashed');
    return reasons;
  },
};
