use super::*;
use orchard::{
    builder::{Builder, BundleType},
    bundle::BundleVersion,
    keys::SpendingKey,
    tree::Anchor,
    value::NoteValue,
};


fn fvk(seed: u8) -> FullViewingKey {
    FullViewingKey::from(&SpendingKey::from_bytes([seed; 32]).unwrap())
}

fn memo(text: &str) -> [u8; 512] {
    let mut m = [0u8; 512];
    m[..text.len()].copy_from_slice(text.as_bytes());
    m
}

/// Alice pays Bob 1.25 ZEC with a memo and keeps 0.5 ZEC of change, in an output-only
/// bundle of the given version. Returns the actions and both keys.
fn payment(version: BundleVersion) -> (Vec<Action<()>>, FullViewingKey, FullViewingKey) {
    let alice = fvk(1);
    let bob = fvk(2);
    let mut builder = Builder::new(
        BundleType::DEFAULT,
        version,
        version.default_flags(),
        Anchor::empty_tree(),
    )
    .unwrap();
    builder
        .add_output(
            Some(alice.to_ovk(Scope::External)),
            bob.address_at(0u32, Scope::External),
            NoteValue::from_raw(125_000_000),
            memo("invoice #1042"),
        )
        .unwrap();
    builder
        .add_output(
            Some(alice.to_ovk(Scope::Internal)),
            alice.address_at(0u32, Scope::Internal),
            NoteValue::from_raw(50_000_000),
            [0xf6; 512],
        )
        .unwrap();
    let (bundle, _) = builder.build::<i64>(rand::rng()).unwrap().unwrap();
    let actions = bundle.actions().iter().map(|a| a.clone().map(|_| ())).collect();
    (actions, alice, bob)
}

fn scan_all<V: DomainVersion>(actions: &[Action<()>], fvk: &FullViewingKey) -> Vec<(usize, Hit)> {
    actions
        .iter()
        .enumerate()
        .filter_map(|(i, a)| scan_action::<V>(a, fvk).map(|h| (i, h)))
        .collect()
}

fn check_pool<V: DomainVersion>(version: BundleVersion) {
    let (actions, alice, bob) = payment(version);

    // Alice sees her payment to Bob as outgoing, and her change as incoming change.
    let alice_hits = scan_all::<V>(&actions, &alice);
    let sent: Vec<_> = alice_hits
        .iter()
        .filter(|(_, h)| h.0 == Direction::Outgoing)
        .collect();
    assert_eq!(sent.len(), 1);
    let (i, (_, _, note, _, _, key)) = sent[0];
    assert_eq!(note.value().inner(), 125_000_000);
    assert!(matches!(key, KeyMaterial::Ock(_)));
    assert!(alice_hits.iter().any(|(_, h)| h.0 == Direction::Incoming && h.1));

    // The outgoing disclosure opens Bob's output, and shows his address and the memo.
    let (n, addr, m) = open::<V>(&actions[*i], key).expect("ock opens the output");
    assert_eq!(n.value().inner(), 125_000_000);
    assert_eq!(addr, bob.address_at(0u32, Scope::External));
    assert_eq!(MemoView::from_bytes(&m), MemoView::Text("invoice #1042".into()));

    // It opens nothing else.
    for (j, a) in actions.iter().enumerate() {
        if j != *i {
            assert!(open::<V>(a, key).is_none());
        }
    }

    // Bob sees the same output as incoming, and his disclosure opens it too.
    let bob_hits = scan_all::<V>(&actions, &bob);
    assert_eq!(bob_hits.len(), 1);
    let (bi, (dir, change, _, _, _, bkey)) = &bob_hits[0];
    assert_eq!((*bi, *dir, *change), (*i, Direction::Incoming, false));
    let (n, _, _) = open::<V>(&actions[*bi], bkey).expect("pk_d||esk opens the output");
    assert_eq!(n.value().inner(), 125_000_000);

    // A flipped bit in either kind of key is rejected.
    let mut bad = key.clone();
    if let KeyMaterial::Ock(k) = &mut bad {
        k[0] ^= 1;
    }
    assert!(open::<V>(&actions[*i], &bad).is_none());
    let mut bad = bkey.clone();
    if let KeyMaterial::PkdEsk(k) = &mut bad {
        k[40] ^= 1;
    }
    assert!(open::<V>(&actions[*bi], &bad).is_none());
}

#[test]
fn ironwood_outgoing_and_incoming() {
    check_pool::<IronwoodVersion>(BundleVersion::ironwood_v3());
}

#[test]
fn orchard_outgoing_and_incoming() {
    // Orchard accepts no new outputs after NU6.3, so this is a pre-NU6.3 bundle, which is
    // what every Orchard output still on chain was created with.
    check_pool::<OrchardVersion>(BundleVersion::orchard_v2());
}

#[test]
fn pool_domains_do_not_cross() {
    // An Ironwood note must not verify as an Orchard one, or the pool in a disclosure
    // would be meaningless.
    let (actions, alice, _) = payment(BundleVersion::ironwood_v3());
    let hits = scan_all::<IronwoodVersion>(&actions, &alice);
    let (i, (_, _, _, _, _, key)) = hits.iter().find(|(_, h)| h.0 == Direction::Outgoing).unwrap();
    assert!(open::<IronwoodVersion>(&actions[*i], key).is_some());
    assert!(open::<OrchardVersion>(&actions[*i], key).is_none());
}

#[test]
fn encoding_round_trips() {
    let d = Disclosure {
        network: NetworkType::Main,
        txid: TxId::from_bytes([9; 32]),
        pool: Pool::Ironwood,
        action: 3,
        key: KeyMaterial::Ock([5; 32]),
    };
    let s = d.encode();
    assert!(s.starts_with("zout1"));
    assert_eq!(Disclosure::decode(&s).unwrap(), d);

    let d2 = Disclosure {
        network: NetworkType::Test,
        key: KeyMaterial::PkdEsk([7; 64]),
        ..d
    };
    let s2 = d2.encode();
    assert!(s2.starts_with("zouttest1"));
    assert_eq!(Disclosure::decode(&s2).unwrap(), d2);

    // One changed character breaks the checksum.
    let mut chars: Vec<char> = s.chars().collect();
    let k = chars.len() - 5;
    chars[k] = if chars[k] == 'q' { 'p' } else { 'q' };
    assert!(Disclosure::decode(&chars.into_iter().collect::<String>()).is_err());
}

#[test]
fn txid_display_order() {
    let id = "ae3e37dbffde0d00c80f294bdcf23118d3bc1fe053896cdcba402c86868baa87";
    assert_eq!(parse_txid(id).unwrap().to_string(), id);
}
