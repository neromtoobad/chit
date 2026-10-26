//! JSON shapes shared by `--json` output and the `chit serve` API, so both speak the
//! same format as the WebAssembly bindings and the npm package.

use crate::source::Fetched;
use chit_core::{Direction, Found, MemoView, Report, Verified};
use serde_json::{json, Value};

pub fn memo(m: &MemoView) -> Value {
    match m {
        MemoView::Empty => json!({ "kind": "empty", "value": "" }),
        MemoView::Text(t) => json!({ "kind": "text", "value": t }),
        MemoView::Binary(h) => json!({ "kind": "binary", "value": h }),
    }
}

pub fn direction(d: Direction) -> &'static str {
    match d {
        Direction::Outgoing => "outgoing",
        Direction::Incoming => "incoming",
    }
}

pub fn verified(v: &Verified) -> Value {
    json!({
        "txid": v.txid, "pool": v.pool.name(), "action": v.action,
        "direction": direction(v.direction), "value_zat": v.value_zat,
        "recipient": v.recipient, "memo": memo(&v.memo),
    })
}

pub fn mined(f: Option<&Fetched>) -> Value {
    match f {
        Some(f) => {
            json!({ "height": f.height, "confirmations": f.confirmations, "source": f.source })
        }
        None => json!({ "height": null, "confirmations": null, "source": "supplied" }),
    }
}

pub fn report(r: &Report, f: Option<&Fetched>) -> Value {
    json!({
        "valid": r.result.is_ok(),
        "error": r.result.as_ref().err().map(|e| e.to_string()),
        "verified": r.result.as_ref().ok().map(verified),
        "steps": r.steps.iter().map(|s| json!({ "id": s.id, "label": s.label, "ok": s.ok })).collect::<Vec<_>>(),
        "mined": mined(f),
    })
}

pub fn found(list: &[Found]) -> Value {
    Value::Array(
        list.iter()
            .map(|f| {
                json!({
                    "pool": f.pool.name(), "action": f.action, "direction": direction(f.direction),
                    "change": f.change, "value_zat": f.value_zat, "recipient": f.recipient,
                    "memo": memo(&f.memo), "disclosure": f.disclosure,
                })
            })
            .collect(),
    )
}
