export type Network = 'main' | 'test';
export interface Memo { kind: 'empty' | 'text' | 'binary'; value: string }
export interface Verified { network: Network; txid: string; pool: 'orchard' | 'ironwood'; action: number; direction: 'outgoing' | 'incoming'; value_zat: number; recipient: string; memo: Memo }
export interface Step { id: string; label: string; ok: boolean | null }
export interface Report { valid: boolean; error: string | null; verified: Verified | null; steps: Step[] }
export interface Found extends Omit<Verified, 'network' | 'txid'> { change: boolean; disclosure: string }
export function ready(): Promise<unknown>;
export function verify(txHex: string, chit: string): Report;
export function scan(txHex: string, ufvk: string, network?: Network): Found[];
export function inspect(chit: string): Omit<Verified, 'value_zat' | 'recipient' | 'memo'>;
export function txid(txHex: string): string;
export function sameReceiver(a: string, b: string, network?: Network): boolean;
