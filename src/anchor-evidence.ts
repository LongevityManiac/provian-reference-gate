/** Receipt-time Base observations; no owner data, headers or credential-bearing RPC URLs retained. */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { decodeFunctionResult, encodeFunctionData, keccak256, concatHex, type Hex } from 'viem';
import { decodePresentationToken, parseDisclosureAnswers, PROVIAN_BASE_PE_ANCHOR, DEFAULT_BASE_RPC_URL, validateEgressTarget } from '@provian/agent-sdk';

const ABI = [{ type: 'function', name: 'getBatch', stateMutability: 'view',
  inputs: [{ name: 'batchId', type: 'bytes32' }], outputs: [
    { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' },
  ] }] as const;
export interface AnchorObservation {
  readonly batch_id: string;
  readonly contract: string;
  readonly chain_id: 8453;
  readonly block_number: string | null;
  readonly root: string | null;
  readonly exists: boolean | null;
  readonly status: 'observed' | 'unavailable';
  readonly source: 'verified_inclusion' | 'rpc_root';
}
interface Proof { pe_id?: string; anchor: { batch_id?: unknown; contract_address?: unknown }; leaf: { leaf_value?: unknown }; merkle_proof: unknown[] }
function proofsOf(token: string): Proof[] {
  const p = decodePresentationToken(token.trim());
  if (!p) return [];
  const objects = (value: unknown): Proof[] => Array.isArray(value)
    ? value.filter((proof): proof is Proof => typeof proof === 'object' && proof !== null) : [];
  if (p.tier === 'pe_fact') return objects(p.proofs); // SDK checks every outer PE-fact proof.
  if (p.tier !== 'reputation' || typeof p.provian_jws !== 'string') return [];
  // The SDK reads reputation records from the SIGNED JWS payload, never its unsigned outer copy.
  let signed: unknown;
  try { signed = JSON.parse(Buffer.from(p.provian_jws.split('.')[1] ?? '', 'base64url').toString('utf8')); }
  catch { return []; }
  if (typeof signed !== 'object' || signed === null || !('disclosures' in signed) || !Array.isArray(signed.disclosures)) return [];
  const candidates = objects(p.disclosure_proofs);
  const selected: Proof[] = [];
  for (const answer of parseDisclosureAnswers(signed.disclosures) ?? []) {
    if (answer.election !== 'disclosed') continue;
    for (const record of answer.records ?? []) {
      // Same first match by PE id as checkDisclosedRecords; unused/duplicate outer proofs are inert.
      const proof = candidates.find((candidate) => candidate.pe_id === record.pe_id);
      if (proof && !selected.includes(proof)) selected.push(proof);
    }
  }
  return selected;
}

/** Default outbound read: validate all DNS answers, pin the selected public address at the socket,
 * refuse redirects. Injected fetch is the same explicit transport seam as the gate/SDK tests. */
export const anchorFetch: typeof fetch = async (input, init) => {
  init?.signal?.throwIfAborted();
  const url = new URL(String(input));
  const validation = validateEgressTarget(url.href, { resolveHost: async (hostname) => (await lookup(hostname, { all: true })).map((a) => a.address) });
  const signal = init?.signal;
  const checked = signal ? await new Promise<Awaited<typeof validation>>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { signal.removeEventListener('abort', abort); reject(signal.reason); return; }
    validation.then((value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); });
  }) : await validation;
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  const ip = checked.resolvedIps?.[0] ?? (isIP(literal) ? literal : undefined);
  if (!checked.ok || !ip) throw new Error('anchor RPC egress refused');
  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, family: ip.includes(':') ? 6 : 4,
      lookup: (_hostname, _options, callback) => callback(null, ip, ip.includes(':') ? 6 : 4),
      timeout: 10_000, ...(signal ? { signal } : {}),
    }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024) response.destroy(new Error('anchor RPC response too large')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500 })));
    });
    request.on('error', reject); request.on('timeout', () => request.destroy(new Error('anchor RPC timeout')));
    request.end(typeof init?.body === 'string' ? init.body : '');
  });
};

/** Reproduce the contract's sorted, 0x01-domain-separated outer proof. leaf_value is already
 * leaf-domain hashed; do NOT apply the leaf prefix again here. */
export function outerProofRoot(leaf: string, siblings: readonly unknown[]): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(leaf)) return null;
  let current = leaf.toLowerCase() as Hex;
  for (const value of siblings) {
    if (typeof value !== 'string' || !/^(0x)?[0-9a-fA-F]{64}$/.test(value)) return null;
    const sibling = `0x${value.replace(/^0x/, '').toLowerCase()}` as Hex;
    current = keccak256(concatHex(['0x01', ...([current, sibling].sort() as [Hex, Hex])]));
  }
  return current;
}

/** Read only batch roots required by the disclosed proofs. Roots are immutable once anchored. */
export async function captureAnchorObservations(token: string, rpcUrl = DEFAULT_BASE_RPC_URL, fetchFn: typeof fetch = anchorFetch, verifiedInclusion = false): Promise<AnchorObservation[]> {
  const proofs = proofsOf(token);
  const ids = [...new Set(proofs.map((p) => p.anchor?.batch_id).filter((id): id is string => typeof id === 'string' && /^0x[0-9a-fA-F]{64}$/.test(id)))];
  if (ids.length === 0) return [];
  // verifyPE=true on the pinned immutable contract proves that its stored root equals the
  // fold of these exact proof siblings. Preserve that observed root without a second RPC or
  // a new availability dependency. A replay refusal occurs only AFTER all proof checks passed.
  if (verifiedInclusion) {
    return ids.map((batchId) => {
      const matching = proofs.filter((proof) => proof.anchor?.batch_id === batchId);
      const roots = matching.map((proof) => typeof proof.leaf?.leaf_value === 'string' && Array.isArray(proof.merkle_proof)
        ? outerProofRoot(proof.leaf.leaf_value, proof.merkle_proof) : null);
      const root = roots[0] ?? null;
      const valid = root !== null && roots.every((value) => value === root);
      return { batch_id: batchId, contract: PROVIAN_BASE_PE_ANCHOR.toLowerCase(), chain_id: 8453,
        block_number: null, root: valid ? root : null, exists: valid ? true : null,
        status: valid ? 'observed' : 'unavailable', source: 'verified_inclusion' };
    });
  }
  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const response = await fetchFn(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('RPC unavailable');
    const body = await response.json() as { result?: unknown; error?: unknown };
    if (body.error !== undefined || body.result === undefined) throw new Error('RPC refused');
    return body.result;
  };
  let block: string | null = null;
  try {
    if (await rpc('eth_chainId', []) !== '0x2105') throw new Error('not Base');
    const height = await rpc('eth_blockNumber', []);
    if (typeof height !== 'string' || !/^0x[0-9a-fA-F]+$/.test(height)) throw new Error('bad block number');
    block = height;
  } catch { /* every required root records unavailability */ }
  const observations: AnchorObservation[] = [];
  for (const batchId of ids) {
    const base = { batch_id: batchId, contract: PROVIAN_BASE_PE_ANCHOR.toLowerCase(), chain_id: 8453 as const, block_number: block, source: 'rpc_root' as const };
    try {
      if (block === null) throw new Error('no Base block');
      const data = encodeFunctionData({ abi: ABI, functionName: 'getBatch', args: [batchId as Hex] });
      const result = await rpc('eth_call', [{ to: PROVIAN_BASE_PE_ANCHOR, data }, block]);
      if (typeof result !== 'string') throw new Error('bad root response');
      const [root, , , , exists] = decodeFunctionResult({ abi: ABI, functionName: 'getBatch', data: result as Hex });
      observations.push({ ...base, root, exists, status: 'observed' });
    } catch { observations.push({ ...base, root: null, exists: null, status: 'unavailable' }); }
  }
  return observations;
}

export function offlineAnchorCheck(token: string, observations: readonly AnchorObservation[]): 'valid' | 'invalid' | 'untrusted' | 'unavailable' | 'not_needed' {
  const proofs = proofsOf(token);
  if (proofs.length === 0) return 'not_needed';
  for (const proof of proofs) {
    if (decodePresentationToken(token.trim())?.tier === 'pe_fact' && typeof proof.anchor?.contract_address === 'string' && proof.anchor.contract_address.toLowerCase() !== PROVIAN_BASE_PE_ANCHOR.toLowerCase()) return 'untrusted';
    const observation = observations.find((o) => o.batch_id === proof.anchor?.batch_id);
    if (!observation || observation.status !== 'observed') return 'unavailable';
    if (observation.contract !== PROVIAN_BASE_PE_ANCHOR.toLowerCase() || observation.chain_id !== 8453 || !observation.exists ||
      typeof proof.leaf?.leaf_value !== 'string' || !Array.isArray(proof.merkle_proof) ||
      outerProofRoot(proof.leaf.leaf_value, proof.merkle_proof) !== observation.root?.toLowerCase()) return 'invalid';
  }
  return 'valid';
}
