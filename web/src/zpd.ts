import init, * as wasm from '../pkg/chit_wasm.js';
import type { Network } from './chain';

export type Pool = 'orchard' | 'ironwood';
export type Direction = 'outgoing' | 'incoming';

export interface Memo {
  kind: 'empty' | 'text' | 'binary';
  value: string;
}

export interface Header {
  network: Network;
  txid: string;
  pool: Pool;
  action: number;
  direction: Direction;
}

export interface Verified extends Header {
  value_zat: number;
  recipient: string;
  memo: Memo;
}

export interface Step {
  id: string;
  label: string;
  ok: boolean | null;
}

export interface Report {
  valid: boolean;
  error: string | null;
  verified: Verified | null;
  steps: Step[];
}

export interface Found {
  pool: Pool;
  action: number;
  direction: Direction;
  change: boolean;
  value_zat: number;
  recipient: string;
  memo: Memo;
  disclosure: string;
}

let ready: Promise<unknown> | null = null;
// Resolved against this module's own URL, so the embed badge works on other sites too.
export const load = () => (ready ??= init({ module_or_path: new URL('../pkg/chit_wasm_bg.wasm', import.meta.url) }));

export async function inspect(disclosure: string): Promise<Header> {
  await load();
  return JSON.parse(wasm.inspect(disclosure));
}

export async function verify(txHex: string, disclosure: string): Promise<Report> {
  await load();
  return JSON.parse(wasm.verify(txHex, disclosure));
}

export async function scan(txHex: string, ufvk: string, network: Network): Promise<Found[]> {
  await load();
  return JSON.parse(wasm.scan(txHex, ufvk, network));
}

export async function txidOf(txHex: string): Promise<string> {
  await load();
  return wasm.txid(txHex);
}

export async function sameReceiver(a: string, b: string, network: Network): Promise<boolean> {
  await load();
  return wasm.same_receiver(a, b, network);
}

export async function hasOrchardReceiver(address: string, network: Network): Promise<boolean> {
  await load();
  return wasm.has_orchard_receiver(address, network);
}
