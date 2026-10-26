export const CHAIN_HASH: string;
export function isSealed(memo: string): boolean;
export function seal(text: string, when: Date): Promise<string>;
export function sealRound(memo: string): number;
export function opensAt(memo: string): Promise<Date>;
export function unseal(memo: string): Promise<string>;
