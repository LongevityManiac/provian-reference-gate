/**
 * AN ANCHOR STUB — a local JSON-RPC server that answers the PEAnchor `verifyPE` read with `true`,
 * so the illustrative contrast and the tests can run the gate exactly as a live gate runs it
 * (`requireOnchain: true`) without Base. Illustrative only: the live gate reads Base, and a record
 * whose proof is not anchored there is refused.
 */
import { createServer, type Server } from 'node:http';

export interface AnchorStub { readonly url: string; close(): Promise<void> }

const TRUE_WORD = `0x${'0'.repeat(63)}1`;

/** Start a stub answering every `eth_call` with ABI-encoded `true` (and `eth_chainId` with Base). */
export function startAnchorStub(answer: 'true' | 'false' = 'true'): Promise<AnchorStub> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let calls: Array<{ id?: unknown; method?: unknown }> = [];
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          calls = Array.isArray(parsed) ? (parsed as typeof calls) : [parsed as typeof calls[number]];
        } catch { /* an empty batch */ }
        const reply = calls.map((c) => ({
          jsonrpc: '2.0', id: c.id ?? null,
          result: c.method === 'eth_chainId' ? '0x2105' : answer === 'true' ? TRUE_WORD : `0x${'0'.repeat(64)}`,
        }));
        const text = JSON.stringify(Array.isArray(calls) && calls.length === 1 && !Buffer.concat(chunks).toString('utf8').trim().startsWith('[') ? reply[0] : reply);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        res.end(text);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}
