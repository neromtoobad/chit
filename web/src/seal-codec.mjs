// "Called it": predictions sealed with drand time-lock encryption (tlock) and burned into
// a Zcash memo. Nobody, including the author, can read one before its drand round; after
// it, anyone can. The burn's block height proves when it was sealed.
//
// A tlock ciphertext is an age file whose header is mostly constant. To fit a 512-byte
// memo we keep only what varies and rebuild the rest:
//
//   memo = "seal:" + base64url( round u32 BE ‖ stanza body ‖ header MAC (32) ‖ payload )
//
// The stanza body is the tlock IBE ciphertext (fixed size for one drand chain); the payload
// is age's nonce, ChaCha20-Poly1305 ciphertext and tag.

import { timelockEncrypt, timelockDecrypt, mainnetClient, roundAt, roundTime } from 'tlock-js';
import { Buffer } from 'buffer';

// drand quicknet, the chain mainnetClient() follows.
export const CHAIN_HASH = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const PREFIX = 'seal:';
const AGE = 'age-encryption.org/v1';

let client;
const drand = () => (client ??= mainnetClient());

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const wrap = (s, n = 64) => s.match(new RegExp(`.{1,${n}}`, 'g')).join('\n');

export const isSealed = (memo) => typeof memo === 'string' && memo.startsWith(PREFIX);

/** Encrypts `text` so it opens at `when` (a Date). Returns the memo string. */
export async function seal(text, when) {
  const info = await drand().chain().info();
  if (info.hash !== CHAIN_HASH) throw new Error('Unexpected drand chain.');
  const round = roundAt(when.getTime(), info);
  const armored = await timelockEncrypt(round, Buffer.from(text, 'utf8'), drand());
  const bin = Buffer.from(armored.split('\n').filter((l) => l && !l.startsWith('-----')).join(''), 'base64');
  const s = bin.toString('latin1');
  const macAt = s.indexOf('\n--- ');
  const macEnd = s.indexOf('\n', macAt + 1);
  const lines = s.slice(0, macAt).split('\n');
  const stanza = Buffer.from(lines.slice(2).join(''), 'base64');
  const mac = Buffer.from(s.slice(macAt + 5, macEnd), 'base64');
  const payload = bin.subarray(macEnd + 1);
  const r = Buffer.alloc(4);
  r.writeUInt32BE(round);
  return PREFIX + b64url(Buffer.concat([r, Buffer.from([stanza.length]), stanza, mac, payload]));
}

/** Reads the round of a sealed memo without decrypting it. */
export function sealRound(memo) {
  return unb64url(memo.slice(PREFIX.length)).readUInt32BE(0);
}

export async function opensAt(memo) {
  const info = await drand().chain().info();
  return new Date(roundTime(info, sealRound(memo)));
}

/** Opens a sealed memo once its round has passed. Throws before that. */
export async function unseal(memo) {
  const bin = unb64url(memo.slice(PREFIX.length));
  const round = bin.readUInt32BE(0);
  const n = bin[4];
  const stanza = bin.subarray(5, 5 + n);
  const mac = bin.subarray(5 + n, 5 + n + 32);
  const payload = bin.subarray(5 + n + 32);
  const header = `${AGE}\n-> tlock ${round} ${CHAIN_HASH}\n${wrap(b64(stanza).replace(/=+$/, ''))}\n--- ${b64(mac).replace(/=+$/, '')}\n`;
  const file = Buffer.concat([Buffer.from(header, 'latin1'), payload]);
  const armored = `-----BEGIN AGE ENCRYPTED FILE-----\n${wrap(b64(file))}\n-----END AGE ENCRYPTED FILE-----\n`;
  return (await timelockDecrypt(armored, drand())).toString('utf8');
}
