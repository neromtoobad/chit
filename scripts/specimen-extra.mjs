// Memos for the Burn Book specimen's masks, poll and votes:
//   node scripts/specimen-extra.mjs   (then rerun the burnspecimen example)
// Signed memos use two fixed specimen mask keys. {POLL} in a memo is replaced with the
// poll's id once the first transaction exists.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const { ed25519 } = require('@noble/curves/ed25519');

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const mask = (byte) => new Uint8Array(32).fill(byte);
const sign = (body, sk) => `${body}\n~${b64url(ed25519.getPublicKey(sk))}.${b64url(ed25519.sign(new TextEncoder().encode(body), sk))}`;

const oracle = mask(0x0c);
const moth = mask(0x2a);
const out = {
  a: [
    { value: 30_000000, memo: sign('Every ZEC on this wall was burned by someone who wanted to be heard more than they wanted the money. Respect it.', oracle) },
    { value: 8_000000, memo: sign('Mask on. Wallet unlinkable. Reputation provable. This is what Zcash identity should feel like.', moth) },
    { value: 5_000000, memo: 'poll:Should Zcash burn 60% of transaction fees (ZIP 235)?|Yes, burn them|No, keep issuance|Burn them here instead' },
  ],
  b: [
    { value: 40_000000, memo: 'vote:{POLL}:0 scarcity is a feature' },
    { value: 15_000000, memo: 'vote:{POLL}:1' },
    { value: 22_000000, memo: 'vote:{POLL}:2 the black hole is right here' },
    { value: 9_000000, memo: 'vote:{POLL}:0' },
  ],
};
writeFileSync(new URL('../web/public/specimen/extra.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log('memo bytes', [...out.a, ...out.b].map((x) => Buffer.byteLength(x.memo)));
