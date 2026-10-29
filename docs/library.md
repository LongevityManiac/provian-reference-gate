# Reference gate library

`Gate.create({ domain, key, admissionLog?, seenStore?, ... })` embeds the same gate as the
standalone service. Publish `gate.wellKnownDocument()` on the named domain; hand out
`gate.issueChallenge(policy)` and call `await gate.decide(policy, exactToken)` on return.
The returned `Decision` carries the six-heading report. Unknown, false or failed is BLOCK.

## Optional admission receipts

Attach `admissionLog: createFileAdmissionLog(directory)` or omit it. The library has no implicit
log. Configure the same independent `seenStore` either way; use `createFileSeenStore(path)` from
the SDK for process-safe durable replay claims. The service/walkthrough default to a file log
under `GATE_DATA_DIR/admissions`; `GATE_ADMISSION_LOG=false` disables that attachment.

The `AdmissionLog` interface has three operations:

- `rememberChallenge(challenge): void`: durably retain an issued envelope without overwriting it.
- `findChallenge(nonce): ChallengeEnvelope | null`: retrieve it for a receipt, never for acceptance.
- `append(entry): Promise<void>`: durably append exactly one sealed `AdmissionEntry` before resolving.

The built-in implementation writes UUID-named, create-only receipt files and retained challenges
with mode 0600 under mode-0700 directories, fsyncing the file and its directory. It exposes no
rewrite/delete operation. Bring operator-owned durable storage; use a WORM backend if your
retention policy must resist deletion by a storage administrator. Custom sinks must preserve
exact strings and write every ALLOW/BLOCK, including refusals. They must not transmit receipts
to Provian. A write failure throws `AdmissionLogError`; do not perform the protected action
when `decide` throws. Claims already made in the independent seen-store are never rolled back.

`AdmissionEntry.record` includes the exact token, identified challenge (or null), receipt time,
verification clock, policy descriptor, full local verification result, sanitized public JWKS,
Base anchor-root observations, complete decision/report and gate public JWK. The receipt has a
SHA-256 digest of recursively key-sorted JSON and a domain-separated Ed25519 signature over that
digest. No presenter data is fetched to enrich the log. Public key/root evidence and the gate's
own policy/challenge/decision are the only additions to the received disclosure.

## Offline re-verification

`await reverifyAdmission(entry, independentlyTrustedGatePublicJwk, policy?)` verifies the receipt
signature and digest, the issued challenge, token signatures and PoP, bindings, freshness at the
original verification time, local act proofs and outer proofs against the retained Base roots.
It never fetches keys or uses the admission seen-store. Old issuer keys in the receipt keep old
presentations verifiable after key rotation. Retain old gate public keys independently too.

Results distinguish `receipt_valid`, `challenge`, `presentation`, `anchor_check`,
`verification_matches`, `recorded_decision`, `recorded_replay` and `policy_check`. A genuine
BLOCK may carry valid signatures. Replay is authenticated historical gate state; offline
verification never creates a fresh acceptance. Passing the same `GatePolicy` also reevaluates
its callbacks and report for a locally verified original decision. A missing policy or a refusal
before policy evaluation reports `policy_check: not_run`. A relay refusal is receipt history;
offline checking does not pretend to repeat the relay's second opinion.

Base roots are the gate operator's authenticated receipt-time RPC observations, not independent
chain-consensus proofs. `anchor_check: unavailable` never means inclusion verified. Signed
receipts detect content edits, but do not alone prove completeness or prevent deletion.

The offline CLI accepts an entry and trusted public-JWK file:

```sh
npm run reverify-admission -- entry.json gate-public-jwk.json
```

It evaluates the built-in default example policy when named by the entry. Custom policies belong
to the operator and can be supplied through the library. Exit 0 authenticates a checked receipt
(including a real BLOCK); exit 1 rejects an invalid/untrusted receipt or an error; exit 2 reports
a verification or policy mismatch. See the README's complete example entry and output.
