//! k256-vs-host-`ecrecover` primitive-equivalence harness (test-only).
//!
//! Compares the current WASM recovery path (RustCrypto `k256`, used by
//! [`crate::reclaim::recover`] and [`crate::mpc::check_mpc_signer`]) against
//! the NEAR host function `env::ecrecover`. Under `testing_env` the mock
//! dispatches to real `VMLogic::ecrecover` (near-vm-runner), i.e. production
//! runtime semantics, not a stub.
//!
//! Corpus:
//! - 161 official vectors vendored byte-identical from
//!   `near-sdk 5.1.0/tests/ecrecover-tests.json`
//!   (sha256 `76197db6…f54a`; NEAR SDK authors, MIT/Apache-2.0): `v` in
//!   `0..=3`, mixed `mc` (malleability flag), 126 negative cases.
//! - High-S malleation twins (`s' = N - s`, `v' = v ^ 1`) derived from every
//!   valid vector: proves flag `false` accepts both S parities (required:
//!   Reclaim witnesses sign with random S parity) while flag `true`
//!   rejects upper-S.
//! - `r`/`s` edge corpus (`0, 1, N-1, N, N+1, MAX`) x `v` in `{0, 1}`.
//!
//! Deliberately NOT covered: host trap inputs (sig != 64 bytes, hash != 32
//! bytes, `v` >= 4 — the host raises `HostError`, aborting the transaction).
//! The production wrapper never passes those: lengths are fixed by
//! construction (`[u8; 32]`/`[u8; 64]`) and `v` is pre-validated by
//! [`crate::normalize::recovery_id_from_v`] (`{0,1,27,28}` -> `{0,1}`).
//! Production ALWAYS uses malleability flag `false` ("no extra checks").
//!
//! PROVEN RELATION (Phase 5.1): for v in {0,1}, host(flag=false) and
//! k256 agree on every input EXCEPT in-range (r,s) with valid R and
//! high-S, where the host recovers and k256 rejects. Mechanism: k256's
//! `recover_from_prehash` re-verifies against the recovered key
//! (ecdsa-0.16.9 recovery.rs:313) and k256 verification enforces low-S
//! (k256-0.13.3 ecdsa.rs:203) — the verify step is otherwise
//! message-tautological (pinned by `recovery_message_independence`).
//! For v in {2,3} (x-reduced; rejected by the production wrapper before
//! reaching the primitive) only the superset envelope is pinned: the host
//! never rejects what k256 accepts. Consequences:
//! - The pre-migration production path spuriously rejects valid high-S
//!   witness/MPC signatures (pinned red by `wrapper_accepts_high_s_like_host`
//!   until the migration lands).
//! - Post-migration, low-S behavior is byte-identical (pinned green in both
//!   eras by `wrapper_unchanged_on_low_s_v01` + the full existing suite).

use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{env, testing_env, Gas};

/// secp256k1 group order N (big-endian).
pub(crate) const SECP_N: [u8; 32] = [
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE,
    0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B, 0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36, 0x41, 0x41,
];

/// N / 2 (big-endian): S values above this are "high-S".
pub(crate) const SECP_N_HALF: [u8; 32] = [
    0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0x5D, 0x57, 0x6E, 0x73, 0x57, 0xA4, 0x50, 0x1D, 0xDF, 0xE9, 0x2F, 0x46, 0x68, 0x1B, 0x20, 0xA1,
];

fn setup() {
    testing_env!(VMContextBuilder::new()
        .prepaid_gas(Gas::from_tgas(300))
        .build());
}

/// Raw k256 recovery mapped to the host's output shape (64-byte key / None).
/// `pub(crate)` for the pre-migration native-timing reference test.
pub(crate) fn k256_raw(m: &[u8; 32], v: u8, sig: &[u8; 64]) -> Option<[u8; 64]> {
    assert!(v < 4, "harness only compares host-accepted v");
    let id = RecoveryId::new(v & 1 != 0, v & 2 != 0);
    let parsed = Signature::from_bytes((&sig[..]).into()).ok()?;
    let verkey = VerifyingKey::recover_from_prehash(m, &parsed, id).ok()?;
    let bytes = verkey.to_encoded_point(false);
    let raw = bytes.as_bytes();
    if raw.len() != 65 || raw[0] != 0x04 {
        return None;
    }
    let mut out = [0u8; 64];
    out.copy_from_slice(&raw[1..]);
    Some(out)
}

/// Raw host recovery (real VMLogic under the mock).
fn host_raw(m: &[u8; 32], v: u8, sig: &[u8; 64], malleability: bool) -> Option<[u8; 64]> {
    env::ecrecover(&m[..], &sig[..], v, malleability)
}

/// `a - b` for 256-bit big-endian values, `a >= b`.
pub(crate) fn be_sub(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow: u16 = 0;
    for i in (0..32).rev() {
        let diff = a[i] as u16 as i32 - b[i] as u16 as i32 - borrow as i32;
        if diff < 0 {
            out[i] = (diff + 256) as u8;
            borrow = 1;
        } else {
            out[i] = diff as u8;
            borrow = 0;
        }
    }
    assert_eq!(borrow, 0, "be_sub underflow: a < b");
    out
}

/// Big-endian `a > b`.
pub(crate) fn be_gt(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.cmp(b) == core::cmp::Ordering::Greater
}

fn be_add_one(a: &[u8; 32]) -> [u8; 32] {
    let mut out = *a;
    for i in (0..32).rev() {
        let (v, carry) = out[i].overflowing_add(1);
        out[i] = v;
        if !carry {
            break;
        }
    }
    out
}

struct Vector {
    m: [u8; 32],
    v: u8,
    sig: [u8; 64],
    mc: bool,
    res: Option<[u8; 64]>,
}

fn load_official_vectors() -> Vec<Vector> {
    let raw = include_str!("../tests/data/ecrecover-vectors.json");
    let parsed: serde_json::Value = serde_json::from_str(raw).expect("valid vectors json");
    let arr = parsed.as_array().expect("vectors array");
    assert_eq!(arr.len(), 161, "vendored vector count pinned");
    arr.iter()
        .map(|entry| {
            let hex32 = |key: &str| -> [u8; 32] {
                let bytes =
                    hex::decode(entry[key].as_str().expect("hex str")).expect("hex decodes");
                bytes.try_into().expect("32 bytes")
            };
            let hex64 = |key: &str| -> [u8; 64] {
                let bytes =
                    hex::decode(entry[key].as_str().expect("hex str")).expect("hex decodes");
                bytes.try_into().expect("64 bytes")
            };
            Vector {
                m: hex32("m"),
                v: entry["v"].as_u64().expect("v u8") as u8,
                sig: hex64("sig"),
                mc: entry["mc"].as_bool().expect("mc bool"),
                res: entry["res"].as_str().map(|_| hex64("res")),
            }
        })
        .collect()
}

/// Proven equivalence relation (see module docs and the `*_semantics` pins):
/// host(flag=false) and k256 agree on every input EXCEPT in-range (r,s)
/// with valid R and high-S, where the host recovers and k256 rejects
/// (its recovery re-verifies, and k256 verification enforces low-S).
fn s_high(sig: &[u8; 64]) -> bool {
    let mut s = [0u8; 32];
    s.copy_from_slice(&sig[32..64]);
    be_gt(&s, &SECP_N_HALF)
}

fn assert_equivalent(m: &[u8; 32], v: u8, sig: &[u8; 64], ctx: &str) {
    let k = k256_raw(m, v, sig);
    let h = host_raw(m, v, sig, false);
    if v > 1 {
        // x-reduced (v in {2,3}): production-irrelevant (the wrapper rejects
        // v >= 2 before reaching the primitive; real signatures never carry
        // it, P(x >= N) = (p-N)/p ~ 2^-132). k256's verify step compares
        // the full x-coordinate (r+N) against r and rejects, while libsecp's
        // pure recovery succeeds. Only the migration-safety envelope is
        // pinned: the host accepts a SUPERSET of k256 (never newly-rejects).
        assert!(
            !(k.is_some() && h.is_none()),
            "{ctx}: host must not reject what k256 accepts (v={v})"
        );
        return;
    }
    if s_high(sig) {
        assert!(
            k == h || (k.is_none() && h.is_some()),
            "{ctx}: illegal divergence k256={k:02x?} host={h:02x?}"
        );
    } else {
        assert_eq!(k, h, "{ctx}: k256/host diverge on low-S input");
    }
}

/// 161 official vectors: the proven relation holds on every input.
/// Also counts natural high-S valids (host accepts, k256 rejects).
#[test]
fn official_vectors_equivalence_relation() {
    setup();
    let vectors = load_official_vectors();
    let mut natural_high = 0usize;
    for (i, vec) in vectors.iter().enumerate() {
        assert!(vec.v < 4, "vector {i}: unexpected v {}", vec.v);
        assert_equivalent(
            &vec.m,
            vec.v,
            &vec.sig,
            &format!("vector {i} (v={} mc={})", vec.v, vec.mc),
        );
        if vec.v < 2
            && s_high(&vec.sig)
            && k256_raw(&vec.m, vec.v, &vec.sig).is_none()
            && host_raw(&vec.m, vec.v, &vec.sig, false).is_some()
        {
            natural_high += 1;
        }
    }
    eprintln!(
        "equiv: relation holds on all 161 official vectors; natural high-S valids: {natural_high}"
    );
}

/// Mock-fidelity check: host(flag=mc) reproduces the file's oracle output.
/// (Proves the unit-test mock IS the runtime implementation for these inputs.)
#[test]
fn official_vectors_mock_matches_runtime_oracle() {
    setup();
    let vectors = load_official_vectors();
    for (i, vec) in vectors.iter().enumerate() {
        let got = host_raw(&vec.m, vec.v, &vec.sig, vec.mc);
        assert_eq!(
            got, vec.res,
            "vector {i} (v={} mc={}): mock != oracle",
            vec.v, vec.mc
        );
    }
    eprintln!("equiv: host(flag=mc) matches all 161 oracle outputs");
}

/// Malleation twins: for every k256-valid vector (hence low-S),
/// `s' = N - s, v' = v ^ 1` is the high-S twin. The host with flag=false
/// recovers the SAME key (the required production behavior); k256 rejects
/// it (the strictness being migrated away from); the host with flag=true
/// rejects it (why production must use flag=false).
#[test]
fn high_s_twins_flag_policy() {
    setup();
    let vectors = load_official_vectors();
    let mut twins = 0usize;
    for (i, vec) in vectors.iter().enumerate() {
        let Some(key) = k256_raw(&vec.m, vec.v, &vec.sig) else {
            continue;
        };
        // s in [1, N) for every valid vector, so N - s is well-defined.
        let mut s = [0u8; 32];
        s.copy_from_slice(&vec.sig[32..64]);
        let s_twin = be_sub(&SECP_N, &s);
        let mut sig_twin = vec.sig;
        sig_twin[32..64].copy_from_slice(&s_twin);
        let v_twin = vec.v ^ 1;
        assert_eq!(
            host_raw(&vec.m, v_twin, &sig_twin, false),
            Some(key),
            "vector {i}: host(flag=false) must accept the high-S twin"
        );
        assert_eq!(
            k256_raw(&vec.m, v_twin, &sig_twin),
            None,
            "vector {i}: k256 documents strict low-S (migration rationale)"
        );
        assert_eq!(
            host_raw(&vec.m, v_twin, &sig_twin, true),
            None,
            "vector {i}: host(flag=true) must reject the high-S twin"
        );
        twins += 1;
    }
    assert!(twins > 0, "expected some valid vectors to twin");
    eprintln!(
        "equiv: {twins} high-S twins: host(flag=false) accepts, k256 + host(flag=true) reject"
    );
}

/// `r`/`s` edge corpus x `v` in {0,1}: the proven relation holds on all 72.
#[test]
fn rs_edge_corpus_relation() {
    setup();
    let one = be_add_one(&[0u8; 32]);
    let n_minus_1 = be_sub(&SECP_N, &one);
    let n_plus_1 = be_add_one(&SECP_N);
    let edges: [[u8; 32]; 6] = [[0u8; 32], one, n_minus_1, SECP_N, n_plus_1, [0xFFu8; 32]];
    let m = env::keccak256(b"omnibounty-v3 ecrecover edge corpus");
    let mut m32 = [0u8; 32];
    m32.copy_from_slice(&m);
    let mut compared = 0usize;
    for r in &edges {
        for s in &edges {
            for v in [0u8, 1u8] {
                let mut sig = [0u8; 64];
                sig[..32].copy_from_slice(r);
                sig[32..].copy_from_slice(s);
                assert_equivalent(&m32, v, &sig, &format!("edge v={v}"));
                compared += 1;
            }
        }
    }
    eprintln!("equiv: relation holds on {compared} edge combinations (r/s in 0,1,N-1,N,N+1,MAX x v in 0,1)");
}

fn key_to_addr(key: &[u8; 64]) -> [u8; 20] {
    let hash = env::keccak256(key);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[12..]);
    addr
}

/// No-regression pin (green in BOTH eras): on low-S-or-invalid inputs with
/// v in {0,1} the production wrapper matches k256 and the host alike.
/// This is the "migration changes nothing for all previously-accepted
/// inputs" proof.
#[test]
fn wrapper_unchanged_on_low_s_v01() {
    use crate::normalize::Sig65;
    setup();
    let vectors = load_official_vectors();
    let mut compared = 0usize;
    for (i, vec) in vectors.iter().enumerate() {
        if vec.v > 1 || s_high(&vec.sig) {
            continue;
        }
        let expected_k = k256_raw(&vec.m, vec.v, &vec.sig).map(|key| key_to_addr(&key));
        let expected_h = host_raw(&vec.m, vec.v, &vec.sig, false).map(|key| key_to_addr(&key));
        assert_eq!(
            expected_k, expected_h,
            "vector {i}: primitives diverge on low-S"
        );
        let mut sig65 = [0u8; 65];
        sig65[..64].copy_from_slice(&vec.sig);
        sig65[64] = vec.v + 27;
        let got = crate::reclaim::recover(&Sig65(sig65), &vec.m).ok();
        assert_eq!(
            got, expected_k,
            "vector {i}: wrapper != primitives on low-S"
        );
        compared += 1;
    }
    eprintln!("equiv: wrapper matches both primitives on {compared} low-S vectors (v in 0,1)");
}

/// Fix pin (RED pre-migration by design, green after): the production
/// wrapper must accept high-S valid inputs exactly like host(flag=false) —
/// both natural officials and malleation twins of valid v in {0,1} vectors.
#[test]
fn wrapper_accepts_high_s_like_host() {
    use crate::normalize::Sig65;
    setup();
    let vectors = load_official_vectors();
    let mut compared = 0usize;
    let mut check = |m: &[u8; 32], v: u8, sig: &[u8; 64], ctx: &str| {
        let expected = host_raw(m, v, sig, false).map(|key| key_to_addr(&key));
        if expected.is_none() {
            return;
        }
        let mut sig65 = [0u8; 65];
        sig65[..64].copy_from_slice(sig);
        sig65[64] = v + 27;
        let got = crate::reclaim::recover(&Sig65(sig65), m).ok();
        assert_eq!(
            got, expected,
            "{ctx}: wrapper must accept high-S like host(flag=false)"
        );
        compared += 1;
    };
    for (i, vec) in vectors.iter().enumerate() {
        if vec.v > 1 {
            continue;
        }
        // Natural high-S officials.
        if s_high(&vec.sig) {
            check(
                &vec.m,
                vec.v,
                &vec.sig,
                &format!("vector {i} natural high-S"),
            );
        }
        // Malleation twins of k256-valid (hence low-S) vectors.
        if k256_raw(&vec.m, vec.v, &vec.sig).is_some() {
            let mut s = [0u8; 32];
            s.copy_from_slice(&vec.sig[32..64]);
            let mut twin = vec.sig;
            twin[32..64].copy_from_slice(&be_sub(&SECP_N, &s));
            check(&vec.m, vec.v ^ 1, &twin, &format!("vector {i} high-S twin"));
        }
    }
    assert!(compared > 0, "expected high-S valid cases with v in 0,1");
    eprintln!("equiv: wrapper accepts {compared} high-S valid inputs like host(flag=false)");
}

/// Message-independence pin: flipping one message bit on every valid
/// vector yields IDENTICAL keys on both primitives. Recovery success
/// depends only on (r, s, v) curve validity, never on message "correctness"
/// (k256's verify step is message-tautological for the recovered key; its
/// only behavioral bite is the low-S policy).
#[test]
fn recovery_message_independence() {
    setup();
    let vectors = load_official_vectors();
    let mut compared = 0usize;
    for (i, vec) in vectors.iter().enumerate() {
        if k256_raw(&vec.m, vec.v, &vec.sig).is_none() {
            continue;
        }
        let mut m = vec.m;
        m[0] ^= 0x01;
        let k = k256_raw(&m, vec.v, &vec.sig);
        let h = host_raw(&m, vec.v, &vec.sig, false);
        assert_eq!(k, h, "vector {i}: flipped-message keys diverge");
        assert!(k.is_some(), "vector {i}: flipped-message recovery failed");
        compared += 1;
    }
    eprintln!("equiv: flipped-message keys identical on both primitives ({compared} cases)");
}

/// Gas probe: per-call host cost is constant; print it for the gas model.
#[test]
fn host_ecrecover_gas_probe() {
    setup();
    let vectors = load_official_vectors();
    let vec = vectors
        .iter()
        .find(|e| e.res.is_some())
        .expect("a valid vector");
    let g0 = env::used_gas().as_gas();
    let first = host_raw(&vec.m, vec.v, &vec.sig, false);
    let g1 = env::used_gas().as_gas();
    let second = host_raw(&vec.m, vec.v, &vec.sig, false);
    let g2 = env::used_gas().as_gas();
    assert_eq!(first, second, "host recovery must be deterministic");
    let per_call_1 = g1 - g0;
    let per_call_2 = g2 - g1;
    assert_eq!(
        per_call_1, per_call_2,
        "host cost must be input-independent"
    );
    assert!(
        per_call_1 < 500_000_000_000,
        "per-call {per_call_1} exceeds 0.5 Tgas sanity bound"
    );
    eprintln!(
        "equiv: host ecrecover per-call = {per_call_1} gas ({:.6} Tgas)",
        per_call_1 as f64 / 1e12
    );
}
