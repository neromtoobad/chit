//! The Burn Book address: a shielded Orchard/Ironwood address that nobody can ever spend
//! from, and that anyone can check is unspendable.
//!
//! An Orchard full viewing key is `(ak, nk, rivk)`. Spending a note needs a signature under
//! `rk = ak + [α]G`, which needs the spend authorizing key `ask` with `ak = [ask]G`. Here
//! `ak` is not derived from any `ask`: it is a hash-to-curve output,
//!
//! ```text
//! ak = ±GroupHash^Pallas("z.cash:Chit-BurnBook", "ak")
//! ```
//!
//! (negated if needed so its y-coordinate is positive, as Orchard requires). Finding `ask`
//! would mean computing a discrete logarithm of a point nobody chose, which is the same
//! assumption every Zcash signature rests on. `nk` and `rivk` are also derived from public
//! strings; they are not secret, because the whole full viewing key is published. That
//! makes every burn and its memo publicly readable, while the burner stays anonymous.

use blake2b_simd::Params;
use ff::{FromUniformBytes, PrimeField};
use group::{Curve, GroupEncoding};
use orchard::keys::{FullViewingKey, Scope};
use pasta_curves::{arithmetic::CurveExt, pallas};
use zcash_address::unified::{Encoding, Fvk, Revision, Ufvk, Uitem};
use zcash_keys::address::UnifiedAddress;
use zcash_protocol::consensus::{Network, NetworkType};

pub const DOMAIN: &str = "z.cash:Chit-BurnBook";

fn wide(personal: &[u8; 16], msg: &[u8]) -> [u8; 64] {
    let h = Params::new().hash_length(64).personal(personal).hash(msg);
    h.as_bytes().try_into().unwrap()
}

/// The raw 96-byte full viewing key, and how each part was derived.
pub fn burn_fvk_bytes() -> [u8; 96] {
    let p = pallas::Point::hash_to_curve(DOMAIN)(b"ak");
    let mut ak = p.to_affine().to_bytes();
    if ak[31] & 0x80 != 0 {
        ak = (-p).to_affine().to_bytes();
    }
    let nk = pallas::Base::from_uniform_bytes(&wide(b"ChitBurnBook__nk", b"nk")).to_repr();
    let rivk = pallas::Scalar::from_uniform_bytes(&wide(b"ChitBurnBook_rvk", b"rivk")).to_repr();
    let mut out = [0u8; 96];
    out[..32].copy_from_slice(&ak);
    out[32..64].copy_from_slice(&nk);
    out[64..].copy_from_slice(&rivk);
    out
}

pub fn burn_fvk() -> FullViewingKey {
    FullViewingKey::from_bytes(&burn_fvk_bytes())
        .expect("the derived burn key is a valid full viewing key")
}

pub(crate) fn params(n: NetworkType) -> Network {
    match n {
        NetworkType::Main => Network::MainNetwork,
        _ => Network::TestNetwork,
    }
}

/// The Burn Book address: a Unified Address holding only the Orchard receiver (which
/// delivers into the Ironwood pool after NU6.3).
pub fn burn_address(network: NetworkType) -> String {
    let addr = burn_fvk().address_at(0u32, Scope::External);
    UnifiedAddress::from_receivers(Some(addr), None, None, None, None)
        .expect("orchard-only UA")
        .encode(&params(network))
}

/// The published viewing key. Anyone can load it into a wallet to watch every burn.
pub fn burn_ufvk(network: NetworkType) -> String {
    Ufvk::try_from_items(
        Revision::R0,
        vec![Uitem::Data(Fvk::Orchard(burn_fvk_bytes()))],
    )
    .expect("an Orchard-only UFVK is valid")
    .encode(&network)
}

/// Every burn in a transaction: outputs to the Burn Book address, with value and memo.
pub fn burns_in(tx: &crate::Transaction, network: NetworkType) -> Vec<crate::Found> {
    crate::scan_fvk(tx, &burn_fvk(), network)
        .into_iter()
        .filter(|f| f.direction == crate::Direction::Incoming && !f.change)
        .collect()
}
