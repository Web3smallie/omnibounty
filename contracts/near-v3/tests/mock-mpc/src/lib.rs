//! Mock MPC signer for V3 sandbox cross-contract tests.
//!
//! TEST-ONLY CONTRACT. Never deployed outside sandbox. Verbatim copy of the
//! proven V2 mock (`contracts/near/tests/mock-mpc`), which is itself the
//! authority for the v3.18.0 `sign` wire interface of
//! `v1.signer-prod.testnet` (`{"request": {path, payload_v2, domain_id}}`
//! -> tagged `Secp256k1` envelope with compressed R). Copied (not shared)
//! so V3 test collateral is independent of the frozen V2 tree.
//!
//! It embeds a fixed secp256k1 test key. Request validation mirrors the real
//! contract (domain, payload length); the ONLY intentional difference is key
//! custody (fixed test key instead of distributed MPC key generation).
//!
//! `mode` drives failure injection for the negative tests:
//! - 0: sign honestly.
//! - 1: panic (simulates MPC outage -> caller must release the dispatch).
//! - 2: return JSON that is not a signature envelope (caller must release).
//! - 3: sign with a DIFFERENT key (caller self-check must fail + release).

use near_sdk::{env, near, serde_json};

/// Fixed test-only secret key. Public; appears in test vectors.
const TEST_SK: [u8; 32] = [
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
];

/// Second test-only key for the wrong-signer mode.
const OTHER_SK: [u8; 32] = [0x42; 32];

#[near(contract_state)]
#[derive(Default)]
pub struct MockMpc {
    mode: u8,
}

#[near(serializers = [json])]
#[derive(Debug)]
pub struct SignRequestIn {
    path: String,
    payload_v2: PayloadIn,
    domain_id: u64,
}

#[near(serializers = [json])]
#[derive(Debug)]
pub enum PayloadIn {
    Ecdsa(String),
}

#[near]
impl MockMpc {
    #[init]
    pub fn new() -> Self {
        Self { mode: 0 }
    }

    /// Test control. Deliberately unpermissioned: sandbox-only contract.
    pub fn set_mode(&mut self, mode: u8) {
        if mode > 3 {
            env::panic_str("bad mode");
        }
        self.mode = mode;
    }

    /// EVM address of the honest-signing key, for `set_mpc_signer`.
    pub fn signer_address(&self) -> String {
        address_of(&TEST_SK)
    }

    pub fn public_key(&self) -> String {
        // `secp256k1:<bs58>` rendering is unnecessary for the tests; the
        // address view above carries the binding. Kept minimal on purpose.
        env::panic_str("not implemented in mock")
    }

    /// v3 `sign`. Panics on malformed requests, like the real contract.
    /// Payable: the caller attaches the 1-yocto v3 deposit, which a
    /// non-payable method would reject (every mode would fail closed).
    #[payable]
    pub fn sign(&mut self, request: SignRequestIn) -> serde_json::Value {
        if request.domain_id != 0 {
            env::panic_str("unsupported domain");
        }
        if request.path.is_empty() || request.path.len() > 128 {
            env::panic_str("bad path");
        }
        let payload_hex = match &request.payload_v2 {
            PayloadIn::Ecdsa(h) => h,
        };
        let payload: [u8; 32] = hex::decode(payload_hex)
            .ok()
            .and_then(|b| b.try_into().ok())
            .unwrap_or_else(|| env::panic_str("bad payload"));
        match self.mode {
            0 => sign_envelope(&TEST_SK, &payload),
            1 => env::panic_str("mock mpc outage"),
            2 => serde_json::Value::String("not-a-signature-envelope".to_string()),
            3 => sign_envelope(&OTHER_SK, &payload),
            _ => env::panic_str("bad mode"),
        }
    }
}

fn address_of(sk: &[u8; 32]) -> String {
    use k256::ecdsa::SigningKey;
    let signing = SigningKey::from_bytes(sk.into()).expect("valid test key");
    let point = signing.verifying_key().to_encoded_point(false);
    let hash = env::keccak256(&point.as_bytes()[1..]);
    format!("0x{}", hex::encode(&hash[12..]))
}

fn sign_envelope(sk: &[u8; 32], prehash: &[u8; 32]) -> serde_json::Value {
    use k256::ecdsa::SigningKey;
    let signing = SigningKey::from_bytes(sk.into()).expect("valid test key");
    let (sig, recid) = signing
        .sign_prehash_recoverable(prehash)
        .expect("signing never fails");
    let prefix = if recid.is_y_odd() { "03" } else { "02" };
    serde_json::json!({
        "scheme": "Secp256k1",
        "big_r": {"affine_point": format!("{prefix}{}", hex::encode(sig.r().to_bytes()))},
        "s": {"scalar": hex::encode(sig.s().to_bytes())},
        "recovery_id": recid.to_byte(),
    })
}
