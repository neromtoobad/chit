//! Property tests: whatever bytes or strings arrive from the outside (a pasted chit, a
//! fetched transaction, a viewing key), the core returns an error and never panics, and
//! every valid disclosure survives an encode/decode round trip.

use chit_core::{parse_tx, scan, verify, Disclosure, KeyMaterial, Pool};
use proptest::prelude::*;
use zcash_protocol::{consensus::NetworkType, TxId};

fn pool() -> impl Strategy<Value = Pool> {
    prop_oneof![Just(Pool::Orchard), Just(Pool::Ironwood)]
}

fn key() -> impl Strategy<Value = KeyMaterial> {
    prop_oneof![
        any::<[u8; 32]>().prop_map(KeyMaterial::Ock),
        prop::collection::vec(any::<u8>(), 64)
            .prop_map(|v| KeyMaterial::PkdEsk(v.try_into().unwrap())),
    ]
}

fn specimen() -> zcash_primitives::transaction::Transaction {
    parse_tx(&hex::decode(include_str!("fixtures/synthetic.hex").trim()).unwrap()).unwrap()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn disclosures_round_trip(net in prop_oneof![Just(NetworkType::Main), Just(NetworkType::Test)], txid in any::<[u8; 32]>(), pool in pool(), action in any::<u16>(), key in key()) {
        let d = Disclosure { network: net, txid: TxId::from_bytes(txid), pool, action, key };
        prop_assert_eq!(Disclosure::decode(&d.encode()).unwrap(), d);
    }

    #[test]
    fn arbitrary_strings_never_panic_the_decoder(s in ".{0,300}") {
        let _ = Disclosure::decode(&s);
    }

    #[test]
    fn mutated_disclosures_are_rejected_or_differ(txid in any::<[u8; 32]>(), action in any::<u16>(), ock in any::<[u8; 32]>(), at in 0usize..120, c in prop::sample::select(b"qpzry9x8gf2tvdw0s3jn54khce6mua7l".to_vec())) {
        let d = Disclosure { network: NetworkType::Main, txid: TxId::from_bytes(txid), pool: Pool::Ironwood, action, key: KeyMaterial::Ock(ock) };
        let s = d.encode();
        let mut chars: Vec<char> = s.chars().collect();
        let i = 5 + at % (chars.len() - 5);
        if chars[i] != c as char {
            chars[i] = c as char;
            // A one-character change must break the Bech32m checksum.
            prop_assert!(Disclosure::decode(&chars.into_iter().collect::<String>()).is_err());
        }
    }

    #[test]
    fn arbitrary_bytes_never_panic_the_transaction_parser(bytes in prop::collection::vec(any::<u8>(), 0..2048)) {
        let _ = parse_tx(&bytes);
    }

    #[test]
    fn truncated_and_corrupted_transactions_never_panic(cut in 0usize..18000, flip in 0usize..18000, bit in 0u8..8) {
        let mut bytes = hex::decode(include_str!("fixtures/synthetic.hex").trim()).unwrap();
        let n = bytes.len();
        bytes[flip % n] ^= 1 << bit;
        bytes.truncate(cut % (n + 1));
        if let Ok(tx) = parse_tx(&bytes) {
            let _ = scan(&tx, include_str!("fixtures/synthetic.alice.ufvk"), NetworkType::Main);
        }
    }

    #[test]
    fn random_keys_never_verify_and_never_panic(action in 0u16..8, pool in pool(), key in key()) {
        let tx = specimen();
        let d = Disclosure { network: NetworkType::Main, txid: tx.txid(), pool, action, key };
        prop_assert!(verify(&tx, &d).is_err());
        let r = chit_core::verify_with_steps(&tx, &d);
        prop_assert!(r.result.is_err());
        prop_assert_eq!(r.steps.last().unwrap().ok, Some(false));
    }

    #[test]
    fn arbitrary_viewing_keys_never_panic(s in "(uview1)?[a-z0-9]{0,200}") {
        let _ = scan(&specimen(), &s, NetworkType::Main);
    }
}
