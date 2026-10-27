# Security and threat model

Chit proves that one shielded output, in one transaction, holds a given value, recipient and
memo. This page says what that proof does and does not establish, what Chit protects, what
it leaks, and what was found and fixed in review.

**Status: hackathon software.** It has had an adversarial internal review (below), not a
third-party audit. Do not settle large sums on a chit alone.

## What a valid chit proves

- The transaction's bytes hash to the txid in the chit (ZIP 244), so the transaction cannot be swapped.
- The named Action's note opens with the chit's key material. Opening means:
  - the AEAD tag verifies;
  - the ZIP 212 `esk` re-derives from the note's `rseed`;
  - `[esk]·g_d` equals the on-chain ephemeral key;
  - the note commitment recomputes to the on-chain `cmx`.
  Both Chit's own step-by-step checks and `zcash_note_encryption`'s recovery routine must agree, or the result is a failure.
- The note's version byte matches the pool the chit names (`0x02` Orchard, `0x03` Ironwood), so a note cannot be passed off as another pool's.
- When the transaction came from a source (Blockchair, or your own node through `chit serve`), that source says whether, and at what height, it is mined.

## What it does not prove

- **Who is showing it.** A chit is a bearer proof. Anyone it is forwarded to can present it.
- **Who sent the payment.** Chits carry no spend-authority signature. A payer form (`ock`) and a payee form (`pk_d ‖ esk`) say which keys open the note, not who made the chit:
  - the payer's wallet chose `rseed`, so the payer knows `esk` too;
  - anyone holding an `ock` chit can decrypt `pk_d ‖ esk` and re-encode it.
- **That a transaction is mined, unless a source says so.** `parse_tx` does not check proofs or signatures. A pasted transaction, or `tx_hex` sent to the API, is checked only for the disclosure. It could be one that was never broadcast. The network lives in the chit's prefix, not in the transaction.
  - The UI labels such checks "Pasted tx" or "Not mined".
  - The API's `valid` field means only that the chit opens its output; integrators must also require `mined.height`.
  - Invoices show "Paid" only for mined transactions.
- **That the money stayed there.** The recipient may have spent it since.
- **That an output was a payout.** A ledger shows which outputs exist and what they hold. It does not show that the publisher paid them, or that hidden recipients are not the publisher's own addresses. Change outputs cannot be added to a ledger from the Make page.

## What stays private

- **Other outputs and the wallet.** `ock` is a PRF output bound to one Action's `cv_net`, `cmx` and `epk`, under the sender's `ovk`.
  - It opens that one Action's `outCiphertext` and nothing else.
  - It cannot be turned back into the `ovk`, the viewing key or the spending key.
  - The other outputs of the same transaction stay sealed. The judges' tour shows this live.
- **Keys.** The viewing key is used inside the browser tab, in WebAssembly, and the field is cleared immediately after.
  - It is never sent anywhere. The web app has no backend.
  - The CLI reads it from a file or an environment variable, never from command-line arguments.
  - The input is not a password field, so password managers do not offer to store it.
- **Links.** Chits, requests and ledgers live in the URL fragment. Browsers never send the fragment to the server hosting the page.

## What leaks, and to whom

| Leak | To whom | How to avoid it |
| --- | --- | --- |
| The txid of every chit you check, and the txid you make a chit from | Blockchair, along with your IP address | Paste the raw transaction instead, or run `chit serve --rpc` next to your own Zebra node. The app then talks only to that node. |
| Chain statistics on the home page | Blockchair (no txid) | Self-host |
| Opening a sealed prediction | the drand HTTP API (only the round number) | — |
| Transactions you have already looked up | stored in this browser's IndexedDB cache (mined transactions only) | Clear site data |
| Burn Book claims | kept in session storage, gone when the tab closes | — |
| Claiming a fresh burn | Blockchair sees the first lookup of that txid, which probably comes from the author | Use Tor, wait, or self-host. Submit the txid to the public index from an account not linked to you. |
| A chit itself | whoever you give it to sees that output's value, recipient address and memo, plus the transaction's public data (time, fee, number of actions) | — |

## The Burn Book address

- The address is a provable black hole. Its `ak` is a point hashed onto the Pallas curve from the public string `z.cash:Chit-BurnBook`.
  - Spending a note needs the `ask` with `ak = [ask]·G`, which is a discrete logarithm nobody knows.
  - `nk` and `rivk` are public on purpose. They make every post readable, and they do not help anyone spend.
- `core/src/burn.rs` derives the address, and a test re-derives it independently. The app re-derives it in the browser at `#/burn/proof`.
- ZEC sent there is destroyed.

## Review findings and fixes

An adversarial review read the whole repository on 2026-10-27. Fixed in this release:

| # | Finding | Fix |
| --- | --- | --- |
| H1 | **Pay & prove spoofing.** The payer could edit the request inside the link they sent back, for example lower the amount, and the merchant would see "Paid". Unmined and pasted transactions could also show "Paid". The memo reference matched as a substring, so `INV-1` matched `INV-10`. | Requests made on a device are remembered there. "Paid" now needs: the payee's own request, a mined transaction, and an exact reference match on token boundaries. A request that came with the link is marked as not made on this device. |
| H2 | **Burn Book deanonymisation.** The claim flow asked users to DM the maintainer. Claims were stored on the device permanently. | The DM instruction is removed. Claims are kept in session storage only. The page warns that the first lookup of a fresh burn goes to Blockchair. |
| H3 | **Ledger inflation.** Change outputs could pad a ledger, and the page claimed it proved "every payment". | Change outputs can't be ticked. Unmined rows are not counted. The payee form is labelled. The wording now states what is proven, and warns when recipients are hidden. |
| M1 | **"On chain · Valid" without being mined.** The certificate and the embed badge showed it for transactions that were not mined. | The certificate shows "Not mined yet" and the badge shows "Wait". API semantics are documented above. |
| M2 | **Post-ref collisions.** Post refs are 40 bits of the txid, so a later transaction could be ground to collide with a popular post. | On a collision, the earliest mined post keeps the ref, and replies, boosts and votes attach only to it. |
| M3 | **Back-dated "Called it".** A prediction sealed to a round that had already passed could still show "Called it". | A seal is marked "Sealed in advance" only if it was mined before its round. One mined after its own opening time is flagged. |
| M4 | **Replayed mask signatures.** A copy of a signed memo, burned by anyone, counted toward that mask. | Only the first copy, by block height, is attributed to the mask. |
| M5 | **Server exposure.** `/v1/scan` took viewing keys with no opt-in. There were no upstream timeouts, and a panic killed a worker thread for good. | `/v1/scan` is off unless the server runs with `--allow-scan`. Upstream calls time out after 20 seconds. Panics are contained per request. The Docker example binds to 127.0.0.1. |
| M6 | **"Made with the payee's viewing key" was not true.** The payer also knows `esk`. | The UI, CLI and spec now name the key form, and do not claim who made the chit. |
| L1–L6 | Smaller issues. | The viewing-key field is no longer a password field. Path checks are safe on Windows. The Make self-check now uses the pasted transaction. A malformed `%` in the URL no longer blanks the page. The embed badge no longer takes transactions from the page that hosts it. Every leak is listed above. |

Still open, by design or for later:

- `chit serve` has no read timeouts of its own (tiny_http). Put it behind a reverse proxy with timeouts and TLS before exposing it.
- One payment whose memo carries several references can satisfy several invoices. A merchant should record which output settled which invoice.
- Chits have no sender signature. Adding one would need an Orchard spend-authority proof, which ZIP 311 also leaves as a TODO.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (Security → Report a
vulnerability). Please do not open a public issue for anything that could cost someone money
or privacy.
