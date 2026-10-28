// The only network code in the app. It fetches public transaction data by txid and
// sends nothing else: no viewing key, no disclosure, no cookies, no referrer.
//
// Where transactions come from, in order:
//   1. this browser's cache (IndexedDB) for transactions already seen mined: a mined
//      transaction never changes, so repeat checks need no network at all;
//   2. a `chit serve` instance on this same origin, if there is one: then the page talks
//      only to its own server, which reads from the operator's own Zebra node;
//   3. Blockchair's public API, with retries on rate limits.

export type Network = 'main' | 'test';

export interface TxData {
  hex: string;
  height: number | null;
  time: string | null;
  confirmations: number | null;
  /** Human name of where the transaction came from. */
  source: string;
}

const BASE = 'https://api.blockchair.com/zcash';
const opts: RequestInit = { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' };

export class ChainError extends Error {}

// ---------- cache ----------

const DB = 'chit';
const STORE = 'txs';

function db(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null); // private mode or no IndexedDB: work uncached
    }
  });
}

let dbp: Promise<IDBDatabase | null> | null = null;
const open = () => (dbp ??= db());

async function cached(network: Network, txid: string): Promise<TxData | null> {
  const d = await open();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      // Ignore legacy txid-only entries: their network cannot be established.
      const r = d.transaction(STORE).objectStore(STORE).get(`${network}:${txid}`);
      r.onsuccess = () => resolve(r.result ? { ...r.result, confirmations: null, source: `${r.result.source}, cached` } : null);
      r.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function remember(network: Network, txid: string, tx: TxData) {
  if (!tx.height) return; // only mined transactions are immutable
  const d = await open();
  try {
    d?.transaction(STORE, 'readwrite').objectStore(STORE).put({ hex: tx.hex, height: tx.height, time: tx.time, source: tx.source }, `${network}:${txid}`);
  } catch {
    /* quota or private mode: fine, just uncached */
  }
}

// ---------- sources ----------

let selfHosted: Promise<boolean> | null = null;

/** Whether this page is served by `chit serve`, which then becomes the only data source. */
export function nodeOnThisOrigin(): Promise<boolean> {
  // Resolved against this module, not the page: the embed badge on someone else's site must
  // never take transactions from that site.
  return (selfHosted ??= fetch(new URL('/v1/health', import.meta.url), opts)
    .then(async (r) => r.ok && (r.headers.get('content-type') ?? '').includes('json') && (await r.json()).ok === true)
    .catch(() => false));
}

export async function sourceName(): Promise<string> {
  return (await nodeOnThisOrigin()) ? 'your chit node' : 'Blockchair';
}

const inflight = new Map<string, Promise<TxData>>();

export function fetchTx(network: Network, txid: string): Promise<TxData> {
  txid = txid.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) return Promise.reject(new ChainError('A txid is 64 hex characters.'));
  const key = `${network}:${txid}`;
  // Many views ask for the same transaction at once (a ledger, a wall): share one request.
  let p = inflight.get(key);
  if (!p) {
    p = load(network, txid).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function load(network: Network, txid: string): Promise<TxData> {
  const hit = await cached(network, txid);
  if (hit) return hit;
  const tx = (await nodeOnThisOrigin()) ? await fromNode(txid) : await fromBlockchair(network, txid);
  remember(network, txid, tx);
  return tx;
}

async function fromNode(txid: string): Promise<TxData> {
  const r = await get(new URL(`/v1/tx/${txid}`, import.meta.url).href);
  return { hex: r.hex, height: r.height ?? null, time: null, confirmations: r.confirmations ?? null, source: `your node (${r.source})` };
}

async function fromBlockchair(network: Network, txid: string): Promise<TxData> {
  if (network !== 'main') {
    throw new ChainError('No public testnet explorer is wired in. Paste the raw transaction, or run chit serve with your own node.');
  }
  const [raw, dash] = await Promise.all([get(`${BASE}/raw/transaction/${txid}`), get(`${BASE}/dashboards/transaction/${txid}`).catch(() => null)]);
  const entry = raw?.data?.[txid];
  if (!entry?.raw_transaction) throw new ChainError('The explorer does not know this transaction yet.');
  const meta = dash?.data?.[txid]?.transaction;
  const tip: number | undefined = raw?.context?.state;
  const height = typeof meta?.block_id === 'number' && meta.block_id > 0 ? meta.block_id : null;
  return {
    hex: entry.raw_transaction,
    height,
    time: meta?.time ? `${meta.time} UTC` : null,
    confirmations: height && tip ? tip - height + 1 : null,
    source: 'Blockchair',
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET JSON with up to three tries, backing off on rate limits and server errors. */
async function get(url: string): Promise<any> {
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(800 * 3 ** (attempt - 1) + Math.random() * 300);
    let res: Response;
    try {
      res = await fetch(url, opts);
    } catch {
      last = 'Could not reach the transaction source. Check your connection, or paste the raw transaction.';
      continue;
    }
    if (res.status === 404) throw new ChainError('The transaction source does not know this transaction.');
    if (res.status === 402 || res.status === 429 || res.status === 430 || res.status >= 500) {
      last = res.status >= 500 ? `The transaction source answered ${res.status}.` : 'The explorer is rate-limiting this connection. Try again in a minute, or paste the raw transaction.';
      continue;
    }
    if (!res.ok) throw new ChainError(`The transaction source answered ${res.status}.`);
    return res.json();
  }
  throw new ChainError(last);
}

export function explorerUrl(network: Network, txid: string): string | null {
  return network === 'main' ? `https://blockchair.com/zcash/transaction/${txid}` : null;
}

export interface ChainStats {
  blocks: number;
  tx24h: number;
}

/** Public network numbers for the home page. Carries no user data. */
export async function fetchStats(): Promise<ChainStats> {
  // A self-hosted page talks only to its own server, so it skips public network stats.
  if (await nodeOnThisOrigin()) throw new ChainError('self-hosted');
  const s = await get(`${BASE}/stats`);
  return { blocks: s.data.best_block_height ?? s.data.blocks, tx24h: s.data.transactions_24h };
}
