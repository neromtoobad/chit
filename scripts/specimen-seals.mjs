// Seals the specimen predictions for the Burn Book specimen wall:
//   node scripts/specimen-seals.mjs   (then rerun the burnspecimen example)
import { writeFileSync } from 'node:fs';
const { seal } = await import(new URL('../web/src/seal-codec.mjs', import.meta.url));
const memos = [
  await seal('Called it: someone ships ZIP 311 for Orchard before the Zecathon closes.', new Date(Date.now() - 60_000)),
  await seal('Prediction for winners day: the most-burned post on this wall is not the one you expect.', new Date('2026-11-23T12:00:00Z')),
];
writeFileSync(new URL('../web/public/specimen/seals.json', import.meta.url), JSON.stringify({ memos }, null, 2) + '\n');
console.log(memos.map((m) => Buffer.byteLength(m)));
