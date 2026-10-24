//! Builds a real, fully proven and signed v6 transaction with an Ironwood bundle (Alice
//! pays Bob 1.25 ZEC with a memo, plus change) and writes it with both wallets' viewing
//! keys to `tests/fixtures/`. It funds the bundle from nothing, so it is valid to parse and
//! to disclose but would never be accepted by the network.
//!
//!     cargo run -p chit-core --release --example fixture

use orchard::{
    builder::{Builder, BundleType},
    bundle::BundleVersion,
    circuit::ProvingKey,
    keys::{FullViewingKey, Scope, SpendingKey},
    tree::Anchor,
    value::NoteValue,
};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::transaction::TransactionData;
use zcash_protocol::consensus::{BlockHeight, BranchId, Network};

fn memo(text: &str) -> [u8; 512] {
    let mut m = [0u8; 512];
    m[..text.len()].copy_from_slice(text.as_bytes());
    m
}

fn main() {
    let mut rng = rand::rng();
    let alice = FullViewingKey::from(&SpendingKey::from_bytes([0xa1; 32]).unwrap());
    let bob = FullViewingKey::from(&SpendingKey::from_bytes([0xb0; 32]).unwrap());

    let version = BundleVersion::ironwood_v3();
    let mut b = Builder::new(BundleType::DEFAULT, version, version.default_flags(), Anchor::empty_tree()).unwrap();
    b.add_output(Some(alice.to_ovk(Scope::External)), bob.address_at(0u32, Scope::External), NoteValue::from_raw(125_000_000), memo("ZECATHON prize · track 4")).unwrap();
    b.add_output(Some(alice.to_ovk(Scope::Internal)), alice.address_at(0u32, Scope::Internal), NoteValue::from_raw(31_415_926), [0xf6; 512]).unwrap();
    let (bundle, _) = b.build::<i64>(&mut rng).unwrap().unwrap();

    eprintln!("building proving key…");
    let pk = ProvingKey::build(bundle.circuit_version());
    let bundle = bundle
        .create_proof(&pk, &mut rng)
        .unwrap()
        .apply_signatures(&mut rng, [0u8; 32], &[])
        .unwrap();
    let bundle = bundle.try_map_value_balance(|v: i64| zcash_protocol::value::ZatBalance::from_i64(v)).unwrap();

    let tx = TransactionData::from_parts_v6(BranchId::Nu6_3, 0, BlockHeight::from_u32(3_530_000), None, None, None, Some(bundle))
        .freeze()
        .unwrap();
    let mut bytes = Vec::new();
    tx.write(&mut bytes).unwrap();

    let ufvk = |fvk: FullViewingKey| UnifiedFullViewingKey::new(None, Some(fvk)).unwrap().encode(&Network::MainNetwork).unwrap();
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
    std::fs::write(format!("{dir}/synthetic.hex"), hex::encode(&bytes)).unwrap();
    std::fs::write(format!("{dir}/synthetic.alice.ufvk"), ufvk(alice)).unwrap();
    std::fs::write(format!("{dir}/synthetic.bob.ufvk"), ufvk(bob)).unwrap();
    println!("{}", tx.txid());
}
