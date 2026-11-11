//! Strict hex normalization (H1 resolution).
//!
//! Accepted input: an optional single `0x`/`0X` prefix followed by exactly
//! `N*2` ASCII hex characters of any case. Canonical output: lowercase hex
//! with no prefix. Everything else is REJECTED, never repaired:
//! empty input, prefix-only, double prefixes, whitespace, non-hex
//! characters, and wrong lengths all fail.
//!
//! Security rationale: all downstream uses (identifier comparison, signed
//! message reconstruction, witness comparison) operate on canonical bytes,
//! so distinct representations of the same value collapse BEFORE any
//! cryptographic use. Lowercasing before `hex::decode` additionally removes
//! any dependence on decoder case behavior.

use crate::error::ClaimError;

/// 32-byte value (proof identifier, digests).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Hex32(pub [u8; 32]);

/// 20-byte EVM address (owner, recipient, token, escrow, witnesses).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EthAddr(pub [u8; 20]);

/// 65-byte secp256k1 signature (r || s || v).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sig65(pub [u8; 65]);

/// Parse `s` into exactly `N` bytes. `field` names the value for errors.
pub fn parse_hex<const N: usize>(
    field: &'static str,
    s: &str,
) -> Result<[u8; N], ClaimError> {
    if s.is_empty() {
        return Err(ClaimError::InvalidLength(field));
    }
    let body = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    if body.len() != N * 2 {
        return Err(ClaimError::InvalidLength(field));
    }
    if !body.is_ascii() || !body.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ClaimError::InvalidHex(field));
    }
    // Lowercase first: canonical bytes must not depend on decoder quirks.
    let lower = body.to_ascii_lowercase();
    let bytes = hex::decode(&lower).map_err(|_| ClaimError::InvalidHex(field))?;
    let mut out = [0u8; N];
    if bytes.len() != N {
        return Err(ClaimError::InvalidLength(field));
    }
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// Canonical hex encoding: lowercase, no prefix.
pub fn to_hex(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

/// Human-facing hex with `0x` prefix (views, logs). Never used for hashing.
pub fn to_hex_prefixed(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2 + 2);
    s.push_str("0x");
    s.push_str(&hex::encode(bytes));
    s
}

pub fn parse_identifier(s: &str) -> Result<Hex32, ClaimError> {
    Ok(Hex32(parse_hex("identifier", s)?))
}

pub fn parse_address(field: &'static str, s: &str) -> Result<EthAddr, ClaimError> {
    Ok(EthAddr(parse_hex(field, s)?))
}

pub fn parse_signature(s: &str) -> Result<Sig65, ClaimError> {
    Ok(Sig65(parse_hex("signature", s)?))
}

/// Map a signature recovery byte to the normalized 0/1 recovery id.
/// Accepts legacy Ethereum (27/28) and modern (0/1) forms only.
pub fn recovery_id_from_v(v: u8) -> Result<u8, ClaimError> {
    match v {
        0 | 1 => Ok(v),
        27 => Ok(0),
        28 => Ok(1),
        _ => Err(ClaimError::InvalidRecoveryId),
    }
}

/// Parse a decimal uint256 (EVM-native amounts). Accepts ASCII digits with
/// optional leading zeros; rejects empty, signed, hex, fractional, spaced,
/// and out-of-range inputs. Output is 32-byte big-endian.
pub fn parse_u256_decimal(s: &str) -> Result<[u8; 32], ClaimError> {
    if s.is_empty() || s.len() > 78 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ClaimError::InvalidAmount);
    }
    let mut out = [0u8; 32];
    for digit in s.bytes() {
        let d = (digit - b'0') as u16;
        // out = out * 10 + d, manually (u128 would overflow for big values).
        let mut carry = d;
        for byte in out.iter_mut().rev() {
            let v = *byte as u16 * 10 + carry;
            *byte = (v & 0xff) as u8;
            carry = v >> 8;
        }
        if carry != 0 {
            return Err(ClaimError::InvalidAmount);
        }
    }
    Ok(out)
}

/// Render 32-byte big-endian as minimal decimal (no leading zeros).
pub fn u256_to_decimal(v: &[u8; 32]) -> String {
    let mut tmp = *v;
    if tmp == [0u8; 32] {
        return "0".to_string();
    }
    let mut digits: Vec<u8> = Vec::new();
    while tmp != [0u8; 32] {
        let mut rem: u16 = 0;
        for byte in tmp.iter_mut() {
            let cur = (rem << 8) | *byte as u16;
            *byte = (cur / 10) as u8;
            rem = cur % 10;
        }
        digits.push(b'0' + rem as u8);
    }
    digits.reverse();
    // Digits are ASCII by construction; fall back safely (never panics).
    String::from_utf8(digits).unwrap_or_else(|_| "0".to_owned())
}

pub fn u256_is_zero(v: &[u8; 32]) -> bool {
    v == &[0u8; 32]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn u256_decimal_roundtrip_and_edges() {
        // Zero, one, typical USDC value.
        assert_eq!(u256_to_decimal(&parse_u256_decimal("0").unwrap()), "0");
        assert_eq!(u256_to_decimal(&parse_u256_decimal("1").unwrap()), "1");
        assert_eq!(
            u256_to_decimal(&parse_u256_decimal("2500000000").unwrap()),
            "2500000000"
        );
        // Leading zeros accepted, stripped in output.
        assert_eq!(u256_to_decimal(&parse_u256_decimal("007").unwrap()), "7");
        // u128::MAX boundary (the old cap) and beyond.
        let u128max = "340282366920938463463374607431768211455";
        assert_eq!(u256_to_decimal(&parse_u256_decimal(u128max).unwrap()), u128max);
        let over = "340282366920938463463374607431768211456";
        assert_eq!(u256_to_decimal(&parse_u256_decimal(over).unwrap()), over);
        // MaxUint256 round-trips exactly.
        let max = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
        let bytes = parse_u256_decimal(max).unwrap();
        assert_eq!(bytes, [0xffu8; 32]);
        assert_eq!(u256_to_decimal(&bytes), max);
        // Out of range and malformed rejected.
        assert!(parse_u256_decimal("115792089237316195423570985008687907853269984665640564039457584007913129639936").is_err());
        for bad in ["", "-1", "+1", "0x10", "1.5", " 1", "1 ", "1_000", "abc"] {
            assert!(parse_u256_decimal(bad).is_err(), "must reject {bad:?}");
        }
        assert!(u256_is_zero(&[0u8; 32]));
        assert!(!u256_is_zero(&parse_u256_decimal("1").unwrap()));
    }

    #[test]
    fn happy_paths() {
        let id = parse_identifier(
            "0x94bb12417065a93c36cdf75539d16c0a25f707b882f4ea2b0b69272254357175",
        )
        .unwrap();
        assert_eq!(
            to_hex(&id.0),
            "94bb12417065a93c36cdf75539d16c0a25f707b882f4ea2b0b69272254357175"
        );
        let addr =
            parse_address("owner", "0xCb234C6FC8aBE3Eb38e31eEc6288B431E313d9b9")
                .unwrap();
        assert_eq!(
            to_hex(&addr.0),
            "cb234c6fc8abe3eb38e31eec6288b431e313d9b9"
        );
        assert_eq!(recovery_id_from_v(27).unwrap(), 0);
        assert_eq!(recovery_id_from_v(28).unwrap(), 1);
        assert_eq!(recovery_id_from_v(0).unwrap(), 0);
        assert_eq!(recovery_id_from_v(1).unwrap(), 1);
    }

    #[test]
    fn rejects_malformed() {
        for bad in [
            "",
            "0x",
            "0X",
            "0x0x94bb12417065a93c36cdf75539d16c0a25f707b882f4ea2b0b69272254357175",
            " 0x94bb12417065a93c36cdf75539d16c0a25f707b882f4ea2b0b69272254357175",
            "0x94bb12417065a93c36cdf75539d16c0a25f707b882f4ea2b0b69272254357175 ",
            "0x94bb12417065a93c36cdf75539d16c0a25f707b882f4ea2b0b6927225435717",
            "0x94bb12417065a93c36cdf75539d16c0a25f707b882f4ea2b0b6927225435717500",
            "0xzzbb12417065a93c36cdf75539d16c0a25f707b882f4ea2b0b69272254357175",
        ] {
            assert!(parse_identifier(bad).is_err(), "must reject {bad:?}");
        }
        for bad_v in [2u8, 3, 29, 30, 255] {
            assert!(recovery_id_from_v(bad_v).is_err());
        }
    }

    #[test]
    fn oracle_fixture_matrix() {
        // Every case in testdata/normalize.json, generated by tools/.
        let raw = include_str!("../../../testdata/normalize.json");
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();
        let mut count = 0;
        for case in v["identifier"].as_array().unwrap() {
            let input = case["input"].as_str().unwrap();
            let res = parse_identifier(input).map(|h| to_hex(&h.0));
            match case["expected"].as_str() {
                Some(exp) => assert_eq!(res.unwrap(), exp, "input {input:?}"),
                None => assert!(res.is_err(), "input {input:?} must be rejected"),
            }
            count += 1;
        }
        for case in v["owner"].as_array().unwrap() {
            let input = case["input"].as_str().unwrap();
            let res = parse_address("owner", input).map(|a| to_hex(&a.0));
            match case["expected"].as_str() {
                Some(exp) => assert_eq!(res.unwrap(), exp, "input {input:?}"),
                None => assert!(res.is_err(), "input {input:?} must be rejected"),
            }
            count += 1;
        }
        for case in v["signature"].as_array().unwrap() {
            let input = case["input"].as_str().unwrap();
            let res = parse_signature(input).map(|s| to_hex(&s.0));
            match case["expected"].as_str() {
                Some(exp) => assert_eq!(res.unwrap(), exp, "input {input:?}"),
                None => assert!(res.is_err(), "input {input:?} must be rejected"),
            }
            count += 1;
        }
        for case in v["recoveryId"].as_array().unwrap() {
            let vin = case["v"].as_u64().unwrap() as u8;
            let res = recovery_id_from_v(vin);
            match case["expected"].as_u64() {
                Some(exp) => assert_eq!(res.unwrap() as u64, exp),
                None => assert!(res.is_err(), "v={vin} must be rejected"),
            }
            count += 1;
        }
        assert!(count >= 30, "fixture matrix unexpectedly small");
    }
}
