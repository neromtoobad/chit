// chit-zcash: verify Zcash Orchard/Ironwood output disclosures ("chits") in Node or the
// browser. Pure computation: you fetch the transaction, this checks the chit.
import init, * as w from './pkg/chit_wasm.js';

let loading;

/** Loads the WebAssembly module. Call (and await) once before anything else. */
export function ready() {
  return (loading ??= (async () => {
    const url = new URL('./pkg/chit_wasm_bg.wasm', import.meta.url);
    if (typeof process !== 'undefined' && process.versions?.node) {
      const { readFile } = await import('node:fs/promises');
      return init({ module_or_path: await readFile(url) });
    }
    return init({ module_or_path: url });
  })());
}

/** Checks a chit against the raw transaction hex it names. Returns every step. */
export const verify = (txHex, chit) => JSON.parse(w.verify(txHex, chit));
/** Lists the outputs a Unified Full Viewing Key can disclose in a transaction. */
export const scan = (txHex, ufvk, network = 'main') => JSON.parse(w.scan(txHex, ufvk, network));
/** Reads which transaction and output a chit names, without verifying it. */
export const inspect = (chit) => JSON.parse(w.inspect(chit));
/** The txid of a raw transaction. */
export const txid = (txHex) => w.txid(txHex);
/** Whether two addresses share an Orchard receiver. */
export const sameReceiver = (a, b, network = 'main') => w.same_receiver(a, b, network);
