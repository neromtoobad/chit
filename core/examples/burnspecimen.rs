//! Builds specimen Burn Book transactions: fully proven v6 transactions whose Ironwood
//! outputs pay the Burn Book address, funded from nothing (never on chain). The second
//! transaction replies to and boosts a post in the first. The app labels them SPECIMEN
//! and never counts them as real burns.
//!
//!     cargo run -p chit-core --release --example burnspecimen

use orchard::{
    builder::{Builder, BundleType},
    bundle::BundleVersion,
    circuit::ProvingKey,
    keys::{FullViewingKey, Scope, SpendingKey},
    tree::Anchor,
    value::NoteValue,
};
use zcash_primitives::transaction::{Transaction, TransactionData};
use zcash_protocol::consensus::{BlockHeight, BranchId};

fn memo(text: &str) -> [u8; 512] {
    let mut m = [0u8; 512];
    m[..text.len()].copy_from_slice(text.as_bytes());
    m
}

fn build(pk: &mut Option<ProvingKey>, burner: &FullViewingKey, posts: &[(u64, String)]) -> Transaction {
    let mut rng = rand::rng();
    let version = BundleVersion::ironwood_v3();
    let to = chit_core::burn::burn_fvk().address_at(0u32, Scope::External);
    let mut b = Builder::new(BundleType::DEFAULT, version, version.default_flags(), Anchor::empty_tree()).unwrap();
    for (value, text) in posts {
        b.add_output(Some(burner.to_ovk(Scope::External)), to, NoteValue::from_raw(*value), memo(text)).unwrap();
    }
    let (bundle, _) = b.build::<i64>(&mut rng).unwrap().unwrap();
    let pk = pk.get_or_insert_with(|| ProvingKey::build(bundle.circuit_version()));
    let bundle = bundle
        .create_proof(pk, &mut rng)
        .unwrap()
        .apply_signatures(&mut rng, [0u8; 32], &[])
        .unwrap()
        .try_map_value_balance(|v: i64| zcash_protocol::value::ZatBalance::from_i64(v))
        .unwrap();
    TransactionData::from_parts_v6(BranchId::Nu6_3, 0, BlockHeight::from_u32(3_530_000), None, None, None, Some(bundle))
        .freeze()
        .unwrap()
}

/// Sealed predictions made by scripts/specimen-seals.mjs (drand time-lock memos).
fn seals() -> Vec<String> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/public/specimen/seals.json");
    let json = std::fs::read_to_string(path).unwrap_or_default();
    json.split('"').filter(|s| s.starts_with("seal:")).map(str::to_string).collect()
}

fn main() {
    let mut pk = None;
    let burner = FullViewingKey::from(&SpendingKey::from_bytes([0x77; 32]).unwrap());
    let a = build(
        &mut pk,
        &burner,
        &[
            (1_00000000, "Privacy is not a crime. I burned 1 ZEC to say it where nobody can delete it.".into()),
            (5_000000, "gm from nowhere".into()),
            (42_000000, "If you can read this, someone just set money on fire for attention. Worth it.".into()),
        ]
        .into_iter()
        .chain(seals().into_iter().zip([25_000000u64, 10_000000]).map(|(m, v)| (v, m)))
        .collect::<Vec<_>>(),
    );
    // The builder shuffles outputs, so find which action carries the first post.
    let target = chit_core::burn::burns_in(&a, zcash_protocol::consensus::NetworkType::Main)
        .into_iter()
        .find(|f| matches!(&f.memo, chit_core::MemoView::Text(t) if t.starts_with("Privacy")))
        .unwrap()
        .action;
    let ref_a = format!("{}.{}", &a.txid().to_string()[..10], target);
    let b = build(
        &mut pk,
        &burner,
        &[
            (2_000000, format!("re:{ref_a} then why pay to prove it? asking anonymously")),
            (50_000000, format!("+{ref_a} burned half a ZEC to agree")),
        ],
    );
    let enc = |t: &Transaction| {
        let mut v = Vec::new();
        t.write(&mut v).unwrap();
        format!("{{\"txid\":\"{}\",\"tx\":\"{}\"}}", t.txid(), hex::encode(v))
    };
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/public/specimen");
    std::fs::write(
        format!("{dir}/burns.json"),
        format!("{{\n\"note\":\"SPECIMEN burns: proven v6 Ironwood transactions paying the Burn Book address, funded from nothing, never on chain.\",\n\"txs\":[{},\n{}]\n}}\n", enc(&a), enc(&b)),
    )
    .unwrap();
    println!("{} {}", a.txid(), b.txid());
}
