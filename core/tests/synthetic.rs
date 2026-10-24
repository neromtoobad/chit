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

#[test]
fn every_step_passes_for_a_valid_chit_and_stops_at_the_broken_one() {
    use chit_core::{verify_with_steps, KeyMaterial};
    let tx = tx();
    for key in [ALICE, BOB] {
        let f = scan(&tx, key, NetworkType::Main).unwrap().into_iter().find(|f| !f.change).unwrap();
        let r = verify_with_steps(&tx, &Disclosure::decode(&f.disclosure).unwrap());
        assert!(r.result.is_ok());
        assert!(r.steps.len() >= 9, "{:?}", r.steps);
        assert!(r.steps.iter().all(|s| s.ok == Some(true)), "{:?}", r.steps);
    }

    // A flipped ock fails at the outgoing ciphertext, and nothing after it runs.
    let paid = scan(&tx, ALICE, NetworkType::Main).unwrap().into_iter().find(|f| f.direction == Direction::Outgoing).unwrap();
    let mut d = Disclosure::decode(&paid.disclosure).unwrap();
    if let KeyMaterial::Ock(k) = &mut d.key {
        k[3] ^= 0x10;
    }
    let r = verify_with_steps(&tx, &d);
    assert!(r.result.is_err());
    let key = r.steps.iter().position(|s| s.id == "key").unwrap();
    assert_eq!(r.steps[key].ok, Some(false));
    assert!(r.steps[key + 1..r.steps.len() - 1].iter().all(|s| s.ok.is_none()));
    assert_eq!(r.steps.last().unwrap().ok, Some(false));

    // A payee chit with a tampered esk opens nothing.
    let got = scan(&tx, BOB, NetworkType::Main).unwrap().remove(0);
    let mut d = Disclosure::decode(&got.disclosure).unwrap();
    if let KeyMaterial::PkdEsk(k) = &mut d.key {
        k[40] ^= 1;
    }
    assert!(verify_with_steps(&tx, &d).result.is_err());
}

#[test]
fn paid_to_compares_orchard_receivers() {
    let tx = tx();
    let paid = scan(&tx, ALICE, NetworkType::Main).unwrap().into_iter().find(|f| f.direction == Direction::Outgoing).unwrap();
    let v = verify(&tx, &Disclosure::decode(&paid.disclosure).unwrap()).unwrap();
    assert!(chit_core::paid_to(&v, &paid.recipient));
    let change = scan(&tx, ALICE, NetworkType::Main).unwrap().into_iter().find(|f| f.change).unwrap();
    assert!(!chit_core::paid_to(&v, &change.recipient));
    assert!(!chit_core::paid_to(&v, "t1e6hceYHkzCbwcwGZzKeMfXXW7x7gr19Cw"));
}
