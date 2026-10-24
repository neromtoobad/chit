// The only network code in the app. It fetches public transaction data by txid and
// sends nothing else: no viewing key, no disclosure, no cookies, no referrer.

export type Network = 'main' | 'test';

export interface TxData {
  hex: string;
  height: number | null;
  time: string | null;
  confirmations: number | null;
}

const BASE = 'https://api.blockchair.com/zcash';
const opts: RequestInit = { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' };

export class ChainError extends Error {}

export async function fetchTx(network: Network, txid: string): Promise<TxData> {
  if (network !== 'main') {
    throw new ChainError('No public testnet explorer is wired in. Paste the raw transaction instead.');
  }
  if (!/^[0-9a-f]{64}$/i.test(txid)) throw new ChainError('A txid is 64 hex characters.');
  const [raw, dash] = await Promise.all([
    get(`${BASE}/raw/transaction/${txid}`),
    get(`${BASE}/dashboards/transaction/${txid}`).catch(() => null),
  ]);
  const entry = raw?.data?.[txid.toLowerCase()];
  if (!entry?.raw_transaction) throw new ChainError('The explorer does not know this transaction yet.');
  const meta = dash?.data?.[txid.toLowerCase()]?.transaction;
  const tip: number | undefined = raw?.context?.state;
  const height = typeof meta?.block_id === 'number' && meta.block_id > 0 ? meta.block_id : null;
  return {
    hex: entry.raw_transaction,
    height,
    time: meta?.time ? `${meta.time} UTC` : null,
    confirmations: height && tip ? tip - height + 1 : null,
  };
}

async function get(url: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ChainError('Could not reach the explorer. Check your connection, or paste the raw transaction.');
  }
  if (res.status === 404) throw new ChainError('The explorer does not know this transaction.');
  if (res.status === 402 || res.status === 429 || res.status === 430) {
    throw new ChainError('The explorer is rate-limiting this connection. Try again in a minute, or paste the raw transaction.');
  }
  if (!res.ok) throw new ChainError(`The explorer answered ${res.status}.`);
  return res.json();
}

export function explorerUrl(network: Network, txid: string): string | null {
  return network === 'main' ? `https://blockchair.com/zcash/transaction/${txid}` : null;
}
