# Chit

**Prove one shielded Zcash payment. Reveal nothing else.**

Shielded ZEC hides who paid whom. Sometimes you need to show one payment anyway: to a
merchant who says it never arrived, an exchange's support desk, an accountant, a DAO, or
the public, when you pay out prizes. Today the only way is to hand over your viewing key,
which reveals every payment you have ever made or received.

Chit turns **one** Orchard or Ironwood output into a short code, a *chit*. Anyone can check
the chit against the chain and see that output's amount, recipient and memo. They see
nothing else.

```
zout1qypqqqpp4sckleylqe5cleu303gy5m3t8lcsgzsa4dua3ljwdqz26ccwu4xgqhxzl0tkj2dne20skvhgpexyfvpxgfdzjm2uzkasgvp5t9v9y077t3g
```

It implements the Orchard and Ironwood output disclosures that draft
[ZIP 311](https://zips.z.cash/zip-0311) leaves as `TODO: Add support for Orchard`. The
proposed spec text is in [`docs/zip-0311-orchard-ironwood.md`](docs/zip-0311-orchard-ironwood.md).

## What you can do with it

- **Make and check chits.** Pick one output of your transaction, share it as a link or QR
  code, and let anyone verify it. The checker shows every cryptographic check as it runs.
- **Pay & prove.** A merchant creates a payment request: a ZIP 321 link with the amount,
  their address and an invoice reference in the memo. The customer pays it from Zodl in
  one tap and sends back their chit. Chit then checks it against the request and stamps it
  **Paid in full**, **Short**, **Wrong recipient** or **Memo mismatch**.
- **Proof of payouts.** Publish one ledger page that proves a set of shielded payments
  (prizes, grants, payroll) and their total, line by line. Recipients can be hidden, and it
  exports to CSV or JSON. The payer's wallet stays closed.
- **Developer kit:**
  - the `chit-zcash` npm package (WebAssembly, works in Node and the browser);
  - an embeddable `<chit-verify chit="zout1…">` badge;
  - the `chit` CLI;
  - the Rust crate.
- **The specimen.** A real, fully proven v6 Ironwood transaction that pays out five
  prizes. It is funded from nothing, so it is not on chain. It ships with the app, with
  its throwaway keys, so you can try every flow without a wallet. The app always labels it
  SPECIMEN and never calls it "on chain".

## Burn Book

**Say anything. Burn ZEC to say it. Nobody knows who.**

- **Posts are burns.** Each post is a shielded payment to an address nobody can ever
  spend from, with the message in the encrypted memo.
- **The black hole is provable.** The address's `ak` is a hash-to-curve point
  (`core/src/burn.rs`), so no spend key exists. Its viewing key is public: every reader
  decrypts and verifies every post in the browser, while burners stay anonymous.
- **Ranking:** by total ZEC burned. Boosts (`+<ref>`) and replies (`re:<ref>`) are burns too.
- **Called it:** a prediction time-locked to a drand round (tlock) inside the memo. Nobody
  can read it before its date, not even its author; the burn's block proves when it was
  said.
- **Burn polls:** `poll:Question|A|B|…`, then voting with `vote:<ref>:<k>`. Results are
  weighted by ZEC destroyed, and every voter is anonymous.
- **Masks:** an optional Ed25519 signature line, `~<pubkey>.<sig>`, from a key that lives
  only in your browser. It gives a pseudonymous reputation (total ZEC burned) that is
  provably yours and unlinkable to your wallet.
- **Share cards:** a 1200×630 image of any post, drawn locally, plus a Post on X link.
- **Listing:** a post's share link reads the burn straight from the chain. The public wall
  lists claimed txids: `./scripts/add-burn.sh <txid>` checks the burn is mined and paid to
  the black hole, then lists it and redeploys.

## What a chit reveals

|                                              | Viewing key | Chit |
|----------------------------------------------|:-----------:|:----:|
| This payment's amount, recipient and memo    | yes         | yes  |
| Every other payment you made or received     | yes         | no   |
| Your balance                                 | yes         | no   |
| Can be turned back into your key             |             | no   |

## How it works

- **The payer's chit** carries the output's *outgoing cipher key* `ock`, derived from the
  payer's outgoing viewing key. This is the mechanism ZIP 311 specifies for Sapling,
  applied to Orchard-protocol Actions.
- **The payee's chit** carries `pk_d || esk`. A recipient can rebuild the note's ephemeral
  secret `esk` from its `rseed` (ZIP 212), so the person who was paid can prove what they
  received. ZIP 311 has no equivalent.
- **Checking** a chit re-runs the decryption a wallet runs on that one output, with the
  official crates (`orchard` 0.16, `zcash_note_encryption` 0.5.1, `zcash_primitives` 0.31):
  - the AEAD tag must verify;
  - the ZIP 212 `esk` must be consistent;
  - `[esk] g_d` must equal the ephemeral key;
  - the recomputed note commitment must equal the on-chain `cmx`;
  - the note plaintext's lead byte must match the pool (`0x02` Orchard, `0x03` Ironwood).

  Change one character and the check fails.
- **What it does not prove:** who is showing it to you. A chit proves what an output
  contains, and anyone it is forwarded to can present it. ZIP 311's signed spend-authority
  proofs are future work; see the spec.

## Privacy model

- **No backend.** The web app is static files. There is no server, account, cookie or
  analytics.
- **Keys stay in the tab.** The viewing key is read, used for one scan, and the input is
  cleared. It is never sent anywhere. In WebAssembly the crypto has no network access, and
  the page's Content-Security-Policy only allows connections to itself and to the explorer.
- **Chits travel in the URL fragment** (`#/v/zout1…`). Browsers never send the fragment to
  a server, so whoever hosts the page never sees a chit.
- **The one disclosed leak.** To check a chit, the app fetches that transaction from
  Blockchair's public API, so Blockchair learns that someone looked up that txid. If you
  don't want that, paste the raw transaction from your own node: *Check without the
  explorer* in the app, or `--tx` in the CLI. The app then says it checked against a
  transaction you supplied, because that alone does not prove the transaction was mined.

## What is real, what is not

- **Real:** everything described above works against Zcash mainnet today, for Ironwood
  (NU6.3) and for historical Orchard outputs, payer and payee side. Tests cover:
  - a fully proven, signed v6 Ironwood transaction built with the official builder;
  - a real mainnet Ironwood transaction (`ae3e37db…`);
  - forgery cases: flipped key bits, the wrong output, the wrong pool, the wrong
    transaction, and a guessed key.
- **Not included:**
  - Sapling outputs. They are already specified by ZIP 311, but not wired in here.
  - Spend-authority proofs.
  - A testnet explorer. On testnet, paste the raw transaction.
- **The test transaction is synthetic.** It is cryptographically real but funded from
  nothing, so it is not on chain. Its viewing keys are throwaway test keys.

## Use it

### Web

Open the app, then:

- **Make:** paste a txid and your Unified Full Viewing Key (`uview1…`). Zodl exports one
  under Settings → Export viewing key. Pick an output and share the link or QR code.
- **Check:** open a chit link, or paste a chit code.
- **Ledger:** tick several outputs to get one page that verifies all of them, with a
  total. Use it to prove a set of payouts, such as a hackathon paying its winners, without
  showing the payer's wallet.

### CLI

```bash
cargo install --path cli
```

```bash
chit make <txid> --key-file my.ufvk
```

```bash
chit check zout1…
```

```bash
chit check zout1… --tx raw.hex
```

The viewing key is read from a file or `CHIT_UFVK`, never from the command line, so it
stays out of shell history. `--json` gives machine-readable output.

### Rust

```rust
let tx = chit_core::parse_tx(&raw_bytes)?;
for found in chit_core::scan(&tx, ufvk, NetworkType::Main)? {
    println!("{} zat → {}  {}", found.value_zat, found.recipient, found.disclosure);
}
let v = chit_core::verify(&tx, &chit_core::Disclosure::decode(chit)?)?;
```

### JavaScript (WebAssembly)

`./scripts/npm.sh` builds the `chit-zcash` package (`npm/chit-zcash-0.1.0.tgz`). It works in
Node and the browser, and does no I/O:

```js
import { ready, verify } from 'chit-zcash';
await ready();
const report = verify(rawTxHex, 'zout1…');   // { valid, verified, steps: [{ label, ok }] }
```

### Embed

```html
<script type="module" src="https://chit.nerom.site/embed.js"></script>
<chit-verify chit="zout1…"></chit-verify>
```

## Build

You need Rust (stable) with the `wasm32-unknown-unknown` target, `wasm-pack`, the
`llvm-tools` component, and Node 20+.

```bash
rustup target add wasm32-unknown-unknown && rustup component add llvm-tools
```

```bash
cargo test --release
```

```bash
./scripts/build.sh
```

`scripts/build.sh` builds the WebAssembly package and the static site into `web/dist`.
macOS `ar` cannot index wasm objects, which breaks the `secp256k1-sys` C dependency;
`.cargo/config.toml` points the wasm build at rustup's `llvm-ar` instead.

## Layout

| Path | What |
|---|---|
| `core/` | `chit-core`: encoding, scan, verify. Unit tests in `src/tests.rs`, integration tests in `tests/` |
| `core/examples/fixture.rs` | builds the proven synthetic Ironwood transaction in `tests/fixtures/` |
| `core/examples/specimen.rs` | builds the public five-payout specimen in `web/public/specimen/` |
| `npm/` | the `chit-zcash` package wrapper |
| `wasm/` | WebAssembly bindings |
| `cli/` | the `chit` command |
| `web/` | the static web app (Vite, TypeScript, no framework) and the `<chit-verify>` embed |
| `docs/` | the proposed ZIP 311 text |

## License

MIT or Apache-2.0, at your option. These are the licenses of the Zcash crates it builds on.
