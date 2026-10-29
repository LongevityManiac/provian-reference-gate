/**
 * AN ANCHOR STUB — a local JSON-RPC server that answers the PEAnchor `verifyPE` read with `true`,
 * so the illustrative contrast and the tests can run the gate exactly as a live gate runs it
 * (`requireOnchain: true`) without Base. Illustrative only: the live gate reads Base, and a record
 * whose proof is not anchored there is refused.
 */
import { createServer, type Server } from 'node:http';
import { decodeFunctionData, encodeAbiParameters, type Hex } from 'viem';
import { outerProofRoot } from '../anchor-evidence.js';

export interface AnchorStub { readonly url: string; close(): Promise<void> }

const TRUE_WORD = `0x${'0'.repeat(63)}1`;

/** Start a stub answering every `eth_call` with ABI-encoded `true` (and `eth_chainId` with Base). */
export function startAnchorStub(answer: 'true' | 'false' = 'true'): Promise<AnchorStub> {
  const roots = new Map<string, Hex>();
  const abi = [{ type: 'function', name: 'verifyPE', stateMutability: 'view', inputs: [{type:'bytes32'}, {type:'bytes32'}, {type:'bytes32[]'}], outputs: [{type:'bool'}] }, { type:'function', name:'getBatch', stateMutability:'view', inputs:[{type:'bytes32'}], outputs:[{type:'bytes32'}, {type:'uint256'}, {type:'uint256'}, {type:'uint256'}, {type:'bool'}] }] as const;
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let calls: Array<{ id?: unknown; method?: unknown; params?: Array<{ data?: Hex }> }> = [];
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          calls = Array.isArray(parsed) ? (parsed as typeof calls) : [parsed as typeof calls[number]];
        } catch { /* an empty batch */ }
        const reply = calls.map((c) => {
          let result = answer === 'true' ? TRUE_WORD : `0x${'0'.repeat(64)}`;
          if (c.method === 'eth_chainId') result = '0x2105';
          else if (c.method === 'eth_blockNumber') result = '0x123456';
          else if (c.method === 'eth_call' && c.params?.[0]?.data) {
            try {
              const decoded = decodeFunctionData({ abi, data: c.params[0].data });
              if (decoded.functionName === 'verifyPE') {
                const [batch, leaf, proof] = decoded.args;
                const root = outerProofRoot(leaf, proof);
                if (root) roots.set(batch, root as Hex);
              } else {
                const root = answer === 'true' ? roots.get(decoded.args[0]) : undefined;
                result = encodeAbiParameters([{type:'bytes32'}, {type:'uint256'}, {type:'uint256'}, {type:'uint256'}, {type:'bool'}],
                  [root ?? `0x${'0'.repeat(64)}`, 1n, 1n, 1n, Boolean(root)]);
              }
            } catch { /* malformed illustrative RPC */ }
          }
          return { jsonrpc: '2.0', id: c.id ?? null, result };
        });
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
