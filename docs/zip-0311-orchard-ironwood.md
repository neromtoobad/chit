    ZIP: 311 (proposed amendment)
    Title: Output Disclosures for Orchard and Ironwood
    Owners: neromtoobad <https://github.com/neromtoobad>
    Status: Draft
    Category: Standards / Wallet
    Amends: ZIP 311 "Zcash Payment Disclosures" (Draft)
    Discussions-To: <https://github.com/zcash/zips/issues/387>

# Terminology

The key words "MUST", "MUST NOT", "SHOULD" and "MAY" are to be interpreted as described in
RFC 2119.

"Orchard pool" and "Ironwood pool" are as in ZIP 258. Both are uses of the Orchard protocol.
An *Action output* is the note created by one Action description in an Orchard-protocol
bundle.

# Abstract

ZIP 311 specifies how a sender discloses the contents of a Sapling output with its outgoing
cipher key `ock`, and leaves Orchard as "TODO: Add support for Orchard". It defines no
encoding.

This document fills that gap for the Orchard and Ironwood pools. It specifies:

- an **outgoing** output disclosure, made from the payer's outgoing viewing key, carrying
  `ock`. This is the direct Orchard counterpart of ZIP 311's `saplingOutputs`;
- an **incoming** output disclosure, made from the payee's incoming viewing key, carrying
  `pk_d || esk`. This lets the recipient of a payment prove what it received, which ZIP 311
  does not cover;
- a verification procedure that works for notes in both pools;
- a versioned Bech32m encoding.

These are *unsigned* output disclosures. They prove what one output contains. They do not
prove who is presenting them. Proving spend authority, which ZIP 311 requires of a full
payment disclosure, is out of scope (see "Relationship to ZIP 311").

# Motivation

After NU6.3, shielded value lives in the Ironwood pool, and the remaining Orchard notes can
only leave it. A Zcash user who must show that a specific shielded payment happened has two
options today: share a full viewing key, which reveals their entire history, or share
nothing. Merchants, support desks, accountants, grant programmes and prize payers need a
middle ground: proof of one payment, and nothing else.

# Specification

## Outgoing disclosure (payer)

Let `act` be an Action description in an Orchard or Ironwood bundle of transaction `tx`,
created with outgoing viewing key `ovk`. The payer computes

    ock = PRF^ock_Orchard(ovk, cv_net, cmx, ephemeralKey)

using `act`'s fields, as in §4.20.3 of the protocol specification. If the payer created the
output with `ovk = ⊥`, no outgoing disclosure exists for it. This keeps the meaning of `⊥`,
as ZIP 311 notes for Sapling.

The disclosure carries `ock` (32 bytes).

## Incoming disclosure (payee)

A payee that has decrypted `act` with its incoming viewing key holds the note, including
`rseed`, and `ρ = act.nf`. The payee computes

    esk = ToScalar^Orchard(PRF^expand_rseed([4] || I2LEOSP_256(ρ)))

as required by ZIP 212. It sets `pk_d` to the transmission key of the note's recipient
address. The disclosure carries `pk_d || esk` (64 bytes). This is the same encoding as the
outgoing plaintext `OutPlaintext`, so verification can share code with the outgoing case.

## Verification

Given a disclosure `d` and a transaction `tx`, a verifier MUST check, and fail if any check
fails:

1. `d.txid = tx.txid()`.
2. `tx` has a bundle for `d.pool`, and `d.action < length(bundle.actions)`.
   Let `act = bundle.actions[d.action]`.
3. It derives the key material:
   - For an outgoing disclosure: decrypt `act.outCiphertext` with `d.ock` (AEAD
     ChaCha20Poly1305, zero nonce) to obtain `pk_d || esk`.
   - For an incoming disclosure: take `pk_d || esk` from `d`.

   `pk_d` MUST decode to a non-identity Pallas point. `esk` MUST decode to a canonical
   non-zero scalar.
4. `sharedSecret = KA^Orchard.Agree(esk, pk_d)`. Decrypt `act.encCiphertext` with
   `KDF^Orchard(sharedSecret, ephemeralKey)`.
5. The note plaintext lead byte MUST be `0x02` if `d.pool` is Orchard, and `0x03` if
   `d.pool` is Ironwood (ZIP 2005). A note MUST NOT verify in the other pool's domain.
6. Parse `(d, v, rseed, memo)` with the recipient `(d, pk_d)`. Check that `esk` equals the
   value ZIP 212 derives from `rseed` and `ρ = act.nf`, that `[esk] g_d` equals
   `ephemeralKey`, and that the recomputed `cmx` equals `act.cmx`.

On success the verifier learns `v`, the recipient address `(d, pk_d)` and the memo. Steps
3 to 6 are exactly the last half of DecryptOVK (§4.20.3). An implementation SHOULD use its
wallet's existing routine: `try_output_recovery_with_ock` and
`try_output_recovery_with_pkd_esk` in `zcash_note_encryption`, with `OrchardDomain` or
`IronwoodDomain` from the `orchard` crate.

The verifier MUST also establish that `tx` is mined, from its own node or a source it
trusts. A disclosure checked only against a transaction supplied alongside it proves only
that it is consistent with that transaction.

## Encoding

An output disclosure is encoded as Bech32m (BIP 350) with no 90-character length limit (as
in ZIP 316). The human-readable part is `zout` for Mainnet and `zouttest` for Testnet and
Regtest.

The payload, version 1, is:

| Bytes | Field |
|---|---|
| 1 | `version` = `0x01` |
| 1 | flags: bits 0–1 pool (`1` Orchard, `2` Ironwood; `0` reserved for Sapling); bit 2 kind (`0` outgoing, `1` incoming); bits 3–7 MUST be zero |
| 2 | action index, little-endian |
| 32 | txid, internal byte order |
| 32 or 64 | `ock` (outgoing), or `pk_d ‖ esk` (incoming) |

A decoder MUST reject an unknown version, a reserved pool value, non-zero reserved bits, or a
key length that does not match the kind. An outgoing disclosure is 120 characters on
Mainnet. An incoming one is 171.

The prefix is deliberately not shared with a future signed ZIP 311 payment disclosure, so
that an unsigned output disclosure can never be shown as one (ZIP 311 Rationale).

## Display

A UI showing a valid disclosure:

- MUST show the value, the recipient, the memo, the txid and the action index;
- MUST say whether the transaction was confirmed as mined, and from what source;
- MUST NOT describe the disclosure as proof of who sent the payment, or of who is presenting
  it. It MAY say which key form it carries (`ock`, or `pk_d || esk`). It MUST NOT say that a
  `pk_d || esk` disclosure was made by the payee: the payer's wallet chose `rseed`, so the
  payer knows `esk` too, and anyone holding an `ock` disclosure can decrypt `pk_d || esk`
  from it and re-encode it in that form. Anyone the disclosure is forwarded to can present it;
- SHOULD show the recipient as a Unified Address that contains only the disclosed receiver.
  For Ironwood notes that receiver uses typecode `0x03`, as in ZIP 258.

# Privacy and security

- **Scope.** `ock` is a PRF output bound to one Action's `cv_net`, `cmx` and
  `ephemeralKey`. It cannot be inverted to `ovk` and it opens no other output. `esk` opens
  only the Action it was derived for. Recovering `ivk` from `(pk_d, esk)` is a discrete
  logarithm problem. A disclosure reveals no balance, no other payment, and no other
  address of either party.
- **Recipient-side.** An incoming disclosure reveals the payee's receiver `(d, pk_d)` to
  whoever holds it. That is the point: it is the address being paid. It does not reveal the
  payee's other diversified addresses.
- **No forgery.** A disclosure that verifies must open a real note that matches the
  on-chain commitment. Changing any field breaks the AEAD tag, the ZIP 212 `esk` check or
  the `cmx` check.
- **Lookup leakage.** Fetching `tx` from a third-party explorer tells that explorer someone
  is looking at `txid`. Verifiers SHOULD offer to verify against a transaction fetched from
  their own node. When disclosures travel in URLs, they SHOULD be placed in the fragment,
  which browsers do not send to servers.
- **Viewing keys.** Software that creates disclosures from a UFVK SHOULD process the key
  locally and keep it no longer than the scan.

# Relationship to ZIP 311

ZIP 311 payment disclosures prove spend authority for at least one input, and they are
non-malleable. Output disclosures do neither. They are the `saplingOutputs` component, for
Orchard and Ironwood, standing on its own. For Orchard, spend authority could follow the
Sapling design: a fresh Action statement proof for the spent note against the transaction's
anchor, with a re-randomized `rk` and a `SpendAuthSig` over the ZIP 311 digest. That needs
the note's witness and the spending key, so it is left for a later revision. An output
disclosure defined here can be embedded unchanged in such a signed disclosure.

# Test vectors

Transaction `e50e63ad04684efed879ab1d0a04f13f2b6e4a507c91e78f69069fe46f31ac21` is a v6
transaction (NU6.3) with one Ironwood bundle. It is fully proven and signed, but its
transparent value is not funded, so it is not on chain. The raw hex and both wallets'
UFVKs are in `core/tests/fixtures/synthetic.*`.

| Kind | Action | Value | Disclosure |
|---|---|---|---|
| outgoing | 0 | 1.25 ZEC, memo "ZECATHON prize · track 4" | `zout1qypqqqpp4sckleylqe5cleu303gy5m3t8lcsgzsa4dua3ljwdqz26ccwu4xgqhxzl0tkj2dne20skvhgpexyfvpxgfdzjm2uzkasgvp5t9v9y077t3g` |
| incoming | 0 | 1.25 ZEC, as above | `zout1qyrqqqpp4sckleylqe5cleu303gy5m3t8lcsgzsa4dua3ljwdqz26ccwukwxvwn7764ph7d38actk9dj32t2u8zc2xvh6rudf8ldun3gklqgf6xdpxxvgdm3vwx4tldm3rz620wta3u84arup5lflmuxjej5hsczkgmyty` |
| incoming (payer's change) | 1 | 0.31415926 ZEC, empty memo | `zout1qyrqzqpp4sckleylqe5cleu303gy5m3t8lcsgzsa4dua3ljwdqz26ccwu4m44f3kkp7msfewceu5kp9hljhtf466fhgkjmr07sgcdasrux02274p3s39vl4khxlkqat3yzmtspxe7f3f9vtzkzk6alzfwjfuedg6evsfgr` |

The recipient of action 0 is
`u1ds00364hcspuwc0mstjy8fth8cnpnj0lp4mnw54qk54gh50zn3matkvc54m6w6p0v6jn6q0r9rc9mseq0xwej6waz7kpe7akzymgd93w`.

The disclosures above are randomized. Regenerating the fixture produces new ones, and the
committed fixture is the reference.

# Reference implementation

`chit-core` in this repository. It is a Rust crate on `orchard` 0.16,
`zcash_note_encryption` 0.5.1 and `zcash_primitives` 0.31, with WebAssembly bindings and a
CLI.

# References

- ZIP 311: Zcash Payment Disclosures (Draft).
- ZIP 212: Allow Recipient to Derive Ephemeral Secret from Note Plaintext.
- ZIP 258: Deployment of the NU6.3 Network Upgrade (Ironwood).
- ZIP 2005: Quantum-recoverable note plaintexts.
- ZIP 316: Unified Addresses and Unified Viewing Keys.
- BIP 350: Bech32m.
- Zcash Protocol Specification, §4.20.3 Decryption using an Outgoing Viewing Key, and
  §5.4.2 Pseudo Random Functions.
