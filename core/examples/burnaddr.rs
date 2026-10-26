//! Prints the Burn Book address and its published viewing key.
//!
//!     cargo run -p chit-core --release --example burnaddr
use zcash_protocol::consensus::NetworkType;
fn main() {
    println!("address {}", chit_core::burn::burn_address(NetworkType::Main));
    println!("ufvk    {}", chit_core::burn::burn_ufvk(NetworkType::Main));
    println!("fvk     {}", hex::encode(chit_core::burn::burn_fvk_bytes()));
}
