// Payment requests ("Pay & prove"). A request is a ZIP 321 payment URI plus a reference
// the memo must carry. It lives entirely in a link, so no server ever sees it.

import type { Network } from './chain';
import type { Verified } from './zpd';
import { sameReceiver } from './zpd';

export interface PayRequest {
  network: Network;
  address: string;
  amountZat: number;
  /** Must appear in the payment's memo, e.g. an invoice number. */
  reference: string;
  label: string;
}

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

export function encodeRequest(r: PayRequest): string {
  return b64url(JSON.stringify({ n: r.network, a: r.address, z: r.amountZat, r: r.reference, l: r.label }));
}

export function decodeRequest(s: string): PayRequest | null {
  try {
    const o = JSON.parse(unb64url(s));
    if (typeof o.a !== 'string' || !Number.isSafeInteger(o.z) || o.z <= 0 || typeof o.r !== 'string') return null;
    return { network: o.n === 'test' ? 'test' : 'main', address: o.a, amountZat: o.z, reference: o.r, label: typeof o.l === 'string' ? o.l : '' };
  } catch {
    return null;
  }
}

export const zecString = (zat: number) => `${Math.floor(zat / 1e8)}.${String(zat % 1e8).padStart(8, '0')}`.replace(/\.?0+$/, '');

export function parseZec(s: string): number | null {
  const m = s.trim().match(/^(\d{1,8})(?:\.(\d{1,8}))?$/);
  if (!m) return null;
  const zat = Number(m[1]) * 1e8 + Number((m[2] ?? '').padEnd(8, '0'));
  return zat > 0 ? zat : null;
}

/** The memo the payer's wallet will attach. */
export const memoFor = (r: PayRequest) => (r.label ? `${r.reference} · ${r.label}` : r.reference);

/** ZIP 321 payment URI that wallets such as Zodl open directly. */
export function zip321(r: PayRequest): string {
  const q = new URLSearchParams();
  q.set('amount', zecString(r.amountZat));
  q.set('memo', b64url(memoFor(r)));
  if (r.label) q.set('message', r.label);
  return `zcash:${r.address}?${q.toString().replace(/\+/g, '%20')}`;
}

export interface InvoiceCheck {
  recipient: boolean;
  amount: boolean;
  memo: boolean;
  /** How much more was due, in zatoshis, when underpaid. */
  shortBy: number;
}

export async function checkInvoice(v: Verified, r: PayRequest): Promise<InvoiceCheck> {
  const recipient = await sameReceiver(v.recipient, r.address, r.network);
  const memo = v.memo.kind === 'text' && v.memo.value.includes(r.reference);
  return { recipient, amount: v.value_zat >= r.amountZat, memo, shortBy: Math.max(0, r.amountZat - v.value_zat) };
}
