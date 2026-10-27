//! `chit`: make and check Zcash Orchard/Ironwood payment disclosures.
//!
//!     chit check <zout…> [--tx FILE]
//!     chit make  <txid | --tx FILE> --key-file FILE [--testnet]
//!     chit inspect <zout…>
//!
//! The viewing key is read from a file (or `CHIT_UFVK`), never from the command line,
//! so it does not end up in shell history or the process list.

mod report;
mod serve;
mod source;

use chit_core::{Direction, Disclosure, MemoView, Pool, Transaction};
use std::process::ExitCode;
use zcash_protocol::consensus::NetworkType;

const USAGE: &str = "usage:
  chit check <zout…> [--tx FILE]                         verify a disclosure
  chit make  (<txid> | --tx FILE) --key-file FILE [--testnet]
                                                        list outputs your viewing key can disclose
  chit inspect <zout…>                                   show which transaction a disclosure names
  chit check-burn <txid>                                list the Burn Book posts in a mined transaction
  chit serve [--listen ADDR] [--web DIR] [--cors ORIGIN] [--threads N] [--allow-scan]
                                                        run the verification API (see /openapi.json)

  --rpc URL    fetch transactions from your own Zebra node, e.g. http://user:pass@127.0.0.1:8232
               (default: Blockchair's public API, which learns the txids you look up)
  --tx FILE    raw transaction hex (\"-\" for stdin) instead of fetching it
  --json       machine-readable output
  The viewing key can also come from the CHIT_UFVK environment variable.";

struct Args {
    positional: Vec<String>,
    tx_file: Option<String>,
    key_file: Option<String>,
    rpc: Option<String>,
    listen: String,
    web: Option<std::path::PathBuf>,
    cors: Option<String>,
    threads: usize,
    allow_scan: bool,
    testnet: bool,
    json: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args {
        positional: vec![],
        tx_file: None,
        key_file: None,
        rpc: std::env::var("CHIT_RPC").ok(),
        listen: "127.0.0.1:8787".into(),
        web: None,
        cors: None,
        threads: 16,
        allow_scan: false,
        testnet: false,
        json: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--tx" => a.tx_file = Some(it.next().ok_or("--tx needs a file")?),
            "--key-file" => a.key_file = Some(it.next().ok_or("--key-file needs a file")?),
            "--rpc" => a.rpc = Some(it.next().ok_or("--rpc needs a URL")?),
            "--listen" => a.listen = it.next().ok_or("--listen needs an address")?,
            "--web" => a.web = Some(it.next().ok_or("--web needs a directory")?.into()),
            "--cors" => a.cors = Some(it.next().ok_or("--cors needs an origin")?),
            "--threads" => {
                a.threads = it
                    .next()
                    .and_then(|n| n.parse().ok())
                    .ok_or("--threads needs a number")?
            }
            "--allow-scan" => a.allow_scan = true,
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

fn fetch(a: &Args, network: NetworkType, txid: &str) -> Result<source::Fetched, String> {
    source::from_flag(a.rpc.as_deref())?.fetch(network, txid)
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
        MemoView::Binary(h) if h.len() > 48 => {
            format!("binary {}… ({} bytes)", &h[..48], h.len() / 2)
        }
        MemoView::Binary(h) => format!("binary {h}"),
    }
}

fn pool(p: Pool) -> &'static str {
    p.name()
}

fn check(a: &Args) -> Result<(), String> {
    let s = a.positional.get(1).ok_or("check needs a disclosure")?;
    let d = Disclosure::decode(s).map_err(|e| e.to_string())?;
    let fetched = match &a.tx_file {
        Some(_) => None,
        None => Some(fetch(a, d.network, &d.txid.to_string())?),
    };
    let hex = match &a.tx_file {
        Some(f) => read_input(f)?,
        None => fetched.as_ref().unwrap().hex.clone(),
    };
    let r = chit_core::verify_with_steps(&load_tx(&hex)?, &d);
    if a.json {
        println!("{}", report::report(&r, fetched.as_ref()));
        return if r.result.is_ok() {
            Ok(())
        } else {
            Err("VOID".into())
        };
    }
    for s in &r.steps {
        let mark = match s.ok {
            Some(true) => "✓",
            Some(false) => "✕",
            None => "–",
        };
        println!("  {mark} {}", s.label);
    }
    let v = r.result.map_err(|e| format!("VOID: {e}"))?;
    println!("VALID  {}", zec(v.value_zat));
    println!("  to      {}", v.recipient);
    println!("  memo    {}", memo_text(&v.memo));
    println!(
        "  tx      {} ({} output {})",
        v.txid,
        pool(v.pool),
        v.action
    );
    match &fetched {
        Some(f) => match f.height {
            Some(h) => println!("  mined   block {h} ({})", f.source),
            None => println!("  mined   NOT YET ({})", f.source),
        },
        None => println!("  mined   unknown: checked against the transaction you supplied"),
    }
    // The form says which key opened the note, not who made the chit: a payer knows esk too.
    println!(
        "  form    {}",
        if v.direction == Direction::Outgoing {
            "outgoing cipher key (ock)"
        } else {
            "note keys (pk_d || esk)"
        }
    );
    Ok(())
}

fn make(a: &Args) -> Result<(), String> {
    let network = if a.testnet {
        NetworkType::Test
    } else {
        NetworkType::Main
    };
    let key = match (&a.key_file, std::env::var("CHIT_UFVK")) {
        (Some(f), _) => read_input(f)?,
        (None, Ok(k)) => k,
        _ => return Err("make needs --key-file FILE or CHIT_UFVK".into()),
    };
    let hex = match (&a.tx_file, a.positional.get(1)) {
        (Some(f), _) => read_input(f)?,
        (None, Some(txid)) => fetch(a, network, &txid.to_lowercase())?.hex,
        _ => return Err("make needs a txid or --tx FILE".into()),
    };
    let found = chit_core::scan(&load_tx(&hex)?, &key, network).map_err(|e| e.to_string())?;
    if a.json {
        println!("{}", report::found(&found));
        return Ok(());
    }
    if found.is_empty() {
        return Err(
            "this viewing key has no Orchard or Ironwood outputs in that transaction".into(),
        );
    }
    for f in &found {
        let label = if f.change {
            "change"
        } else if f.direction == Direction::Outgoing {
            "you paid"
        } else {
            "you received"
        };
        println!(
            "{label:<12} {}  ({} output {})",
            zec(f.value_zat),
            pool(f.pool),
            f.action
        );
        println!("  to    {}", f.recipient);
        println!("  memo  {}", memo_text(&f.memo));
        println!("  chit  {}\n", f.disclosure);
    }
    Ok(())
}

fn check_burn(a: &Args) -> Result<(), String> {
    let txid = a
        .positional
        .get(1)
        .ok_or("check-burn needs a txid")?
        .to_lowercase();
    let f = fetch(a, NetworkType::Main, &txid)?;
    let height = f.height.ok_or("not mined yet")?;
    let burns = chit_core::burn::burns_in(&load_tx(&f.hex)?, NetworkType::Main);
    if burns.is_empty() {
        return Err("no output to the Burn Book address in that transaction".into());
    }
    for b in &burns {
        println!(
            "burn  {}  block {height}  output {}  {}",
            zec(b.value_zat),
            b.action,
            memo_text(&b.memo)
        );
    }
    Ok(())
}

fn inspect(a: &Args) -> Result<(), String> {
    let s = a.positional.get(1).ok_or("inspect needs a disclosure")?;
    let d = Disclosure::decode(s).map_err(|e| e.to_string())?;
    println!(
        "network  {}",
        if d.network == NetworkType::Main {
            "mainnet"
        } else {
            "testnet"
        }
    );
    println!("tx       {}", d.txid);
    println!("output   {} {}", pool(d.pool), d.action);
    println!(
        "by       the {}",
        if d.key.direction() == Direction::Outgoing {
            "payer (ock)"
        } else {
            "payee (pk_d, esk)"
        }
    );
    Ok(())
}

fn main() -> ExitCode {
    let result = parse_args().and_then(|a| match a.positional.first().map(String::as_str) {
        Some("check") | Some("verify") => check(&a),
        Some("make") | Some("scan") => make(&a),
        Some("inspect") => inspect(&a),
        Some("check-burn") => check_burn(&a),
        Some("serve") => serve::run(
            source::from_flag(a.rpc.as_deref())?,
            serve::Config {
                web: a.web.clone(),
                listen: a.listen.clone(),
                cors: a.cors.clone(),
                threads: a.threads,
                allow_scan: a.allow_scan,
            },
        ),
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
