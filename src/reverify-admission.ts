/** Offline only. Pass the gate's independently retained public JWK, never its private key file. */
import { readFileSync } from 'node:fs';
import { reverifyAdmission, type AdmissionEntry } from './admission.js';
import { examplePolicies } from './examples/index.js';
import type { GateKey } from './types.js';

async function main(): Promise<void> {
  const [, , receiptFile, publicKeyFile] = process.argv;
  if (!receiptFile || !publicKeyFile) throw new Error('usage: reverify-admission <entry.json> <trusted-gate-public-jwk.json>');
  const entry = JSON.parse(readFileSync(receiptFile, 'utf8')) as AdmissionEntry;
  const publicKey = JSON.parse(readFileSync(publicKeyFile, 'utf8')) as GateKey['publicJwk'];
  const result = await reverifyAdmission(entry, publicKey, examplePolicies()[entry.record.policy.slug]);
  if (result.verification_matches === false || result.policy_check === 'mismatch') process.exitCode = 2;
  // Compact enough for a terminal; the library returns the complete verified presentation too.
  console.log(JSON.stringify({ ...result, presentation: result.presentation?.valid
    ? { valid: true, presentation_id: result.presentation.presentationId, presenter: result.presentation.presenterAddress,
      onchainChecked: result.presentation.onchainChecked }
    : result.presentation }, null, 2));
}
main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; });
