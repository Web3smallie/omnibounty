//! Host-backed secp256k1 recovery shared by the witness leg
//! ([`crate::reclaim::recover`]) and the MPC leg
//! ([`crate::mpc::check_mpc_signer`]).
//!
//! Uses `env::ecrecover` with malleability flag `false` ("no extra
//! checks"): full-range S accepted, matching ethers/EVM `ecrecover`
//! semantics. Phase 5.1 migrated both legs here from in-WASM k256
//! recovery, which spuriously rejected valid high-S signatures (k256's
//! recovery re-verifies, and k256 verification enforces low-S; see
//! `ecrecover_equiv` for the proven primitive relation).
//!
//! Trap-safety: the host raises `HostError` (aborting the transaction) on
//! malformed call shapes, so this wrapper only admits fixed-shape inputs:
//! `hash`/`rs` lengths are fixed by type (`[u8; 32]`/`[u8; 64]`), and
//! `v01` outside `{0, 1}` returns `None`. Callers additionally pre-validate
//! `v` through their own parsers (`recovery_id_from_v`, MPC response
//! parsing) to keep precise error variants. Returns `None` — never traps
//! — on zero/out-of-range `r`/`s` and unrecoverable points.

use near_sdk::env;

/// Recover the signer EVM address for a 32-byte prehash and 64-byte
/// `r || s` with normalized recovery id `v01` in `{0, 1}`.
pub fn ecrecover_address(hash: &[u8; 32], rs: &[u8; 64], v01: u8) -> Option<[u8; 20]> {
    if v01 > 1 {
        return None;
    }
    let key = env::ecrecover(&hash[..], &rs[..], v01, false)?;
    let digest = env::keccak256(&key);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&digest[12..]);
    Some(addr)
}
