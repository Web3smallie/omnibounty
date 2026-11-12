//! Embedded Reclaim proof verification with pinned trust roots.
//!
//! ADAPTED from `contracts/near/src/reclaim.rs` (V2, proven): `verify_core`
//! and all helpers below it are verbatim; V3 ADDS the evidence-type tags
//! and the scoped nullifier-key constructor (`nullifier_key`) used for
//! per-(bounty, recipient, evidence-type, proof) replay protection.
//!
//! Pipeline for a submitted proof (all inputs untrusted until normalized):
//! 1. Strict-normalize identifier, owner, signatures (see `normalize`).
//! 2. Validate provider; parse parameters (must be byte-canonical) and
//!    context (any valid JSON, canonicalized for hashing).
//! 3. Recompute `keccak256("provider\\nparams_raw\\ncontext_canon")` and
//!    compare against the normalized submitted identifier.
//! 4. Rebuild the canonical sign-data
//!    `"0x{id}\\n0x{owner}\\n{timestampS}\\n{epoch}"` (byte-identical to the
//!    SDK's `createSignDataForClaim` over normalized inputs).
//! 5. EIP-191 hash and secp256k1 recover every signature.
//! 6. Require the recovered set to equal the pinned witness set for the
//!    proof's epoch: exact count, all distinct, all members.
//!
//!Differences from the reference integration this replaces as a foundation:
//! no `0x`-sensitivity (normalization first), context is canonicalized before
//! hashing (SDK-compatible), no deterministic-selection quirks (pinned set
//! compared directly), no panics on user input, `v` strictly validated.

use crate::canon;
use crate::error::ClaimError;
use crate::normalize::{
    parse_address, parse_identifier, parse_signature, recovery_id_from_v, to_hex, EthAddr, Hex32,
    Sig65,
};
use near_sdk::env;
use serde::{Deserialize, Serialize};

/// Raw proof shapes as produced by `transformForOnchain` (SDK-native forms
/// with `0x` prefixes are accepted; normalization happens inside).
#[derive(Debug, Clone, Deserialize, Serialize, borsh::BorshSchema, schemars::JsonSchema)]
pub struct ProofInput {
    #[serde(rename = "claimInfo")]
    pub claim_info: ClaimInfoInput,
    #[serde(rename = "signedClaim")]
    pub signed_claim: SignedClaimInput,
}

#[derive(Debug, Clone, Deserialize, Serialize, borsh::BorshSchema, schemars::JsonSchema)]
pub struct ClaimInfoInput {
    pub provider: String,
    pub parameters: String,
    pub context: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, borsh::BorshSchema, schemars::JsonSchema)]
pub struct SignedClaimInput {
    pub claim: ClaimDataInput,
    pub signatures: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, borsh::BorshSchema, schemars::JsonSchema)]
pub struct ClaimDataInput {
    pub identifier: String,
    pub owner: String,
    pub epoch: u64,
    #[serde(rename = "timestampS")]
    pub timestamp_s: u64,
}

/// Maximum signatures accepted per proof (DoS bound; ecrecover is metered).
pub const MAX_SIGNATURES: usize = 16;
/// Maximum TOTAL witness signatures across all proofs in one claim
/// (gas bound; checked in `verify_bundle` before any cryptography, so
/// oversized bundles fail closed with `TooManySignatures` without
/// consuming nullifiers). 64 = 2x the largest realistic bundle (~6
/// proofs x ~5 witnesses); worst-case recovery cost is 64 x 0.294 Tgas
/// ~= 19 Tgas, leaving 10x+ margin under the 300 Tgas transaction
/// limit (Phase 5.1 calibration, `gas_qualify_many_shapes`).
pub const MAX_TOTAL_SIGNATURES: usize = 64;
/// Maximum TOTAL serialized evidence bytes (params + context summed
/// over all proofs) in one claim. Checked pre-crypto alongside the
/// signature cap; oversized bundles fail closed with
/// `ProofTooLarge("bundle")`. 256KB = 8x the largest realistic bundle
/// (~30KB); bounds the byte-driven host term (~21 Ggas/KB measured,
/// `gas_max_payload_bundle`) plus the unmetered-here WASM JSON parse
/// (Linux measures it; 256KB keeps worst-case parse small).
pub const MAX_TOTAL_EVIDENCE_BYTES: usize = 262_144;

/// Evidence-type tags for nullifier scoping. Frozen once funded criteria
/// exist; numeric values are part of the replay-key preimage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum EvidenceType {
    Pr = 1,
    CheckRun = 2,
    Files = 3,
    Review = 4,
    Contents = 5,
    Diff = 6,
}

impl EvidenceType {
    pub fn from_u8(v: u8) -> Result<Self, ClaimError> {
        match v {
            1 => Ok(Self::Pr),
            2 => Ok(Self::CheckRun),
            3 => Ok(Self::Files),
            4 => Ok(Self::Review),
            5 => Ok(Self::Contents),
            6 => Ok(Self::Diff),
            _ => Err(ClaimError::InvalidEvidenceType(v)),
        }
    }
}

/// Domain separator for V3 replay keys (prevents cross-protocol collisions).
pub const NULLIFIER_DOMAIN: &[u8] = b"OMNIBOUNTY-V3-NULL";

/// V3 replay key: `keccak256("OMNIBOUNTY-V3-NULL" || bounty_id:u64be ||
/// recipient:20B || evidence_type:u8 || identifier:32B)`.
///
/// Scoping rationale: the SAME evidence MUST be reusable across distinct
/// bounties (a PR can back two task bounties) and distinct recipients, but
/// MUST NEVER be reusable twice within one (bounty, recipient, type)
/// triple. Binding the recipient (not just the proof owner — enforced
/// equal at claim time) prevents one prover's evidence from filling
/// another recipient's slot.
pub fn nullifier_key(
    bounty_id: u64,
    recipient: &[u8; 20],
    evidence_type: u8,
    identifier: &[u8; 32],
) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(NULLIFIER_DOMAIN.len() + 8 + 20 + 1 + 32);
    preimage.extend_from_slice(NULLIFIER_DOMAIN);
    preimage.extend_from_slice(&bounty_id.to_be_bytes());
    preimage.extend_from_slice(recipient);
    preimage.push(evidence_type);
    preimage.extend_from_slice(identifier);
    let hash = env::keccak256(&preimage);
    let mut out = [0u8; 32];
    out.copy_from_slice(&hash);
    out
}

/// Evidence commitment for the `claim_qualified` event: `keccak256` over the
/// concatenation of per-proof records, each `evidence_type:u8 || identifier:32B`,
/// sorted ascending by `(evidence_type, identifier)` bytes.
///
/// Canonical ordering: byte-lexicographic on the 33-byte records. Multiset
/// semantics: a bundle carrying the same record twice commits to it twice
/// (the digest covers the bundle exactly as submitted). Empty input yields
/// `keccak256("")`.
///
/// External auditors reproduce this from the `qualify_claim` transaction
/// arguments: take each tagged proof's (`evidence_type`,
/// `signedClaim.claim.identifier`), sort, concatenate, hash, and compare
/// against the event's `evidence_digest`. No voucher or typehash involvement
/// (audit trail only).
pub fn evidence_records_digest(records: &[(u8, [u8; 32])]) -> [u8; 32] {
    let mut sorted = records.to_vec();
    sorted.sort();
    let mut preimage = Vec::with_capacity(sorted.len() * 33);
    for (t, id) in &sorted {
        preimage.push(*t);
        preimage.extend_from_slice(id);
    }
    let hash = env::keccak256(&preimage);
    let mut out = [0u8; 32];
    out.copy_from_slice(&hash);
    out
}

/// A fully verified proof together with its canonical artifacts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, borsh::BorshSchema)]
pub struct VerifiedProof {
    pub identifier: [u8; 32],
    pub owner: [u8; 20],
    pub epoch: u64,
    pub timestamp_s: u64,
    pub signers: Vec<[u8; 20]>,
    /// Canonical context bytes (reused by template validation).
    pub context_canonical: String,
}

/// Identifier preimage hash: keccak256 over UTF-8
/// `"provider\\nparameters_raw\\ncontext_canonical"`.
pub fn identifier_of(provider: &str, parameters_raw: &str, context_canonical: &str) -> [u8; 32] {
    let mut preimage =
        String::with_capacity(provider.len() + parameters_raw.len() + context_canonical.len() + 2);
    preimage.push_str(provider);
    preimage.push('\n');
    preimage.push_str(parameters_raw);
    preimage.push('\n');
    preimage.push_str(context_canonical);
    let hash = env::keccak256(preimage.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(&hash);
    out
}

/// Canonical sign-data. Byte-identical to the SDK's `createSignDataForClaim`
/// when the SDK inputs are the `0x`-prefixed lowercase forms of these bytes.
pub fn sign_data(identifier: &Hex32, owner: &EthAddr, timestamp_s: u64, epoch: u64) -> String {
    let mut s = String::with_capacity(2 + 64 + 1 + 2 + 40 + 1 + 20 + 1 + 20);
    s.push_str("0x");
    s.push_str(&to_hex(&identifier.0));
    s.push('\n');
    s.push_str("0x");
    s.push_str(&to_hex(&owner.0));
    s.push('\n');
    s.push_str(&timestamp_s.to_string());
    s.push('\n');
    s.push_str(&epoch.to_string());
    s
}

/// EIP-191 `"\x19Ethereum Signed Message:\n" + len + message`, keccak256.
/// Byte-equivalent to ethers v6 `hashMessage` for all inputs (both use the
/// UTF-8 byte length; verified against the ethers source).
pub fn eth_message_hash(message: &str) -> [u8; 32] {
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
    let mut full = Vec::with_capacity(prefix.len() + message.len());
    full.extend_from_slice(prefix.as_bytes());
    full.extend_from_slice(message.as_bytes());
    let hash = env::keccak256(&full);
    let mut out = [0u8; 32];
    out.copy_from_slice(&hash);
    out
}

/// Recover the signer EVM address from one 65-byte signature over a
/// 32-byte prehash. No panics on any input. Host-backed (full-range S,
/// ethers/EVM semantics); `v` policy unchanged ({0,1,27,28} -> {0,1}).
pub fn recover(sig: &Sig65, message_hash: &[u8; 32]) -> Result<[u8; 20], ClaimError> {
    let v_raw = sig.0[64];
    let rec = recovery_id_from_v(v_raw)?;
    let mut rs = [0u8; 64];
    rs.copy_from_slice(&sig.0[..64]);
    crate::ecrecover::ecrecover_address(message_hash, &rs, rec).ok_or(ClaimError::RecoveryFailed)
}

/// Verify identifier binding + witness signatures against a pinned set.
/// Does NOT check template/freshness/replay (handled by the caller with
/// bounty context); returns canonical artifacts for those stages.
pub fn verify_core(
    proof: &ProofInput,
    pinned_witnesses: &[[u8; 20]],
) -> Result<VerifiedProof, ClaimError> {
    if proof.claim_info.provider != "http" {
        return Err(ClaimError::InvalidProvider);
    }
    if proof.signed_claim.signatures.is_empty()
        || proof.signed_claim.signatures.len() > MAX_SIGNATURES
    {
        return Err(ClaimError::InvalidLength("signatures"));
    }
    if pinned_witnesses.is_empty() {
        return Err(ClaimError::InvalidConfig("empty witness set"));
    }

    let identifier = parse_identifier(&proof.signed_claim.claim.identifier)?;
    let owner = parse_address("owner", &proof.signed_claim.claim.owner)?;

    // Parameters: valid JSON AND byte-canonical (fail-closed determinism;
    // genuine attestor output always satisfies this).
    let params_value = canon::parse_capped("parameters", &proof.claim_info.parameters)?;
    let params_canon = canon::canonicalize(&params_value)?;
    if params_canon != proof.claim_info.parameters {
        return Err(ClaimError::NonCanonicalParams);
    }
    // Context: any valid JSON (empty allowed), canonicalized for hashing,
    // exactly like the SDK.
    let context_canonical = if proof.claim_info.context.is_empty() {
        String::new()
    } else {
        canon::canonicalize_str("context", &proof.claim_info.context)?
    };

    let recomputed = identifier_of(
        &proof.claim_info.provider,
        &proof.claim_info.parameters,
        &context_canonical,
    );
    if recomputed != identifier.0 {
        return Err(ClaimError::IdentifierMismatch);
    }

    let data = sign_data(
        &identifier,
        &owner,
        proof.signed_claim.claim.timestamp_s,
        proof.signed_claim.claim.epoch,
    );
    let hash = eth_message_hash(&data);

    let mut signers: Vec<[u8; 20]> = Vec::with_capacity(proof.signed_claim.signatures.len());
    for raw in &proof.signed_claim.signatures {
        let sig = parse_signature(raw)?;
        let addr = recover(&sig, &hash)?;
        if signers.contains(&addr) {
            return Err(ClaimError::DuplicateSignature);
        }
        signers.push(addr);
    }

    if signers.len() != pinned_witnesses.len() {
        return Err(ClaimError::WitnessCountMismatch);
    }
    for s in &signers {
        if !pinned_witnesses.contains(s) {
            return Err(ClaimError::UnknownWitness);
        }
    }

    Ok(VerifiedProof {
        identifier: identifier.0,
        owner: owner.0,
        epoch: proof.signed_claim.claim.epoch,
        timestamp_s: proof.signed_claim.claim.timestamp_s,
        signers,
        context_canonical,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::to_hex;
    use serde_json::Value;

    #[test]
    fn nullifier_key_matches_typescript_golden() {
        // Same fixed inputs as frontend/test/criteria.test.mjs
        // ("nullifier scoping" golden, e2e-fixture values).
        let recipient = parse_address("r", "0xcb234c6fc8abe3eb38e31eec6288b431e313d9b9").unwrap();
        let identifier =
            parse_identifier("0x3373d41d8bbf27c42c3d2f0739ea987f042ae57a626720a42bab58a8adc979d6")
                .unwrap();
        let key = nullifier_key(7, &recipient.0, EvidenceType::Pr as u8, &identifier.0);
        assert_eq!(
            format!("0x{}", to_hex(&key)),
            "0x98da0b4df720098e6ab4cd704ffd386ba5356637410a03623678ea525b83df6e"
        );
        // Scoping: every dimension perturbs the key.
        let other_bounty = nullifier_key(8, &recipient.0, 1, &identifier.0);
        assert_ne!(key, other_bounty);
        let other_type = nullifier_key(7, &recipient.0, 2, &identifier.0);
        assert_ne!(key, other_type);
        let other_recip = nullifier_key(7, &[9u8; 20], 1, &identifier.0);
        assert_ne!(key, other_recip);
        // Evidence tag parsing rejects out-of-range values.
        assert!(EvidenceType::from_u8(0).is_err());
        assert!(EvidenceType::from_u8(7).is_err());
        assert_eq!(EvidenceType::from_u8(6).unwrap(), EvidenceType::Diff);
    }

    #[test]
    fn evidence_digest_empty_order_duplicates() {
        // Empty bundle: keccak256("") (well-known vector).
        assert_eq!(
            to_hex(&evidence_records_digest(&[])),
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
        let a = (2u8, [0x11u8; 32]);
        let b = (1u8, [0x22u8; 32]);
        let c = (1u8, [0x11u8; 32]);
        // Order-invariant: canonical sort by (type, identifier).
        let d1 = evidence_records_digest(&[a, b, c]);
        assert_eq!(d1, evidence_records_digest(&[c, a, b]));
        assert_eq!(d1, evidence_records_digest(&[b, c, a]));
        // Multiset: a duplicated record commits twice (differs from deduped).
        assert_ne!(d1, evidence_records_digest(&[a, a, b, c]));
        // Every dimension perturbs the digest.
        assert_ne!(d1, evidence_records_digest(&[b, c]));
        assert_ne!(
            d1,
            evidence_records_digest(&[(2u8, [0x11u8; 32]), (1u8, [0x23u8; 32]), c])
        );
        // Reproducibility: same input, same digest, across calls.
        assert_eq!(d1, evidence_records_digest(&[a, b, c]));
    }

    fn fixture(name: &str) -> Value {
        let raw = include_str!("../../../testdata/reclaim.json");
        let v: Value = serde_json::from_str(raw).unwrap();
        v[name].clone()
    }

    fn proof_input(v: &Value) -> ProofInput {
        serde_json::from_value(serde_json::json!({
            "claimInfo": v["claimInfo"],
            "signedClaim": {
                "claim": {
                    "identifier": v["claim"]["identifier"],
                    "owner": v["claim"]["owner"],
                    "epoch": v["claim"]["epoch"],
                    "timestampS": v["claim"]["timestampS"],
                },
                "signatures": v["signatures"],
            }
        }))
        .unwrap()
    }

    fn addr(hex_str: &str) -> [u8; 20] {
        parse_address("w", hex_str).unwrap().0
    }

    #[test]
    fn spike_proof_verifies_with_sdk_native_forms() {
        let v = fixture("spike");
        let proof = proof_input(&v);
        let pinned = [addr("0x244897572368eadf65bfbc5aec98d8e5443a9072")];
        let verified = verify_core(&proof, &pinned).unwrap();
        assert_eq!(
            format!("0x{}", to_hex(&verified.identifier)),
            v["expectedIdentifier"].as_str().unwrap()
        );
        assert_eq!(
            format!("0x{}", to_hex(&verified.signers[0])),
            v["expectedSigner"].as_str().unwrap()
        );
        // Sign-data byte-equivalence with the SDK oracle.
        let data = sign_data(
            &Hex32(verified.identifier),
            &EthAddr(verified.owner),
            verified.timestamp_s,
            verified.epoch,
        );
        assert_eq!(data, v["expectedSignData"].as_str().unwrap());
    }

    #[test]
    fn tampered_identifier_rejected() {
        let v = fixture("spike");
        let mut proof = proof_input(&v);
        proof.signed_claim.claim.identifier =
            "0x04bb12417065a93c36cdf75539d16c0a25f707b882f4ea2b0b69272254357175".to_string();
        let pinned = [addr("0x244897572368eadf65bfbc5aec98d8e5443a9072")];
        assert_eq!(
            verify_core(&proof, &pinned).unwrap_err(),
            ClaimError::IdentifierMismatch
        );
    }

    #[test]
    fn tampered_signature_rejected() {
        let v = fixture("spike");
        let mut proof = proof_input(&v);
        let mut sig = proof.signed_claim.signatures[0].clone();
        // Flip a nibble in `r` (keeps valid hex/length: exercises recovery).
        let flipped = if sig.as_bytes()[4] == b'0' { "1" } else { "0" };
        sig.replace_range(4..5, flipped);
        proof.signed_claim.signatures[0] = sig;
        let pinned = [addr("0x244897572368eadf65bfbc5aec98d8e5443a9072")];
        let err = verify_core(&proof, &pinned).unwrap_err();
        assert!(
            matches!(err, ClaimError::RecoveryFailed | ClaimError::UnknownWitness),
            "unexpected: {err:?}"
        );
    }

    #[test]
    fn wrong_witness_rejected() {
        let v = fixture("spike");
        let proof = proof_input(&v);
        let pinned = [addr("0x0000000000000000000000000000000000000001")];
        assert_eq!(
            verify_core(&proof, &pinned).unwrap_err(),
            ClaimError::UnknownWitness
        );
    }

    #[test]
    fn duplicate_signatures_rejected() {
        let v = fixture("spike");
        let mut proof = proof_input(&v);
        let sig = proof.signed_claim.signatures[0].clone();
        proof.signed_claim.signatures.push(sig);
        let pinned = [
            addr("0x244897572368eadf65bfbc5aec98d8e5443a9072"),
            addr("0x244897572368eadf65bfbc5aec98d8e5443a9072"),
        ];
        assert_eq!(
            verify_core(&proof, &pinned).unwrap_err(),
            ClaimError::DuplicateSignature
        );
    }

    #[test]
    fn noncanonical_params_rejected() {
        let v = fixture("spike");
        let mut proof = proof_input(&v);
        // Same JSON value, pretty-printed: must fail closed.
        let parsed: Value = serde_json::from_str(&proof.claim_info.parameters).unwrap();
        proof.claim_info.parameters = serde_json::to_string_pretty(&parsed).unwrap();
        let pinned = [addr("0x244897572368eadf65bfbc5aec98d8e5443a9072")];
        assert_eq!(
            verify_core(&proof, &pinned).unwrap_err(),
            ClaimError::NonCanonicalParams
        );
    }

    #[test]
    fn noncanonical_context_accepted_via_canonicalization() {
        // Same logical context with unsorted keys: SDK-style hashing must
        // still bind it (this is the M1 trap the reference integration has).
        let v = fixture("spike");
        let mut proof = proof_input(&v);
        proof.claim_info.context = "{\"providerHash\":\"0x1107f0dc35e4c1a899dc33c33f7cd5e90053561adf356dacbbec4be56ca7d0b6\",\"extractedParameters\":{\"state\":\"closed\"}}".to_string();
        // Recompute what the identifier WOULD be and confirm our pipeline
        // hashes context canonically: recompute expected via canonical form.
        let canon_ctx = canon::canonicalize_str("context", &proof.claim_info.context).unwrap();
        assert_eq!(canon_ctx, v["claimInfo"]["context"].as_str().unwrap());
        // The stored identifier still matches (same canonical bytes) and the
        // signature is over the stored identifier, so full verification
        // passes: context byte-order cannot break or forge verification.
        let pinned = [addr("0x244897572368eadf65bfbc5aec98d8e5443a9072")];
        verify_core(&proof, &pinned).unwrap();
    }

    #[test]
    fn steam_vector_verifies_end_to_end() {
        // The reference vector's parameters AND context are both canonical,
        // so SDK-style hashing reproduces the stored identifier exactly and
        // the whole pipeline (including legacy v=27 recovery) must accept it.
        let v = fixture("steam");
        // SDK-style identifier equals the stored one (pinned by oracle).
        let sdk_style = identifier_of(
            "http",
            v["claimInfo"]["parameters"].as_str().unwrap(),
            &canon::canonicalize_str("context", v["claimInfo"]["context"].as_str().unwrap())
                .unwrap(),
        );
        assert_eq!(
            format!("0x{}", to_hex(&sdk_style)),
            v["expectedIdentifierSdkStyle"].as_str().unwrap()
        );
        assert_eq!(
            format!("0x{}", to_hex(&sdk_style)),
            v["expectedStoredIdentifier"].as_str().unwrap()
        );
        // Full verification with 0x-prefixed SDK-native inputs.
        let proof = proof_input(&v);
        let pinned = [addr("0x244897572368eadf65bfbc5aec98d8e5443a9072")];
        let verified = verify_core(&proof, &pinned).unwrap();
        assert_eq!(
            format!("0x{}", to_hex(&verified.signers[0])),
            v["expectedSigner"].as_str().unwrap()
        );
        let data = sign_data(
            &Hex32(verified.identifier),
            &EthAddr(verified.owner),
            verified.timestamp_s,
            verified.epoch,
        );
        assert_eq!(data, v["expectedSignDataOverStored"].as_str().unwrap());
    }
}
