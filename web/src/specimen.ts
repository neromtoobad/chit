// The specimen: a real, fully proven v6 Ironwood transaction that pays out five prizes but is
// funded from nothing, so it is not on chain. It ships with the app so anyone can try every
// flow without a wallet, and it is always labelled SPECIMEN, never "on chain".

export interface Specimen {
  note: string;
  txid: string;
  tx: string;
  organiser_ufvk: string;
  winner_ufvk: string;
  winner_address: string;
  chits: string[];
}

let cached: Promise<Specimen> | null = null;

export function specimen(): Promise<Specimen> {
  return (cached ??= fetch(new URL(`${import.meta.env.BASE_URL}specimen/specimen.json`, import.meta.url), { credentials: 'omit' }).then((r) => {
    if (!r.ok) throw new Error('Could not load the specimen.');
    return r.json();
  }));
}
