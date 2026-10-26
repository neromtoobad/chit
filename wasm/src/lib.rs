//! Browser bindings. Every function takes and returns strings (JSON for structured
//! results) and does no I/O: fetching the transaction is the caller's job, so the
//! viewing key and the disclosure never reach this module's network stack because it has
//! none.

use chit_core::{Direction, Disclosure, MemoView};
use serde::Serialize;
use wasm_bindgen::prelude::*;
use zcash_protocol::consensus::NetworkType;

#[derive(Serialize)]
struct Memo {
    kind: &'static str,
    value: String,
}

impl From<&MemoView> for Memo {
    fn from(m: &MemoView) -> Self {
        match m {
            MemoView::Empty => Memo { kind: "empty", value: String::new() },
            MemoView::Text(t) => Memo { kind: "text", value: t.clone() },
            MemoView::Binary(h) => Memo { kind: "binary", value: h.clone() },
        }
    }
}

fn network_name(n: NetworkType) -> &'static str {
    match n {
        NetworkType::Main => "main",
        _ => "test",
    }
}

fn direction_name(d: Direction) -> &'static str {
    match d {
        Direction::Outgoing => "outgoing",
        Direction::Incoming => "incoming",
    }
}

fn parse_network(s: &str) -> Result<NetworkType, JsError> {
    match s {
        "main" => Ok(NetworkType::Main),
        "test" => Ok(NetworkType::Test),
        _ => Err(JsError::new("network must be \"main\" or \"test\"")),
    }
}

fn tx_from_hex(tx_hex: &str) -> Result<zcash_primitives_tx::Transaction, JsError> {
    let bytes = hex::decode(tx_hex.trim()).map_err(|_| JsError::new("transaction must be hex"))?;
    chit_core::parse_tx(&bytes).map_err(|e| JsError::new(&e.to_string()))
}

mod zcash_primitives_tx {
    pub use chit_core::Transaction;
}

fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("serializable")
}

#[derive(Serialize)]
struct Header {
    network: &'static str,
    txid: String,
    pool: &'static str,
    action: u16,
    direction: &'static str,
}

/// Reads a disclosure's header (which transaction to fetch) without verifying it.
#[wasm_bindgen]
pub fn inspect(disclosure: &str) -> Result<String, JsError> {
    let d = Disclosure::decode(disclosure).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(json(&Header {
        network: network_name(d.network),
        txid: d.txid.to_string(),
        pool: d.pool.name(),
        action: d.action,
        direction: direction_name(d.key.direction()),
    }))
}

#[derive(Serialize)]
struct VerifiedJson {
    network: &'static str,
    txid: String,
    pool: &'static str,
    action: u16,
    direction: &'static str,
    value_zat: u64,
    recipient: String,
    memo: Memo,
}

#[derive(Serialize)]
struct StepJson {
    id: &'static str,
    label: String,
    /// true, false, or null when an earlier step failed and this one did not run.
    ok: Option<bool>,
}

#[derive(Serialize)]
struct ReportJson {
    valid: bool,
    error: Option<String>,
    verified: Option<VerifiedJson>,
    steps: Vec<StepJson>,
}

/// Verifies a disclosure against the raw transaction it names, returning every check.
/// Throws only when the inputs cannot be parsed at all.
#[wasm_bindgen]
pub fn verify(tx_hex: &str, disclosure: &str) -> Result<String, JsError> {
    let d = Disclosure::decode(disclosure).map_err(|e| JsError::new(&e.to_string()))?;
    let tx = tx_from_hex(tx_hex)?;
    let r = chit_core::verify_with_steps(&tx, &d);
    let steps = r.steps.into_iter().map(|s| StepJson { id: s.id, label: s.label, ok: s.ok }).collect();
    Ok(json(&match r.result {
        Ok(v) => ReportJson {
            valid: true,
            error: None,
            verified: Some(VerifiedJson {
                network: network_name(v.network),
                txid: v.txid,
                pool: v.pool.name(),
                action: v.action,
                direction: direction_name(v.direction),
                value_zat: v.value_zat,
                recipient: v.recipient,
                memo: (&v.memo).into(),
            }),
            steps,
        },
        Err(e) => ReportJson { valid: false, error: Some(e.to_string()), verified: None, steps },
    }))
}

/// Whether two addresses share the same Orchard receiver (a disclosure's recipient against
/// an invoice's address, say). False when either has no Orchard receiver.
#[wasm_bindgen]
pub fn same_receiver(a: &str, b: &str, network: &str) -> Result<bool, JsError> {
    let n = parse_network(network)?;
    Ok(match (chit_core::orchard_receiver(a, n), chit_core::orchard_receiver(b, n)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    })
}

/// Whether an address can receive Orchard/Ironwood payments that a chit can prove.
#[wasm_bindgen]
pub fn has_orchard_receiver(address: &str, network: &str) -> Result<bool, JsError> {
    Ok(chit_core::orchard_receiver(address, parse_network(network)?).is_some())
}

#[derive(Serialize)]
struct FoundJson {
    pool: &'static str,
    action: u16,
    direction: &'static str,
    change: bool,
    value_zat: u64,
    recipient: String,
    memo: Memo,
    disclosure: String,
}

/// Lists the outputs of a transaction that a Unified Full Viewing Key can disclose.
#[wasm_bindgen]
pub fn scan(tx_hex: &str, ufvk: &str, network: &str) -> Result<String, JsError> {
    let tx = tx_from_hex(tx_hex)?;
    let found = chit_core::scan(&tx, ufvk, parse_network(network)?)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let out: Vec<FoundJson> = found
        .iter()
        .map(|f| FoundJson {
            pool: f.pool.name(),
            action: f.action,
            direction: direction_name(f.direction),
            change: f.change,
            value_zat: f.value_zat,
            recipient: f.recipient.clone(),
            memo: (&f.memo).into(),
            disclosure: f.disclosure.clone(),
        })
        .collect();
    Ok(json(&out))
}

/// The txid of a raw transaction, so a caller can check what it fetched.
#[wasm_bindgen]
pub fn txid(tx_hex: &str) -> Result<String, JsError> {
    Ok(tx_from_hex(tx_hex)?.txid().to_string())
}

#[derive(Serialize)]
struct BurnInfo {
    address: String,
    ufvk: String,
    domain: &'static str,
    ak: String,
    nk: String,
    rivk: String,
}

/// The Burn Book address, its published viewing key, and the three key parts, each
/// re-derived here from public strings so a reader can check nobody holds a spending key.
#[wasm_bindgen]
pub fn burn_info(network: &str) -> Result<String, JsError> {
    let n = parse_network(network)?;
    let fvk = chit_core::burn::burn_fvk_bytes();
    Ok(json(&BurnInfo {
        address: chit_core::burn::burn_address(n),
        ufvk: chit_core::burn::burn_ufvk(n),
        domain: chit_core::burn::DOMAIN,
        ak: hex::encode(&fvk[..32]),
        nk: hex::encode(&fvk[32..64]),
        rivk: hex::encode(&fvk[64..]),
    }))
}

/// Every burn in a raw transaction: outputs to the Burn Book address, with value and memo.
#[wasm_bindgen]
pub fn burns(tx_hex: &str, network: &str) -> Result<String, JsError> {
    let tx = tx_from_hex(tx_hex)?;
    let found = chit_core::burn::burns_in(&tx, parse_network(network)?);
    let out: Vec<FoundJson> = found
        .iter()
        .map(|f| FoundJson {
            pool: f.pool.name(),
            action: f.action,
            direction: direction_name(f.direction),
            change: f.change,
            value_zat: f.value_zat,
            recipient: f.recipient.clone(),
            memo: (&f.memo).into(),
            disclosure: f.disclosure.clone(),
        })
        .collect();
    Ok(json(&serde_json::json!({ "txid": tx.txid().to_string(), "burns": out })))
}
