/**
 * THE REPORT — every decision the gate renders, read as sentences.
 *
 * A signature check answers one question: does the presenter hold the key? The gate answers the
 * questions a counterparty actually asks, from the presenter's record, under six headings in a fixed
 * order:
 *
 *   Identity · Accountable human · Witnessed history · Standing · Counterparties · Money witnessed
 *
 * then the decision and its reason. Each line is a sentence over one vocabulary fact, from one of
 * three sources, and the report says which:
 *
 *   answer     a predicate the gate asked; the relay computed it and Provian co-signed the boolean.
 *              The raw number is withheld — the gate learns "at least 25", never "9,412".
 *   disclosed  a fact the presenter disclosed raw (reveal-all-minus-redactions is the default).
 *   standing   always present; the presenter can neither redact nor withhold it.
 *
 * A record the challenge NAMED (2026-10-10) reads under Witnessed history as the presenter answered
 * it — disclosed, with what the record carries, or declined, or nothing held — from the answers the
 * verifier checked against each record's anchored act.
 *
 * A fact neither asked nor disclosed reads "withheld by the presenter". A field the vocabulary
 * keeps predicate-only (witnessed payment volume) is never disclosed raw, so it appears only when a
 * gate asks it. Nothing here calls the network; nothing here decides — the decision is the gate's,
 * made before the report is written.
 */
import type { DisclosureAnswer } from '@provian/agent-sdk';
import { describeDisclosure, describePredicate, samePredicate, standingValue } from './policy.js';
import type { AnsweredPredicate, Predicate, VerifiedView } from './types.js';

export const REPORT_HEADINGS = [
  'Identity',
  'Accountable human',
  'Witnessed history',
  'Standing',
  'Counterparties',
  'Money witnessed',
] as const;
export type ReportHeading = (typeof REPORT_HEADINGS)[number];

export interface ReportLine {
  readonly text: string;
  /** The vocabulary field(s) the sentence reads. Empty when nothing could be read. */
  readonly fields: readonly string[];
  readonly source: 'answer' | 'disclosed' | 'standing' | 'withheld' | 'unverified';
}

export interface ReportSection {
  readonly heading: ReportHeading;
  readonly lines: readonly ReportLine[];
}

export interface GateReport {
  readonly sections: readonly ReportSection[];
  readonly decision: 'ALLOW' | 'BLOCK';
  /** Why, one sentence per objection (or the one sentence for an allow). */
  readonly reasons: readonly string[];
  /** The same, as one paragraph. */
  readonly reason: string;
}

// ── how one fact reads ───────────────────────────────────────────────────────

/** A countable fact: "640 inbound payments the chain witnessed". */
interface CountText {
  readonly kind: 'count';
  readonly one: string;
  readonly many: string;
  /** The whole sentence for zero, when "0 …" would read badly. */
  readonly none?: string;
}
/** A 0/1 fact. */
interface FlagText {
  readonly kind: 'flag';
  readonly yes: string;
  readonly no: string;
}
/** A share in basis points of the presenter's work. */
interface ShareText {
  readonly kind: 'share';
  /** "of its work in the last 90 days is hardware-rooted" */
  readonly of: string;
}
type FactText = CountText | FlagText | ShareText;

const TEXT: Readonly<Record<string, FactText>> = {
  'continuity.active_days': { kind: 'count', one: 'distinct day active under witness', many: 'distinct days active under witness', none: 'Not one day active under witness.' },
  'continuity.active_days_90d': { kind: 'count', one: 'active day in the last 90', many: 'active days in the last 90', none: 'No active day in the last 90.' },
  'continuity.registered_devices': { kind: 'count', one: 'registered device', many: 'registered devices', none: 'No registered device.' },
  'continuity.chain_depth': { kind: 'count', one: 'act in its hash chain', many: 'acts in its hash chain', none: 'An empty hash chain: no act has ever been recorded.' },
  'accountability.human_beneficiary': { kind: 'flag', yes: 'A person is linked to this agent and answers for it.', no: 'No person is linked to this agent or answers for it.' },
  'accountability.supervised_turns': { kind: 'count', one: 'turn a person directed', many: 'turns a person directed', none: 'No turn a person directed.' },
  'work.witnessed_90d': { kind: 'count', one: 'act in the last 90 days witnessed by something other than the actor', many: 'acts in the last 90 days witnessed by something other than the actor', none: 'No act in the last 90 days witnessed by anything other than the actor.' },
  'work.compute.forge_witnessed': { kind: 'count', one: 'commit a code forge witnessed', many: 'commits a code forge witnessed', none: 'No commit a code forge witnessed.' },
  'work.hardware_rooted_90d': { kind: 'count', one: 'hardware-rooted act in the last 90 days', many: 'hardware-rooted acts in the last 90 days', none: 'No hardware-rooted act in the last 90 days.' },
  'consumption.independent_parties': { kind: 'count', one: 'independent party built on its output', many: 'independent parties built on its output', none: 'No independent party has built on its output.' },
  'coupling.independent_owners': { kind: 'count', one: 'owner other than itself whose work it cites', many: 'owners other than itself whose work it cites', none: 'It cites no one’s work but its own.' },
  'money.witnessed_inbound': { kind: 'count', one: 'inbound payment the chain witnessed', many: 'inbound payments the chain witnessed', none: 'No inbound payment the chain witnessed.' },
  'money.witnessed_inbound_90d': { kind: 'count', one: 'inbound payment the chain witnessed in the last 90 days', many: 'inbound payments the chain witnessed in the last 90 days', none: 'No inbound payment the chain witnessed in the last 90 days.' },
  'money.independent_payers_90d': { kind: 'count', one: 'independent party paid it in the last 90 days', many: 'independent parties paid it in the last 90 days', none: 'No independent party paid it in the last 90 days.' },
  'share.witness_90d.hardware_rooted': { kind: 'share', of: 'of its work in the last 90 days is hardware-rooted' },
  'money.witnessed_financial_90d': { kind: 'count', one: 'financial act the chain witnessed in the last 90 days', many: 'financial acts the chain witnessed in the last 90 days', none: 'No financial act the chain witnessed in the last 90 days.' },
  'money.witnessed_payment_volume_usd_365d': { kind: 'count', one: 'USD of witnessed payment volume in the last 365 days', many: 'USD of witnessed payment volume in the last 365 days', none: 'No witnessed payment volume in the last 365 days.' },
  'money.promises_fulfilled': { kind: 'count', one: 'promise fulfilled', many: 'promises fulfilled', none: 'No promise fulfilled.' },
  'money.promises_defaulted': { kind: 'count', one: 'promise defaulted', many: 'promises defaulted', none: 'No promise defaulted.' },
  'money.escrows_completed_as_provider': { kind: 'count', one: 'escrow completed as the provider', many: 'escrows completed as the provider', none: 'No escrow completed as the provider.' },
};

/** The facts each heading reads, in order. Standing is composed from the always-present facts. */
const SECTION_FIELDS: Readonly<Record<Exclude<ReportHeading, 'Standing'>, readonly string[]>> = {
  'Identity': ['continuity.first_seen_ms', 'continuity.active_days', 'continuity.active_days_90d', 'continuity.registered_devices', 'continuity.chain_depth'],
  'Accountable human': ['accountability.human_beneficiary', 'accountability.supervised_turns'],
  'Witnessed history': ['work.witnessed_90d', 'work.compute.forge_witnessed', 'work.hardware_rooted_90d', 'share.witness_90d.hardware_rooted'],
  'Counterparties': ['consumption.independent_parties', 'coupling.independent_owners', 'money.independent_payers_90d'],
  'Money witnessed': ['money.witnessed_inbound', 'money.witnessed_inbound_90d', 'money.witnessed_financial_90d', 'money.witnessed_payment_volume_usd_365d', 'money.promises_fulfilled', 'money.promises_defaulted', 'money.escrows_completed_as_provider'],
};

/** Fields the vocabulary never discloses raw (they exist only as predicate answers). */
const PREDICATE_ONLY = /^money\.witnessed_payment_volume_usd(_\d+d)?$/;

const fmt = (n: number): string => n.toLocaleString('en-US');
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function countSentence(t: CountText, quantity: string, n: number | null): string {
  if (n === 0 && t.none) return t.none;
  return `${capital(quantity)} ${n === 1 ? t.one : t.many}.`;
}

/** A raw disclosed value, read as a sentence. */
function rawSentence(field: string, t: FactText, n: number): string {
  switch (t.kind) {
    case 'count': return countSentence(t, fmt(n), n);
    case 'flag': return n !== 0 ? t.yes : t.no;
    case 'share': return `${capital(`${fmt(Math.round(n) / 100)}%`)} ${t.of}.`;
  }
  return `${field} = ${n}`;
}

/** A co-signed predicate answer, read as a sentence. The sentence states what is true. */
function answerSentence(t: FactText, p: AnsweredPredicate): string {
  const yes = p.result;
  const th = p.threshold ?? 0;
  if (t.kind === 'flag') {
    const holds = p.op === 'eq' ? (th !== 0) === yes : p.op === 'in' ? (p.set ?? []).includes(1) === yes : yes;
    return holds ? t.yes : t.no;
  }
  if (t.kind === 'share') {
    const pct = `${fmt(th / 100)}%`;
    const q = p.op === 'gte' ? (yes ? `at least ${pct}` : `less than ${pct}`)
      : p.op === 'gt' ? (yes ? `more than ${pct}` : `at most ${pct}`)
      : p.op === 'lte' ? (yes ? `at most ${pct}` : `more than ${pct}`)
      : p.op === 'lt' ? (yes ? `less than ${pct}` : `at least ${pct}`)
      : (yes ? `exactly ${pct}` : `not ${pct}`);
    return `${capital(q)} ${t.of}.`;
  }
  // A count. `eq 0` and `in {0}` read as "none" / "at least one".
  const zeroOnly = (p.op === 'eq' && th === 0) || (p.op === 'in' && (p.set ?? []).length === 1 && (p.set ?? [])[0] === 0);
  if (zeroOnly) return yes ? (t.none ?? `No ${t.one}.`) : countSentence(t, 'at least one', 1);
  switch (p.op) {
    case 'gte':
      if (!yes && th <= 1) return countSentence(t, '0', 0); // "fewer than 1" is none
      return yes ? countSentence(t, `at least ${fmt(th)}`, th) : countSentence(t, `fewer than ${fmt(th)}`, 2);
    case 'gt':
      if (!yes && th <= 0) return countSentence(t, '0', 0);
      return yes ? countSentence(t, `more than ${fmt(th)}`, 2) : countSentence(t, `at most ${fmt(th)}`, th);
    case 'lte': return yes ? countSentence(t, `at most ${fmt(th)}`, th) : countSentence(t, `more than ${fmt(th)}`, 2);
    case 'lt': return yes ? countSentence(t, `fewer than ${fmt(th)}`, 2) : countSentence(t, `at least ${fmt(th)}`, th);
    case 'eq': return yes ? countSentence(t, `exactly ${fmt(th)}`, th) : countSentence(t, `not exactly ${fmt(th)}`, 2);
    case 'in': return yes ? `${capital(t.many)}: one of {${(p.set ?? []).join(', ')}}.` : `${capital(t.many)}: none of {${(p.set ?? []).join(', ')}}.`;
  }
  return describePredicate(p);
}

function firstSeenSentence(ms: number, nowMs: number): string {
  if (ms <= 0) return 'No witnessed act on record: nothing stands behind this key.';
  const days = Math.max(0, Math.floor((nowMs - ms) / 86_400_000));
  const date = new Date(ms).toISOString().slice(0, 10);
  return `First witnessed ${date}, ${fmt(days)} ${days === 1 ? 'day' : 'days'} before this presentation.`;
}

/** An attestation-fact share the gate asked (`share.issuer_90d.<root>` …), read as its answer. */
function attestationShareLine(p: AnsweredPredicate): ReportLine | null {
  const m = /^share\.(issuer|measurement|region)(?:_(\d+)d)?\.(.+)$/.exec(p.field);
  if (!m) return null;
  const what = m[1] === 'issuer' ? `attested under issuer root ${(m[3] ?? '').slice(0, 16)}…`
    : m[1] === 'measurement' ? `attested under launch measurement ${(m[3] ?? '').slice(0, 23)}…`
    : `attested in region ${m[3]}`;
  const window = m[2] ? ` in the last ${m[2]} days` : '';
  const t: ShareText = { kind: 'share', of: `of its work${window} ran on hardware ${what}` };
  return { text: answerSentence(t, p), fields: [p.field], source: 'answer' };
}

/** The named disclosures, as the presenter answered them (verified against each record's anchored act). */
function disclosureLines(answers: readonly DisclosureAnswer[]): ReportLine[] {
  const out: ReportLine[] = [];
  for (const a of answers) {
    const named = describeDisclosure(a.request);
    if (a.election === 'declined') { out.push({ text: `Declined to disclose the named record (${named}).`, fields: [], source: 'disclosed' }); continue; }
    const records = a.records ?? [];
    if (records.length === 0) { out.push({ text: `Holds no record answering the named request (${named}).`, fields: [], source: 'disclosed' }); continue; }
    for (const r of records) {
      const date = new Date(r.timestamp).toISOString().slice(0, 10);
      const w = r.witness;
      const by = w.kind === 'hardware' ? `witnessed in hardware${w.scheme ? ` (${w.scheme})` : ''}${w.issuer ? ` under issuer root ${w.issuer.slice(0, 16)}…` : ''}${w.region ? `, in ${w.region}` : ''}`
        : w.kind === 'chain' ? `witnessed on chain${w.ref ? ` (${w.ref.slice(0, 18)}…)` : ''}`
        : `witnessed by its device${w.signer ? ` ${w.signer.slice(0, 16)}…` : ''}`;
      const digest = r.output_digest ? `, carrying ${r.output_digest.slice(0, 16)}…` : '';
      const desc = typeof r.content?.description === 'string' && r.content.description.length > 0 ? ` Described as: “${r.content.description}”.` : '';
      const artifacts = Array.isArray(r.content?.artifacts) ? ` ${r.content.artifacts.length} artifact${r.content.artifacts.length === 1 ? '' : 's'} disclosed.` : '';
      const fields = r.fields ? ` Fields: ${Object.entries(r.fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}.` : '';
      out.push({ text: `Disclosed: ${r.action_type} on ${date}, ${by}${digest}.${desc}${artifacts}${fields}`, fields: [], source: 'disclosed' });
    }
  }
  return out;
}

function lineFor(field: string, view: VerifiedView, nowMs: number): ReportLine | null {
  const answered = view.predicates.filter((p) => p.field === field);
  const t = TEXT[field];
  if (answered.length > 0 && t) {
    return { text: answered.map((p) => answerSentence(t, p)).join(' '), fields: [field], source: 'answer' };
  }
  const raw = view.disclosed[field];
  if (typeof raw === 'number' && Number.isFinite(raw) && !PREDICATE_ONLY.test(field)) {
    if (field === 'continuity.first_seen_ms') return { text: firstSeenSentence(raw, nowMs), fields: [field], source: 'disclosed' };
    if (t) return { text: rawSentence(field, t, raw), fields: [field], source: 'disclosed' };
  }
  if (PREDICATE_ONLY.test(field)) return null; // never disclosed; shown only when asked
  return null;
}

const STANDING_TYPE_TEXT: Readonly<Record<string, string>> = {
  'standing.bond_slashed': 'a bond it posted was slashed',
  'standing.bond_abandoned': 'a bond it posted was abandoned and burned',
  'standing.bond_expired': 'a bond it posted expired',
  'standing.bond_autonomy_downgraded': 'its bond autonomy was downgraded',
  'standing.claims_dismissed_as_claimant': 'a bond claim it filed was dismissed',
  'standing.court_verdicts_against': 'a Court verdict went against it',
  'standing.arbitrator_seats_forfeited': 'it forfeited an arbitrator seat',
  'standing.arbitrator_collateral_slashed': 'its arbitrator collateral was slashed',
  'standing.promises_defaulted': 'it defaulted on a promise',
  'standing.reputation_slashed': 'its reputation was slashed',
  'standing.hire_disputes_lost': 'it lost a hire dispute',
  'standing.challenges_upheld_against': 'a Commons challenge was upheld against it',
};

const HEADLINE_STANDING = new Set([
  'standing.adverse_events', 'standing.adverse_events_30d', 'standing.adverse_events_90d', 'standing.adverse_events_365d',
  'standing.bond_active', 'standing.open_bond_claims_against', 'standing.invalidation_active',
]);

function standingLines(view: VerifiedView): ReportLine[] {
  const s = view.standing;
  const total = standingValue(s, 'standing.adverse_events');
  const d90 = standingValue(s, 'standing.adverse_events_90d');
  const d365 = standingValue(s, 'standing.adverse_events_365d');
  const lines: ReportLine[] = [];
  if (total === 0) {
    lines.push({ text: 'No adverse event on record.', fields: ['standing.adverse_events'], source: 'standing' });
  } else {
    const what = Object.entries(s)
      .filter(([k, v]) => k.startsWith('standing.') && !HEADLINE_STANDING.has(k) && typeof v === 'number' && v > 0)
      .map(([k, v]) => `${STANDING_TYPE_TEXT[k] ?? k}${v > 1 ? ` (${fmt(v)} times)` : ''}`);
    const when = d90 > 0 ? `${fmt(d90)} in the last 90 days` : d365 > 0 ? 'none in the last 90 days, within the last year' : 'none in the last year';
    const count = total === 1 ? 'One adverse event on record' : `${fmt(total)} adverse events on record`;
    lines.push({
      text: `${count}${what.length > 0 ? `: ${what.join('; ')}` : ''} — ${when}. It stays in every presentation this actor makes.`,
      fields: ['standing.adverse_events', 'standing.adverse_events_90d', 'standing.adverse_events_365d'],
      source: 'standing',
    });
  }
  const claims = standingValue(s, 'standing.open_bond_claims_against');
  const invalid = standingValue(s, 'standing.invalidation_active') !== 0;
  lines.push({
    text: `${claims === 0 ? 'No open bond claim' : `${fmt(claims)} open bond ${claims === 1 ? 'claim' : 'claims'}`} against it; ${invalid ? 'an invalidation is active' : 'no active invalidation'}.`,
    fields: ['standing.open_bond_claims_against', 'standing.invalidation_active'],
    source: 'standing',
  });
  return lines;
}

/** Why a Standing predicate failed, as a sentence. */
function standingFailure(p: Predicate): string {
  const w = /_(\d+)d$/.exec(p.field);
  if (p.field.startsWith('standing.adverse_events')) {
    return w ? `An adverse event is on record in the last ${w[1]} days, and this gate admits none in that window`
      : 'An adverse event is on record, and this gate admits none at any time';
  }
  if (p.field === 'standing.open_bond_claims_against') return 'A bond claim is open against it';
  if (p.field === 'standing.invalidation_active') return 'An invalidation is active against it';
  return `Standing does not meet ${describePredicate(p)}`;
}

/** Turn a gate reason ("false: work.witnessed_90d gte 25") into the sentence it stands for. */
function reasonSentence(reason: string, view: VerifiedView | null, predicates: readonly Predicate[]): string {
  const m = /^(false|not answered): (.+)$/.exec(reason);
  if (m && view) {
    const p = predicates.find((q) => describePredicate(q) === m[2]);
    const answered = p ? view.predicates.find((a) => samePredicate(a, p)) : undefined;
    const t = p ? TEXT[p.field] : undefined;
    if (answered && t) return `${answerSentence(t, answered).replace(/\.$/, '')} (asked: ${m[2]})`;
    if (p && p.field.startsWith('standing.') && m[1] === 'false') return `${standingFailure(p)} (asked: ${m[2]})`;
    const share = answered ? attestationShareLine(answered) : null;
    if (share) return `${share.text.replace(/\.$/, '')} (asked: ${m[2]})`;
    return `${m[1] === 'false' ? 'Answered no' : 'Not answered'}: ${m[2]}`;
  }
  if (reason === 'local verify: replayed') return 'Refused: this presentation was already accepted here once';
  if (reason.startsWith('challenge: not one this gate issued')) return 'Refused: the challenge it answers was already answered, has expired, or is not this gate’s';
  return capital(reason.replace(/^this presenter’s /, 'the presenter’s '));
}

/** Write the report for a decision already made. */
export function buildReport(input: {
  readonly policy: { readonly predicates: readonly Predicate[] };
  readonly view: VerifiedView | null;
  readonly decision: 'allow' | 'block';
  readonly reasons: readonly string[];
  readonly nowSeconds: number;
}): GateReport {
  const { view, decision, reasons, policy } = input;
  const nowMs = input.nowSeconds * 1000;
  const sections: ReportSection[] = REPORT_HEADINGS.map((heading) => {
    if (!view) {
      return { heading, lines: [{ text: 'Not read: the presentation did not verify, so nothing in it is evidence.', fields: [], source: 'unverified' as const }] };
    }
    if (heading === 'Standing') return { heading, lines: standingLines(view) };
    const fields = SECTION_FIELDS[heading];
    const lines = fields.map((f) => lineFor(f, view, nowMs)).filter((l): l is ReportLine => l !== null);
    if (heading === 'Witnessed history') {
      // The attestation facts a gate asked of every act, and the records a challenge named.
      for (const p of view.predicates) { const l = attestationShareLine(p); if (l) lines.push(l); }
      lines.push(...disclosureLines(view.disclosures));
    }
    if (lines.length === 0) {
      lines.push({ text: 'Withheld by the presenter: this gate did not ask, and the presenter did not disclose it.', fields: [...fields], source: 'withheld' });
    }
    return { heading, lines };
  });
  const why = decision === 'allow'
    ? ['Every question this gate asked was answered yes, and nothing in Standing objects.']
    : reasons.map((r) => `${reasonSentence(r, view, policy.predicates)}.`);
  return { sections, decision: decision === 'allow' ? 'ALLOW' : 'BLOCK', reasons: why, reason: why.join(' ') };
}

/** The report as plain text: the six headings, then the decision and its reason. */
export function formatReport(report: GateReport): string {
  const out: string[] = [];
  for (const s of report.sections) {
    out.push(s.heading);
    for (const l of s.lines) out.push(`  ${l.text}`);
  }
  out.push('');
  out.push(report.decision);
  for (const r of report.reasons) out.push(`  ${r}`);
  return out.join('\n');
}
