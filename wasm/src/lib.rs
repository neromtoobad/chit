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

/// Verifies a disclosure against the raw transaction it names.
#[wasm_bindgen]
pub fn verify(tx_hex: &str, disclosure: &str) -> Result<String, JsError> {
    let d = Disclosure::decode(disclosure).map_err(|e| JsError::new(&e.to_string()))?;
    let tx = tx_from_hex(tx_hex)?;
    let v = chit_core::verify(&tx, &d).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(json(&VerifiedJson {
        network: network_name(v.network),
        txid: v.txid,
        pool: v.pool.name(),
        action: v.action,
        direction: direction_name(v.direction),
        value_zat: v.value_zat,
        recipient: v.recipient,
        memo: (&v.memo).into(),
    }))
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
