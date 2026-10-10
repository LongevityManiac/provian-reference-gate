/**
 * THE WALKTHROUGH CLI — the same path as the service, two commands, no HTTP.
 *
 *   node dist/walkthrough.js issue  <policy> [--presenter 0x…]      → prints the signed challenge (JSON)
 *   node dist/walkthrough.js decide <policy> --challenge <file> --token <file|->
 *                                                                    → prints the decision (JSON) and its report
 *                                                                      (stderr); exit 0 allow, 2 block
 *
 * Uses the same key and seen-store as the service (GATE_DOMAIN, GATE_DATA_DIR). The challenge is
 * handed back explicitly on `decide`, and the gate re-verifies it under its own key.
 */
import { readFileSync } from 'node:fs';
import { Gate } from './gate.js';
import { examplePolicies } from './examples/index.js';
import { fileSeenStore, loadOrCreateKey, readEnv } from './config.js';
import { formatReport } from './report.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const [, , command, slug] = process.argv;
  const env = readEnv();
  const policies = examplePolicies(env.examples);
  const policy = slug ? policies[slug] : undefined;
  if (!command || !policy) {
    console.error(`usage: walkthrough issue|decide <${Object.keys(policies).join('|')}> [--presenter 0x…] [--challenge file --token file|-]`);
    return 1;
  }
  const { key } = loadOrCreateKey(env.dataDir);
  const gate = await Gate.create({
    domain: env.domain, key, relayUrl: env.relayUrl, relayVerify: env.relayVerify, seenStore: fileSeenStore(env.dataDir),
    ...(env.rpcUrl !== undefined ? { rpcUrl: env.rpcUrl } : {}),
  });

  if (command === 'issue') {
    const presenter = flag('--presenter');
    const challenge = gate.issueChallenge(policy, presenter ? { presenter } : {});
    process.stdout.write(`${JSON.stringify(challenge)}\n`);
    return 0;
  }
  if (command === 'decide') {
    const challengeFile = flag('--challenge');
    const tokenFile = flag('--token');
    if (!challengeFile || !tokenFile) { console.error('decide needs --challenge <file> and --token <file|->'); return 1; }
    const challenge = readFileSync(challengeFile, 'utf8');
    const token = (tokenFile === '-' ? readFileSync(0, 'utf8') : readFileSync(tokenFile, 'utf8')).trim();
    const decision = await gate.decide(policy, token, { challenge });
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    process.stderr.write(`\n${formatReport(decision.report)}\n`);
    return decision.decision === 'allow' ? 0 : 2;
  }
  console.error(`unknown command: ${command}`);
  return 1;
}

main().then((code) => process.exit(code), (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
