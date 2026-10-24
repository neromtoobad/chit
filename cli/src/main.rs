//! `chit`: make and check Zcash Orchard/Ironwood payment disclosures.
//!
//!     chit check <zpd…> [--tx FILE]
//!     chit make  <txid | --tx FILE> --key-file FILE [--testnet]
//!     chit inspect <zpd…>
//!
//! The viewing key is read from a file (or `CHIT_UFVK`), never from the command line,
//! so it does not end up in shell history or the process list.

use chit_core::{Direction, Disclosure, MemoView, Pool, Transaction};
use std::process::ExitCode;
use zcash_protocol::consensus::NetworkType;

const USAGE: &str = "usage:
  chit check <zpd…> [--tx FILE]                         verify a disclosure
  chit make  (<txid> | --tx FILE) --key-file FILE [--testnet]
                                                        list outputs your viewing key can disclose
  chit inspect <zpd…>                                   show which transaction a disclosure names

  --tx FILE    raw transaction hex (\"-\" for stdin) instead of fetching it from Blockchair
  --json       machine-readable output
  The viewing key can also come from the CHIT_UFVK environment variable.";

struct Args {
    positional: Vec<String>,
    tx_file: Option<String>,
    key_file: Option<String>,
    testnet: bool,
    json: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args { positional: vec![], tx_file: None, key_file: None, testnet: false, json: false };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--tx" => a.tx_file = Some(it.next().ok_or("--tx needs a file")?),
            "--key-file" => a.key_file = Some(it.next().ok_or("--key-file needs a file")?),
            "--testnet" => a.testnet = true,
            "--json" => a.json = true,
            "-h" | "--help" => return Err(String::new()),
            s if s.starts_with("--") => return Err(format!("unknown option {s}")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

fn read_input(path: &str) -> Result<String, String> {
    if path == "-" {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut s).map_err(|e| e.to_string())?;
        Ok(s)
    } else {
        std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))
    }
}

struct Fetched {
    hex: String,
    height: Option<u64>,
}

fn fetch(network: NetworkType, txid: &str) -> Result<Fetched, String> {
    if network != NetworkType::Main {
        return Err("no public testnet explorer is wired in; pass --tx FILE".into());
    }
    let get = |url: String| -> Result<serde_json::Value, String> {
        ureq::get(&url)
            .call()
            .map_err(|e| format!("explorer: {e}"))?
            .body_mut()
            .read_json()
            .map_err(|e| format!("explorer: {e}"))
    };
    let raw = get(format!("https://api.blockchair.com/zcash/raw/transaction/{txid}"))?;
    let hex = raw["data"][txid]["raw_transaction"]
        .as_str()
        .ok_or("the explorer does not know this transaction")?
        .to_string();
    let height = get(format!("https://api.blockchair.com/zcash/dashboards/transaction/{txid}"))
        .ok()
        .and_then(|d| d["data"][txid]["transaction"]["block_id"].as_u64())
        .filter(|h| *h > 0);
    Ok(Fetched { hex, height })
}

fn load_tx(hex: &str) -> Result<Transaction, String> {
    let bytes = hex::decode(hex.trim()).map_err(|_| "transaction is not hex".to_string())?;
    chit_core::parse_tx(&bytes).map_err(|e| e.to_string())
}

fn zec(zat: u64) -> String {
    format!("{}.{:08} ZEC", zat / 100_000_000, zat % 100_000_000)
}

fn memo_text(m: &MemoView) -> String {
    match m {
        MemoView::Empty => "(none)".into(),
        MemoView::Text(t) => t.clone(),
        MemoView::Binary(h) if h.len() > 48 => format!("binary {}… ({} bytes)", &h[..48], h.len() / 2),
        MemoView::Binary(h) => format!("binary {h}"),
    }
}

fn memo_json(m: &MemoView) -> serde_json::Value {
    match m {
        MemoView::Empty => serde_json::json!({ "kind": "empty" }),
        MemoView::Text(t) => serde_json::json!({ "kind": "text", "value": t }),
        MemoView::Binary(h) => serde_json::json!({ "kind": "binary", "value": h }),
    }
}

fn dir(d: Direction) -> &'static str {
    match d {
        Direction::Outgoing => "outgoing",
        Direction::Incoming => "incoming",
    }
}

fn pool(p: Pool) -> &'static str {
    p.name()
}

fn check(a: &Args) -> Result<(), String> {
    let s = a.positional.get(1).ok_or("check needs a disclosure")?;
    let d = Disclosure::decode(s).map_err(|e| e.to_string())?;
    let txid = d.txid.to_string();
    let (hex, height, source) = match &a.tx_file {
        Some(f) => (read_input(f)?, None, "the transaction you supplied"),
        None => {
            let f = fetch(d.network, &txid)?;
            (f.hex, f.height, "Blockchair")
        }
    };
    let v = chit_core::verify(&load_tx(&hex)?, &d).map_err(|e| format!("VOID: {e}"))?;
    if a.json {
        println!(
            "{}",
            serde_json::json!({
                "valid": true, "txid": v.txid, "pool": pool(v.pool), "action": v.action,
                "direction": dir(v.direction), "value_zat": v.value_zat,
                "recipient": v.recipient, "memo": memo_json(&v.memo), "height": height,
            })
        );
    } else {
        println!("VALID  {}", zec(v.value_zat));
        println!("  to      {}", v.recipient);
        println!("  memo    {}", memo_text(&v.memo));
        println!("  tx      {} ({} output {})", v.txid, pool(v.pool), v.action);
        if let Some(h) = height {
            println!("  mined   block {h}");
        }
        println!("  by      the {}", if v.direction == Direction::Outgoing { "payer" } else { "payee" });
        println!("  source  {source}");
    }
    Ok(())
}

fn make(a: &Args) -> Result<(), String> {
    let network = if a.testnet { NetworkType::Test } else { NetworkType::Main };
    let key = match (&a.key_file, std::env::var("CHIT_UFVK")) {
        (Some(f), _) => read_input(f)?,
        (None, Ok(k)) => k,
        _ => return Err("make needs --key-file FILE or CHIT_UFVK".into()),
    };
    let hex = match (&a.tx_file, a.positional.get(1)) {
        (Some(f), _) => read_input(f)?,
        (None, Some(txid)) => fetch(network, &txid.to_lowercase())?.hex,
        _ => return Err("make needs a txid or --tx FILE".into()),
    };
    let found = chit_core::scan(&load_tx(&hex)?, &key, network).map_err(|e| e.to_string())?;
    if a.json {
        let out: Vec<_> = found
            .iter()
            .map(|f| {
                serde_json::json!({
                    "pool": pool(f.pool), "action": f.action, "direction": dir(f.direction),
                    "change": f.change, "value_zat": f.value_zat, "recipient": f.recipient,
                    "memo": memo_json(&f.memo), "disclosure": f.disclosure,
                })
            })
            .collect();
        println!("{}", serde_json::Value::Array(out));
        return Ok(());
    }
    if found.is_empty() {
        return Err("this viewing key has no Orchard or Ironwood outputs in that transaction".into());
    }
    for f in &found {
        let label = if f.change { "change" } else if f.direction == Direction::Outgoing { "you paid" } else { "you received" };
        println!("{label:<12} {}  ({} output {})", zec(f.value_zat), pool(f.pool), f.action);
        println!("  to    {}", f.recipient);
        println!("  memo  {}", memo_text(&f.memo));
        println!("  chit  {}\n", f.disclosure);
    }
    Ok(())
}

fn inspect(a: &Args) -> Result<(), String> {
    let s = a.positional.get(1).ok_or("inspect needs a disclosure")?;
    let d = Disclosure::decode(s).map_err(|e| e.to_string())?;
    println!("network  {}", if d.network == NetworkType::Main { "mainnet" } else { "testnet" });
    println!("tx       {}", d.txid);
    println!("output   {} {}", pool(d.pool), d.action);
    println!("by       the {}", if d.key.direction() == Direction::Outgoing { "payer (ock)" } else { "payee (pk_d, esk)" });
    Ok(())
}

fn main() -> ExitCode {
    let result = parse_args().and_then(|a| match a.positional.first().map(String::as_str) {
        Some("check") | Some("verify") => check(&a),
        Some("make") | Some("scan") => make(&a),
        Some("inspect") => inspect(&a),
        _ => Err(String::new()),
    });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) if e.is_empty() => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
