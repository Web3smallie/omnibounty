//! Vendored VERBATIM from `contracts/near/src/mpc.rs` (V2, proven).
//! Only the doc-reference to the bounty lifecycle differs (V3 slots);
//! request/response/parsing logic is unchanged.
//!
//! NEAR Chain Signatures (MPC) request/response handling.
//!
//! Wire format of the DEPLOYED testnet signer `v1.signer-prod.testnet`
//! (contract `version()` = `"3.18.0"`, code sha256
//! `af8c66fd...a94955`), verified by read-only view probes plus the
//! matching `near/mpc` tag `3.18.0` sources (see `tools/mpc_ref/3.18.0`
//! and `tools/probe_mpc.py`):
//!
//! ```text
//! sign({"request": {"path": String,
//!                   "payload_v2": {"Ecdsa": "<64 lowercase hex>"},
//!                   "domain_id": 0}})
//!   + 1 yoctoNEAR attached deposit, >= 15 Tgas prepaid gas.
//! -> {"scheme": "Secp256k1",
//!     "big_r": {"affine_point": "<66 hex: 02|03 || x>"},
//!     "s": {"scalar": "<64 hex>"},
//!     "recovery_id": 0|1}
//! ```
//!
//! `big_r` is the COMPRESSED R point; `r` is its x-coordinate (bytes
//! 1..33), exactly as the MPC contract itself extracts it
//! (`TryFrom<&K256Signature> for k256::ecdsa::Signature`). The legacy
//! flat-arg / uncompressed-point v1 API is NOT used: the deployed
//! contract rejects it with `missing field 'request'`.
//!
//! Defense in depth: `on_voucher_signed` parses the raw callback bytes
//! itself (never `#[callback_result] Result<MpcSignature, _>`, whose
//! deserialization failure would panic and wedge the bounty in Pending),
//! `parse_mpc_signature` strictly validates every field, and
//! `check_mpc_signer` re-derives the signer from (digest, r, s, v) and
//! requires it to equal the configured MPC address. Any wiring/format
//! surprise fails closed (bounty released to Open) instead of minting a
//! bad voucher.

use crate::error::ClaimError;
use crate::normalize::{parse_hex, to_hex};
use serde::{Deserialize, Serialize};

/// MPC v3 sign payload: tagged ECDSA prehash, lowercase hex, no `0x`.
/// Serializes as `{"Ecdsa": "<64 hex>"}` (externally tagged).
#[derive(Debug, Clone, Serialize)]
pub enum MpcPayload {
    Ecdsa(String),
}

/// MPC v3 `sign` request body, sent wrapped as `{"request": ...}`.
#[derive(Debug, Clone, Serialize)]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: MpcPayload,
    pub domain_id: u64,
}

impl SignRequest {
    pub fn ecdsa(path: String, digest: &[u8; 32], domain_id: u64) -> Self {
        Self {
            path,
            payload_v2: MpcPayload::Ecdsa(to_hex(digest)),
            domain_id,
        }
    }
}

/// 1 yoctoNEAR: the exact deposit `sign` requires
/// (`SIGN_DEPOSIT_YOCTONEAR`; excess is refunded, zero is rejected).
pub const SIGN_DEPOSIT_YOCTONEAR: u128 = 1;

/// MPC signature response (subset we consume). All wire-string fields so
/// that ANY JSON object with these keys deserializes; strict validation
/// happens in [`parse_mpc_signature`], which releases the bounty on
/// failure instead of panicking.
#[derive(Debug, Clone, Deserialize)]
pub struct AffinePoint {
    pub affine_point: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Scalar {
    pub scalar: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MpcSignature {
    pub scheme: Option<String>,
    pub big_r: AffinePoint,
    pub s: Scalar,
    pub recovery_id: u8,
}

/// Parsed EVM-style signature: r, s, and `v` in {27, 28}.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EvmSig {
    pub r: [u8; 32],
    pub s: [u8; 32],
    pub v: u8,
}

/// Strictly parse an MPC response into (r, s, v27).
pub fn parse_mpc_signature(resp: &MpcSignature) -> Result<EvmSig, ClaimError> {
    if resp.scheme.as_deref() != Some("Secp256k1") {
        return Err(ClaimError::MpcBadResponse("scheme"));
    }
    // Compressed point: 0x02 (even y) | 0x03 (odd y) || x. The prefix
    // MUST agree with recovery_id, exactly as the MPC builds it in
    // `K256Signature::from_ecdsa_recoverable`.
    let point: [u8; 33] = parse_hex("mpc_big_r", &resp.big_r.affine_point)
        .map_err(|_| ClaimError::MpcBadResponse("big_r"))?;
    let v = match (point[0], resp.recovery_id) {
        (0x02, 0) => 27,
        (0x03, 1) => 28,
        _ => return Err(ClaimError::MpcBadResponse("big_r prefix/recovery_id")),
    };
    let s: [u8; 32] =
        parse_hex("mpc_s", &resp.s.scalar).map_err(|_| ClaimError::MpcBadResponse("s"))?;
    if s == [0u8; 32] {
        return Err(ClaimError::MpcBadResponse("zero s"));
    }
    let mut r = [0u8; 32];
    r.copy_from_slice(&point[1..33]);
    if r == [0u8; 32] {
        return Err(ClaimError::MpcBadResponse("zero r"));
    }
    Ok(EvmSig { r, s, v })
}

/// Self-check: recover the signer of `digest` and require the configured
/// MPC address. NOTE: the MPC signs the raw 32-byte digest (prehash), NOT
/// an EIP-191 message — recovery here is over the digest directly, unlike
/// witness recovery which prefixes the sign-data first.
pub fn check_mpc_signer(
    digest: &[u8; 32],
    sig: &EvmSig,
    expected: &[u8; 20],
) -> Result<(), ClaimError> {
    use crate::ecrecover::ecrecover_address;

    // `v` is structurally 27/28 (`parse_mpc_response` enforces the mapping).
    let v01 = u8::from(sig.v == 28);
    let mut rs = [0u8; 64];
    rs[..32].copy_from_slice(&sig.r);
    rs[32..].copy_from_slice(&sig.s);
    let addr = ecrecover_address(digest, &rs, v01).ok_or(ClaimError::MpcSignerMismatch)?;
    if addr != *expected {
        return Err(ClaimError::MpcSignerMismatch);
    }
    Ok(())
}

/// Build the 65-byte signature blob for the relayer/escrow (r || s || v27).
#[cfg(test)]
pub fn to_sig65(sig: &EvmSig) -> crate::normalize::Sig65 {
    let mut out = [0u8; 65];
    out[..32].copy_from_slice(&sig.r);
    out[32..64].copy_from_slice(&sig.s);
    out[64] = sig.v;
    crate::normalize::Sig65(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::{to_hex, Sig65};
    use crate::reclaim::{eth_message_hash, recover};

    /// Cross-check: witness-path `recover` agrees with direct k256
    /// recovery on the same prehash.
    fn recover_prehash(sig65: &Sig65, prehash: &[u8; 32]) -> Result<[u8; 20], ClaimError> {
        recover(sig65, prehash).map_err(|_| ClaimError::MpcSignerMismatch)
    }

    fn sig_from_fixture() -> (MpcSignature, [u8; 20]) {
        // Reuse the spike witness signature as a *syntactically* valid MPC
        // response in the exact v3.18.0 envelope: scheme tag + compressed
        // R point (recovery_id 1 => odd y => 0x03 prefix).
        let r = "e1fd48c836b97eea98ed877803164bbd04cfcde0722f0198c8252f7d9a1278ca";
        let s = "648a7a9289898fdb80ade7e6de733f62b5ffed9293aa6586b9b19b4350203859";
        let resp = MpcSignature {
            scheme: Some("Secp256k1".to_string()),
            big_r: AffinePoint {
                affine_point: format!("03{r}"),
            },
            s: Scalar {
                scalar: s.to_string(),
            },
            recovery_id: 1,
        };
        let expected =
            crate::normalize::parse_address("w", "0x244897572368eadf65bfbc5aec98d8e5443a9072")
                .unwrap()
                .0;
        (resp, expected)
    }

    #[test]
    fn request_serializes_to_v3_wire_shape() {
        let digest = [7u8; 32];
        let req = SignRequest::ecdsa("omnibounty-voucher-v1".to_string(), &digest, 0);
        // near-sdk wraps ext args by name: {"request": {...}}.
        let wire = serde_json::json!({ "request": req });
        assert_eq!(
            wire,
            serde_json::json!({
                "request": {
                    "path": "omnibounty-voucher-v1",
                    "payload_v2": {"Ecdsa": "0707070707070707070707070707070707070707070707070707070707070707"},
                    "domain_id": 0,
                }
            })
        );
    }

    #[test]
    fn parses_valid_response() {
        let (resp, _) = sig_from_fixture();
        let sig = parse_mpc_signature(&resp).unwrap();
        assert_eq!(sig.v, 28);
        assert_eq!(
            to_hex(&sig.r),
            "e1fd48c836b97eea98ed877803164bbd04cfcde0722f0198c8252f7d9a1278ca"
        );
    }

    #[test]
    fn tagged_envelope_deserializes() {
        // Byte-shape of a real v3.18.0 `SignatureResponse::Secp256k1`.
        let raw = serde_json::json!({
            "scheme": "Secp256k1",
            "big_r": {"affine_point": "03e1fd48c836b97eea98ed877803164bbd04cfcde0722f0198c8252f7d9a1278ca"},
            "s": {"scalar": "648a7a9289898fdb80ade7e6de733f62b5ffed9293aa6586b9b19b4350203859"},
            "recovery_id": 1,
        });
        let resp: MpcSignature = serde_json::from_value(raw).unwrap();
        assert_eq!(parse_mpc_signature(&resp).unwrap().v, 28);
    }

    #[test]
    fn rejects_malformed_responses() {
        // Bad recovery id range.
        let (mut resp, _) = sig_from_fixture();
        resp.recovery_id = 7;
        assert!(parse_mpc_signature(&resp).is_err());
        // Prefix/parity disagreement (0x02 point with recovery_id 1).
        let (mut resp, _) = sig_from_fixture();
        resp.big_r.affine_point =
            "02e1fd48c836b97eea98ed877803164bbd04cfcde0722f0198c8252f7d9a1278ca".to_string();
        assert!(parse_mpc_signature(&resp).is_err());
        // Legacy 65-byte uncompressed point is NOT the deployed shape.
        let (mut resp, _) = sig_from_fixture();
        resp.big_r.affine_point = format!(
            "04e1fd48c836b97eea98ed877803164bbd04cfcde0722f0198c8252f7d9a1278ca{}",
            "00".repeat(32)
        );
        assert!(parse_mpc_signature(&resp).is_err());
        // Wrong scheme tag.
        let (mut resp, _) = sig_from_fixture();
        resp.scheme = Some("Ed25519".to_string());
        assert!(parse_mpc_signature(&resp).is_err());
        // Missing scheme tag.
        let (mut resp, _) = sig_from_fixture();
        resp.scheme = None;
        assert!(parse_mpc_signature(&resp).is_err());
        // Zero s.
        let (mut resp, _) = sig_from_fixture();
        resp.s.scalar = "00".repeat(32);
        assert!(parse_mpc_signature(&resp).is_err());
        // Zero r.
        let (mut resp, _) = sig_from_fixture();
        resp.big_r.affine_point = "03".to_string() + &"00".repeat(32);
        assert!(parse_mpc_signature(&resp).is_err());
    }

    #[test]
    fn signer_self_check_accepts_matching_and_rejects_other() {
        // The spike signature signs the EIP-191 hash of the spike sign-data.
        // Replaying it as an "MPC response" over that same prehash must
        // recover the witness address through the MPC check path too.
        let raw = include_str!("../../../testdata/reclaim.json");
        let fx: serde_json::Value = serde_json::from_str(raw).unwrap();
        let (resp, witness) = sig_from_fixture();
        let sig = parse_mpc_signature(&resp).unwrap();
        let prehash = eth_message_hash(fx["spike"]["expectedSignData"].as_str().unwrap());
        check_mpc_signer(&prehash, &sig, &witness).unwrap();
        let other = [9u8; 20];
        assert_eq!(
            check_mpc_signer(&prehash, &sig, &other).unwrap_err(),
            ClaimError::MpcSignerMismatch
        );
        // Blob assembly round-trips through the witness-path recovery too.
        let blob = to_sig65(&sig);
        assert_eq!(recover_prehash(&blob, &prehash).unwrap(), witness);
    }
}
