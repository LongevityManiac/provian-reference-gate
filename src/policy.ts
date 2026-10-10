/**
 * Predicate evaluation and the standing read — the gate's half of the decision.
 *
 * The relay computed each predicate against the presenter's live record and Provian co-signed the
 * result; the gate's job is to check that EVERY predicate it asked came back, that each came back
 * `true`, and to apply its own rule over Standing. Nothing here calls the network.
 */
import { disclosureRequestMatches, type CanonicalDisclosureRequest } from '@provian/agent-sdk';
import type { AdverseStanding, AnsweredPredicate, Predicate, VerifiedView } from './types.js';

/** `work.witnessed_90d gte 25` / `standing.adverse_events in {0}` — the predicate, readably. */
export function describePredicate(p: Predicate): string {
  if (p.op === 'in') return `${p.field} in {${[...(p.set ?? [])].sort((a, b) => a - b).join(', ')}}`;
  return `${p.field} ${p.op} ${p.threshold}`;
}

/** Canonical form: an `in` carries its sorted, de-duplicated set; every other op its threshold.
 *  Mirrors the relay's `canonicalPredicate`, so two predicates compare the way the relay compares them. */
export function canonicalPredicate(p: Predicate): string {
  if (p.op === 'in') {
    const set = [...new Set((p.set ?? []).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
    return JSON.stringify({ field: p.field, op: 'in', set });
  }
  return JSON.stringify({ field: p.field, op: p.op, threshold: p.threshold });
}

/** Two predicates are the same request when their canonical forms are byte-identical. */
export function samePredicate(a: Predicate, b: Predicate): boolean {
  return canonicalPredicate(a) === canonicalPredicate(b);
}

/** True when `asked` and `answered` name exactly the same predicate set (order-free). */
export function samePredicateSet(asked: readonly Predicate[], other: readonly Predicate[]): boolean {
  const a = asked.map(canonicalPredicate).sort();
  const b = other.map(canonicalPredicate).sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Every predicate the gate asked must be present in the answer with `result: true`. Returns the
 * objections; an empty list means the presenter answered yes to everything asked.
 *
 * The relay refuses a presentation that leaves an asked predicate unanswered, and both verifiers
 * refuse it again — so a missing answer here means a verifier was bypassed. It is still a block.
 */
export function evaluatePredicates(asked: readonly Predicate[], answered: readonly AnsweredPredicate[]): string[] {
  const reasons: string[] = [];
  for (const p of asked) {
    const hit = answered.find((a) => samePredicate(a, p));
    if (!hit) reasons.push(`not answered: ${describePredicate(p)}`);
    else if (hit.result !== true) reasons.push(`false: ${describePredicate(p)}`);
  }
  return reasons;
}

/** `pe <digest> under <issuer> [+ fields] [+ content]` / `witness issuer=<root> ×10` — a disclosure request, readably. */
export function describeDisclosure(r: CanonicalDisclosureRequest): string {
  const extras = [
    ...(r.fields && r.fields.length > 0 ? [`fields ${r.fields.join(',')}`] : []),
    ...(r.content && r.content.length > 0 ? [`content ${r.content.join(',')}`] : []),
  ];
  const tail = extras.length > 0 ? ` + ${extras.join(' + ')}` : '';
  if (r.kind === 'pe') return `pe ${r.output_digest.slice(0, 16)}…${r.issuer ? ` under ${r.issuer.slice(0, 16)}…` : ''}${tail}`;
  const by = r.issuer !== undefined ? `issuer=${r.issuer.slice(0, 16)}…` : r.signer !== undefined ? `signer=${r.signer.slice(0, 16)}…` : 'any witness';
  return `witness ${by} ×${r.limit}${tail}`;
}

/** True when `asked` and `other` name exactly the same disclosure requests (order-free). */
export function sameDisclosureSet(asked: readonly CanonicalDisclosureRequest[], other: readonly CanonicalDisclosureRequest[]): boolean {
  if (asked.length !== other.length) return false;
  return asked.every((a) => other.some((b) => disclosureRequestMatches(a, b)));
}

/** The value of a standing fact; a verifier already refused a payload missing any required one, so
 *  an absent per-type key is an observed zero (the relay writes every type for every actor). */
export function standingValue(standing: Readonly<Record<string, number>>, field: string): number {
  const v = standing[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Adverse standing as the decision shows it. Every number is co-signed; none can be redacted. */
export function adverseStandingOf(standing: Readonly<Record<string, number>>): AdverseStanding {
  const byType: Record<string, number> = {};
  const headline = new Set([
    'standing.adverse_events', 'standing.adverse_events_30d', 'standing.adverse_events_90d', 'standing.adverse_events_365d',
    'standing.bond_active', 'standing.open_bond_claims_against', 'standing.invalidation_active',
  ]);
  for (const [k, v] of Object.entries(standing)) {
    if (k.startsWith('standing.') && !headline.has(k) && typeof v === 'number' && v !== 0) byType[k] = v;
  }
  return {
    adverse_events: standingValue(standing, 'standing.adverse_events'),
    adverse_events_30d: standingValue(standing, 'standing.adverse_events_30d'),
    adverse_events_90d: standingValue(standing, 'standing.adverse_events_90d'),
    adverse_events_365d: standingValue(standing, 'standing.adverse_events_365d'),
    bond_active: standingValue(standing, 'standing.bond_active') !== 0,
    open_bond_claims_against: standingValue(standing, 'standing.open_bond_claims_against'),
    invalidation_active: standingValue(standing, 'standing.invalidation_active') !== 0,
    by_type: byType,
  };
}

/** One sentence per adverse fact that is set — what a policy's `standing()` typically reads. */
export function adverseSentences(view: VerifiedView): string[] {
  const s = adverseStandingOf(view.standing);
  const out: string[] = [];
  if (s.invalidation_active) out.push('an invalidation is active against this presenter');
  if (s.open_bond_claims_against > 0) out.push(`${s.open_bond_claims_against} bond claim(s) are open against this presenter`);
  for (const [k, v] of Object.entries(s.by_type)) out.push(`${k} = ${v}`);
  return out;
}
