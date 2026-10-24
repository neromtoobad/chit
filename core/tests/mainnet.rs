//! Parses a real mainnet v6 transaction with an Ironwood bundle.

use chit_core::{parse_tx, verify, Disclosure, Error, KeyMaterial, Pool};
use zcash_protocol::consensus::NetworkType;

const TXID: &str = "ae3e37dbffde0d00c80f294bdcf23118d3bc1fe053896cdcba402c86868baa87";

fn tx() -> zcash_primitives::transaction::Transaction {
    let hex = include_str!("fixtures/ae3e37db.hex").trim();
    parse_tx(&hex::decode(hex).unwrap()).unwrap()
}

#[test]
fn parses_ironwood_tx_and_computes_its_txid() {
    let tx = tx();
    assert_eq!(tx.txid().to_string(), TXID);
    assert!(tx.ironwood_bundle().unwrap().actions().len() >= 2);
}

#[test]
fn rejects_a_guessed_key() {
    let d = Disclosure {
        network: NetworkType::Main,
        txid: chit_core::parse_txid(TXID).unwrap(),
        pool: Pool::Ironwood,
        action: 0,
        key: KeyMaterial::Ock([1; 32]),
    };
    assert_eq!(verify(&tx(), &d), Err(Error::Invalid));
}

#[test]
fn rejects_the_wrong_transaction() {
    let d = Disclosure {
        network: NetworkType::Main,
        txid: chit_core::parse_txid(&"00".repeat(32)).unwrap(),
        pool: Pool::Ironwood,
        action: 0,
        key: KeyMaterial::Ock([1; 32]),
    };
    assert!(matches!(verify(&tx(), &d), Err(Error::TxidMismatch { .. })));
}
