/**
 * THE ILLUSTRATIVE CONTRAST — the same gate, five policies, two presenters.
 *
 *   npm run contrast                       print every report
 *   npm run contrast -- --json <file>      also write the record (docs/illustrative-contrast.json)
 *
 * Illustrative: the presentations are signed by the reference's own TEST issuer key, not by
 * Provian, and the two presenters are fixtures (src/illustrative/presenters.ts). Everything after
 * issuance is the live path: the gate issues and signs a challenge, the token is checked by the same
 * SDK verifier a live gate uses (issuer signature, the presenter's live-key signature, audience,
 * nonce, deadline, predicates answered, Standing present, one-shot acceptance), the gate evaluates
 * its predicates and its Standing rule, and the decision is written as a report. The relay's second
 * opinion is off — the public relay would rightly refuse a token this issuer signed. The one anchor
 * read a disclosed record needs (the sensitive site) is answered by a local stub, not Base.
 *
 * Each presentation is then sent again with the same challenge: the gate refuses it.
 */
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Gate, generateGateKey } from './gate.js';
import { examplePolicies } from './examples/index.js';
import { formatReport } from './report.js';
import { describeDisclosure, describePredicate } from './policy.js';
import { DOMAIN, forgeReputationToken } from './illustrative/forge.js';
import { startAnchorStub } from './illustrative/anchor-stub.js';
import { ILLUSTRATIVE_NOW, establishedPresenter, freshPresenter, illustrativeIssuer, type IllustrativePresenter } from './illustrative/presenters.js';
import type { Decision, GatePolicy } from './types.js';

/** The live reputation-tier burn floor, in PVT (what a real presentation at this tier costs). */
export const REPUTATION_FLOOR_PVT = 15;

export interface ContrastRun {
  readonly presenter: IllustrativePresenter['id'];
  readonly challenge: { readonly nonce: string; readonly issued_at: number; readonly expires_at: number; readonly kid: string; readonly sig: string };
  readonly presentation_id: string;
  /** The burn a presentation stands for. Illustrative: nothing was burned on chain; a live presentation
   *  at the reputation tier burns the tier floor first, and the burn id is the presentation id. */
  readonly burn: { readonly tier: 'reputation'; readonly floor_pvt: number; readonly id: string; readonly onchain: false };
  /** What a key check says: the issuer's signature and the presenter's live-key signature verify. */
  readonly signature_check: 'valid' | 'invalid';
  readonly decision: Decision;
  readonly replay: Decision;
}

/** Fixed per-run clocks make the record reproducible; only the gate's fresh nonces and signatures differ. */

export interface ContrastRecord {
  readonly kind: 'provian-reference-gate.illustrative-contrast.v1';
  readonly illustrative: true;
  readonly note: string;
  readonly at: string;
  readonly gate: string;
  readonly issuer: { readonly kid: string; readonly x: string; readonly note: string };
  readonly presenters: ReadonlyArray<{ readonly id: string; readonly label: string; readonly summary: string; readonly address: string; readonly wallet_id: string }>;
  readonly examples: ReadonlyArray<{
    readonly policy: { readonly slug: string; readonly name: string; readonly action: string; readonly predicates: readonly string[]; readonly disclosures?: readonly string[] };
    readonly runs: readonly ContrastRun[];
  }>;
}

async function runOne(gate: Gate, policy: GatePolicy, who: IllustrativePresenter, issuer: ReturnType<typeof illustrativeIssuer>): Promise<ContrastRun> {
  const challenge = gate.issueChallenge(policy);
  const burnId = crypto.createHash('sha256').update(`illustrative-burn/${policy.slug}/${who.id}`).digest('hex');
  const token = forgeReputationToken({
    issuer, presenter: who.presenter, nowSeconds: ILLUSTRATIVE_NOW, facts: { ...who.facts }, burnId, held: who.held,
    challenge: {
      audience: challenge.audience, challenge: challenge.challenge, expiresAt: challenge.expiresAt as number,
      predicates: challenge.predicates ?? [], disclosures: challenge.disclosures ?? [], requester: { type: 'domain', id: DOMAIN },
    },
  });
  const decision = await gate.decide(policy, token);
  // The same presentation, sent again with its challenge: one-shot acceptance refuses it.
  const replay = await gate.decide(policy, token, { challenge });
  return {
    presenter: who.id,
    challenge: {
      nonce: challenge.challenge, issued_at: challenge.issuedAt as number, expires_at: challenge.expiresAt as number,
      kid: challenge.requester?.kid ?? '', sig: typeof challenge.sig === 'string' ? challenge.sig : '',
    },
    presentation_id: burnId,
    burn: { tier: 'reputation', floor_pvt: REPUTATION_FLOOR_PVT, id: burnId, onchain: false },
    signature_check: decision.verification?.local === 'valid' ? 'valid' : 'invalid',
    decision,
    replay,
  };
}

export async function runContrast(): Promise<ContrastRecord> {
  const issuer = illustrativeIssuer();
  const anchor = await startAnchorStub();
  try {
    const gate = await Gate.create({ domain: DOMAIN, key: generateGateKey('gate-k1'), jwks: issuer.jwks, relayVerify: false, nowSeconds: () => ILLUSTRATIVE_NOW, rpcUrl: anchor.url });
    const presenters = [freshPresenter(), establishedPresenter()];
    const examples: ContrastRecord['examples'][number][] = [];
    for (const policy of Object.values(examplePolicies())) {
      const runs: ContrastRun[] = [];
      for (const who of presenters) runs.push(await runOne(gate, policy, who, issuer));
      examples.push({
        policy: {
          slug: policy.slug, name: policy.name, action: policy.action, predicates: policy.predicates.map(describePredicate),
          ...(policy.disclosures && policy.disclosures.length > 0 ? { disclosures: policy.disclosures.map(describeDisclosure) } : {}),
        },
        runs,
      });
    }
    return assemble(issuer, presenters, examples);
  } finally {
    await anchor.close();
  }
}

function assemble(issuer: ReturnType<typeof illustrativeIssuer>, presenters: IllustrativePresenter[], examples: ContrastRecord['examples'][number][]): ContrastRecord {
  return {
    kind: 'provian-reference-gate.illustrative-contrast.v1',
    illustrative: true,
    note: 'Illustrative. Presentations signed by the reference’s own test issuer key, not by Provian; presenters are fixtures. Every decision went through the same SDK verifier a live gate uses; the relay’s second opinion was off, and the one anchor read a disclosed record needs was answered by a local stub, not Base.',
    at: new Date(ILLUSTRATIVE_NOW * 1000).toISOString(),
    gate: DOMAIN,
    issuer: { kid: issuer.kid, x: issuer.jwks[0]?.x ?? '', note: 'TEST key derived from a public label — not Provian’s.' },
    presenters: presenters.map((p) => ({ id: p.id, label: p.label, summary: p.summary, address: p.presenter.address, wallet_id: p.presenter.walletId })),
    examples,
  };
}

async function main(): Promise<void> {
  const record = await runContrast();
  const out: string[] = [];
  out.push('ILLUSTRATIVE — presentations signed by the reference’s test issuer, presenters are fixtures; the verifier and the gate are the live ones.');
  for (const ex of record.examples) {
    out.push('', '='.repeat(96), `${ex.policy.name} — ${ex.policy.action}`, `asks: ${ex.policy.predicates.join(' · ')}`);
    if (ex.policy.disclosures) out.push(`names: ${ex.policy.disclosures.join(' · ')}`);
    for (const run of ex.runs) {
      const who = record.presenters.find((p) => p.id === run.presenter);
      out.push('', `── ${who?.label ?? run.presenter} (${who?.address ?? ''})`, `signature check: ${run.signature_check}`, '', formatReport(run.decision.report));
      out.push('', `replay: ${run.replay.report.decision} — ${run.replay.report.reason}`);
    }
  }
  console.log(out.join('\n'));
  const i = process.argv.indexOf('--json');
  const file = i >= 0 ? process.argv[i + 1] : undefined;
  if (file) writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
