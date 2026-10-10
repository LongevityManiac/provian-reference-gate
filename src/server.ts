/**
 * THE STANDALONE SERVICE — the gate as an HTTP server, no framework.
 *
 *   GET  /.well-known/provian-requester.json   the gate's identity (STEP 0)
 *   GET  /                                     the policies this gate runs, with their predicates
 *   POST /gates/<policy>/challenge             { presenter? }  →  { challenge }        (STEP 1)
 *   POST /gates/<policy>/decide                { token }       →  Decision (200 allow / 403 block)
 *
 * Environment: GATE_DOMAIN (required), PORT (8080), GATE_DATA_DIR (./data: the key and the
 * seen-store), GATE_KEY_JSON (the key as one JSON string, for containers), PROVIAN_RELAY_URL
 * (https://api.provian.ai), GATE_RELAY_VERIFY (true), MISSION_ISSUER_ROOT + MISSION_LAUNCH_MEASUREMENT +
 * MISSION_REGION (the mission-critical example's fleet), SENSITIVE_CREDENTIAL_DIGEST +
 * SENSITIVE_CREDENTIAL_ISSUER (the sensitive-site example's credential), BASE_RPC_URL (anchor reads).
 *
 * Put it behind TLS on the domain it names: the relay fetches the well-known document over HTTPS
 * from exactly that hostname.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { REQUESTER_WELL_KNOWN_PATH } from '@provian/agent-sdk';
import { Gate } from './gate.js';
import { examplePolicies } from './examples/index.js';
import { fileSeenStore, loadOrCreateKey, readEnv } from './config.js';
import type { GatePolicy } from './types.js';

const MAX_BODY_BYTES = 256 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return; }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {});
      } catch { reject(new Error('body is not JSON')); }
    });
    req.on('error', reject);
  });
}

export async function main(): Promise<void> {
  const env = readEnv();
  const { key, created } = loadOrCreateKey(env.dataDir);
  const gate = await Gate.create({
    domain: env.domain,
    key,
    relayUrl: env.relayUrl,
    relayVerify: env.relayVerify,
    seenStore: fileSeenStore(env.dataDir),
    ...(env.rpcUrl !== undefined ? { rpcUrl: env.rpcUrl } : {}),
  });
  const policies: Record<string, GatePolicy> = examplePolicies(env.examples);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (req.method === 'GET' && url.pathname === REQUESTER_WELL_KNOWN_PATH) {
        json(res, 200, gate.wellKnownDocument());
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/gates')) {
        json(res, 200, {
          gate: gate.domain,
          identity: gate.wellKnownUrl(),
          relay: gate.relayUrl,
          policies: Object.values(policies).map((p) => ({
            slug: p.slug, name: p.name, action: p.action, description: p.description, predicates: p.predicates,
            ...(p.disclosures && p.disclosures.length > 0 ? { disclosures: p.disclosures } : {}),
            challenge: `POST /gates/${p.slug}/challenge`, decide: `POST /gates/${p.slug}/decide`,
          })),
        });
        return;
      }
      const m = /^\/gates\/([a-z0-9-]+)\/(challenge|decide)$/.exec(url.pathname);
      if (m) {
        const policy = policies[m[1] as string];
        if (!policy) { json(res, 404, { error: 'unknown policy' }); return; }
        if (req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return; }
        const body = await readJson(req);
        if (m[2] === 'challenge') {
          const presenter = typeof body.presenter === 'string' && body.presenter.trim() ? body.presenter.trim() : undefined;
          const challenge = gate.issueChallenge(policy, presenter ? { presenter } : {});
          json(res, 201, { challenge, decide: `/gates/${policy.slug}/decide` });
          return;
        }
        const token = typeof body.token === 'string' ? body.token : '';
        const decision = await gate.decide(policy, token);
        json(res, decision.decision === 'allow' ? 200 : 403, decision);
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : 'bad request' });
    }
  });

  server.listen(env.port, () => {
    console.log(`[reference-gate] ${gate.domain} listening on :${env.port}`);
    console.log(`[reference-gate] identity: serve GET ${REQUESTER_WELL_KNOWN_PATH} at ${gate.wellKnownUrl()}${created ? ' (key generated now)' : ''}`);
    console.log(`[reference-gate] relay: ${gate.relayUrl} (relay verify ${env.relayVerify ? 'on' : 'off'})`);
    for (const p of Object.values(policies)) console.log(`[reference-gate] policy ${p.slug}: ${p.predicates.length} predicates${p.disclosures?.length ? `, ${p.disclosures.length} named disclosure(s)` : ''}`);
  });
}

main().catch((err) => {
  console.error(`[reference-gate] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
