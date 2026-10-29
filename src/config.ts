/**
 * Shared configuration for the service and the CLI: the data directory, the gate key on disk,
 * the seen-store, and the environment the gate reads.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createFileSeenStore, type PresentationSeenStore } from '@provian/agent-sdk';
import { generateGateKey } from './gate.js';
import type { GateKey } from './types.js';
import type { ExampleConfig } from './examples/index.js';

export interface GateEnv {
  readonly domain: string;
  readonly relayUrl: string;
  readonly relayVerify: boolean;
  readonly admissionLog: boolean;
  readonly dataDir: string;
  readonly port: number;
  /** What the mission-critical and sensitive-site examples require (unset = the illustrative defaults). */
  readonly examples: ExampleConfig;
  readonly rpcUrl: string | undefined;
}

/**
 * MISSION_ISSUER_ROOT + MISSION_LAUNCH_MEASUREMENT + MISSION_REGION name the fleet the mission-critical
 * example admits (all three, or none); SENSITIVE_CREDENTIAL_DIGEST + SENSITIVE_CREDENTIAL_ISSUER name
 * the credential the sensitive-site example asks for (both, or none).
 */
export function exampleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ExampleConfig {
  const t = (k: string): string | undefined => env[k]?.trim().toLowerCase() || undefined;
  const issuerRoot = t('MISSION_ISSUER_ROOT'); const launchMeasurement = t('MISSION_LAUNCH_MEASUREMENT'); const region = t('MISSION_REGION');
  const mission = [issuerRoot, launchMeasurement, region].filter((x) => x !== undefined).length;
  if (mission !== 0 && mission !== 3) throw new Error('MISSION_ISSUER_ROOT, MISSION_LAUNCH_MEASUREMENT and MISSION_REGION go together');
  const digest = t('SENSITIVE_CREDENTIAL_DIGEST'); const issuer = t('SENSITIVE_CREDENTIAL_ISSUER');
  if ((digest === undefined) !== (issuer === undefined)) throw new Error('SENSITIVE_CREDENTIAL_DIGEST and SENSITIVE_CREDENTIAL_ISSUER go together');
  return {
    ...(issuerRoot && launchMeasurement && region ? { attestation: { issuerRoot, launchMeasurement, region } } : {}),
    ...(digest && issuer ? { credential: { digest, issuer } } : {}),
  };
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): GateEnv {
  const domain = (env.GATE_DOMAIN ?? '').trim().toLowerCase();
  if (!domain) throw new Error('GATE_DOMAIN is required: the lowercase DNS hostname this gate serves HTTPS on');
  const port = Number(env.PORT ?? '8080');
  if (!Number.isInteger(port) || port <= 0) throw new Error('PORT must be a positive integer');
  return {
    domain,
    relayUrl: (env.PROVIAN_RELAY_URL ?? 'https://api.provian.ai').replace(/\/+$/, ''),
    relayVerify: (env.GATE_RELAY_VERIFY ?? 'true').toLowerCase() !== 'false',
    admissionLog: (env.GATE_ADMISSION_LOG ?? 'true').toLowerCase() !== 'false',
    dataDir: path.resolve(env.GATE_DATA_DIR ?? './data'),
    port,
    examples: exampleConfigFromEnv(env),
    rpcUrl: env.BASE_RPC_URL?.trim() || undefined,
  };
}

function asGateKey(parsed: unknown, source: string): GateKey {
  const k = parsed as Partial<GateKey> | null;
  if (!k || typeof k.kid !== 'string' || typeof k.privateKeyPem !== 'string' || typeof k.publicJwk?.x !== 'string' || k.publicJwk.kid !== k.kid) {
    throw new Error(`${source} is not a gate key`);
  }
  return { kid: k.kid, privateKeyPem: k.privateKeyPem, publicJwk: { kty: 'OKP', crv: 'Ed25519', x: k.publicJwk.x, kid: k.kid } };
}

/**
 * Load the gate key: from `GATE_KEY_JSON` (the key document as one JSON string — how a container
 * or a secret manager hands it in, so every instance shares ONE identity), else from
 * `<dataDir>/requester-key.json`, generating that file on first use.
 */
export function loadOrCreateKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): { key: GateKey; created: boolean } {
  const fromEnv = env.GATE_KEY_JSON?.trim();
  if (fromEnv) {
    let parsed: unknown;
    try { parsed = JSON.parse(fromEnv); } catch { throw new Error('GATE_KEY_JSON is not JSON'); }
    return { key: asGateKey(parsed, 'GATE_KEY_JSON'), created: false };
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'requester-key.json');
  if (existsSync(file)) {
    return { key: asGateKey(JSON.parse(readFileSync(file, 'utf8')), file), created: false };
  }
  const key = generateGateKey();
  writeFileSync(file, JSON.stringify(key, null, 2), { mode: 0o600 });
  return { key, created: true };
}

/** The multi-process seen-store at `<dataDir>/presentations-seen.json`. */
export function fileSeenStore(dataDir: string): PresentationSeenStore {
  return createFileSeenStore(path.join(dataDir, 'presentations-seen.json'));
}
