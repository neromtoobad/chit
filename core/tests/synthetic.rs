//! End to end on a fully proven and signed v6 transaction with an Ironwood bundle, built
//! by `examples/fixture.rs`: viewing key → scan → encoded disclosure → verify.

use chit_core::{parse_tx, scan, verify, Direction, Disclosure, Error, MemoView, Pool};
use zcash_protocol::consensus::NetworkType;

fn tx() -> zcash_primitives::transaction::Transaction {
    parse_tx(&hex::decode(include_str!("fixtures/synthetic.hex").trim()).unwrap()).unwrap()
}

const ALICE: &str = include_str!("fixtures/synthetic.alice.ufvk");
const BOB: &str = include_str!("fixtures/synthetic.bob.ufvk");

#[test]
fn payer_discloses_the_payment_and_checker_sees_it() {
    let tx = tx();
    let found = scan(&tx, ALICE, NetworkType::Main).unwrap();
    assert_eq!(found.len(), 2, "payment + change");
    let paid = found.iter().find(|f| f.direction == Direction::Outgoing).unwrap();
    assert_eq!(paid.value_zat, 125_000_000);
    assert!(found.iter().any(|f| f.change && f.value_zat == 31_415_926));

    let v = verify(&tx, &Disclosure::decode(&paid.disclosure).unwrap()).unwrap();
    assert_eq!(v.pool, Pool::Ironwood);
    assert_eq!(v.direction, Direction::Outgoing);
    assert_eq!(v.value_zat, 125_000_000);
    assert_eq!(v.recipient, paid.recipient);
    assert!(v.recipient.starts_with("u1"));
    assert_eq!(v.memo, MemoView::Text("ZECATHON prize · track 4".into()));
}

#[test]
fn payee_discloses_the_same_payment() {
    let tx = tx();
    let alice_view = scan(&tx, ALICE, NetworkType::Main).unwrap();
    let found = scan(&tx, BOB, NetworkType::Main).unwrap();
    assert_eq!(found.len(), 1);
    let got = &found[0];
    assert_eq!((got.direction, got.change, got.value_zat), (Direction::Incoming, false, 125_000_000));

    let v = verify(&tx, &Disclosure::decode(&got.disclosure).unwrap()).unwrap();
    assert_eq!(v.direction, Direction::Incoming);
    // Both sides' disclosures describe the same output.
    let paid = alice_view.iter().find(|f| f.direction == Direction::Outgoing).unwrap();
    assert_eq!((v.action, &v.recipient), (paid.action, &paid.recipient));
}

#[test]
fn a_disclosure_moved_to_another_output_is_void() {
    let tx = tx();
    let paid = scan(&tx, ALICE, NetworkType::Main)
        .unwrap()
        .into_iter()
        .find(|f| f.direction == Direction::Outgoing)
        .unwrap();
    let mut d = Disclosure::decode(&paid.disclosure).unwrap();
    d.action ^= 1;
    assert_eq!(verify(&tx, &d), Err(Error::Invalid));
    d.action = 9;
    assert_eq!(verify(&tx, &d), Err(Error::NoSuchAction));
    d.action = paid.action;
    d.pool = Pool::Orchard;
    assert_eq!(verify(&tx, &d), Err(Error::NoSuchAction));
}

#[test]
fn a_stranger_key_finds_nothing() {
    // Alice's key on the real mainnet transaction: no outputs belong to her.
    let other = parse_tx(&hex::decode(include_str!("fixtures/ae3e37db.hex").trim()).unwrap()).unwrap();
    assert!(scan(&other, ALICE, NetworkType::Main).unwrap().is_empty());
}

#[test]
fn wrong_network_key_is_rejected() {
    assert!(matches!(scan(&tx(), ALICE, NetworkType::Test), Err(Error::Key(_))));
}
