// OmniBounty V3 slot-voucher EIP-712 digest.
//!
//! VoucherV2 binds (bounty, slot, recipient, slot-amount, nonce, expiry,
//! chain, escrow, criteria_hash). Construction mirrors V2's proven pattern
//! (fixed-size abi.encode buffer, EIP-191 prefix); the struct gains
//! slot_index + criteria_hash and a new type string. Domain name/version
//! are unchanged ("OmniBounty"/"1") — the separator still differs per
//! deployment via chainId + verifyingContract.
//!
//! Oracle cross-checks: `testdata/v3/eip712-voucher2.json` (ethers-generated
//! by tools/gen_v3_fixtures.mjs).

use crate::error::ClaimError;
use crate::normalize::parse_address;
use near_sdk::env;
use serde::{Deserialize, Serialize};

#[cfg(test)]
pub const VOUCHER_V2_TYPE_STRING: &str = "VoucherV2(uint256 bountyId,uint8 slotIndex,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow,bytes32 criteriaHash)";

/// keccak256(VOUCHER_V2_TYPE_STRING). Pinned by `constants_match_literals`.
pub const VOUCHER_V2_TYPEHASH: [u8; 32] = [
    0x14, 0x55, 0xb3, 0x5c, 0xc7, 0x86, 0x41, 0x27, 0xc5, 0x6d, 0x1e, 0x0d, 0x2f, 0x4e, 0x61, 0x72,
    0xe7, 0x17, 0x0a, 0xa9, 0x4c, 0xb6, 0x77, 0xc3, 0x01, 0x41, 0x5a, 0xac, 0x89, 0x95, 0x4b, 0xfb,
];

/// EIP-712 domain pieces (identical strings to V2; separator differs only
/// through chainId + verifyingContract inputs). Test-only: the precomputed
/// hashes below are what the contract uses (saving gas);
/// `constants_match_literals` proves they match.
#[cfg(test)]
pub const DOMAIN_TYPE_STRING: &str =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
#[cfg(test)]
pub const DOMAIN_NAME: &str = "OmniBounty";
#[cfg(test)]
pub const DOMAIN_VERSION: &str = "1";

/// keccak256(DOMAIN_TYPE_STRING).
pub const DOMAIN_TYPEHASH: [u8; 32] = [
    0x8b, 0x73, 0xc3, 0xc6, 0x9b, 0xb8, 0xfe, 0x3d, 0x51, 0x2e, 0xcc, 0x4c, 0xf7, 0x59, 0xcc, 0x79,
    0x23, 0x9f, 0x7b, 0x17, 0x9b, 0x0f, 0xfa, 0xca, 0xa9, 0xa7, 0x5d, 0x52, 0x2b, 0x39, 0x40, 0x0f,
];

/// keccak256("OmniBounty").
pub const NAME_HASH: [u8; 32] = [
    0xf1, 0x64, 0x82, 0x2d, 0x77, 0x4d, 0x9e, 0xdf, 0xb6, 0xa3, 0xca, 0x9c, 0x89, 0x53, 0x5d, 0x6b,
    0xf4, 0xd5, 0xce, 0x37, 0x40, 0xe9, 0xd9, 0xdd, 0x2d, 0xa8, 0xf6, 0x3b, 0x68, 0x9b, 0xee, 0x93,
];

/// keccak256("1").
pub const VERSION_HASH: [u8; 32] = [
    0xc8, 0x9e, 0xfd, 0xaa, 0x54, 0xc0, 0xf2, 0x0c, 0x7a, 0xdf, 0x61, 0x28, 0x82, 0xdf, 0x09, 0x50,
    0xf5, 0xa9, 0x51, 0x63, 0x7e, 0x03, 0x07, 0xcd, 0xcb, 0x4c, 0x67, 0x2f, 0x29, 0x8b, 0x8b, 0xc6,
];

#[derive(
    Debug,
    Clone,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    borsh::BorshSerialize,
    borsh::BorshDeserialize,
)]
pub struct VoucherV2 {
    pub bounty_id: u64,
    pub slot_index: u8,
    pub recipient: [u8; 20],
    pub token: [u8; 20],
    /// Slot amount, EVM-native uint256 big-endian (exact escrow type match).
    pub amount: [u8; 32],
    pub nonce: u64,
    pub expiry: u64,
    pub chain_id: u64,
    pub escrow: [u8; 20],
    pub criteria_hash: [u8; 32],
}

#[derive(
    Debug,
    Clone,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    borsh::BorshSerialize,
    borsh::BorshDeserialize,
)]
pub struct SignedVoucher {
    pub voucher: VoucherV2,
    pub v: u8,
    pub r: [u8; 32],
    pub s: [u8; 32],
}

fn u256_from_u64(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&v.to_be_bytes());
    out
}

fn padded_address(a: &[u8; 20]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(a);
    out
}

fn keccak(bytes: &[u8]) -> [u8; 32] {
    let h = env::keccak256(bytes);
    let mut out = [0u8; 32];
    out.copy_from_slice(&h);
    out
}

/// EIP-712 domain separator for (chain_id, escrow).
pub fn domain_separator(chain_id: u64, escrow: &[u8; 20]) -> [u8; 32] {
    let mut enc = [0u8; 160];
    enc[0..32].copy_from_slice(&DOMAIN_TYPEHASH);
    enc[32..64].copy_from_slice(&NAME_HASH);
    enc[64..96].copy_from_slice(&VERSION_HASH);
    enc[96..128].copy_from_slice(&u256_from_u64(chain_id));
    enc[128..160].copy_from_slice(&padded_address(escrow));
    keccak(&enc)
}

/// `keccak256(abi.encode(VOUCHER_V2_TYPEHASH, ...fields))`.
/// Field order MUST match VOUCHER_V2_TYPE_STRING exactly.
pub fn struct_hash(v: &VoucherV2) -> [u8; 32] {
    let mut enc = [0u8; 352];
    enc[0..32].copy_from_slice(&VOUCHER_V2_TYPEHASH);
    enc[32..64].copy_from_slice(&u256_from_u64(v.bounty_id));
    enc[64..96].copy_from_slice(&u256_from_u64(v.slot_index as u64));
    enc[96..128].copy_from_slice(&padded_address(&v.recipient));
    enc[128..160].copy_from_slice(&padded_address(&v.token));
    enc[160..192].copy_from_slice(&v.amount);
    enc[192..224].copy_from_slice(&u256_from_u64(v.nonce));
    enc[224..256].copy_from_slice(&u256_from_u64(v.expiry));
    enc[256..288].copy_from_slice(&u256_from_u64(v.chain_id));
    enc[288..320].copy_from_slice(&padded_address(&v.escrow));
    enc[320..352].copy_from_slice(&v.criteria_hash);
    keccak(&enc)
}

/// Final digest: `keccak256("\x19\x01" || domainSeparator || structHash)`.
pub fn digest(v: &VoucherV2) -> [u8; 32] {
    let ds = domain_separator(v.chain_id, &v.escrow);
    let sh = struct_hash(v);
    let mut enc = [0u8; 66];
    enc[0] = 0x19;
    enc[1] = 0x01;
    enc[2..34].copy_from_slice(&ds);
    enc[34..66].copy_from_slice(&sh);
    keccak(&enc)
}

/// Build a voucher from human-readable inputs (used by finalize + tests).
#[allow(clippy::too_many_arguments)]
pub fn build_voucher(
    bounty_id: u64,
    slot_index: u8,
    recipient_hex: &str,
    token: &[u8; 20],
    amount: &[u8; 32],
    nonce: u64,
    expiry: u64,
    chain_id: u64,
    escrow: &[u8; 20],
    criteria_hash: &[u8; 32],
) -> Result<VoucherV2, ClaimError> {
    let recipient = parse_address("recipient", recipient_hex)?.0;
    Ok(VoucherV2 {
        bounty_id,
        slot_index,
        recipient,
        token: *token,
        amount: *amount,
        nonce,
        expiry,
        chain_id,
        escrow: *escrow,
        criteria_hash: *criteria_hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::{parse_u256_decimal, to_hex};

    fn keccak_of(s: &str) -> [u8; 32] {
        let h = env::keccak256(s.as_bytes());
        let mut out = [0u8; 32];
        out.copy_from_slice(&h);
        out
    }

    #[test]
    fn constants_match_literals() {
        assert_eq!(keccak_of(VOUCHER_V2_TYPE_STRING), VOUCHER_V2_TYPEHASH);
        assert_eq!(keccak_of(DOMAIN_TYPE_STRING), DOMAIN_TYPEHASH);
        assert_eq!(keccak_of(DOMAIN_NAME), NAME_HASH);
        assert_eq!(keccak_of(DOMAIN_VERSION), VERSION_HASH);
    }

    fn addr(s: &str) -> [u8; 20] {
        parse_address("t", s).unwrap().0
    }

    fn hex32(s: &str) -> [u8; 32] {
        let body = s.strip_prefix("0x").unwrap_or(s);
        let bytes = hex::decode(body).unwrap();
        let mut out = [0u8; 32];
        out.copy_from_slice(&bytes);
        out
    }

    #[test]
    fn oracle_fixture_digests_match() {
        // Every vector in testdata/v3/eip712-voucher2.json (ethers-generated
        // by tools/gen_v3_fixtures.mjs with grounded inputs).
        let raw = include_str!("../../../testdata/v3/eip712-voucher2.json");
        let fx: serde_json::Value = serde_json::from_str(raw).unwrap();
        assert_eq!(
            format!("0x{}", to_hex(&VOUCHER_V2_TYPEHASH)),
            fx["typeHash"].as_str().unwrap()
        );
        for v in fx["vectors"].as_array().unwrap() {
            let chain = v["chainId"].as_u64().unwrap();
            let escrow = addr(v["escrow"].as_str().unwrap());
            assert_eq!(
                format!("0x{}", to_hex(&domain_separator(chain, &escrow))),
                v["domainSeparator"].as_str().unwrap()
            );
            let voucher = VoucherV2 {
                bounty_id: v["bountyId"].as_u64().unwrap(),
                slot_index: v["slotIndex"].as_u64().unwrap() as u8,
                recipient: addr(v["recipient"].as_str().unwrap()),
                token: addr(v["token"].as_str().unwrap()),
                amount: parse_u256_decimal(v["amount"].as_str().unwrap()).unwrap(),
                nonce: v["nonce"].as_u64().unwrap(),
                expiry: v["expiry"].as_u64().unwrap(),
                chain_id: chain,
                escrow,
                criteria_hash: hex32(v["criteriaHash"].as_str().unwrap()),
            };
            assert_eq!(
                format!("0x{}", to_hex(&struct_hash(&voucher))),
                v["structHash"].as_str().unwrap()
            );
            assert_eq!(
                format!("0x{}", to_hex(&digest(&voucher))),
                v["digest"].as_str().unwrap()
            );
        }
    }
}
