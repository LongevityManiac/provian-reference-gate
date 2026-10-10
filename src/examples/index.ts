/**
 * The five worked examples. Each is a complete decision over a real presentation: the predicates
 * it asks (frozen grammar), the disclosures it names (the sensitive site), the rule it applies to
 * the answers, and the adverse standing it shows. The first asks only the general questions every
 * door asks of a stranger; the other four add what one sector needs. None of them is a
 * recommendation — Provian defines no policy. Replace them with your own.
 */
import type { GatePolicy } from '../types.js';
import { counterpartyOnboarding } from './counterparty-onboarding.js';
import { paymentRail } from './payment-rail.js';
import { repositoryMerge } from './repository-merge.js';
import { missionCriticalAction, ILLUSTRATIVE_ATTESTATION, type AttestationFacts } from './mission-critical-action.js';
import { sensitiveSite, credentialRequest, credentialObjection, ILLUSTRATIVE_CREDENTIAL, type NamedCredential } from './sensitive-site.js';

export {
  counterpartyOnboarding, paymentRail, repositoryMerge,
  missionCriticalAction, ILLUSTRATIVE_ATTESTATION, type AttestationFacts,
  sensitiveSite, credentialRequest, credentialObjection, ILLUSTRATIVE_CREDENTIAL, type NamedCredential,
};

export interface ExampleConfig {
  /** The attestation facts the mission-critical example requires of every act (default: the illustrative fleet). */
  readonly attestation?: AttestationFacts;
  /** The credential the sensitive-site example names (default: the illustrative credential). */
  readonly credential?: NamedCredential;
}

/** The example policies by slug, in the order the README presents them. */
export function examplePolicies(config: ExampleConfig = {}): Record<string, GatePolicy> {
  const mission = missionCriticalAction(config.attestation ?? ILLUSTRATIVE_ATTESTATION);
  const site = sensitiveSite(config.credential ?? ILLUSTRATIVE_CREDENTIAL);
  return {
    [counterpartyOnboarding.slug]: counterpartyOnboarding,
    [paymentRail.slug]: paymentRail,
    [repositoryMerge.slug]: repositoryMerge,
    [mission.slug]: mission,
    [site.slug]: site,
  };
}
