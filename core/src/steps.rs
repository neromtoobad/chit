//! The verification of a disclosure, broken into the individual checks a wallet runs when it
//! recovers a note, so a UI can show each one.
//!
//! The verdict is never taken from these steps: [`verify_with_steps`] also runs
//! [`crate::verify`], which uses `zcash_note_encryption`'s own recovery routine, and only
//! reports success when both agree.

use crate::{bundle_actions, Disclosure, Error, KeyMaterial, Pool, Verified};
use chacha20poly1305::{AeadInOut, ChaCha20Poly1305, KeyInit, Nonce};
use orchard::{
    note_encryption::{DomainVersion, IronwoodVersion, NoteEncryptionDomain, OrchardVersion},
    Action,
};
use subtle::ConstantTimeEq;
use zcash_note_encryption::{Domain, OutPlaintextBytes, ShieldedOutput, OUT_PLAINTEXT_SIZE};
use zcash_primitives::transaction::Transaction;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub id: &'static str,
    pub label: String,
    /// `None` when an earlier step failed and this one did not run.
    pub ok: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct Report {
    pub steps: Vec<Step>,
    pub result: Result<Verified, Error>,
}

struct Log(Vec<Step>);

impl Log {
    /// Records a step and returns whether it passed.
    fn check(&mut self, id: &'static str, label: impl Into<String>, ok: bool) -> bool {
        self.0.push(Step {
            id,
            label: label.into(),
            ok: Some(ok),
        });
        ok
    }

    fn skip(&mut self, ids: &[(&'static str, &str)]) {
        for (id, label) in ids {
            self.0.push(Step {
                id,
                label: label.to_string(),
                ok: None,
            });
        }
    }
}

const NOTE_STEPS: [(&str, &str); 6] = [
    ("note", "Note ciphertext opens"),
    ("version", "Note version matches the pool"),
    ("parse", "Note plaintext parses"),
    ("esk", "esk re-derives from the note's rseed (ZIP 212)"),
    ("epk", "[esk]·g_d equals the on-chain ephemeral key"),
    ("cmx", "Note commitment recomputes to the on-chain cmx"),
];

pub fn verify_with_steps(tx: &Transaction, d: &Disclosure) -> Report {
    let mut log = Log(Vec::new());
    let actual = tx.txid();
    let short = |s: String| format!("{}…{}", &s[..8], &s[s.len() - 8..]);
    if log.check(
        "txid",
        format!(
            "Transaction hashes to its txid {}",
            short(actual.to_string())
        ),
        actual == d.txid,
    ) {
        let actions = bundle_actions(tx, d.pool);
        let found = actions.get(d.action as usize);
        let label = format!(
            "Output {} exists in the {} bundle ({} actions)",
            d.action,
            d.pool.name(),
            actions.len()
        );
        if log.check("action", label, found.is_some()) {
            let action = found.unwrap();
            match d.pool {
                Pool::Orchard => note_steps::<OrchardVersion>(&mut log, action, &d.key, 0x02),
                Pool::Ironwood => note_steps::<IronwoodVersion>(&mut log, action, &d.key, 0x03),
            }
        } else {
            log.skip(&[("key", "Chit key material decodes")]);
            log.skip(&NOTE_STEPS);
        }
    } else {
        log.skip(&[
            ("action", "Output exists in the bundle"),
            ("key", "Chit key material decodes"),
        ]);
        log.skip(&NOTE_STEPS);
    }

    let result = crate::verify(tx, d);
    let steps_ok = log.0.iter().all(|s| s.ok == Some(true));
    // The two paths must agree; if they ever do not, report failure.
    let result = match result {
        Ok(v) if steps_ok => Ok(v),
        Ok(_) => Err(Error::Invalid),
        Err(e) => Err(e),
    };
    log.check(
        "official",
        "zcash_note_encryption recovery agrees",
        steps_ok && result.is_ok(),
    );
    Report {
        steps: log.0,
        result,
    }
}

fn note_steps<V: DomainVersion>(
    log: &mut Log,
    action: &Action<impl Sized>,
    key: &KeyMaterial,
    lead: u8,
) {
    type D<V> = NoteEncryptionDomain<V>;
    let domain = D::<V>::for_action(action);

    // pk_d || esk, either opened from the outgoing ciphertext or carried by the chit.
    let op = match key {
        KeyMaterial::Ock(ock) => {
            let out = &action.encrypted_note().out_ciphertext;
            let mut op = OutPlaintextBytes([0; OUT_PLAINTEXT_SIZE]);
            op.0.copy_from_slice(&out[..OUT_PLAINTEXT_SIZE]);
            let tag: [u8; 16] = out[OUT_PLAINTEXT_SIZE..].try_into().unwrap();
            let ok = ChaCha20Poly1305::new(ock.into())
                .decrypt_inout_detached(&Nonce::default(), &[], (&mut op.0[..]).into(), &tag.into())
                .is_ok();
            if !log.check(
                "key",
                "Outgoing ciphertext opens with the chit's ock (ChaCha20-Poly1305)",
                ok,
            ) {
                log.skip(&NOTE_STEPS);
                return;
            }
            op
        }
        KeyMaterial::PkdEsk(bytes) => OutPlaintextBytes(*bytes),
    };
    let pk_d = D::<V>::extract_pk_d(&op);
    let esk = D::<V>::extract_esk(&op);
    let (pk_d, esk) = match (pk_d, esk) {
        (Some(p), Some(e)) => {
            log.check(
                "keys",
                "pk_d is a Pallas point and esk a valid scalar",
                true,
            );
            (p, e)
        }
        _ => {
            log.check(
                "keys",
                "pk_d is a Pallas point and esk a valid scalar",
                false,
            );
            log.skip(&NOTE_STEPS);
            return;
        }
    };

    let epk = ShieldedOutput::<D<V>>::ephemeral_key(action);
    let sym = D::<V>::kdf(D::<V>::ka_agree_enc(&esk, &pk_d), &epk);
    let Some((mut plaintext, tag)) = ShieldedOutput::<D<V>>::split_ciphertext_at_tag(action) else {
        log.check("note", NOTE_STEPS[0].1, false);
        log.skip(&NOTE_STEPS[1..]);
        return;
    };
    let opened = ChaCha20Poly1305::new_from_slice(sym.as_ref())
        .ok()
        .and_then(|c| {
            c.decrypt_inout_detached(
                &Nonce::default(),
                &[],
                plaintext.as_mut().into(),
                &tag.into(),
            )
            .ok()
        })
        .is_some();
    if !log.check("note", "Note ciphertext opens with KDF([esk]·pk_d)", opened) {
        log.skip(&NOTE_STEPS[1..]);
        return;
    }

    let pool = if lead == 0x03 { "Ironwood" } else { "Orchard" };
    let version_ok = plaintext.as_ref().first() == Some(&lead);
    if !log.check(
        "version",
        format!("Note version 0x{lead:02x} matches the {pool} pool"),
        version_ok,
    ) {
        log.skip(&NOTE_STEPS[2..]);
        return;
    }

    let parsed = domain
        .split_plaintext_at_memo(&plaintext)
        .and_then(|(compact, _)| domain.parse_note_plaintext_without_memo_ovk(&pk_d, &compact));
    let Some((note, _)) = parsed else {
        log.check("parse", NOTE_STEPS[2].1, false);
        log.skip(&NOTE_STEPS[3..]);
        return;
    };
    log.check("parse", NOTE_STEPS[2].1, true);

    let esk_ok = D::<V>::derive_esk(&note).is_some_and(|e| bool::from(e.ct_eq(&esk)));
    log.check("esk", NOTE_STEPS[3].1, esk_ok);
    let epk_ok = D::<V>::epk_bytes(&D::<V>::ka_derive_public(&note, &esk)).0 == epk.0;
    log.check("epk", NOTE_STEPS[4].1, epk_ok);
    let cmx_ok = <[u8; 32]>::from(&D::<V>::cmstar(&note)) == action.cmx().to_bytes();
    log.check("cmx", NOTE_STEPS[5].1, cmx_ok);
}
