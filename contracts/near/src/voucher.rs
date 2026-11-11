//! EIP-712 voucher hashing (must match `contracts/base/OmniEscrow.sol` and
//! `testdata/eip712.json` byte-for-byte).
//!
//! Domain: name "OmniBounty", version "1", chainId, verifyingContract=escrow.
//! Voucher type:
//! `Voucher(uint256 bountyId,address recipient,address token,uint256 amount,
//!  uint256 nonce,uint256 expiry,uint256 chainId,address escrow)`
//!
//! Hash constants below are cross-checked two ways: Rust tests assert they
//! equal `keccak256` of the literal strings, and the oracle fixtures in
//! `testdata/eip712.json` (ethers-generated) pin the resulting digests.

use near_sdk::env;

/// Pinned preimage literals. Production code uses the precomputed hashes
/// below (saving gas); `constants_match_literals` proves they match.
#[cfg(test)]
pub const VOUCHER_TYPE_STRING: &str = "Voucher(uint256 bountyId,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow)";
#[cfg(test)]
pub const DOMAIN_TYPE_STRING: &str =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
#[cfg(test)]
pub const DOMAIN_NAME: &str = "OmniBounty";
#[cfg(test)]
pub const DOMAIN_VERSION: &str = "1";

/// keccak256(VOUCHER_TYPE_STRING) — see oracle output, asserted in tests.
pub const VOUCHER_TYPEHASH: [u8; 32] = [
    0xd6, 0xe3, 0x3b, 0xde, 0x1c, 0xad, 0x65, 0x5a, 0x2f, 0x57, 0x64, 0xa3,
    0x5e, 0x26, 0x42, 0xeb, 0x0c, 0xfe, 0xb0, 0x6e, 0xa0, 0x6b, 0x05, 0xe3,
    0x01, 0x9f, 0x8e, 0x79, 0x8c, 0x14, 0xff, 0xc4,
];
/// keccak256(DOMAIN_TYPE_STRING).
pub const DOMAIN_TYPEHASH: [u8; 32] = [
    0x8b, 0x73, 0xc3, 0xc6, 0x9b, 0xb8, 0xfe, 0x3d, 0x51, 0x2e, 0xcc, 0x4c,
    0xf7, 0x59, 0xcc, 0x79, 0x23, 0x9f, 0x7b, 0x17, 0x9b, 0x0f, 0xfa, 0xca,
    0xa9, 0xa7, 0x5d, 0x52, 0x2b, 0x39, 0x40, 0x0f,
];
/// keccak256("OmniBounty").
pub const NAME_HASH: [u8; 32] = [
    0xf1, 0x64, 0x82, 0x2d, 0x77, 0x4d, 0x9e, 0xdf, 0xb6, 0xa3, 0xca, 0x9c,
    0x89, 0x53, 0x5d, 0x6b, 0xf4, 0xd5, 0xce, 0x37, 0x40, 0xe9, 0xd9, 0xdd,
    0x2d, 0xa8, 0xf6, 0x3b, 0x68, 0x9b, 0xee, 0x93,
];
/// keccak256("1").
pub const VERSION_HASH: [u8; 32] = [
    0xc8, 0x9e, 0xfd, 0xaa, 0x54, 0xc0, 0xf2, 0x0c, 0x7a, 0xdf, 0x61, 0x28,
    0x82, 0xdf, 0x09, 0x50, 0xf5, 0xa9, 0x51, 0x63, 0x7e, 0x03, 0x07, 0xcd,
    0xcb, 0x4c, 0x67, 0x2f, 0x29, 0x8b, 0x8b, 0xc6,
];

/// Voucher authorized by MPC signature. Field order matches the type string.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    near_sdk::borsh::BorshSerialize,
    near_sdk::borsh::BorshDeserialize,
    borsh::BorshSchema,
)]
pub struct Voucher {
    pub bounty_id: u64,
    pub recipient: [u8; 20],
    pub token: [u8; 20],
    /// EVM-native uint256, big-endian (exact type match with the escrow).
    pub amount: [u8; 32],
    pub nonce: u64,
    pub expiry: u64,
    pub chain_id: u64,
    pub escrow: [u8; 20],
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

/// `keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, chainId,
/// verifyingContract))`.
pub fn domain_separator(chain_id: u64, escrow: &[u8; 20]) -> [u8; 32] {
    let mut enc = [0u8; 160];
    enc[0..32].copy_from_slice(&DOMAIN_TYPEHASH);
    enc[32..64].copy_from_slice(&NAME_HASH);
    enc[64..96].copy_from_slice(&VERSION_HASH);
    enc[96..128].copy_from_slice(&u256_from_u64(chain_id));
    enc[128..160].copy_from_slice(&padded_address(escrow));
    keccak(&enc)
}

/// `keccak256(abi.encode(VOUCHER_TYPEHASH, ...fields))`.
pub fn struct_hash(v: &Voucher) -> [u8; 32] {
    let mut enc = [0u8; 288];
    enc[0..32].copy_from_slice(&VOUCHER_TYPEHASH);
    enc[32..64].copy_from_slice(&u256_from_u64(v.bounty_id));
    enc[64..96].copy_from_slice(&padded_address(&v.recipient));
    enc[96..128].copy_from_slice(&padded_address(&v.token));
    enc[128..160].copy_from_slice(&v.amount);
    enc[160..192].copy_from_slice(&u256_from_u64(v.nonce));
    enc[192..224].copy_from_slice(&u256_from_u64(v.expiry));
    enc[224..256].copy_from_slice(&u256_from_u64(v.chain_id));
    enc[256..288].copy_from_slice(&padded_address(&v.escrow));
    keccak(&enc)
}

/// Final digest: `keccak256("\x19\x01" || domainSeparator || structHash)`.
pub fn digest(v: &Voucher) -> [u8; 32] {
    let ds = domain_separator(v.chain_id, &v.escrow);
    let sh = struct_hash(v);
    let mut enc = [0u8; 66];
    enc[0] = 0x19;
    enc[1] = 0x01;
    enc[2..34].copy_from_slice(&ds);
    enc[34..66].copy_from_slice(&sh);
    keccak(&enc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::{parse_address, to_hex};

    fn keccak_of(s: &str) -> [u8; 32] {
        let h = env::keccak256(s.as_bytes());
        let mut out = [0u8; 32];
        out.copy_from_slice(&h);
        out
    }

    #[test]
    fn constants_match_literals() {
        assert_eq!(keccak_of(VOUCHER_TYPE_STRING), VOUCHER_TYPEHASH);
        assert_eq!(keccak_of(DOMAIN_TYPE_STRING), DOMAIN_TYPEHASH);
        assert_eq!(keccak_of(DOMAIN_NAME), NAME_HASH);
        assert_eq!(keccak_of(DOMAIN_VERSION), VERSION_HASH);
    }

    fn addr(s: &str) -> [u8; 20] {
        parse_address("t", s).unwrap().0
    }

    #[test]
    fn oracle_fixture_digests_match() {
        use crate::normalize::parse_u256_decimal;
        // Every EIP-712 vector in testdata/eip712.json (ethers-generated).
        let raw = include_str!("../../../testdata/eip712.json");
        let fx: serde_json::Value = serde_json::from_str(raw).unwrap();
        assert_eq!(
            format!("0x{}", to_hex(&domain_separator(
                fx["domain"]["chainId"].as_u64().unwrap(),
                &addr(fx["domain"]["verifyingContract"].as_str().unwrap())
            ))),
            fx["domainSeparator"].as_str().unwrap()
        );
        assert_eq!(
            format!("0x{}", to_hex(&VOUCHER_TYPEHASH)),
            fx["voucherTypehash"].as_str().unwrap()
        );
        for v in fx["vouchers"].as_array().unwrap() {
            let val = &v["value"];
            let voucher = Voucher {
                bounty_id: val["bountyId"].as_u64().unwrap(),
                recipient: addr(val["recipient"].as_str().unwrap()),
                token: addr(val["token"].as_str().unwrap()),
                amount: parse_u256_decimal(val["amount"].as_str().unwrap()).unwrap(),
                nonce: val["nonce"].as_u64().unwrap(),
                expiry: val["expiry"].as_u64().unwrap(),
                chain_id: val["chainId"].as_u64().unwrap(),
                escrow: addr(val["escrow"].as_str().unwrap()),
            };
            assert_eq!(
                format!("0x{}", to_hex(&struct_hash(&voucher))),
                v["structHash"].as_str().unwrap(),
                "structHash for {}",
                v["name"]
            );
            assert_eq!(
                format!("0x{}", to_hex(&digest(&voucher))),
                v["digest"].as_str().unwrap(),
                "digest for {}",
                v["name"]
            );
        }
    }

    #[test]
    fn field_changes_move_digest() {
        let mut amount = [0u8; 32];
        amount[31] = 100;
        let base = Voucher {
            bounty_id: 7,
            recipient: [1u8; 20],
            token: [2u8; 20],
            amount,
            nonce: 1,
            expiry: 999,
            chain_id: 84532,
            escrow: [3u8; 20],
        };
        let d0 = digest(&base);
        let mut v = base;
        v.nonce = 2;
        assert_ne!(digest(&v), d0);
        v = base;
        v.amount[31] = 101;
        assert_ne!(digest(&v), d0);
        v = base;
        v.chain_id = 1;
        assert_ne!(digest(&v), d0);
        v = base;
        v.escrow = [4u8; 20];
        assert_ne!(digest(&v), d0);
    }
}
