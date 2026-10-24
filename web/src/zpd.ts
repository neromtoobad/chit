import init, * as wasm from '../pkg/chit_wasm.js';
import wasmUrl from '../pkg/chit_wasm_bg.wasm?url';
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
const load = () => (ready ??= init({ module_or_path: wasmUrl }));

export async function inspect(disclosure: string): Promise<Header> {
  await load();
  return JSON.parse(wasm.inspect(disclosure));
}

export async function verify(txHex: string, disclosure: string): Promise<Verified> {
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
