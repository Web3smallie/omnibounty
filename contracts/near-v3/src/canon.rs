//! Vendored VERBATIM from `contracts/near/src/canon.rs` (V2, proven).
//! Covers proof params/context canonicalization; criteria documents use the
//! same function after the strict-subset pre-scan in `criteria.rs`.
//!
//! Canonical JSON compatible with `canonicalize@2.1.0`.
//!
//! Rules (verified against the package source in `read_skill`-era audit and
//! pinned by `testdata/canon.json` fixtures generated with the real package):
//! - Objects: keys sorted (JS `Array.sort` order = UTF-16 code-unit order),
//!   no whitespace, `{"k":v,"k2":v2}`.
//! - Arrays: order preserved.
//! - Strings: `JSON.stringify` escaping (`\"`, `\\`, `\b \t \n \f \r`,
//!   `\u00XX` for other control characters; all else raw UTF-8).
//! - Numbers: integers render exactly. Non-integral or out-of-range JSON
//!   numbers are REJECTED (fail-closed): genuine Reclaim parameters/contexts
//!   for this contract's template carry only strings, booleans, objects and
//!   arrays, and ECMAScript float formatting is intentionally not replicated.
//! - Duplicate object keys: the parser keeps the LAST occurrence, matching
//!   both `JSON.parse` and `serde_json` (pinned by fixture).
//!
//! DoS bounds: input byte cap and nesting-depth cap are enforced before and
//! during serialization.

use crate::error::ClaimError;
use serde_json::Value;

pub const MAX_JSON_BYTES: usize = 16_384;
pub const MAX_JSON_DEPTH: usize = 32;

/// Parse with a byte-size cap.
pub fn parse_capped(field: &'static str, s: &str) -> Result<Value, ClaimError> {
    if s.len() > MAX_JSON_BYTES {
        return Err(ClaimError::ProofTooLarge(field));
    }
    serde_json::from_str(s).map_err(|_| match field {
        "parameters" => ClaimError::InvalidParamsJson,
        "context" => ClaimError::InvalidContextJson,
        _ => ClaimError::InvalidParamsJson,
    })
}

/// Canonicalize an already-parsed value.
pub fn canonicalize(value: &Value) -> Result<String, ClaimError> {
    let mut out = String::new();
    write_canonical(&mut out, value, 0)?;
    Ok(out)
}

/// Parse (capped) and canonicalize in one step.
pub fn canonicalize_str(field: &'static str, s: &str) -> Result<String, ClaimError> {
    let v = parse_capped(field, s)?;
    canonicalize(&v)
}

fn write_canonical(out: &mut String, v: &Value, depth: usize) -> Result<(), ClaimError> {
    if depth > MAX_JSON_DEPTH {
        return Err(ClaimError::JsonTooDeep);
    }
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => write_number(out, n)?,
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(out, item, depth + 1)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            // JS default sort compares UTF-16 code units; replicate exactly
            // (differs from byte order only for non-BMP keys, but be exact).
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| utf16_units(a).cmp(&utf16_units(b)).then_with(|| a.cmp(b)));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, k);
                out.push(':');
                // Key came from the map, so indexing is infallible; avoid
                // indexing panics anyway by matching on the lookup.
                match map.get(*k) {
                    Some(child) => write_canonical(out, child, depth + 1)?,
                    None => return Err(ClaimError::InvalidParamsJson),
                }
            }
            out.push('}');
        }
    }
    Ok(())
}

fn write_number(out: &mut String, n: &serde_json::Number) -> Result<(), ClaimError> {
    if let Some(u) = n.as_u64() {
        out.push_str(&u.to_string());
        Ok(())
    } else if let Some(i) = n.as_i64() {
        out.push_str(&i.to_string());
        Ok(())
    } else if let Some(f) = n.as_f64() {
        // Accept integral floats whose value fits i64, rendered as integers
        // (matches JSON.stringify(42.0) === "42"). Reject all else.
        if f.is_finite() && f.fract() == 0.0 && f >= i64::MIN as f64 && f <= i64::MAX as f64 {
            out.push_str(&(f as i64).to_string());
            Ok(())
        } else {
            Err(ClaimError::NonIntegralNumber)
        }
    } else {
        Err(ClaimError::NonIntegralNumber)
    }
}

/// `JSON.stringify`-compatible string escaping.
fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{09}' => out.push_str("\\t"),
            '\u{0A}' => out.push_str("\\n"),
            '\u{0C}' => out.push_str("\\f"),
            '\u{0D}' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn utf16_units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oracle_fixture_matrix() {
        let raw = include_str!("../../../testdata/canon.json");
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();
        let cases = v["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let input = case["input"].as_str().unwrap();
            let expected = case["canonical"].as_str().unwrap();
            let got = canonicalize_str("parameters", input).unwrap();
            assert_eq!(got, expected, "case {name}");
        }
    }

    #[test]
    fn rejects_hostile_inputs() {
        assert!(canonicalize_str("parameters", &"x".repeat(MAX_JSON_BYTES + 1)).is_err());
        assert!(canonicalize_str("parameters", "{not json").is_err());
        // Non-integral float must fail closed.
        assert!(canonicalize_str("parameters", r#"{"v":1.5}"#).is_err());
        // Deep nesting beyond the cap must fail.
        let deep = format!("{}{{}}", "{\"a\":".repeat(MAX_JSON_DEPTH + 4));
        assert!(canonicalize_str("parameters", &deep).is_err());
        // 42.0 renders as 42 like JSON.stringify.
        assert_eq!(
            canonicalize_str("parameters", r#"{"v":42.0}"#).unwrap(),
            r#"{"v":42}"#
        );
    }

    #[test]
    fn utf16_key_order_matches_js() {
        // U+10000 sorts before U+E000 in UTF-16 code units (D800 < E000)
        // but after it in scalar/byte order. JS sort => U+10000 first.
        let input = "{\"\u{e000}\":1,\"𐀀\":2}";
        assert_eq!(
            canonicalize_str("parameters", input).unwrap(),
            "{\"𐀀\":2,\"\u{e000}\":1}"
        );
    }
}
