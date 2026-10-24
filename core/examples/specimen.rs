//! Builds the public *specimen*: a fully proven and signed v6 transaction whose Ironwood
//! bundle pays out five hackathon-style prizes, plus change. It is funded from nothing, so
//! it is not and never will be on chain. The web app ships it, clearly labelled, so anyone
//! can try every flow without a wallet. Its keys are throwaway.
//!
//!     cargo run -p chit-core --release --example specimen

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
use zcash_protocol::consensus::{BlockHeight, BranchId, Network, NetworkType};

fn memo(text: &str) -> [u8; 512] {
    let mut m = [0u8; 512];
    m[..text.len()].copy_from_slice(text.as_bytes());
    m
}

fn main() {
    let mut rng = rand::rng();
    let fvk = |b: u8| FullViewingKey::from(&SpendingKey::from_bytes([b; 32]).unwrap());
    let organiser = fvk(0x5e);
    let prizes: [(u8, u64, &str); 5] = [
        (0x11, 20_00000000, "Grand prize · Specimen Hackathon"),
        (0x12, 15_00000000, "Track 1 · Shielded Payments"),
        (0x13, 15_00000000, "Track 4 · Core & Tooling"),
        (0x14, 7_50000000, "Bounty · Onboarding"),
        (0x15, 2_50000000, "Community vote"),
    ];

    let version = BundleVersion::ironwood_v3();
    let mut b = Builder::new(BundleType::DEFAULT, version, version.default_flags(), Anchor::empty_tree()).unwrap();
    for (seed, value, text) in prizes {
        b.add_output(Some(organiser.to_ovk(Scope::External)), fvk(seed).address_at(0u32, Scope::External), NoteValue::from_raw(value), memo(text)).unwrap();
    }
    let mut empty = [0u8; 512];
    empty[0] = 0xf6;
    b.add_output(Some(organiser.to_ovk(Scope::Internal)), organiser.address_at(0u32, Scope::Internal), NoteValue::from_raw(4_20000000), empty).unwrap();
    let (bundle, _) = b.build::<i64>(&mut rng).unwrap().unwrap();

    eprintln!("building proving key…");
    let pk = ProvingKey::build(bundle.circuit_version());
    let bundle = bundle
        .create_proof(&pk, &mut rng)
        .unwrap()
        .apply_signatures(&mut rng, [0u8; 32], &[])
        .unwrap()
        .try_map_value_balance(|v: i64| zcash_protocol::value::ZatBalance::from_i64(v))
        .unwrap();
    let tx = TransactionData::from_parts_v6(BranchId::Nu6_3, 0, BlockHeight::from_u32(3_530_000), None, None, None, Some(bundle))
        .freeze()
        .unwrap();
    let mut bytes = Vec::new();
    tx.write(&mut bytes).unwrap();

    let ufvk = UnifiedFullViewingKey::new(None, Some(organiser)).unwrap().encode(&Network::MainNetwork).unwrap();
    let found = chit_core::scan(&tx, &ufvk, NetworkType::Main).unwrap();
    let chits: Vec<String> = found.iter().filter(|f| !f.change).map(|f| f.disclosure.clone()).collect();
    let winner = UnifiedFullViewingKey::new(None, Some(fvk(0x13))).unwrap().encode(&Network::MainNetwork).unwrap();

    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/public/specimen");
    std::fs::create_dir_all(dir).unwrap();
    let json = format!(
        "{{\n  \"note\": \"SPECIMEN. A real, proven v6 Ironwood transaction funded from nothing: it is not on chain. Keys are throwaway.\",\n  \"txid\": \"{}\",\n  \"tx\": \"{}\",\n  \"organiser_ufvk\": \"{}\",\n  \"winner_ufvk\": \"{}\",\n  \"winner_address\": \"{}\",\n  \"chits\": [{}]\n}}\n",
        tx.txid(),
        hex::encode(&bytes),
        ufvk,
        winner,
        UnifiedFullViewingKey::new(None, Some(fvk(0x13))).unwrap().default_address(zcash_keys::keys::UnifiedAddressRequest::ORCHARD).unwrap().0.encode(&Network::MainNetwork),
        chits.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", "),
    );
    std::fs::write(format!("{dir}/specimen.json"), json).unwrap();
    println!("{} · {} payout chits", tx.txid(), chits.len());
}
