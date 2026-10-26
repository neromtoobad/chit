//! Where transactions come from. Verification itself never touches the network; it only
//! needs the raw transaction. A source supplies that, plus whether and where it is mined.
//!
//! - [`Zebra`]: your own full node over JSON-RPC (`getrawtransaction txid 1`). Nothing
//!   leaves your infrastructure.
//! - [`Blockchair`]: the public explorer API. Convenient, but it learns which txids you
//!   look up.

use serde_json::{json, Value};
use zcash_protocol::consensus::NetworkType;

#[derive(Debug, Clone)]
pub struct Fetched {
    pub hex: String,
    pub height: Option<u64>,
    pub confirmations: Option<u64>,
    pub source: &'static str,
}

pub trait Source: Send + Sync {
    fn name(&self) -> &'static str;
    fn fetch(&self, network: NetworkType, txid: &str) -> Result<Fetched, String>;
}

fn check_txid(txid: &str) -> Result<(), String> {
    if txid.len() == 64 && txid.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("a txid is 64 hex characters".into())
    }
}

pub struct Blockchair;

impl Source for Blockchair {
    fn name(&self) -> &'static str {
        "blockchair"
    }

    fn fetch(&self, network: NetworkType, txid: &str) -> Result<Fetched, String> {
        check_txid(txid)?;
        if network != NetworkType::Main {
            return Err("Blockchair has no Zcash testnet; use --rpc with your own node".into());
        }
        let get = |url: String| -> Result<Value, String> {
            ureq::get(&url)
                .call()
                .map_err(|e| format!("blockchair: {e}"))?
                .body_mut()
                .read_json()
                .map_err(|e| format!("blockchair: {e}"))
        };
        let raw = get(format!(
            "https://api.blockchair.com/zcash/raw/transaction/{txid}"
        ))?;
        let hex = raw["data"][txid]["raw_transaction"]
            .as_str()
            .ok_or("the explorer does not know this transaction")?
            .to_string();
        let tip = raw["context"]["state"].as_u64();
        let height = get(format!(
            "https://api.blockchair.com/zcash/dashboards/transaction/{txid}"
        ))
        .ok()
        .and_then(|d| d["data"][txid]["transaction"]["block_id"].as_u64())
        .filter(|h| *h > 0);
        Ok(Fetched {
            hex,
            height,
            confirmations: height.zip(tip).map(|(h, t)| t.saturating_sub(h) + 1),
            source: self.name(),
        })
    }
}

/// A Zebra (or any zcashd-compatible) JSON-RPC endpoint, e.g. `http://user:pass@127.0.0.1:8232`.
pub struct Zebra {
    url: String,
    auth: Option<String>,
}

impl Zebra {
    pub fn new(url: &str) -> Result<Self, String> {
        let (scheme, rest) = url
            .split_once("://")
            .ok_or("--rpc must be a URL like http://127.0.0.1:8232")?;
        // Credentials in the URL become HTTP basic auth, and are kept out of the request URL.
        let (auth, host) = match rest.rsplit_once('@') {
            Some((cred, host)) => (Some(format!("Basic {}", base64(cred.as_bytes()))), host),
            None => (None, rest),
        };
        Ok(Zebra {
            url: format!("{scheme}://{host}"),
            auth,
        })
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut req = ureq::post(&self.url).header("content-type", "application/json");
        if let Some(a) = &self.auth {
            req = req.header("authorization", a);
        }
        let mut resp = req
            .send_json(
                json!({ "jsonrpc": "2.0", "id": "chit", "method": method, "params": params }),
            )
            .map_err(|e| format!("node: {e}"))?;
        let v: Value = resp
            .body_mut()
            .read_json()
            .map_err(|e| format!("node: {e}"))?;
        if !v["error"].is_null() {
            return Err(format!(
                "node: {}",
                v["error"]["message"].as_str().unwrap_or("error")
            ));
        }
        Ok(v["result"].clone())
    }
}

impl Source for Zebra {
    fn name(&self) -> &'static str {
        "zebra-rpc"
    }

    fn fetch(&self, _network: NetworkType, txid: &str) -> Result<Fetched, String> {
        check_txid(txid)?;
        let r = self.call("getrawtransaction", json!([txid, 1]))?;
        let hex = r["hex"]
            .as_str()
            .ok_or("node returned no transaction hex")?
            .to_string();
        // Mempool transactions have no height; a negative or absent one means unmined.
        let height = r["height"].as_i64().filter(|h| *h > 0).map(|h| h as u64);
        let confirmations = r["confirmations"].as_u64().filter(|c| *c > 0);
        Ok(Fetched {
            hex,
            height,
            confirmations,
            source: self.name(),
        })
    }
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                T[(n >> (18 - 6 * i) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    out
}

/// `--rpc URL` selects your node; otherwise Blockchair.
pub fn from_flag(rpc: Option<&str>) -> Result<Box<dyn Source>, String> {
    match rpc {
        Some(url) => Ok(Box::new(Zebra::new(url)?)),
        None => Ok(Box::new(Blockchair)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_auth_is_split_out_of_the_url() {
        let z = Zebra::new("http://alice:s3cret@127.0.0.1:8232").unwrap();
        assert_eq!(z.url, "http://127.0.0.1:8232");
        assert_eq!(z.auth.as_deref(), Some("Basic YWxpY2U6czNjcmV0"));
        assert!(Zebra::new("http://127.0.0.1:8232").unwrap().auth.is_none());
    }

    #[test]
    fn rejects_malformed_txids_before_any_request() {
        assert!(Blockchair.fetch(NetworkType::Main, "zz").is_err());
        assert!(Zebra::new("http://127.0.0.1:1")
            .unwrap()
            .fetch(NetworkType::Main, "../etc")
            .is_err());
    }
}
