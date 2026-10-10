/**
 * provian-reference-gate — the library a gate embeds.
 *
 *   import { Gate, generateGateKey, paymentRail } from 'provian-reference-gate';
 *   const gate = await Gate.create({ domain: 'gate.example.com', key });
 *   const challenge = gate.issueChallenge(paymentRail);      // hand JSON.stringify(challenge) to the presenter
 *   const decision = await gate.decide(paymentRail, token);  // 'allow' | 'block', with reasons, standing and a report
 *
 * Serve gate.wellKnownDocument() at https://gate.example.com/.well-known/provian-requester.json.
 */
export { Gate, generateGateKey, DEFAULT_RELAY_URL, type GateOptions } from './gate.js';
export {
  describePredicate, canonicalPredicate, samePredicate, samePredicateSet, evaluatePredicates,
  describeDisclosure, sameDisclosureSet,
  adverseStandingOf, adverseSentences, standingValue,
} from './policy.js';
export {
  counterpartyOnboarding, paymentRail, repositoryMerge, missionCriticalAction, sensitiveSite, examplePolicies,
  credentialRequest, credentialObjection, ILLUSTRATIVE_ATTESTATION, ILLUSTRATIVE_CREDENTIAL,
  type ExampleConfig, type AttestationFacts, type NamedCredential,
} from './examples/index.js';
export { exampleConfigFromEnv } from './config.js';
export { buildReport, formatReport, REPORT_HEADINGS, type GateReport, type ReportSection, type ReportLine, type ReportHeading } from './report.js';
export type {
  Predicate, PredicateOp, AnsweredPredicate, GateKey, GatePolicy, VerifiedView, Decision, AdverseStanding, VerificationRecord,
} from './types.js';
