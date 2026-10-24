# chit-zcash

Verify Zcash Orchard and Ironwood output disclosures ("chits") in Node or the browser.
It wraps the official Zcash crates, compiled to WebAssembly, and does no network I/O:
you fetch the raw transaction, it checks the chit.

```js
import { ready, verify } from 'chit-zcash';
await ready();
const report = verify(rawTxHex, 'zout1…');
if (report.valid) console.log(report.verified.value_zat, report.verified.memo);
for (const s of report.steps) console.log(s.ok, s.label);
```

The spec is at https://github.com/neromtoobad/chit/blob/main/docs/zip-0311-orchard-ironwood.md.
