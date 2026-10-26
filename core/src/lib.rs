//! Output disclosures for Zcash Orchard and Ironwood.
//!
//! A disclosure proves the contents of exactly one shielded output (value, recipient and
//! memo) to anyone who holds it, without revealing a viewing key or anything else about
//! the wallet. It implements, for Orchard and the Ironwood pool (ZIP 258), the output
//! part of [ZIP 311], which only specifies Sapling and leaves Orchard as a TODO.
//!
//! These are *unsigned* output disclosures: they prove what an output contains, not who
//! is presenting the proof. ZIP 311 payment disclosures additionally prove spend
//! authority; that part is out of scope here, and the encoding uses its own prefix so the
//! two can never be confused.
//!
//! Two kinds exist:
//! - **Outgoing** (the payer): the output's outgoing cipher key `ock`, derived from the
//!   payer's OVK. This is the mechanism ZIP 311 already specifies for Sapling.
//! - **Incoming** (the payee): the output's `pk_d || esk`. The payee can rebuild `esk` from
//!   the note's `rseed` (ZIP 212), so a recipient can prove what it was paid.
//!
//! Neither `ock` nor `esk` can be turned back into a viewing key, and each opens only the
//! one output it was derived for. Verification runs the same checks a wallet runs when it
//! decrypts a note, including the note commitment and the ZIP 212 `esk` consistency check,
//! so a disclosure that does not match the on-chain output is rejected.
//!
//! [ZIP 311]: https://zips.z.cash/zip-0311

use bech32::{primitives::decode::CheckedHrpstring, Bech32m, Hrp};
use orchard::{
    keys::{FullViewingKey, PreparedIncomingViewingKey, Scope},
    note_encryption::{DomainVersion, IronwoodVersion, NoteEncryptionDomain, OrchardVersion},
    Action, Address,
};
use zcash_keys::{address::UnifiedAddress, keys::UnifiedFullViewingKey};
use zcash_note_encryption::{
    try_note_decryption, try_output_recovery_with_ock, try_output_recovery_with_ovk,
    try_output_recovery_with_pkd_esk, Domain, OutPlaintextBytes, OutgoingCipherKey, ShieldedOutput,
    OUT_PLAINTEXT_SIZE,
};
pub use zcash_primitives::transaction::Transaction;
use zcash_protocol::{
    consensus::{BranchId, Network, NetworkType},
    memo::{Memo, MemoBytes},
    TxId,
};

pub mod burn;
mod steps;
pub use steps::{verify_with_steps, Report, Step};

const VERSION: u8 = 1;
const HRP_MAIN: &str = "zout";
const HRP_TEST: &str = "zouttest";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    Encoding(String),
    Transaction(String),
    Key(String),
    TxidMismatch {
        expected: String,
        actual: String,
    },
    NoSuchAction,
    /// The output did not open with the disclosed key, or failed a validity check.
    Invalid,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Encoding(e) => write!(f, "bad disclosure encoding: {e}"),
            Error::Transaction(e) => write!(f, "bad transaction: {e}"),
            Error::Key(e) => write!(f, "bad viewing key: {e}"),
            Error::TxidMismatch { expected, actual } => {
                write!(
                    f,
                    "transaction is {actual}, but the disclosure is for {expected}"
                )
            }
            Error::NoSuchAction => write!(f, "the transaction has no such output"),
            Error::Invalid => write!(f, "the disclosure does not open this output"),
        }
    }
}

impl std::error::Error for Error {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pool {
    Orchard,
    Ironwood,
}

impl Pool {
    pub fn name(self) -> &'static str {
        match self {
            Pool::Orchard => "orchard",
            Pool::Ironwood => "ironwood",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Made from the payer's outgoing viewing key: carries `ock`.
    Outgoing,
    /// Made from the payee's incoming viewing key: carries `pk_d || esk`.
    Incoming,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyMaterial {
    Ock([u8; 32]),
    PkdEsk([u8; OUT_PLAINTEXT_SIZE]),
}

impl KeyMaterial {
    pub fn direction(&self) -> Direction {
        match self {
            KeyMaterial::Ock(_) => Direction::Outgoing,
            KeyMaterial::PkdEsk(_) => Direction::Incoming,
        }
    }
}

/// A disclosure of one Orchard or Ironwood action output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Disclosure {
    pub network: NetworkType,
    pub txid: TxId,
    pub pool: Pool,
    pub action: u16,
    pub key: KeyMaterial,
}

// Payload layout, version 1:
//   [0]       version
//   [1]       bits 0-1: pool (1 = Orchard, 2 = Ironwood); bit 2: 0 = ock, 1 = pk_d || esk
//   [2..4]    action index, little-endian
//   [4..36]   txid, internal byte order
//   [36..]    32-byte ock, or 64-byte pk_d || esk
impl Disclosure {
    pub fn encode(&self) -> String {
        let pool_bits = match self.pool {
            Pool::Orchard => 1u8,
            Pool::Ironwood => 2u8,
        };
        let (kind_bit, key): (u8, &[u8]) = match &self.key {
            KeyMaterial::Ock(ock) => (0, ock),
            KeyMaterial::PkdEsk(op) => (1, op),
        };
        let mut data = Vec::with_capacity(36 + key.len());
        data.push(VERSION);
        data.push(pool_bits | (kind_bit << 2));
        data.extend_from_slice(&self.action.to_le_bytes());
        data.extend_from_slice(self.txid.as_ref());
        data.extend_from_slice(key);
        let hrp = Hrp::parse(hrp_for(self.network)).expect("valid hrp");
        bech32::encode::<Bech32m>(hrp, &data).expect("payload fits bech32m")
    }

    pub fn decode(s: &str) -> Result<Self, Error> {
        let s = s.trim();
        let checked =
            CheckedHrpstring::new::<Bech32m>(s).map_err(|e| Error::Encoding(e.to_string()))?;
        let network = match checked.hrp().as_str() {
            HRP_MAIN => NetworkType::Main,
            HRP_TEST => NetworkType::Test,
            other => return Err(Error::Encoding(format!("unknown prefix {other}"))),
        };
        let data: Vec<u8> = checked.byte_iter().collect();
        if data.len() < 36 {
            return Err(Error::Encoding("too short".into()));
        }
        if data[0] != VERSION {
            return Err(Error::Encoding(format!("unsupported version {}", data[0])));
        }
        let pool = match data[1] & 0b11 {
            1 => Pool::Orchard,
            2 => Pool::Ironwood,
            p => return Err(Error::Encoding(format!("unknown pool {p}"))),
        };
        if data[1] & !0b111 != 0 {
            return Err(Error::Encoding("reserved flag bits set".into()));
        }
        let action = u16::from_le_bytes([data[2], data[3]]);
        let txid = TxId::from_bytes(data[4..36].try_into().unwrap());
        let key = match (data[1] >> 2 & 1, &data[36..]) {
            (0, k) if k.len() == 32 => KeyMaterial::Ock(k.try_into().unwrap()),
            (1, k) if k.len() == OUT_PLAINTEXT_SIZE => KeyMaterial::PkdEsk(k.try_into().unwrap()),
            _ => return Err(Error::Encoding("wrong key length".into())),
        };
        Ok(Disclosure {
            network,
            txid,
            pool,
            action,
            key,
        })
    }
}

fn hrp_for(network: NetworkType) -> &'static str {
    match network {
        NetworkType::Main => HRP_MAIN,
        NetworkType::Test | NetworkType::Regtest => HRP_TEST,
    }
}

fn params(network: NetworkType) -> Network {
    match network {
        NetworkType::Main => Network::MainNetwork,
        NetworkType::Test | NetworkType::Regtest => Network::TestNetwork,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoView {
    Empty,
    Text(String),
    /// Hex of the memo bytes with trailing zeros removed.
    Binary(String),
}

impl MemoView {
    fn from_bytes(bytes: &[u8; 512]) -> Self {
        match MemoBytes::from_bytes(bytes).and_then(Memo::try_from) {
            Ok(Memo::Empty) => MemoView::Empty,
            Ok(Memo::Text(t)) => MemoView::Text(t.to_string()),
            _ => {
                let end = bytes.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
                MemoView::Binary(hex::encode(&bytes[..end]))
            }
        }
    }
}

/// What a valid disclosure proves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    pub network: NetworkType,
    pub txid: String,
    pub pool: Pool,
    pub action: u16,
    pub direction: Direction,
    pub value_zat: u64,
    /// The recipient as a Unified Address holding only this receiver.
    pub recipient: String,
    pub memo: MemoView,
}

/// An output of a transaction that the given viewing key can disclose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub pool: Pool,
    pub action: u16,
    pub direction: Direction,
    /// True when the output goes to the wallet's own internal (change) address.
    pub change: bool,
    pub value_zat: u64,
    pub recipient: String,
    pub memo: MemoView,
    pub disclosure: String,
}

/// Parses a raw v5 or v6 transaction.
pub fn parse_tx(bytes: &[u8]) -> Result<Transaction, Error> {
    // v5 and later transactions carry their own consensus branch ID; this one is only
    // consulted for older formats, which have no Orchard or Ironwood bundle anyway.
    Transaction::read(bytes, BranchId::Nu6_3).map_err(|e| Error::Transaction(e.to_string()))
}

/// Parses a txid in the usual display (byte-reversed hex) form.
pub fn parse_txid(s: &str) -> Result<TxId, Error> {
    let mut bytes: [u8; 32] = hex::decode(s.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| Error::Transaction("txid must be 64 hex characters".into()))?;
    bytes.reverse();
    Ok(TxId::from_bytes(bytes))
}

pub(crate) fn bundle_actions(
    tx: &Transaction,
    pool: Pool,
) -> Vec<
    &Action<orchard::primitives::redpallas::Signature<orchard::primitives::redpallas::SpendAuth>>,
> {
    let bundle = match pool {
        Pool::Orchard => tx.orchard_bundle(),
        Pool::Ironwood => tx.ironwood_bundle(),
    };
    bundle
        .map(|b| b.actions().iter().collect())
        .unwrap_or_default()
}

fn recipient_string(addr: Address, network: NetworkType) -> String {
    UnifiedAddress::from_receivers(Some(addr), None, None, None, None)
        .expect("an orchard receiver alone is a valid UA")
        .encode(&params(network))
}

fn note_value(note: &orchard::Note) -> u64 {
    note.value().inner()
}

/// The Orchard-protocol receiver of a Unified Address, as raw bytes. Ironwood notes are
/// paid to the same receiver (typecode 0x03, ZIP 258).
pub fn orchard_receiver(address: &str, network: NetworkType) -> Option<[u8; 43]> {
    match zcash_keys::address::Address::decode(&params(network), address.trim())? {
        zcash_keys::address::Address::Unified(ua) => ua.orchard().map(|a| a.to_raw_address_bytes()),
        _ => None,
    }
}

/// Whether a verified disclosure paid `address` (compared by Orchard receiver, so a full
/// Unified Address with Sapling and transparent receivers still matches).
pub fn paid_to(v: &Verified, address: &str) -> bool {
    match (
        orchard_receiver(&v.recipient, v.network),
        orchard_receiver(address, v.network),
    ) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// Checks `disclosure` against the transaction it names.
pub fn verify(tx: &Transaction, disclosure: &Disclosure) -> Result<Verified, Error> {
    let actual = tx.txid();
    if actual != disclosure.txid {
        return Err(Error::TxidMismatch {
            expected: disclosure.txid.to_string(),
            actual: actual.to_string(),
        });
    }
    let actions = bundle_actions(tx, disclosure.pool);
    let action = actions
        .get(disclosure.action as usize)
        .ok_or(Error::NoSuchAction)?;
    let (note, addr, memo) = match disclosure.pool {
        Pool::Orchard => open::<OrchardVersion>(action, &disclosure.key),
        Pool::Ironwood => open::<IronwoodVersion>(action, &disclosure.key),
    }
    .ok_or(Error::Invalid)?;
    Ok(Verified {
        network: disclosure.network,
        txid: actual.to_string(),
        pool: disclosure.pool,
        action: disclosure.action,
        direction: disclosure.key.direction(),
        value_zat: note_value(&note),
        recipient: recipient_string(addr, disclosure.network),
        memo: MemoView::from_bytes(&memo),
    })
}

fn open<V: DomainVersion>(
    action: &Action<impl Sized>,
    key: &KeyMaterial,
) -> Option<(orchard::Note, Address, [u8; 512])> {
    let domain = NoteEncryptionDomain::<V>::for_action(action);
    match key {
        KeyMaterial::Ock(ock) => try_output_recovery_with_ock(
            &domain,
            &OutgoingCipherKey(*ock),
            action,
            &action.encrypted_note().out_ciphertext,
        ),
        KeyMaterial::PkdEsk(bytes) => {
            let op = OutPlaintextBytes(*bytes);
            let pk_d = NoteEncryptionDomain::<V>::extract_pk_d(&op)?;
            let esk = NoteEncryptionDomain::<V>::extract_esk(&op)?;
            try_output_recovery_with_pkd_esk(&domain, pk_d, esk, action)
        }
    }
}

/// Finds every Orchard and Ironwood output of `tx` that `ufvk` can disclose.
///
/// Outputs the wallet received get an incoming disclosure; outputs it sent to someone else
/// get an outgoing one. Nothing here touches the network.
pub fn scan(tx: &Transaction, ufvk: &str, network: NetworkType) -> Result<Vec<Found>, Error> {
    let ufvk = UnifiedFullViewingKey::decode(&params(network), ufvk.trim())
        .map_err(|e| Error::Key(e.to_string()))?;
    let fvk = ufvk
        .orchard()
        .ok_or_else(|| Error::Key("this viewing key has no Orchard/Ironwood component".into()))?;
    Ok(scan_fvk(tx, fvk, network))
}

/// [`scan`] with an Orchard full viewing key.
pub fn scan_fvk(tx: &Transaction, fvk: &FullViewingKey, network: NetworkType) -> Vec<Found> {
    let txid = tx.txid();
    let mut found = Vec::new();
    for pool in [Pool::Orchard, Pool::Ironwood] {
        for (i, action) in bundle_actions(tx, pool).into_iter().enumerate() {
            let hit = match pool {
                Pool::Orchard => scan_action::<OrchardVersion>(action, fvk),
                Pool::Ironwood => scan_action::<IronwoodVersion>(action, fvk),
            };
            if let Some((direction, change, note, addr, memo, key)) = hit {
                let disclosure = Disclosure {
                    network,
                    txid,
                    pool,
                    action: i as u16,
                    key,
                };
                found.push(Found {
                    pool,
                    action: i as u16,
                    direction,
                    change,
                    value_zat: note_value(&note),
                    recipient: recipient_string(addr, network),
                    memo: MemoView::from_bytes(&memo),
                    disclosure: disclosure.encode(),
                });
            }
        }
    }
    found
}

type Hit = (
    Direction,
    bool,
    orchard::Note,
    Address,
    [u8; 512],
    KeyMaterial,
);

fn scan_action<V: DomainVersion>(action: &Action<impl Sized>, fvk: &FullViewingKey) -> Option<Hit> {
    let domain = NoteEncryptionDomain::<V>::for_action(action);
    // Received: our own address, external or internal (change).
    for scope in [Scope::External, Scope::Internal] {
        let ivk = PreparedIncomingViewingKey::new(&fvk.to_ivk(scope));
        if let Some((note, addr, memo)) = try_note_decryption(&domain, &ivk, action) {
            let esk = NoteEncryptionDomain::<V>::derive_esk(&note)?;
            let op = NoteEncryptionDomain::<V>::outgoing_plaintext_bytes(&note, &esk);
            return Some((
                Direction::Incoming,
                scope == Scope::Internal,
                note,
                addr,
                memo,
                KeyMaterial::PkdEsk(op.0),
            ));
        }
    }
    // Sent to someone else.
    for scope in [Scope::External, Scope::Internal] {
        let ovk = fvk.to_ovk(scope);
        let out = &action.encrypted_note().out_ciphertext;
        if let Some((note, addr, memo)) =
            try_output_recovery_with_ovk(&domain, &ovk, action, action.cv_net(), out)
        {
            let ock = NoteEncryptionDomain::<V>::derive_ock(
                &ovk,
                action.cv_net(),
                &action.cmx().to_bytes(),
                &ShieldedOutput::<NoteEncryptionDomain<V>>::ephemeral_key(action),
            );
            return Some((
                Direction::Outgoing,
                false,
                note,
                addr,
                memo,
                KeyMaterial::Ock(ock.0),
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests;
