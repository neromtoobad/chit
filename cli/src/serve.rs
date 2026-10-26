//! `chit serve`: a small, self-hostable verification API for merchants, exchanges and
//! support desks. Point it at your own node (`--rpc`) and no lookup leaves your network.
//!
//!   GET  /v1/health
//!   GET  /v1/inspect/{chit}
//!   GET  /v1/verify/{chit}              fetch the transaction, verify, report every step
//!   POST /v1/verify   {chit, tx_hex?}
//!   POST /v1/scan     {ufvk, txid | tx_hex, network?}   (self-host only: takes a viewing key)
//!   GET  /v1/burns/{txid}
//!   GET  /v1/tx/{txid}                  the raw transaction and where it is mined
//!   GET  /openapi.json
//!
//! With `--web DIR` it also serves the Chit web app from the same origin. The app notices
//! `/v1/health` and fetches transactions from here instead of Blockchair, so a merchant
//! running `chit serve --rpc … --web …` next to their own Zebra node uses no third party.
//!
//! Mined transactions never change, so fetched ones are cached in memory.

use crate::report;
use crate::source::{Fetched, Source};
use chit_core::Disclosure;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Method, Request, Response, Server};
use zcash_protocol::consensus::NetworkType;

const MAX_BODY: u64 = 2 * 1024 * 1024;
const CACHE_MAX: usize = 2048;

pub struct Config {
    pub web: Option<std::path::PathBuf>,
    pub listen: String,
    pub cors: Option<String>,
    pub threads: usize,
}

struct App {
    web: Option<std::path::PathBuf>,
    source: Box<dyn Source>,
    cache: Mutex<HashMap<String, Fetched>>,
    cors: Option<String>,
}

type Reply = (u16, Value);

fn bad(msg: impl Into<String>) -> Reply {
    (400, json!({ "error": msg.into() }))
}

impl App {
    fn fetch(&self, network: NetworkType, txid: &str) -> Result<Fetched, Reply> {
        let txid = txid.to_lowercase();
        if let Some(f) = self.cache.lock().unwrap().get(&txid) {
            return Ok(f.clone());
        }
        let f = self
            .source
            .fetch(network, &txid)
            .map_err(|e| (502, json!({ "error": e })))?;
        if f.height.is_some() {
            let mut c = self.cache.lock().unwrap();
            if c.len() >= CACHE_MAX {
                c.clear();
            }
            c.insert(txid, f.clone());
        }
        Ok(f)
    }

    fn verify(&self, chit: &str, tx_hex: Option<&str>) -> Reply {
        let d = match Disclosure::decode(chit) {
            Ok(d) => d,
            Err(e) => return bad(e.to_string()),
        };
        let fetched = match tx_hex {
            Some(_) => None,
            None => match self.fetch(d.network, &d.txid.to_string()) {
                Ok(f) => Some(f),
                Err(r) => return r,
            },
        };
        let hex = tx_hex
            .map(str::to_string)
            .unwrap_or_else(|| fetched.as_ref().unwrap().hex.clone());
        let tx = match hex::decode(hex.trim())
            .map_err(|_| "tx_hex is not hex".to_string())
            .and_then(|b| chit_core::parse_tx(&b).map_err(|e| e.to_string()))
        {
            Ok(t) => t,
            Err(e) => return bad(e),
        };
        let r = chit_core::verify_with_steps(&tx, &d);
        (200, report::report(&r, fetched.as_ref()))
    }

    fn scan(&self, body: &Value) -> Reply {
        let Some(ufvk) = body["ufvk"].as_str() else {
            return bad("ufvk is required");
        };
        let network = if body["network"].as_str() == Some("test") {
            NetworkType::Test
        } else {
            NetworkType::Main
        };
        let hex = match (body["tx_hex"].as_str(), body["txid"].as_str()) {
            (Some(h), _) => h.to_string(),
            (None, Some(t)) => match self.fetch(network, t) {
                Ok(f) => f.hex,
                Err(r) => return r,
            },
            _ => return bad("txid or tx_hex is required"),
        };
        let tx = match hex::decode(hex.trim())
            .map_err(|_| "not hex".to_string())
            .and_then(|b| chit_core::parse_tx(&b).map_err(|e| e.to_string()))
        {
            Ok(t) => t,
            Err(e) => return bad(e),
        };
        match chit_core::scan(&tx, ufvk, network) {
            Ok(found) => (
                200,
                json!({ "txid": tx.txid().to_string(), "outputs": report::found(&found) }),
            ),
            Err(e) => bad(e.to_string()),
        }
    }

    fn burns(&self, txid: &str) -> Reply {
        let f = match self.fetch(NetworkType::Main, txid) {
            Ok(f) => f,
            Err(r) => return r,
        };
        let tx = match hex::decode(&f.hex)
            .ok()
            .and_then(|b| chit_core::parse_tx(&b).ok())
        {
            Some(t) => t,
            None => {
                return (
                    502,
                    json!({ "error": "source returned an unparseable transaction" }),
                )
            }
        };
        let burns = chit_core::burn::burns_in(&tx, NetworkType::Main);
        (
            200,
            json!({ "txid": tx.txid().to_string(), "mined": report::mined(Some(&f)), "burns": report::found(&burns) }),
        )
    }

    fn route(&self, method: &Method, path: &str, body: &str) -> Reply {
        let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
        let json_body =
            || serde_json::from_str::<Value>(body).map_err(|_| bad("body must be JSON"));
        match (method, parts.as_slice()) {
            (Method::Get, ["v1", "health"]) => (
                200,
                json!({ "ok": true, "source": self.source.name(), "version": env!("CARGO_PKG_VERSION") }),
            ),
            (Method::Get, ["openapi.json"]) => (
                200,
                serde_json::from_str(include_str!("../openapi.json")).unwrap(),
            ),
            (Method::Get, ["v1", "inspect", chit]) => match Disclosure::decode(chit) {
                Ok(d) => (
                    200,
                    json!({ "network": if d.network == NetworkType::Main { "main" } else { "test" }, "txid": d.txid.to_string(), "pool": d.pool.name(), "action": d.action, "direction": report::direction(d.key.direction()) }),
                ),
                Err(e) => bad(e.to_string()),
            },
            (Method::Get, ["v1", "verify", chit]) => self.verify(chit, None),
            (Method::Post, ["v1", "verify"]) => match json_body() {
                Ok(b) => match b["chit"].as_str() {
                    Some(c) => self.verify(c, b["tx_hex"].as_str()),
                    None => bad("chit is required"),
                },
                Err(r) => r,
            },
            (Method::Post, ["v1", "scan"]) => match json_body() {
                Ok(b) => self.scan(&b),
                Err(r) => r,
            },
            (Method::Get, ["v1", "burns", txid]) => self.burns(txid),
            (Method::Get, ["v1", "tx", txid]) => match self.fetch(NetworkType::Main, txid) {
                Ok(f) => (
                    200,
                    json!({ "hex": f.hex, "height": f.height, "confirmations": f.confirmations, "source": f.source }),
                ),
                Err(r) => r,
            },
            _ => (404, json!({ "error": "not found", "see": "/openapi.json" })),
        }
    }

    fn handle(&self, mut req: Request) {
        let mut body = String::new();
        if req.body_length().unwrap_or(0) as u64 > MAX_BODY {
            return self.respond(req, (413, json!({ "error": "body too large" })));
        }
        if req
            .as_reader()
            .take(MAX_BODY)
            .read_to_string(&mut body)
            .is_err()
        {
            return self.respond(req, bad("body must be UTF-8"));
        }
        if req.method() == &Method::Options {
            return self.respond(req, (204, Value::Null));
        }
        let path = req.url().split('?').next().unwrap_or("/").to_string();
        if let (Some(dir), &Method::Get, false) = (
            &self.web,
            req.method(),
            path.starts_with("/v1/") || path == "/openapi.json",
        ) {
            return self.static_file(req, dir, &path);
        }
        let reply = self.route(req.method(), &path, &body);
        self.respond(req, reply);
    }

    /// Serves the built web app. Paths are confined to `dir`; unknown paths get index.html.
    fn static_file(&self, req: Request, dir: &std::path::Path, path: &str) {
        let rel = path.trim_start_matches('/');
        let safe = !rel.split('/').any(|c| c == ".." || c.starts_with('.'));
        let mut file = dir.join(if rel.is_empty() || !safe {
            "index.html"
        } else {
            rel
        });
        if !file.is_file() {
            file = dir.join("index.html");
        }
        let Ok(bytes) = std::fs::read(&file) else {
            return self.respond(req, (404, json!({ "error": "not found" })));
        };
        let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("");
        let ctype = match ext {
            "html" => "text/html; charset=utf-8",
            "js" | "mjs" => "text/javascript",
            "css" => "text/css",
            "wasm" => "application/wasm",
            "json" => "application/json",
            "svg" => "image/svg+xml",
            "woff2" => "font/woff2",
            "woff" => "font/woff",
            "webmanifest" => "application/manifest+json",
            _ => "application/octet-stream",
        };
        let mut resp = Response::from_data(bytes);
        let mut add = |k: &str, v: &str| {
            resp.add_header(Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap())
        };
        add("content-type", ctype);
        add("x-content-type-options", "nosniff");
        add("referrer-policy", "no-referrer");
        add("x-frame-options", "DENY");
        // Self-hosted: the page may talk to this server and the drand beacon, nothing else.
        add("content-security-policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' https://api.drand.sh; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
        if path.starts_with("/assets/") {
            add("cache-control", "public, max-age=31536000, immutable");
        }
        let _ = req.respond(resp);
    }

    fn respond(&self, req: Request, (status, body): Reply) {
        let text = if body.is_null() {
            String::new()
        } else {
            body.to_string()
        };
        let mut resp = Response::from_string(text).with_status_code(status);
        let mut add = |k: &str, v: &str| {
            resp.add_header(Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap())
        };
        add("content-type", "application/json");
        add("cache-control", "no-store");
        add("x-content-type-options", "nosniff");
        if let Some(origin) = &self.cors {
            add("access-control-allow-origin", origin);
            add("access-control-allow-methods", "GET, POST, OPTIONS");
            add("access-control-allow-headers", "content-type");
        }
        let _ = req.respond(resp);
    }
}

pub fn run(source: Box<dyn Source>, cfg: Config) -> Result<(), String> {
    let server = Arc::new(
        Server::http(&cfg.listen).map_err(|e| format!("cannot listen on {}: {e}", cfg.listen))?,
    );
    if let Some(dir) = &cfg.web {
        if !dir.join("index.html").is_file() {
            return Err(format!(
                "--web {}: no index.html there (build the app with scripts/build.sh)",
                dir.display()
            ));
        }
    }
    let app = Arc::new(App {
        web: cfg.web,
        source,
        cache: Mutex::new(HashMap::new()),
        cors: cfg.cors,
    });
    eprintln!(
        "chit serve: listening on http://{} (source: {})",
        cfg.listen,
        app.source.name()
    );
    let workers: Vec<_> = (0..cfg.threads.max(1))
        .map(|_| {
            let (server, app) = (server.clone(), app.clone());
            std::thread::spawn(move || {
                for req in server.incoming_requests() {
                    app.handle(req);
                }
            })
        })
        .collect();
    for w in workers {
        let _ = w.join();
    }
    Ok(())
}
