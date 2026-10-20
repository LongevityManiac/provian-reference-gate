# provian-reference-gate

The reference gate for [Provian](https://provian.ai) presentations. A gate is any system that has
to decide what to do with an instruction from an agent, or a person, it has never met: a payment
rail about to settle, a code forge about to merge, a controller about to run a privileged job. The
gate makes the actor **present its record first**, verifies the presentation itself, applies its
own predicates, and decides. Reading the record costs the gate nothing: no Provian account, no key
from Provian, no fee.

Burn-to-present is Provian's foundational burn, and gates like this one are where most of it
happens. A gate does not register with Provian. Provian proves the presentation is real: burned,
signed, bound to this gate's challenge, not reused. What the gate grants on it is the gate's own
policy. An agent does not burn on every transaction: one presentation opens the
relationship, and the gate decides how long it trusts it and when it asks again.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/gate-handshake-dark.svg">
    <img src="docs/gate-handshake-light.svg" width="560" alt="The reference-gate handshake, animated and illustrative: two agents arrive at the same gate; each receives a challenge signed from the gate&#39;s own domain; both burn to present; both keys are valid and both presentations verify, which is where a key check stops; the gate&#39;s report blocks the fresh key and admits the established agent; a replay from either is refused.">
  </picture>
</p>

<p align="center"><sub><b>Illustrative.</b> The counterparty-onboarding example, run on the two fixture presenters in this repo (<code>npm run contrast</code>). Both presentations are signed by the reference's own test issuer key, not by Provian, and checked by the same verifier a live gate uses.</sub></p>

This repository is one standalone service and one library, both walking the complete path:

1. **Identity** — the gate's Ed25519 key, published at `https://<your-domain>/.well-known/provian-requester.json`.
2. **Challenge** — a signed `provian-challenge-v1` envelope naming the gate's questions (predicates).
3. **Present** — the presenter burns PVT and the relay hands it a co-signed token; the presenter returns it.
4. **Verify** — the stateless relay verify and a local verify against Provian's published keys (and Base, for a PE fact), both required; each presentation accepted **once**.
5. **Decide** — every predicate true, the gate's own rule over Standing (always present, never redactable), the addressed presenter. Unknown or failed is **blocked**, not warned. Every decision is written as a **report**.

Everything is in [`src/gate.ts`](src/gate.ts), written to be read as a protocol walkthrough: the
challenge shape, the verify call, the key check and the predicate evaluation are visible in the
code, so a shop in any language can port it. Provian defines no policy vocabulary; the five
worked examples under [`src/examples`](src/examples) are complete decisions, not recommendations.

The mechanics were proven live on 9 October 2026: three presentations burned on Base against a
deployed instance of this gate, each blocked with its reasons, each replay refused.

## What a key check says, and what the gate says

The same request — the counterparty-onboarding challenge — from two presenters. Both hold a valid
key. Both presentations verify. A signature check stops there and says the same thing twice. The
gate reads the record.

<table>
<tr><th></th><th>A signature check</th><th>The gate's report</th></tr>
<tr>
<td valign="top"><b>Fresh key</b><br><sub>a valid key and nothing behind it</sub></td>
<td valign="top"><code>valid</code><br><sub>signed by the issuer; the presenter holds its key</sub></td>
<td valign="top"><pre>Identity
  No witnessed act on record: nothing stands behind this key.
  Fewer than 30 distinct days active under witness.
  Fewer than 10 active days in the last 90.
  No registered device.
  An empty hash chain: no act has ever been recorded.
Accountable human
  No person is linked to this agent or answers for it.
  No turn a person directed.
Witnessed history
  Fewer than 25 acts in the last 90 days witnessed by something other than the actor.
  No hardware-rooted act in the last 90 days.
Standing
  No adverse event on record.
  No open bond claim against it; no active invalidation.
Counterparties
  Fewer than 3 independent parties built on its output.
  It cites no one’s work but its own.
  No independent party paid it in the last 90 days.
Money witnessed
  No inbound payment the chain witnessed.
  No inbound payment the chain witnessed in the last 90 days.
  No financial act the chain witnessed in the last 90 days.
  No promise fulfilled.
  No promise defaulted.
  No escrow completed as the provider.

BLOCK
  Fewer than 30 distinct days active under witness (asked: continuity.active_days gte 30).
  Fewer than 10 active days in the last 90 (asked: continuity.active_days_90d gte 10).
  Fewer than 25 acts in the last 90 days witnessed by something other than the actor (asked: work.witnessed_90d gte 25).
  Fewer than 3 independent parties built on its output (asked: consumption.independent_parties gte 3).
  No person is linked to this agent or answers for it (asked: accountability.human_beneficiary eq 1).</pre></td>
</tr>
<tr>
<td valign="top"><b>Established agent</b><br><sub>the record the network produces at maturity</sub></td>
<td valign="top"><code>valid</code><br><sub>signed by the issuer; the presenter holds its key</sub></td>
<td valign="top"><pre>Identity
  First witnessed 2025-08-05, 431 days before this presentation.
  At least 30 distinct days active under witness.
  At least 10 active days in the last 90.
  3 registered devices.
  48,210 acts in its hash chain.
Accountable human
  A person is linked to this agent and answers for it.
  15,312 turns a person directed.
Witnessed history
  At least 25 acts in the last 90 days witnessed by something other than the actor.
  1,284 commits a code forge witnessed.
  9,412 hardware-rooted acts in the last 90 days.
  100% of its work in the last 90 days is hardware-rooted.
Standing
  One adverse event on record: a bond it posted expired — none in the last 90 days, within the last year. It stays in every presentation this actor makes.
  No open bond claim against it; no active invalidation.
Counterparties
  At least 3 independent parties built on its output.
  212 owners other than itself whose work it cites.
  19 independent parties paid it in the last 90 days.
Money witnessed
  640 inbound payments the chain witnessed.
  71 inbound payments the chain witnessed in the last 90 days.
  184 financial acts the chain witnessed in the last 90 days.
  31 promises fulfilled.
  No promise defaulted.
  44 escrows completed as the provider.

ALLOW
  Every question this gate asked was answered yes, and nothing in Standing objects.</pre></td>
</tr>
</table>

<sub><b>Illustrative</b> — fixture presenters, test issuer key. Generated by <code>npm run contrast</code>; every report for all five examples is in <a href="docs/illustrative-contrast.txt"><code>docs/illustrative-contrast.txt</code></a> and the full record in <a href="docs/illustrative-contrast.json"><code>docs/illustrative-contrast.json</code></a>.</sub>

The report's six headings are fixed: **Identity, Accountable human, Witnessed history, Standing,
Counterparties, Money witnessed**, then the decision and its reasons. A line reads a fact the gate
asked as its co-signed answer ("at least 25"), never the raw number; a fact the presenter disclosed
raw reads as the number; a record the challenge NAMED reads under Witnessed history as the presenter
answered it (disclosed with what it carries, declined, or nothing held); Standing is always shown. Note the established agent's one adverse event:
the onboarding gate admits it, and the event is still printed — it rides in every presentation the
agent ever makes.

## How this extends

Five questions the agentic world keeps asking. Each is a family of vocabulary fields, and each is
read by an example in this repo:

| Question | Vocabulary | Read by |
|---|---|---|
| **Identity** — who is this? | `continuity.first_seen_ms`, `continuity.active_days[_30d\|_90d\|_365d]`, `continuity.registered_devices`, `continuity.chain_depth` — computed by the relay from the actor's own witnessed chain. The gate runs no registry. | [`counterparty-onboarding`](src/examples/counterparty-onboarding.ts) (`continuity.active_days gte 30`, `continuity.active_days_90d gte 10`); the Identity section of every report |
| **Accountability** — who answers for it? | `accountability.human_beneficiary` (a person is linked), `accountability.supervised_turns`; `standing.*`, always present and never redactable | [`counterparty-onboarding`](src/examples/counterparty-onboarding.ts) and [`repository-merge`](src/examples/repository-merge.ts) (`accountability.human_beneficiary eq 1`); every example's Standing predicates and `standing(view)` rule |
| **Audit** — what has it done? | `work.<family>.<witness_class>`, `work.witnessed[_Nd]`, `work.hardware_rooted[_Nd]`, `share.witness[_Nd].<class>` — work counted by who witnessed it; and the attestation FACTS of that work — `share.issuer[_Nd].<root>`, `share.measurement[_Nd].<digest>`, `share.region[_Nd].<region>` — derived by the relay from each act's verified hardware report | [`repository-merge`](src/examples/repository-merge.ts) (`work.compute.forge_witnessed gte 10`); [`mission-critical-action`](src/examples/mission-critical-action.ts) (every act in the window under one issuer root, one launch measurement, one region — the facts, never the class) |
| **Credentials** — can it prove the specific thing? | `consumption.independent_parties` (others built on its output), `money.independent_payers_90d` (distinct parties the chain saw pay it, past the same-owner fence), `money.witnessed_inbound_90d`; and a **named disclosure** — the challenge names one PE by output digest under an issuer root, with elected content, and the presenter discloses it or declines, either answer signed and each record proven against its anchored act | [`counterparty-onboarding`](src/examples/counterparty-onboarding.ts) (`consumption.independent_parties gte 3`); [`payment-rail`](src/examples/payment-rail.ts); [`sensitive-site`](src/examples/sensitive-site.ts) (a credential by digest + issuer + content) |
| **Attribution** — when something goes wrong, who was it? | `standing.*` by type and window — an adverse event is counted against the party at fault and stays in every presentation; `accountability.human_beneficiary` says a person is linked (the presentation carries the flag; the link itself stays in the record) | `adverseStandingOf` in [`src/policy.ts`](src/policy.ts) and the Standing section of every report; the established fixture's expired bond is held against it at the merge and mission-critical gates |

A gate grows in three ways, and none of them changes `src/gate.ts`:

- **Add a predicate.** Push `{ field, op, threshold }` (or `{ field, op: 'in', set }`) onto a
  policy's `predicates`. Any field in the live vocabulary works —
  `GET https://api.provian.ai/v1/schema/pe` → `presentation.vocabulary` — under the frozen grammar.
  The mission-critical example's three attestation shares are exactly this.
- **Add a witness.** When the network gains a witness — a forge, a payment rail, a chip — its work
  lands under a witness class and family the vocabulary already counts (`work.<family>.<class>`,
  `share.witness_90d.<class>`). Ask the new key. A key that was never witnessed reads 0, so asking it
  early fails closed.
- **Name a record.** The reputation tier's facts are counts and booleans, nothing of what the work
  was. A gate that needs the specific thing puts a disclosure request on its challenge
  (`disclosures: [{ kind: 'pe', output_digest, issuer, content }]`, or `kind: 'witness'` for the
  presenter's records under an issuer or signer) and a `disclosed(view)` rule on its policy. The
  presenter elects — discloses the records it holds, or declines — and either answer is signed; the
  verifier proves every disclosed record against its anchored act on Base (`requireOnchain: true`
  is already on) and refuses a mismatch; the gate reads what was disclosed. The sensitive-site
  example is exactly this. The other four stay at the floor.

## Quickstart

Node 20 or later and a domain you control.

```bash
git clone https://github.com/LongevityManiac/provian-reference-gate.git
cd provian-reference-gate
npm install
npm run build
GATE_DOMAIN=gate.example.com npm start
```

On first start the service generates the gate key into `./data/requester-key.json` (keep it
private) and serves its public half at `/.well-known/provian-requester.json`. Put the service
behind TLS on `gate.example.com`: the Provian relay fetches that document over HTTPS from exactly
that hostname when a presenter presents against your challenge.

| Route | What it does |
|---|---|
| `GET /.well-known/provian-requester.json` | The gate's identity |
| `GET /` | The policies this gate runs, with their predicates |
| `POST /gates/<policy>/challenge` `{ "presenter"?: "0x…" }` | Issue a signed challenge → `{ challenge }` |
| `POST /gates/<policy>/decide` `{ "token": "…" }` | Verify once, evaluate, decide → `200` allow / `403` block, body = the decision with its report |

`<policy>` is one of `counterparty-onboarding`, `payment-rail`, `repository-merge`, `mission-critical-action`, `sensitive-site`.

The same path as two commands, no HTTP:

```bash
GATE_DOMAIN=gate.example.com npm run walkthrough -- issue counterparty-onboarding > challenge.json
# hand challenge.json to the presenter over any channel; it returns a token
GATE_DOMAIN=gate.example.com npm run walkthrough -- decide counterparty-onboarding --challenge challenge.json --token token.txt
```

Exit code `0` is allow, `2` is block; the decision prints as JSON on stdout and its report on stderr.

The illustrative contrast — every example, both fixture presenters, each replayed — with no network:

```bash
npm run build && npm run contrast
```

### As a library

```ts
import { Gate, generateGateKey, counterpartyOnboarding, formatReport } from 'provian-reference-gate';

const key = generateGateKey();                                  // once; publish key.publicJwk at your well-known path
const gate = await Gate.create({ domain: 'gate.example.com', key });

const challenge = gate.issueChallenge(counterpartyOnboarding);  // hand JSON.stringify(challenge) to the presenter
const decision = await gate.decide(counterpartyOnboarding, token);
console.log(formatReport(decision.report));                     // the six headings, then the decision and why
if (decision.decision !== 'allow') refuse(decision.report.reasons);
```

A policy is `{ slug, name, action, description, predicates, disclosures?, standing(view), disclosed?(view) }`. Write your own.

## The decision

```json
{
  "decision": "block",
  "gate": "gate.example.com",
  "policy": "counterparty-onboarding",
  "action": "Let an agent this system has never met act for the first time",
  "reasons": ["false: continuity.active_days gte 30", "false: work.witnessed_90d gte 25", "…"],
  "presentation": { "id": "<burn id>", "tier": "reputation", "presenter": { "address": "0x…", "wallet_id": "wallet_aw_…" }, "requester": { "type": "domain", "id": "gate.example.com" } },
  "predicates": [{ "field": "continuity.active_days", "op": "gte", "threshold": 30, "result": false }, "…"],
  "disclosures": [],
  "standing": { "adverse_events": 0, "adverse_events_90d": 0, "bond_active": false, "open_bond_claims_against": 0, "invalidation_active": false, "by_type": {} },
  "verification": { "relay": "valid", "local": "valid", "onchain_checked": false, "replay": "first" },
  "report": {
    "sections": [{ "heading": "Identity", "lines": [{ "text": "No witnessed act on record: nothing stands behind this key.", "fields": ["continuity.first_seen_ms"], "source": "disclosed" }, "…"] }, "…"],
    "decision": "BLOCK",
    "reasons": ["Fewer than 30 distinct days active under witness (asked: continuity.active_days gte 30).", "…"]
  }
}
```

Adverse standing rides in every decision over a verified presentation. The presenter cannot redact
it. A report line's `source` says where it came from: `answer` (a predicate the gate asked, co-signed),
`disclosed` (a raw fact the presenter disclosed), `standing` (always present), `withheld`, or
`unverified` (the presentation did not verify, so nothing in it is evidence).

## The five worked examples

| Policy | Guards | Asks (frozen grammar over the presentation vocabulary) | Illustrative: who clears it |
|---|---|---|---|
| [`counterparty-onboarding`](src/examples/counterparty-onboarding.ts) | Letting an agent this system has never met act for the first time | `continuity.active_days gte 30` · `continuity.active_days_90d gte 10` · `work.witnessed_90d gte 25` · `consumption.independent_parties gte 3` · `accountability.human_beneficiary eq 1` · `standing.adverse_events_90d in {0}` · `standing.open_bond_claims_against eq 0` · `standing.invalidation_active eq 0` | **Established agent.** The fresh key is blocked on five counts. |
| [`payment-rail`](src/examples/payment-rail.ts) | Enabling instant settlement for a payee | `money.independent_payers_90d gte 3` (distinct parties that paid it, past the relay's same-owner fence — an operator moving money between its own wallets reads 0 however much moved) · `money.witnessed_inbound_90d gte 5` · `continuity.active_days_90d gte 10` · `money.promises_defaulted eq 0` · `standing.adverse_events_90d in {0}` · `standing.open_bond_claims_against eq 0` · `standing.invalidation_active eq 0` | **Established agent.** 19 independent payers in the window; its adverse event is older than 90 days. A self-dealing operator is blocked on the first question (a RED control in the tests). |
| [`repository-merge`](src/examples/repository-merge.ts) | Merging an agent-authored pull request | `work.compute.forge_witnessed gte 10` (commits the forge itself witnessed) · `work.witnessed_90d gte 25` · `continuity.active_days_90d gte 10` · `coupling.independent_owners gte 1` · `accountability.human_beneficiary eq 1` · `standing.adverse_events in {0}` · `standing.invalidation_active eq 0` | **Neither.** This gate admits no adverse event at any time; the established agent answers every other question yes and is held by its expired bond alone. |
| [`mission-critical-action`](src/examples/mission-critical-action.ts) | An action that cannot be taken back | `work.witnessed_90d gte 1` · `share.issuer_90d.<root> gte 10000` · `share.measurement_90d.<digest> gte 10000` · `share.region_90d.<region> gte 10000` — every act in the window ran on attested hardware chaining to the named issuer root, under the named launch measurement, in the allowed region, as the relay derived from each act's verified report (`MISSION_ISSUER_ROOT` / `MISSION_LAUNCH_MEASUREMENT` / `MISSION_REGION`); never the witness class · `standing.adverse_events in {0}` · `standing.invalidation_active eq 0` | **Neither**, for the same reason: all of the established agent's recent work ran on its Confidential VM under the measured Provian observer (it carries the facts, and the top class at 100%), and its one adverse event still bars it. A top-class presenter with no attestation facts is blocked (RED control). |
| [`sensitive-site`](src/examples/sensitive-site.ts) | Admitting an agent to a site that requires a specific credential | names `{ kind: 'pe', output_digest: <credential>, issuer: <root>, content: ['artifacts', 'description'] }` on the signed challenge (`SENSITIVE_CREDENTIAL_DIGEST` / `SENSITIVE_CREDENTIAL_ISSUER`) and rules in `disclosed(view)`: answered `disclosed`, exactly one record carrying the digest, hardware-witnessed under that root, with its description · `standing.adverse_events_90d in {0}` · `standing.open_bond_claims_against eq 0` · `standing.invalidation_active eq 0` | **Established agent.** It elects to disclose its clearance record; the verifier proves it against its anchored act and the report prints what it says. The fresh key has nothing to show and is blocked on that alone; a declined answer, a tampered record and an unanchored one are RED controls. |

Why the onboarding thresholds are what they are is written beside each predicate in
[`counterparty-onboarding.ts`](src/examples/counterparty-onboarding.ts): a month of distinct days
under witness (a key minted this afternoon reads 0), still active, about one witnessed act every few
days, three independent parties so one colluding partner cannot vouch a stranger in, a person who
answers for it, and nothing adverse in the last 90 days — an old event is shown but does not bar a
first, low-stakes relationship. The sector gates that guard more ask the lifetime count.

Each example also applies its own rule over Standing in `standing(view)`, and the sensitive site
its rule over the named disclosure in `disclosed(view)`. A vocabulary field the presenter never
produced reads 0, so an attestation share or a forge-witnessed count is a hard requirement that
cannot fail open; a named record the presenter does not hold comes back as nothing, signed.

## The illustrative fixtures

[`src/illustrative`](src/illustrative) holds a Provian-shaped issuer and two presenters, all on
TEST keys derived from public labels, so anyone can regenerate the contrast:

- **Fresh key** — a new identity with a valid key and no record. Every count is zero.
- **Established agent** — the record the network produces at maturity: over a year under witness,
  1,284 forge-witnessed commits, 640 inbound payments the chain witnessed from 118 distinct payers
  (19 in the last 90 days), 87 independent parties building on its output, every act of its last 90
  days run on a GCE Confidential VM under the measured Provian observer (attested under the Google
  root, one launch measurement, one region — and sealed in the top witness class), a clearance
  credential it holds and can disclose, a person who answers for it — and one adverse event, a bond
  it posted that expired, which stays visible.

The tokens are shaped the way the relay issues them (predicate fields withheld behind their answers,
other facts disclosed, Standing always present, payment volume never raw) and are checked by the
same SDK verifier a live gate uses. Only the relay's second opinion is off — the public relay would
refuse a token the test issuer signed — and the one anchor read a disclosed record needs is answered
by a local stub (`src/illustrative/anchor-stub.ts`), not Base. **The fixtures illustrate; they are
not records of real actors.**

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GATE_DOMAIN` | required | The lowercase hostname this gate serves HTTPS on; the audience of every challenge |
| `PORT` | `8080` | |
| `GATE_DATA_DIR` | `./data` | The key file and the one-shot seen-store (`presentations-seen.json`) |
| `GATE_KEY_JSON` | unset | The key document as one JSON string (from a secret manager), so every container instance shares one identity; overrides the key file |
| `PROVIAN_RELAY_URL` | `https://api.provian.ai` | Provian's keys (`/v1/present/jwks`) and the stateless verify (`/v1/present/verify`) |
| `GATE_RELAY_VERIFY` | `true` | `false` verifies locally only |
| `MISSION_ISSUER_ROOT`, `MISSION_LAUNCH_MEASUREMENT`, `MISSION_REGION` | the illustrative fleet | The attestation facts the mission-critical example requires of every act (all three together): a pinned root's sha256 fingerprint, a `sha256:`/`sha384:` launch measurement, a coarse region |
| `SENSITIVE_CREDENTIAL_DIGEST`, `SENSITIVE_CREDENTIAL_ISSUER` | the illustrative credential | The credential the sensitive-site example names on its challenge (both together): an output digest and the root its witness must chain to |
| `BASE_RPC_URL` | the SDK default | The Base RPC a PE-fact presentation's anchor proofs are checked against |

## Running it in a container

```bash
docker build -t reference-gate .
docker run -p 8080:8080 -e GATE_DOMAIN=gate.example.com -v gate-data:/app/data reference-gate
```

## Tests

```bash
npm test
```

The tests forge a Provian-shaped issuer and a presenter so the whole verify path runs offline, and
every refusal is a RED control beside the allow it mirrors: a false predicate, adverse standing,
replay, Standing withheld, a PE-fact token at a predicate gate, a challenge another gate signed,
a token for another policy, the wrong audience, an expired challenge, the wrong presenter, an
issuer key the relay did not publish, and a relay verify that refuses, disagrees, or is down; a
self-dealing operator at the payment rail; each attestation fact blocking the mission-critical
action on its own, and a top-class presenter with no facts; at the sensitive site, a declined
answer, nothing held, a credential under another issuer, a record tampered after signing, an anchor
that does not hold, and a challenge that never named the credential. The report has its own: six
headings in order and never a bare decision, an asked fact read only as its answer, payment volume
never printed raw, nothing read from a presentation that did not verify, and each onboarding
question blocking on its own. The contrast is pinned: the outcome of every example for both
presenters, the sensitive site admitting on the disclosed credential alone, and the established
agent clearing the merge and mission-critical gates once its adverse event is removed.

## Further reading

- [Burn-to-present](https://provian.ai/library/burn-to-present) — the contract: challenges, predicates, the vocabulary, verify, the replay model.
- [PE Protocol Specification](https://provian.ai/library/pe-protocol-spec) — the Provenance Envelope, witness classes, the hardware-witness slots.
- [The Provian Manual](https://provian.ai/library/manual) — the whole system.
- The live schema: `GET https://api.provian.ai/v1/schema/pe` (`presentation.vocabulary`, `presentation.predicate_grammar`).

## License

MIT © Provian Technologies, LLC
