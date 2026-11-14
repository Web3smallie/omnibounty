//! OmniBounty NEAR V3 contract: task-first bounties with immutable criteria
//! commitments, multi-proof Reclaim verification, ordered winner slots,
//! bounded challenge windows, and MPC-authorized VoucherV2 payouts.
//!
//! Design authority: `docs/v3/NEAR_V3_DESIGN.md` (states, lifecycles,
//! entrypoints) plus the Phase 2 specs (`ACCEPTANCE_CRITERIA_SPEC.md`,
//! `VERIFICATION_MATRIX.md`, `SECURITY_MODEL.md`, `CANONICALIZATION.md`).
//!
//! Proven V2 machinery is reused verbatim where the semantics are identical:
//! canonical JSON, identifier binding, ecrecovery, the MPC v3 envelope, the
//! raw-bytes callback-as-data pattern, the global nonce, epoch pinning, and
//! freshness windows. V3 adds: criteria commitments, multi-proof bundles with
//! URL pinning and head-SHA joins, bounty/recipient-scoped nullifiers, ordered
//! slots with monotonic claim sequences, a fixed transparency window with
//! deterministic re-execution (no counter-evidence engine), storage-paid-by-
//! caller, and 2-step ownership transfer.

use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};

mod canon;
mod criteria;
mod ecrecover;
#[cfg(test)]
mod ecrecover_equiv;
mod error;
mod mpc;
mod normalize;
mod reclaim;
mod rules;
mod voucher;

use criteria::{criteria_hash, strict_parse, validate_criteria, ValidatedCriteria};
use error::ClaimError;
use mpc::{MpcSignature, SignRequest};
use normalize::{parse_address, parse_hex, to_hex_prefixed, u256_is_zero, u256_to_decimal};
use reclaim::{nullifier_key, verify_core, EvidenceType, ProofInput};
use rules::{evaluate, first_failure, EvaluatedProof, Verdict};
use serde_json::Value;
use voucher::{build_voucher, digest as voucher_digest, SignedVoucher, VoucherV2};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Default EVM chain: Base Sepolia.
pub const DEFAULT_CHAIN_ID: u64 = 84532;
/// MPC derivation path for V3 voucher signing. Versioned apart from V2 so
/// each protocol version derives a distinct signing key.
pub const DEFAULT_VOUCHER_PATH: &str = "omnibounty-voucher-v2";
/// Gas attached to the MPC `sign` call.
pub const SIGN_GAS: Gas = Gas::from_tgas(100);
/// Gas reserved for the MPC callback.
pub const CALLBACK_GAS: Gas = Gas::from_tgas(40);
/// Callers should attach at least this much gas to `qualify_claim`.
/// Heavy bundles (many proofs/witnesses) need more; unused gas is refunded.
pub const QUALIFY_MIN_GAS: Gas = Gas::from_tgas(150);
/// Callers should attach at least this much gas to `finalize_claim`.
pub const FINALIZE_MIN_GAS: Gas = Gas::from_tgas(150);
/// Freshness defaults: proofs valid 7 days, 5 minutes future skew.
pub const DEFAULT_MAX_PROOF_AGE_SEC: u64 = 7 * 24 * 3600;
pub const DEFAULT_FUTURE_SKEW_SEC: u64 = 300;
/// Voucher lifetime from dispatch: 24h.
pub const DEFAULT_VOUCHER_TTL_SEC: u64 = 24 * 3600;
/// Stuck-dispatch recovery: a pending MPC request older than this may be
/// superseded by a fresh permissionless `finalize_claim` (6h).
pub const DEFAULT_PENDING_TIMEOUT_SEC: u64 = 6 * 3600;
/// Registry DoS cap.
pub const MAX_BOUNTIES: usize = 10_000;
pub const MAX_LIST_LIMIT: u64 = 100;
/// Operational slot cap, mirroring criteria validation (`<= 16`); slot
/// indices always fit `u8`, and `slots_filled` can never overflow.
pub const MAX_SLOTS: usize = 16;

/// Claim is qualified and inside (or awaiting) its challenge window.
pub const CLAIM_CHALLENGEABLE: u8 = 0;
/// Claim dispatched an MPC signing request (voucher pending or signed).
pub const CLAIM_FINALIZED: u8 = 1;

// ---------------------------------------------------------------------------
// Storage types
// ---------------------------------------------------------------------------

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct PinnedEpoch {
    /// Canonical 20-byte witness addresses; ALL must sign.
    pub witnesses: Vec<[u8; 20]>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct BountyV3 {
    pub id: u64,
    pub sponsor: AccountId,
    pub token: [u8; 20],
    /// Keccak-256 over the canonical criteria JSON. Binds repo, checks,
    /// files, labels, reviews, slots, amounts, deadline, and windows: the
    /// claim-supplied document is re-validated and re-hashed on every
    /// `qualify_claim`, so no criteria setter can exist.
    pub criteria_hash: [u8; 32],
    /// Per-slot amounts (u256 big-endian), copied from the validated
    /// criteria at creation. Voucher amounts come ONLY from here, never
    /// from claim input.
    pub slots: Vec<[u8; 32]>,
    /// Count of qualified claims; also the next slot index to fill.
    pub slots_filled: u8,
    /// Checked `sum(slots)` (u256 big-endian). The escrow-side funded
    /// total must equal this before `mark_funded` is meaningful.
    pub total_amount: [u8; 32],
    pub funded: bool,
    /// Submission deadline from criteria (0 = none). Gates qualification
    /// only; finalization of an already-qualified claim is unaffected.
    pub deadline: u64,
    /// Challenge window in seconds, from criteria (0 = immediate).
    pub challenge_window: u64,
    pub created_at: u64,
    /// Monotonic qualification sequence: each accepted claim takes the
    /// current value and increments. Orders winners deterministically.
    pub seq: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct ClaimRecord {
    pub bounty_id: u64,
    pub slot: u8,
    pub recipient: [u8; 20],
    pub pr_number: u64,
    pub head_sha: [u8; 20],
    /// Verified PR authorship timestamp (unix seconds), unified across
    /// the bundle's PR proofs. Recorded for deterministic ordering.
    pub github_created: u64,
    pub claim_seq: u64,
    pub qualified_at: u64,
    pub status: u8,
    /// Digest of the in-flight MPC request, if any. Lets `finalize_claim`
    /// find (and, after the pending timeout, supersede) a stuck dispatch
    /// without scanning storage.
    pub pending_digest: Option<[u8; 32]>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct PendingVoucher {
    pub bounty_id: u64,
    pub slot: u8,
    pub voucher: VoucherV2,
    pub claim_seq: u64,
    /// Dispatch timestamp: the re-finalize timeout anchor.
    pub dispatched_at: u64,
}

// ---------------------------------------------------------------------------
// Views (JSON) and call arguments
// ---------------------------------------------------------------------------

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BountyView {
    pub id: u64,
    pub sponsor: String,
    pub token: String,
    pub criteria_hash: String,
    pub slots: Vec<String>,
    pub slots_filled: u8,
    pub total_amount: String,
    pub funded: bool,
    pub deadline: u64,
    pub challenge_window: u64,
    pub created_at: u64,
    pub seq: u64,
    pub status: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ClaimView {
    pub bounty_id: u64,
    pub slot: u8,
    pub recipient: String,
    pub pr_number: u64,
    pub head_sha: String,
    pub github_created: u64,
    pub claim_seq: u64,
    pub qualified_at: u64,
    pub challenge_ends_at: u64,
    pub status: String,
    pub pending_digest: Option<String>,
    pub signed: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VoucherView {
    pub bounty_id: u64,
    pub slot_index: u8,
    pub recipient: String,
    pub token: String,
    pub amount: String,
    pub nonce: u64,
    pub expiry: u64,
    pub chain_id: u64,
    pub escrow: String,
    pub criteria_hash: String,
    pub digest: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignedVoucherView {
    pub voucher: VoucherView,
    pub v: u8,
    pub r: String,
    pub s: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PendingVoucherView {
    pub voucher: VoucherView,
    pub digest: String,
    pub bounty_id: u64,
    pub slot: u8,
    pub claim_seq: u64,
    pub dispatched_at: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct EpochView {
    pub epoch_id: u64,
    pub witnesses: Vec<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ConfigView {
    pub owner: String,
    pub pending_owner: Option<String>,
    pub paused: bool,
    pub mpc_contract: String,
    pub mpc_signer: Option<String>,
    pub escrow: String,
    pub chain_id: u64,
    pub voucher_path: String,
    pub domain_id: u64,
    pub max_proof_age_sec: u64,
    pub future_skew_sec: u64,
    pub voucher_ttl_sec: u64,
    pub pending_timeout_sec: u64,
    pub next_nonce: u64,
    pub bounty_count: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VerdictView {
    pub id: String,
    pub status: String,
    pub detail: String,
}

/// Total transparency outcome: NEVER panics on user input. `ok` is true
/// only when every check passed; otherwise `errors` holds the stable
/// `CODE: detail` strings and `verdicts` shows per-criterion detail.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct DryOutcome {
    pub ok: bool,
    pub bounty_id: u64,
    pub pr_number: Option<u64>,
    pub head_sha: Option<String>,
    pub verdicts: Vec<VerdictView>,
    pub errors: Vec<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct UnrelayedVoucher {
    pub bounty_id: u64,
    pub slot: u8,
    pub digest: String,
    pub voucher: VoucherView,
    pub v: u8,
    pub r: String,
    pub s: String,
}

/// MPC callback result-as-data. Returning `Rejected` (instead of panicking)
/// lets the release commit — a panic would roll it back and wedge the slot.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum VoucherCallbackOutcome {
    Applied(Box<SignedVoucherView>),
    Rejected(String),
}

/// One tagged proof in a claim bundle: the `evidence_type` tag selects the
/// endpoint template and scopes the replay nullifier.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TaggedProofArg {
    pub evidence_type: u8,
    pub proof: ProofInput,
}

#[ext_contract(ext_mpc)]
pub trait ExtMpc {
    fn sign(&mut self, request: SignRequest) -> MpcSignature;
}

#[ext_contract(ext_self)]
pub trait ExtSelf {
    fn on_voucher_signed(&mut self, digest_hex: String) -> VoucherCallbackOutcome;
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

fn now_sec() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn log_event(event: &str, data: &str) {
    env::log_str(&format!(
        "{{\"standard\":\"omnibounty\",\"event\":\"{event}\",{data}}}"
    ));
}

fn log_rejected(bounty_id: Option<u64>, slot: Option<u8>, digest_hex: &str, reason: &str) {
    let id = bounty_id
        .map(|b| b.to_string())
        .unwrap_or_else(|| "null".to_string());
    let sl = slot
        .map(|s| s.to_string())
        .unwrap_or_else(|| "null".to_string());
    // Reasons and digests are operator-controlled or hex; strip quotes so
    // the log line stays valid JSON regardless.
    let safe_reason = reason.replace('"', "'");
    let safe_digest = digest_hex.replace('"', "'");
    log_event(
        "voucher_rejected",
        &format!(
            "\"bounty_id\":{id},\"slot\":{sl},\
             \"digest\":\"{safe_digest}\",\"reason\":\"{safe_reason}\""
        ),
    );
}

/// Checked big-endian u256 addition. `None` on overflow.
fn u256_add(a: &[u8; 32], b: &[u8; 32]) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    let mut carry: u16 = 0;
    for i in (0..32).rev() {
        let sum = a[i] as u16 + b[i] as u16 + carry;
        out[i] = sum as u8;
        carry = sum >> 8;
    }
    if carry == 0 {
        Some(out)
    } else {
        None
    }
}

fn u256_sum(slots: &[[u8; 32]]) -> Option<[u8; 32]> {
    let mut acc = [0u8; 32];
    for s in slots {
        acc = u256_add(&acc, s)?;
    }
    Some(acc)
}

/// Remaining gas (saturating; panic-free under any test context).
fn gas_left() -> u64 {
    env::prepaid_gas()
        .as_gas()
        .saturating_sub(env::used_gas().as_gas())
}

fn voucher_view(v: &VoucherV2) -> VoucherView {
    VoucherView {
        bounty_id: v.bounty_id,
        slot_index: v.slot_index,
        recipient: to_hex_prefixed(&v.recipient),
        token: to_hex_prefixed(&v.token),
        amount: u256_to_decimal(&v.amount),
        nonce: v.nonce,
        expiry: v.expiry,
        chain_id: v.chain_id,
        escrow: to_hex_prefixed(&v.escrow),
        criteria_hash: to_hex_prefixed(&v.criteria_hash),
        digest: to_hex_prefixed(&voucher_digest(v)),
    }
}

fn signed_view(s: &SignedVoucher) -> SignedVoucherView {
    SignedVoucherView {
        voucher: voucher_view(&s.voucher),
        v: s.v,
        r: to_hex_prefixed(&s.r),
        s: to_hex_prefixed(&s.s),
    }
}

// ---------------------------------------------------------------------------
// Contract state
// ---------------------------------------------------------------------------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    pending_owner: Option<AccountId>,
    paused: bool,
    mpc_contract: AccountId,
    /// Expected MPC EVM address; finalization fails closed until set.
    mpc_signer: Option<[u8; 20]>,
    escrow: [u8; 20],
    chain_id: u64,
    voucher_path: String,
    /// MPC domain id (0 = legacy secp256k1 ECDSA domain).
    domain_id: u64,
    max_proof_age_sec: u64,
    future_skew_sec: u64,
    voucher_ttl_sec: u64,
    pending_timeout_sec: u64,
    next_nonce: u64,
    bounty_ids: Vec<u64>,
    epochs: LookupMap<u64, PinnedEpoch>,
    bounties: LookupMap<u64, BountyV3>,
    claims: LookupMap<(u64, u8), ClaimRecord>,
    /// (bounty, pr_number) -> slot: one claim per PR per bounty.
    pr_claims: LookupMap<(u64, u64), u8>,
    nullifiers: LookupSet<[u8; 32]>,
    pending: LookupMap<[u8; 32], PendingVoucher>,
    vouchers: LookupMap<(u64, u8), SignedVoucher>,
    relayed: LookupSet<[u8; 32]>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, mpc_contract: AccountId, escrow: String, chain_id: u64) -> Self {
        let escrow_addr =
            parse_address("escrow", &escrow).unwrap_or_else(|e| env::panic_str(&e.to_string()));
        Self {
            owner,
            pending_owner: None,
            paused: false,
            mpc_contract,
            mpc_signer: None,
            escrow: escrow_addr.0,
            chain_id,
            voucher_path: DEFAULT_VOUCHER_PATH.to_string(),
            domain_id: 0,
            max_proof_age_sec: DEFAULT_MAX_PROOF_AGE_SEC,
            future_skew_sec: DEFAULT_FUTURE_SKEW_SEC,
            voucher_ttl_sec: DEFAULT_VOUCHER_TTL_SEC,
            pending_timeout_sec: DEFAULT_PENDING_TIMEOUT_SEC,
            next_nonce: 0,
            bounty_ids: Vec::new(),
            epochs: LookupMap::new(b"e".to_vec()),
            bounties: LookupMap::new(b"b".to_vec()),
            claims: LookupMap::new(b"c".to_vec()),
            pr_claims: LookupMap::new(b"q".to_vec()),
            nullifiers: LookupSet::new(b"n".to_vec()),
            pending: LookupMap::new(b"p".to_vec()),
            vouchers: LookupMap::new(b"v".to_vec()),
            relayed: LookupSet::new(b"r".to_vec()),
        }
    }

    // -- Internal guards ----------------------------------------------------

    fn assert_owner(&self) {
        if env::predecessor_account_id() != self.owner {
            env::panic_str(&ClaimError::NotOwner.to_string());
        }
    }

    /// Storage-paid-by-caller: the attached deposit must cover every byte
    /// grown since `start_usage`. Callers attach a small deposit (a few
    /// hundredths of a NEAR suffice for any single call); overpayment is
    /// kept by the contract — no refund promises, no reentrancy surface.
    ///
    /// Callers MUST flush every mutated `store::LookupMap` before calling:
    /// map writes are cached and hit the trie only on flush/drop, so an
    /// unflushed usage delta reads 0 and the check passes vacuously.
    /// (`store::LookupSet` is write-through and needs no flush.)
    /// `root_growth_bytes` covers state-struct growth (e.g. `bounty_ids`
    /// pushes), which serializes only at method return and is likewise
    /// invisible to usage reads; pass 0 when the struct cannot grow.
    /// Failure aborts the receipt (all callers panic on `Err`), so
    /// early-flushed writes always roll back.
    ///
    /// Exempted by design: owner-only transitions (`set_mpc_signer`,
    /// `set_mpc_contract`, `transfer_ownership`) stay non-payable. Only
    /// the owner can invoke them, so no griefing vector exists, and each
    /// moves at most 68 bytes; billing the owner for their own contract's
    /// bytes adds interface churn for no security gain. Bounds are pinned
    /// by the `storage_owner_*` unit tests; fixed-size and shrinking
    /// methods need no accounting at all.
    fn assert_storage_covered(
        &self,
        start_usage: u64,
        root_growth_bytes: u64,
    ) -> Result<(), ClaimError> {
        let grown = env::storage_usage().saturating_sub(start_usage);
        let total = grown.saturating_add(root_growth_bytes);
        let required = env::storage_byte_cost().saturating_mul(total as u128);
        if env::attached_deposit() < required {
            return Err(ClaimError::StorageDepositInsufficient);
        }
        Ok(())
    }

    fn assert_gas(&self, min: Gas) {
        if gas_left() < min.as_gas() {
            env::panic_str(&ClaimError::InvalidConfig("insufficient gas attached").to_string());
        }
    }

    fn bounty_view(&self, b: &BountyV3) -> BountyView {
        let expired = b.deadline != 0 && now_sec() > b.deadline;
        let status = if expired {
            "expired"
        } else if b.funded {
            "funded"
        } else {
            "open"
        };
        BountyView {
            id: b.id,
            sponsor: b.sponsor.to_string(),
            token: to_hex_prefixed(&b.token),
            criteria_hash: to_hex_prefixed(&b.criteria_hash),
            slots: b.slots.iter().map(u256_to_decimal).collect(),
            slots_filled: b.slots_filled,
            total_amount: u256_to_decimal(&b.total_amount),
            funded: b.funded,
            deadline: b.deadline,
            challenge_window: b.challenge_window,
            created_at: b.created_at,
            seq: b.seq,
            status: status.to_string(),
        }
    }

    fn claim_view(&self, bounty: &BountyV3, c: &ClaimRecord) -> ClaimView {
        let status = if c.status == CLAIM_FINALIZED {
            "finalized"
        } else {
            "challengeable"
        };
        ClaimView {
            bounty_id: c.bounty_id,
            slot: c.slot,
            recipient: to_hex_prefixed(&c.recipient),
            pr_number: c.pr_number,
            head_sha: to_hex_prefixed(&c.head_sha),
            github_created: c.github_created,
            claim_seq: c.claim_seq,
            qualified_at: c.qualified_at,
            challenge_ends_at: c.qualified_at.saturating_add(bounty.challenge_window),
            status: status.to_string(),
            pending_digest: c.pending_digest.as_ref().map(|b| to_hex_prefixed(b)),
            signed: self.vouchers.contains_key(&(c.bounty_id, c.slot)),
        }
    }

    // -- Admin ---------------------------------------------------------------

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    #[handle_result]
    pub fn set_mpc_signer(&mut self, signer: String) -> Result<(), String> {
        self.assert_owner();
        let addr = parse_address("mpc_signer", &signer)?;
        self.mpc_signer = Some(addr.0);
        Ok(())
    }

    #[handle_result]
    pub fn set_escrow(&mut self, escrow: String) -> Result<(), String> {
        self.assert_owner();
        let addr = parse_address("escrow", &escrow)?;
        self.escrow = addr.0;
        Ok(())
    }

    pub fn set_chain_id(&mut self, chain_id: u64) {
        self.assert_owner();
        self.chain_id = chain_id;
    }

    pub fn set_mpc_contract(&mut self, mpc_contract: AccountId) {
        self.assert_owner();
        self.mpc_contract = mpc_contract;
    }

    pub fn set_freshness(
        &mut self,
        max_proof_age_sec: u64,
        future_skew_sec: u64,
        voucher_ttl_sec: u64,
    ) {
        self.assert_owner();
        self.max_proof_age_sec = max_proof_age_sec;
        self.future_skew_sec = future_skew_sec;
        self.voucher_ttl_sec = voucher_ttl_sec;
    }

    pub fn set_pending_timeout(&mut self, pending_timeout_sec: u64) {
        self.assert_owner();
        self.pending_timeout_sec = pending_timeout_sec;
    }

    /// 2-step ownership transfer: propose a successor; they accept.
    pub fn transfer_ownership(&mut self, new_owner: AccountId) {
        self.assert_owner();
        self.pending_owner = Some(new_owner.clone());
        log_event(
            "ownership_transfer_proposed",
            &format!("\"new_owner\":\"{new_owner}\""),
        );
    }

    pub fn accept_ownership(&mut self) {
        match &self.pending_owner {
            Some(p) if *p == env::predecessor_account_id() => {}
            _ => env::panic_str(&ClaimError::NoTransferPending.to_string()),
        }
        let new_owner = self.pending_owner.take().expect("checked above");
        self.owner = new_owner.clone();
        log_event(
            "ownership_transferred",
            &format!("\"new_owner\":\"{new_owner}\""),
        );
    }

    pub fn cancel_ownership_transfer(&mut self) {
        self.assert_owner();
        self.pending_owner = None;
    }

    #[handle_result]
    #[payable]
    pub fn upsert_epoch(&mut self, epoch_id: u64, witnesses: Vec<String>) -> Result<(), String> {
        self.assert_owner();
        let start = env::storage_usage();
        if witnesses.is_empty() || witnesses.len() > reclaim::MAX_SIGNATURES {
            return Err(ClaimError::InvalidLength("witnesses").into());
        }
        let mut addrs: Vec<[u8; 20]> = Vec::with_capacity(witnesses.len());
        for w in &witnesses {
            let addr = parse_address("witness", w)?;
            if addrs.contains(&addr.0) {
                return Err(ClaimError::InvalidConfig("duplicate witness").into());
            }
            addrs.push(addr.0);
        }
        self.epochs
            .insert(epoch_id, PinnedEpoch { witnesses: addrs });
        self.epochs.flush();
        self.assert_storage_covered(start, 0)?;
        Ok(())
    }

    pub fn remove_epoch(&mut self, epoch_id: u64) {
        self.assert_owner();
        self.epochs.remove(&epoch_id);
    }

    // -- Bounties ------------------------------------------------------------

    /// Create a task-first bounty: validate the criteria document, commit to
    /// its hash, and copy the slot amounts, deadline, and challenge window
    /// into storage. The full document is NOT stored (events carry the hash;
    /// claimants re-supply the document on every claim).
    #[handle_result]
    #[payable]
    pub fn create_bounty(
        &mut self,
        bounty_id: u64,
        token: String,
        criteria_json: String,
    ) -> Result<BountyView, String> {
        if self.paused {
            return Err(ClaimError::Paused.into());
        }
        if self.bounties.contains_key(&bounty_id) {
            return Err(ClaimError::BountyExists(bounty_id).into());
        }
        if self.bounty_ids.len() >= MAX_BOUNTIES {
            return Err(ClaimError::InvalidConfig("bounty cap reached").into());
        }
        let start = env::storage_usage();
        let token_addr = parse_address("token", &token)?;
        // Strict validation first (dup keys, unknown fields, nulls, bounds),
        // then the commitment. Both must succeed before anything is stored.
        let doc = strict_parse(&criteria_json)?;
        let validated = validate_criteria(&doc)?;
        let hash = criteria_hash(&criteria_json)?;
        // Defense in depth: validation already enforces these, but the
        // accounting below must not depend on that alone.
        if validated.slots.is_empty() || validated.slots.len() > MAX_SLOTS {
            return Err(ClaimError::InvalidConfig("bad slot count").into());
        }
        for amount in &validated.slots {
            if u256_is_zero(amount) {
                return Err(ClaimError::ZeroAmount.into());
            }
        }
        let total = u256_sum(&validated.slots).ok_or(ClaimError::InvalidAmount)?;
        let bounty = BountyV3 {
            id: bounty_id,
            sponsor: env::predecessor_account_id(),
            token: token_addr.0,
            criteria_hash: hash,
            slots: validated.slots,
            slots_filled: 0,
            total_amount: total,
            funded: false,
            deadline: validated.deadline,
            challenge_window: validated.challenge_window,
            created_at: now_sec(),
            seq: 0,
        };
        self.bounties.insert(bounty_id, bounty.clone());
        self.bounty_ids.push(bounty_id);
        self.bounties.flush();
        // Root growth: exactly one `Vec<u64>` push = 8 bytes (pinned by
        // `storage_bounty_ids_push_is_eight_bytes`).
        self.assert_storage_covered(start, 8)?;
        log_event(
            "bounty_created",
            &format!(
                "\"bounty_id\":{bounty_id},\
                 \"criteria_hash\":\"{}\",\"slots\":{},\
                 \"total_amount\":\"{}\",\"deadline\":{}",
                to_hex_prefixed(&hash),
                bounty.slots.len(),
                u256_to_decimal(&total),
                bounty.deadline,
            ),
        );
        Ok(self.bounty_view(&bounty))
    }

    /// Sponsor acknowledges the escrow-side funding out of band (the NEAR
    /// contract cannot observe Base). Only the sponsor, only once, and only
    /// meaningful when the escrow actually holds `total_amount` for this
    /// bounty id — the relayer/frontend must verify that before / while
    /// calling. No storage growth: fixed-size root update only.
    #[handle_result]
    pub fn mark_funded(&mut self, bounty_id: u64) -> Result<BountyView, String> {
        if self.paused {
            return Err(ClaimError::Paused.into());
        }
        let mut bounty = self
            .bounties
            .get(&bounty_id)
            .cloned()
            .ok_or(ClaimError::BountyNotFound(bounty_id))?;
        if env::predecessor_account_id() != bounty.sponsor {
            return Err(ClaimError::NotSponsor.into());
        }
        if bounty.funded {
            return Err(ClaimError::InvalidConfig("already funded").into());
        }
        bounty.funded = true;
        self.bounties.insert(bounty_id, bounty.clone());
        log_event("bounty_funded", &format!("\"bounty_id\":{bounty_id}"));
        Ok(self.bounty_view(&bounty))
    }

    // -- Claims --------------------------------------------------------------

    /// Shared bundle pipeline used by `qualify_claim` (which then mutates)
    /// and `dry_qualify` (which never mutates). For every tagged proof: tag
    /// validity, identifier binding + witness signatures against the pinned
    /// epoch set, freshness against BOTH the global and the criteria windows,
    /// recipient binding, replay precheck, and params/context parsing. Reads
    /// state but writes nothing; nullifier keys are RETURNED for the caller
    /// to consume only after full acceptance.
    fn verify_bundle<'a>(
        &self,
        bounty_id: u64,
        criteria: &ValidatedCriteria,
        recipient: &[u8; 20],
        proofs: &[TaggedProofArg],
        now: u64,
        arena: &'a mut Vec<(Value, Value)>,
    ) -> Result<(Vec<EvaluatedProof<'a>>, Vec<[u8; 32]>), ClaimError> {
        if proofs.is_empty() {
            return Err(ClaimError::EmptyClaim);
        }
        if proofs.len() > rules::MAX_CLAIM_PROOFS {
            return Err(ClaimError::TooManyProofs);
        }
        // Total-signature cap BEFORE any cryptography: pure length reads,
        // no parsing, no recovery, no nullifier consumption. Shared by
        // qualify_claim and dry_qualify (both route through here).
        let total_sigs: usize = proofs
            .iter()
            .map(|t| t.proof.signed_claim.signatures.len())
            .sum();
        if total_sigs > reclaim::MAX_TOTAL_SIGNATURES {
            return Err(ClaimError::TooManySignatures);
        }
        let total_bytes: usize = proofs
            .iter()
            .map(|t| t.proof.claim_info.parameters.len() + t.proof.claim_info.context.len())
            .sum();
        if total_bytes > reclaim::MAX_TOTAL_EVIDENCE_BYTES {
            return Err(ClaimError::ProofTooLarge("bundle"));
        }
        struct Staged {
            kind: EvidenceType,
            owner: [u8; 20],
            identifier: [u8; 32],
            // None for attribute/context proofs (identity, base legs):
            // their identifiers are stable across claims by design
            // (one identity, one shared base run), so consuming a
            // nullifier would wrongly single-use them. Substitution is
            // still blocked by owner binding + join equality.
            nullifier: Option<[u8; 32]>,
        }
        let mut staged: Vec<Staged> = Vec::with_capacity(proofs.len());
        // Pass 1: verify each proof; park owned JSON in the arena.
        for tagged in proofs {
            let kind = EvidenceType::from_u8(tagged.evidence_type)?;
            let proof = &tagged.proof;
            let epoch_id = proof.signed_claim.claim.epoch;
            let pinned = self
                .epochs
                .get(&epoch_id)
                .ok_or(ClaimError::UnknownEpoch(epoch_id))?;
            let vp = verify_core(proof, pinned.witnesses.as_slice())?;
            // Freshness: global window AND criteria window both apply.
            if vp.timestamp_s > now.saturating_add(self.future_skew_sec) {
                return Err(ClaimError::ProofFromFuture);
            }
            let age = now.saturating_sub(vp.timestamp_s);
            if age > self.max_proof_age_sec {
                return Err(ClaimError::ProofTooOld);
            }
            if age > criteria.evidence_max_age {
                return Err(ClaimError::ProofTooOld);
            }
            if vp.owner != *recipient {
                return Err(ClaimError::RecipientMismatch);
            }
            let key = if kind == EvidenceType::Identity || kind == EvidenceType::BaseCheck {
                None
            } else {
                let key = nullifier_key(bounty_id, recipient, tagged.evidence_type, &vp.identifier);
                if self.nullifiers.contains(&key) {
                    return Err(ClaimError::IdentifierReplay);
                }
                Some(key)
            };
            // Re-parse params (verify_core checked canonicality but returns
            // no AST; re-parsing keeps that proven module untouched).
            let params = canon::parse_capped("parameters", &proof.claim_info.parameters)?;
            if vp.context_canonical.is_empty() {
                return Err(ClaimError::TemplateMismatch("missing extractedParameters"));
            }
            let ctx = canon::parse_capped("context", &vp.context_canonical)?;
            if ctx
                .get("extractedParameters")
                .and_then(Value::as_object)
                .is_none()
            {
                return Err(ClaimError::TemplateMismatch("missing extractedParameters"));
            }
            arena.push((params, ctx));
            staged.push(Staged {
                kind,
                owner: vp.owner,
                identifier: vp.identifier,
                nullifier: key,
            });
        }
        // Pass 2: borrow the parked JSON as evaluation views.
        let mut out: Vec<EvaluatedProof<'a>> = Vec::with_capacity(staged.len());
        let mut keys: Vec<[u8; 32]> = Vec::with_capacity(staged.len());
        for (s, (params, ctx)) in staged.iter().zip(arena.iter()) {
            let extracted = ctx
                .get("extractedParameters")
                .and_then(Value::as_object)
                .ok_or(ClaimError::TemplateMismatch("missing extractedParameters"))?;
            out.push(EvaluatedProof {
                kind: s.kind,
                params,
                extracted,
                owner: s.owner,
                identifier: s.identifier,
            });
            if let Some(key) = s.nullifier {
                keys.push(key);
            }
        }
        Ok((out, keys))
    }

    /// Submit a multi-proof claim. Re-validates the supplied criteria
    /// document against the committed hash, verifies every proof, joins
    /// evidence (URL pinning + head-SHA unity), evaluates ALL criteria, and
    /// — only if every verdict PASSES — consumes the nullifiers, assigns the
    /// next open slot in order, and records the claim with its monotonic
    /// sequence number. All-or-nothing: any failure leaves state untouched
    /// (no slot taken, no nullifier burned, no sequence consumed).
    #[handle_result]
    #[payable]
    pub fn qualify_claim(
        &mut self,
        bounty_id: u64,
        criteria_json: String,
        proofs: Vec<TaggedProofArg>,
        recipient: String,
    ) -> Result<ClaimView, String> {
        self.assert_gas(QUALIFY_MIN_GAS);
        if self.paused {
            return Err(ClaimError::Paused.into());
        }
        let mut bounty = self
            .bounties
            .get(&bounty_id)
            .cloned()
            .ok_or(ClaimError::BountyNotFound(bounty_id))?;
        if !bounty.funded {
            return Err(ClaimError::BountyNotFunded(bounty_id).into());
        }
        let now = now_sec();
        if bounty.deadline != 0 && now > bounty.deadline {
            return Err(ClaimError::BountyExpired(bounty_id).into());
        }
        // Fairness gate: a claim whose challenge window cannot elapse before
        // the deadline could never finalize to a live voucher (the sponsor
        // may legitimately refund the still-unclaimed slot at the deadline).
        // Rejected here — before any crypto or nullifier consumption — with
        // a dedicated code so UIs can explain it. Subtraction form: exact
        // under all inputs (no saturation artifacts near u64::MAX); the
        // exact boundary (`==`) is allowed since finalization at precisely
        // the deadline still succeeds.
        if bounty.deadline != 0 && bounty.challenge_window > bounty.deadline.saturating_sub(now) {
            return Err(ClaimError::ChallengeWindowExceedsDeadline.into());
        }
        if (bounty.slots_filled as usize) >= bounty.slots.len() {
            return Err(ClaimError::NoOpenSlot(bounty_id).into());
        }
        let recipient_addr = parse_address("recipient", &recipient)?;
        // Criteria commitment: the supplied document must re-validate AND
        // re-hash to the stored value. Checked BEFORE expensive crypto.
        let doc = strict_parse(&criteria_json)?;
        let validated = validate_criteria(&doc)?;
        let hash = criteria_hash(&criteria_json)?;
        if hash != bounty.criteria_hash {
            return Err(ClaimError::CriteriaMismatch.into());
        }
        let recipient_hex = to_hex_prefixed(&recipient_addr.0);
        let mut arena: Vec<(Value, Value)> = Vec::new();
        let (eval_proofs, keys) = self.verify_bundle(
            bounty_id,
            &validated,
            &recipient_addr.0,
            &proofs,
            now,
            &mut arena,
        )?;
        let (joined, verdicts) =
            evaluate(&validated, bounty_id, &recipient_hex, &eval_proofs, now)?;
        // UNVERIFIED (or failed) evidence never passes: the first non-PASS
        // verdict aborts the whole claim.
        if let Some(e) = first_failure(&verdicts) {
            return Err(e.into());
        }
        if self.pr_claims.contains_key(&(bounty_id, joined.pr_number)) {
            return Err(ClaimError::DuplicatePr {
                bounty_id,
                pr_number: joined.pr_number,
            }
            .into());
        }
        // -- All checks passed: mutate once, at the end. --
        let start = env::storage_usage();
        let claim_seq = bounty.seq;
        bounty.seq = claim_seq.checked_add(1).ok_or(ClaimError::SeqOverflow)?;
        let slot = bounty.slots_filled;
        bounty.slots_filled = slot
            .checked_add(1)
            .ok_or(ClaimError::InvalidConfig("slot overflow"))?;
        for k in keys {
            self.nullifiers.insert(k);
        }
        let claim = ClaimRecord {
            bounty_id,
            slot,
            recipient: recipient_addr.0,
            pr_number: joined.pr_number,
            head_sha: joined.head_sha,
            github_created: joined.github_created,
            claim_seq,
            qualified_at: now,
            status: CLAIM_CHALLENGEABLE,
            pending_digest: None,
        };
        self.claims.insert((bounty_id, slot), claim);
        self.pr_claims.insert((bounty_id, joined.pr_number), slot);
        self.bounties.insert(bounty_id, bounty.clone());
        // Nullifiers need no flush (write-through set).
        self.claims.flush();
        self.pr_claims.flush();
        self.bounties.flush();
        self.assert_storage_covered(start, 0)?;
        // Evidence commitment (audit trail): auditors recompute this from the
        // qualify_claim arguments — see evidence_records_digest docs. No
        // voucher involvement (frozen interface untouched).
        let evidence: Vec<(u8, [u8; 32])> = eval_proofs
            .iter()
            .map(|p| (p.kind as u8, p.identifier))
            .collect();
        let evidence_digest = reclaim::evidence_records_digest(&evidence);
        log_event(
            "claim_qualified",
            &format!(
                "\"bounty_id\":{bounty_id},\"slot\":{slot},\
                 \"claim_seq\":{claim_seq},\"pr_number\":{},\
                 \"head_sha\":\"{}\",\"recipient\":\"{recipient_hex}\",\
                 \"evidence_digest\":\"{}\"",
                joined.pr_number,
                to_hex_prefixed(&joined.head_sha),
                to_hex_prefixed(&evidence_digest),
            ),
        );
        let stored = self
            .claims
            .get(&(bounty_id, slot))
            .ok_or(ClaimError::ClaimNotFound { bounty_id, slot })?;
        Ok(self.claim_view(&bounty, stored))
    }

    // -- Finalization (MPC dispatch) -------------------------------------------

    /// Internal: all finalization checks + dispatch writes. Separated from
    /// `finalize_claim` (which must return `Promise`) exactly like V2's
    /// claim/prepare split. Permissionless: anyone may finalize a matured
    /// claim; every path is safe under concurrent calls because the pending
    /// entry + voucher map decide, not the caller.
    fn prepare_finalize(
        &mut self,
        bounty_id: u64,
        slot: u8,
    ) -> Result<(VoucherV2, [u8; 32]), ClaimError> {
        let bounty = self
            .bounties
            .get(&bounty_id)
            .cloned()
            .ok_or(ClaimError::BountyNotFound(bounty_id))?;
        let mut claim = self
            .claims
            .get(&(bounty_id, slot))
            .cloned()
            .ok_or(ClaimError::ClaimNotFound { bounty_id, slot })?;
        let now = now_sec();
        // The challenge window must have fully elapsed.
        if now < claim.qualified_at.saturating_add(bounty.challenge_window) {
            return Err(ClaimError::ChallengeWindowClosed);
        }
        // A live signed voucher exists: never dispatch again. An EXPIRED
        // unrelayed voucher is instead reaped so a fresh dispatch can
        // retry the slot: double-payment is impossible because the escrow
        // slot bitmap rejects any second payout for the slot, whichever
        // voucher arrives first. The relayed hint set is deliberately
        // ignored here — it is permissionless and could otherwise be
        // abused to brick a legitimate retry.
        if let Some(signed) = self.vouchers.get(&(bounty_id, slot)) {
            if now <= signed.voucher.expiry {
                return Err(ClaimError::AlreadyFinalized { bounty_id, slot });
            }
            self.vouchers.remove(&(bounty_id, slot));
        }
        // An in-flight dispatch blocks a second one — two digests would
        // yield two independently valid vouchers for one slot. Only a
        // dispatch older than the pending timeout may be superseded, and
        // its stale entry is REMOVED so a late MPC response for it finds
        // no pending entry and Rejects instead of applying.
        if let Some(old) = claim.pending_digest {
            match self.pending.get(&old).cloned() {
                Some(p) if now < p.dispatched_at.saturating_add(self.pending_timeout_sec) => {
                    return Err(ClaimError::SlotPending { bounty_id, slot });
                }
                Some(_) => {
                    self.pending.remove(&old);
                }
                None => {
                    // Entry vanished without a callback (only possible via
                    // storage surgery): no in-flight signature can apply, so
                    // healing forward with a fresh dispatch is safe.
                }
            }
            claim.pending_digest = None;
        }
        if self.mpc_signer.is_none() {
            return Err(ClaimError::MpcNotConfigured);
        }
        let amount = bounty
            .slots
            .get(slot as usize)
            .cloned()
            .ok_or(ClaimError::InvalidSlot(slot))?;
        // Global nonce: burned on failure (a failed digest is never reused),
        // so every dispatch has a distinct digest.
        let nonce = self.next_nonce;
        self.next_nonce = nonce.checked_add(1).ok_or(ClaimError::NonceOverflow)?;
        let expiry = now.saturating_add(self.voucher_ttl_sec);
        let voucher = build_voucher(
            bounty_id,
            slot,
            &to_hex_prefixed(&claim.recipient),
            &bounty.token,
            &amount,
            nonce,
            expiry,
            self.chain_id,
            &self.escrow,
            &bounty.criteria_hash,
        )?;
        let digest = voucher_digest(&voucher);
        let start = env::storage_usage();
        // Nonce uniqueness guarantees this digest is fresh: the insert can
        // never overwrite a live entry.
        self.pending.insert(
            digest,
            PendingVoucher {
                bounty_id,
                slot,
                voucher: voucher.clone(),
                claim_seq: claim.claim_seq,
                dispatched_at: now,
            },
        );
        claim.pending_digest = Some(digest);
        claim.status = CLAIM_FINALIZED;
        self.claims.insert((bounty_id, slot), claim);
        self.pending.flush();
        self.claims.flush();
        self.assert_storage_covered(start, 0)?;
        log_event(
            "voucher_dispatched",
            &format!(
                "\"bounty_id\":{bounty_id},\"slot\":{slot},\
                 \"digest\":\"{}\",\"nonce\":{nonce}",
                to_hex_prefixed(&digest),
            ),
        );
        Ok((voucher, digest))
    }

    /// Permissionlessly dispatch the MPC signing request for a matured
    /// claim (challenge window elapsed). Retries after MPC failure are
    /// immediate; retries over a stuck dispatch wait out the pending
    /// timeout. Returns the MPC promise chain ending in `on_voucher_signed`.
    #[payable]
    pub fn finalize_claim(&mut self, bounty_id: u64, slot: u8) -> Promise {
        self.assert_gas(FINALIZE_MIN_GAS);
        if self.paused {
            env::panic_str(&ClaimError::Paused.to_string());
        }
        let (_voucher, digest) = match self.prepare_finalize(bounty_id, slot) {
            Ok(v) => v,
            Err(e) => env::panic_str(&e.to_string()),
        };
        ext_mpc::ext(self.mpc_contract.clone())
            .with_static_gas(SIGN_GAS)
            // 1 yoctoNEAR, paid from this contract's balance: `sign`
            // rejects zero-deposit calls.
            .with_attached_deposit(NearToken::from_yoctonear(mpc::SIGN_DEPOSIT_YOCTONEAR))
            .sign(SignRequest::ecdsa(
                self.voucher_path.clone(),
                &digest,
                self.domain_id,
            ))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_voucher_signed(to_hex_prefixed(&digest)),
            )
    }

    /// Release a pending dispatch WITHOUT recording a voucher: clears the
    /// pending entry and the claim's pointer so `finalize_claim` can retry.
    /// The claim keeps its slot, sequence, and qualified state; the burned
    /// nonce is never reused. Never panics.
    fn release_pending(&mut self, digest: &[u8; 32]) {
        let pending = self.pending.get(digest).cloned();
        self.pending.remove(digest);
        if let Some(p) = pending {
            if let Some(mut claim) = self.claims.get(&(p.bounty_id, p.slot)).cloned() {
                // Status stays FINALIZED (dispatched once); with no pending
                // entry and no voucher, finalize_claim re-dispatches.
                claim.pending_digest = None;
                self.claims.insert((p.bounty_id, p.slot), claim);
            }
        }
    }

    // -- MPC callback ----------------------------------------------------------

    /// Apply a parsed MPC response to its pending dispatch: strict-parse
    /// (r, s, v), self-check the recovered signer against the configured MPC
    /// address, and — only then — record the signed voucher and clear the
    /// pending state. Pure state logic (no promise reads), so unit tests
    /// drive it directly with real ECDSA signatures. Never panics.
    fn apply_mpc_signature(
        &mut self,
        digest: &[u8; 32],
        resp: &MpcSignature,
    ) -> Result<SignedVoucherView, ClaimError> {
        let p = self
            .pending
            .get(digest)
            .cloned()
            .ok_or(ClaimError::NoPendingVoucher)?;
        let sig = mpc::parse_mpc_signature(resp)?;
        let expected = self.mpc_signer.ok_or(ClaimError::MpcNotConfigured)?;
        mpc::check_mpc_signer(digest, &sig, &expected)?;
        // Verified: the configured MPC key signed exactly this digest.
        let signed = SignedVoucher {
            voucher: p.voucher.clone(),
            v: sig.v,
            r: sig.r,
            s: sig.s,
        };
        self.vouchers.insert((p.bounty_id, p.slot), signed.clone());
        self.pending.remove(digest);
        if let Some(mut claim) = self.claims.get(&(p.bounty_id, p.slot)).cloned() {
            claim.pending_digest = None;
            self.claims.insert((p.bounty_id, p.slot), claim);
        }
        let digest_str = to_hex_prefixed(digest);
        log_event(
            "voucher_signed",
            &format!(
                "\"bounty_id\":{},\"slot\":{},\"digest\":\"{digest_str}\",\
                 \"recipient\":\"{}\",\"amount\":\"{}\"",
                p.bounty_id,
                p.slot,
                to_hex_prefixed(&p.voucher.recipient),
                u256_to_decimal(&p.voucher.amount),
            ),
        );
        Ok(signed_view(&signed))
    }

    /// MPC callback. On promise failure (or any malformed response) the
    /// dispatch is released so the claim can be retried; the voucher is
    /// recorded ONLY on a verified MPC signature. The recovered signer must
    /// equal the configured MPC address.
    ///
    /// The promise result is read as RAW BYTES via `env::promise_result`
    /// and parsed manually. A typed `#[callback_result]` would let the
    /// framework JSON-deserialize the MPC response: any shape mismatch
    /// PANICS before this method runs and wedges the slot. This method
    /// itself NEVER PANICS on MPC data either: every failure is returned
    /// as `VoucherCallbackOutcome::Rejected`, so the receipt succeeds and
    /// the release COMMITS. (A panic here would roll the release back and
    /// wedge the slot — the V2 bounty #3 incident. `#[handle_result]
    /// Result<..>` is equally wrong: it panics on `Err`.) Every
    /// malformed-input path below releases the dispatch first.
    ///
    /// Stale callbacks (unknown digest: retries consume a fresh nonce, so
    /// each attempt has a distinct digest) find no pending entry and return
    /// `Rejected` WITHOUT touching any state.
    #[private]
    pub fn on_voucher_signed(&mut self, digest_hex: String) -> VoucherCallbackOutcome {
        use near_sdk::PromiseResult;

        let digest: [u8; 32] = match parse_hex("digest", &digest_hex) {
            Ok(d) => d,
            Err(e) => return VoucherCallbackOutcome::Rejected(e.to_string()),
        };
        let digest_str = to_hex_prefixed(&digest);
        // Look up the claim for observability only; the authoritative
        // pending check happens inside the apply path below.
        let pending = self.pending.get(&digest).cloned();
        let bounty_id = pending.as_ref().map(|p| p.bounty_id);
        let slot = pending.as_ref().map(|p| p.slot);
        let bytes = match env::promise_result(0) {
            PromiseResult::Successful(b) => b,
            _ => {
                self.release_pending(&digest);
                let reason = ClaimError::MpcFailed.to_string();
                log_rejected(bounty_id, slot, &digest_str, &reason);
                return VoucherCallbackOutcome::Rejected(reason);
            }
        };
        let resp: MpcSignature = match serde_json::from_slice(&bytes) {
            Ok(r) => r,
            Err(_) => {
                self.release_pending(&digest);
                let reason = ClaimError::MpcBadResponse("unparseable json").to_string();
                log_rejected(bounty_id, slot, &digest_str, &reason);
                return VoucherCallbackOutcome::Rejected(reason);
            }
        };
        match self.apply_mpc_signature(&digest, &resp) {
            Ok(v) => VoucherCallbackOutcome::Applied(Box::new(v)),
            Err(e) => {
                // No-pending-voucher is a stale callback: nothing to
                // release, and the error is already specific.
                if !matches!(e, ClaimError::NoPendingVoucher) {
                    self.release_pending(&digest);
                }
                let reason = e.to_string();
                log_rejected(bounty_id, slot, &digest_str, &reason);
                VoucherCallbackOutcome::Rejected(reason)
            }
        }
    }

    /// Permissionless relay hint. The relayer MUST treat the escrow's
    /// `usedVoucher` state as ground truth; this flag is UX only and a false
    /// hint cannot block a payout (relayer re-checks on-chain).
    #[handle_result]
    #[payable]
    pub fn mark_relayed(&mut self, digest_hex: String) -> Result<bool, String> {
        let start = env::storage_usage();
        let digest: [u8; 32] = parse_hex("digest", &digest_hex)?;
        self.relayed.insert(digest);
        // Write-through set: no flush needed.
        self.assert_storage_covered(start, 0)?;
        Ok(true)
    }

    // -- Views ---------------------------------------------------------------

    pub fn get_bounty(&self, bounty_id: u64) -> Option<BountyView> {
        let bounty = self.bounties.get(&bounty_id)?;
        Some(self.bounty_view(bounty))
    }

    pub fn list_bounties(&self, from: u64, limit: u64) -> Vec<BountyView> {
        let limit = limit.min(MAX_LIST_LIMIT) as usize;
        let from = from as usize;
        self.bounty_ids
            .iter()
            .skip(from)
            .take(limit)
            .filter_map(|id| self.bounties.get(id).map(|b| self.bounty_view(b)))
            .collect()
    }

    pub fn get_claim(&self, bounty_id: u64, slot: u8) -> Option<ClaimView> {
        let bounty = self.bounties.get(&bounty_id)?;
        let claim = self.claims.get(&(bounty_id, slot))?;
        Some(self.claim_view(bounty, claim))
    }

    /// Which slot (if any) already holds a claim for this PR on this bounty.
    pub fn get_claim_by_pr(&self, bounty_id: u64, pr_number: u64) -> Option<u8> {
        self.pr_claims.get(&(bounty_id, pr_number)).copied()
    }

    pub fn get_voucher(&self, bounty_id: u64, slot: u8) -> Option<SignedVoucherView> {
        self.vouchers.get(&(bounty_id, slot)).map(signed_view)
    }

    #[handle_result]
    pub fn get_pending(&self, digest_hex: String) -> Result<Option<PendingVoucherView>, String> {
        let digest: [u8; 32] = parse_hex("digest", &digest_hex)?;
        Ok(self.pending.get(&digest).map(|p| PendingVoucherView {
            voucher: voucher_view(&p.voucher),
            digest: to_hex_prefixed(&digest),
            bounty_id: p.bounty_id,
            slot: p.slot,
            claim_seq: p.claim_seq,
            dispatched_at: p.dispatched_at,
        }))
    }

    /// Unrelayed signed vouchers (relayer work queue). Bounded scan over the
    /// registry; the escrow's `usedVoucher` map remains ground truth.
    /// Unrelayed vouchers ordered by verified authorship time (oldest
    /// first), then bounty id, then slot: settlement priority follows
    /// GitHub authorship, not submission order. Ties are impossible to
    /// manipulate — all keys are verified or positional — and the order
    /// is fully deterministic.
    pub fn list_unrelayed(&self, limit: u64) -> Vec<UnrelayedVoucher> {
        let limit = limit.min(MAX_LIST_LIMIT) as usize;
        let mut out: Vec<(u64, u64, u8, UnrelayedVoucher)> = Vec::new();
        for id in self.bounty_ids.iter() {
            let bounty = match self.bounties.get(id) {
                Some(b) => b,
                None => continue,
            };
            for (i, _) in bounty.slots.iter().enumerate() {
                let slot = i as u8;
                let signed = match self.vouchers.get(&(*id, slot)) {
                    Some(s) => s,
                    None => continue,
                };
                let digest = voucher_digest(&signed.voucher);
                if self.relayed.contains(&digest) {
                    continue;
                }
                // Vouchers imply claims; a missing record sorts last
                // rather than vanishing (defensive: unreachable today).
                let created = self
                    .claims
                    .get(&(*id, slot))
                    .map(|c| c.github_created)
                    .unwrap_or(u64::MAX);
                out.push((
                    created,
                    *id,
                    slot,
                    UnrelayedVoucher {
                        bounty_id: *id,
                        slot,
                        digest: to_hex_prefixed(&digest),
                        voucher: voucher_view(&signed.voucher),
                        v: signed.v,
                        r: to_hex_prefixed(&signed.r),
                        s: to_hex_prefixed(&signed.s),
                    },
                ));
            }
        }
        out.sort_by_key(|entry| (entry.0, entry.1, entry.2));
        out.truncate(limit);
        out.into_iter().map(|(_, _, _, v)| v).collect()
    }

    #[handle_result]
    pub fn is_nullifier_used(&self, key_hex: String) -> Result<bool, String> {
        let key: [u8; 32] = parse_hex("nullifier", &key_hex)?;
        Ok(self.nullifiers.contains(&key))
    }

    #[handle_result]
    pub fn is_relayed(&self, digest_hex: String) -> Result<bool, String> {
        let digest: [u8; 32] = parse_hex("digest", &digest_hex)?;
        Ok(self.relayed.contains(&digest))
    }

    pub fn get_epoch(&self, epoch_id: u64) -> Option<EpochView> {
        self.epochs.get(&epoch_id).map(|e| EpochView {
            epoch_id,
            witnesses: e.witnesses.iter().map(|w| to_hex_prefixed(w)).collect(),
        })
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.to_string(),
            pending_owner: self.pending_owner.as_ref().map(|a| a.to_string()),
            paused: self.paused,
            mpc_contract: self.mpc_contract.to_string(),
            mpc_signer: self.mpc_signer.as_ref().map(|s| to_hex_prefixed(s)),
            escrow: to_hex_prefixed(&self.escrow),
            chain_id: self.chain_id,
            voucher_path: self.voucher_path.clone(),
            domain_id: self.domain_id,
            max_proof_age_sec: self.max_proof_age_sec,
            future_skew_sec: self.future_skew_sec,
            voucher_ttl_sec: self.voucher_ttl_sec,
            pending_timeout_sec: self.pending_timeout_sec,
            next_nonce: self.next_nonce,
            bounty_count: self.bounty_ids.len() as u64,
        }
    }

    // -- Transparency ----------------------------------------------------------

    /// Dry-run a claim WITHOUT mutating state: runs the exact `qualify_claim`
    /// pipeline (criteria commitment, proof verification, join, evaluation)
    /// and reports every verdict plus every stable error string. Total on
    /// user input — never panics, never writes. Bounty-level problems
    /// (paused, unfunded, expired, full) are reported alongside the
    /// per-criterion verdicts so contributors see the whole picture.
    pub fn dry_qualify(
        &self,
        bounty_id: u64,
        criteria_json: String,
        proofs: Vec<TaggedProofArg>,
        recipient: String,
    ) -> DryOutcome {
        let mut errors: Vec<String> = Vec::new();
        let bounty = match self.bounties.get(&bounty_id).cloned() {
            Some(b) => b,
            None => {
                errors.push(ClaimError::BountyNotFound(bounty_id).to_string());
                return dry_out(bounty_id, None, None, Vec::new(), errors);
            }
        };
        if self.paused {
            errors.push(ClaimError::Paused.to_string());
        }
        if !bounty.funded {
            errors.push(ClaimError::BountyNotFunded(bounty_id).to_string());
        }
        let now = now_sec();
        if bounty.deadline != 0 && now > bounty.deadline {
            errors.push(ClaimError::BountyExpired(bounty_id).to_string());
        }
        // Same fairness gate as qualify_claim (subtraction form; exact).
        if bounty.deadline != 0 && bounty.challenge_window > bounty.deadline.saturating_sub(now) {
            errors.push(ClaimError::ChallengeWindowExceedsDeadline.to_string());
        }
        if (bounty.slots_filled as usize) >= bounty.slots.len() {
            errors.push(ClaimError::NoOpenSlot(bounty_id).to_string());
        }
        self.dry_pipeline(&bounty, &criteria_json, &proofs, &recipient, now, errors)
    }

    /// Structural half of `dry_qualify`: early-exits (appending to `errors`)
    /// at the first stage that cannot proceed, since later stages would
    /// evaluate against the wrong inputs and mislead.
    fn dry_pipeline(
        &self,
        bounty: &BountyV3,
        criteria_json: &str,
        proofs: &[TaggedProofArg],
        recipient: &str,
        now: u64,
        mut errors: Vec<String>,
    ) -> DryOutcome {
        let recipient_addr = match parse_address("recipient", recipient) {
            Ok(a) => a.0,
            Err(e) => {
                errors.push(e.to_string());
                return dry_out(bounty.id, None, None, Vec::new(), errors);
            }
        };
        let validated = match strict_parse(criteria_json)
            .and_then(|doc| validate_criteria(&doc).map(|v| (v, criteria_hash(criteria_json))))
        {
            Ok((v, Ok(h))) if h == bounty.criteria_hash => v,
            Ok(_) => {
                errors.push(ClaimError::CriteriaMismatch.to_string());
                return dry_out(bounty.id, None, None, Vec::new(), errors);
            }
            Err(e) => {
                errors.push(e.to_string());
                return dry_out(bounty.id, None, None, Vec::new(), errors);
            }
        };
        let recipient_hex = to_hex_prefixed(&recipient_addr);
        let mut arena: Vec<(Value, Value)> = Vec::new();
        let eval_proofs = match self.verify_bundle(
            bounty.id,
            &validated,
            &recipient_addr,
            proofs,
            now,
            &mut arena,
        ) {
            Ok((proofs, _keys)) => proofs,
            Err(e) => {
                errors.push(e.to_string());
                return dry_out(bounty.id, None, None, Vec::new(), errors);
            }
        };
        let (joined, raw) = match evaluate(&validated, bounty.id, &recipient_hex, &eval_proofs, now)
        {
            Ok(v) => v,
            Err(e) => {
                errors.push(e.to_string());
                return dry_out(bounty.id, None, None, Vec::new(), errors);
            }
        };
        let verdicts: Vec<VerdictView> = raw
            .iter()
            .map(|v| VerdictView {
                id: v.id.clone(),
                status: match v.status {
                    Verdict::Pass => "pass",
                    Verdict::Fail => "fail",
                    Verdict::Unverified => "unverified",
                }
                .to_string(),
                detail: v.detail.clone(),
            })
            .collect();
        if let Some(e) = first_failure(&raw) {
            errors.push(e.to_string());
        }
        if self.pr_claims.contains_key(&(bounty.id, joined.pr_number)) {
            errors.push(
                ClaimError::DuplicatePr {
                    bounty_id: bounty.id,
                    pr_number: joined.pr_number,
                }
                .to_string(),
            );
        }
        dry_out(
            bounty.id,
            Some(joined.pr_number),
            Some(to_hex_prefixed(&joined.head_sha)),
            verdicts,
            errors,
        )
    }
}

fn dry_out(
    bounty_id: u64,
    pr_number: Option<u64>,
    head_sha: Option<String>,
    verdicts: Vec<VerdictView>,
    errors: Vec<String>,
) -> DryOutcome {
    let ok = errors.is_empty();
    DryOutcome {
        ok,
        bounty_id,
        pr_number,
        head_sha,
        verdicts,
        errors,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, NearToken};

    const OWNER: &str = "owner.testnet";
    const SPONSOR: &str = "sponsor.testnet";
    const MPC: &str = "mpc.testnet";
    const ESCROW: &str = "0xee5C8F3154fed8B9B2f5D820AC687fDfa8CF2C99";
    const TOKEN: &str = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const RECIPIENT: &str = "0x1111111111111111111111111111111111111111";
    const OTHER: &str = "0x2222222222222222222222222222222222222222";
    const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    const NOW_S: u64 = 1_794_421_000;
    const HEAD_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HEAD_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const HEAD_C: &str = "cccccccccccccccccccccccccccccccccccccccc";
    const HEAD_D: &str = "dddddddddddddddddddddddddddddddddddddddd";
    const HEAD_E: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    const SIMPLE: &str = include_str!("../../../testdata/v3/criteria-valid/simple-ci.json");

    fn ts() -> u64 {
        NOW_S * 1_000_000_000
    }

    fn ctx(predecessor: &str, deposit: u128, block_timestamp: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id("v3.testnet".parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .prepaid_gas(Gas::from_tgas(300))
            .block_timestamp(block_timestamp);
        testing_env!(b.build());
    }

    fn new_contract() -> Contract {
        ctx(OWNER, 0, ts());
        Contract::new(
            OWNER.parse().unwrap(),
            MPC.parse().unwrap(),
            ESCROW.to_string(),
            DEFAULT_CHAIN_ID,
        )
    }

    fn create_simple(contract: &mut Contract, id: u64) -> BountyView {
        ctx(SPONSOR, ONE_NEAR, ts());
        contract
            .create_bounty(id, TOKEN.to_string(), SIMPLE.to_string())
            .unwrap()
    }

    fn fund(contract: &mut Contract, id: u64) {
        ctx(SPONSOR, 0, ts());
        contract.mark_funded(id).unwrap();
    }

    /// Criteria surgery: same simple-ci document with replaced slots (and a
    /// matching policy), deadline, and challenge window. Serialized via
    /// serde_json (sorted keys, no dupes) so strict_parse accepts it.
    fn criteria_custom(amounts: &[&str], deadline: &str, challenge: &str) -> String {
        let mut v: Value = serde_json::from_str(SIMPLE).unwrap();
        v["slots"] = amounts
            .iter()
            .map(|a| serde_json::json!({"amount": a}))
            .collect();
        v["policy"] = Value::String(if amounts.len() == 1 {
            "single_winner".to_string()
        } else {
            "ordered_slots".to_string()
        });
        v["deadline"] = Value::String(deadline.to_string());
        v["challenge_window_sec"] = Value::String(challenge.to_string());
        serde_json::to_string(&v).unwrap()
    }

    fn pin_witness(contract: &mut Contract, epoch: u64, witnesses: &[&str]) {
        ctx(OWNER, ONE_NEAR, ts());
        contract
            .upsert_epoch(epoch, witnesses.iter().map(|s| s.to_string()).collect())
            .unwrap();
    }

    // -- Real-crypto proof builder -------------------------------------------
    // Self-signed Reclaim proofs: identifier binding, canonical params, and
    // witness ECDSA are all genuine — only the witness key is
    // test-controlled (pinned via upsert_epoch, exactly like production
    // pins the real attestor set). This exercises the FULL qualify path:
    // crypto, freshness, binding, replay, join, and rule evaluation.

    fn witness_key() -> [u8; 32] {
        [0x11; 32]
    }

    fn witness_addr_for(key: &[u8; 32]) -> [u8; 20] {
        use k256::ecdsa::SigningKey;
        let signing = SigningKey::from_bytes(key.into()).unwrap();
        let point = signing.verifying_key().to_encoded_point(false);
        let hash = near_sdk::env::keccak256(&point.as_bytes()[1..]);
        let mut a = [0u8; 20];
        a.copy_from_slice(&hash[12..]);
        a
    }

    fn witness_addr() -> [u8; 20] {
        witness_addr_for(&witness_key())
    }

    fn witness_hex() -> String {
        format!("0x{}", hex::encode(witness_addr()))
    }

    fn signed_proof(
        url: &str,
        accept: &str,
        matchers: Vec<(String, String)>,
        extracted: serde_json::Map<String, Value>,
        owner_hex: &str,
        epoch: u64,
        timestamp_s: u64,
    ) -> ProofInput {
        signed_proof_multi(
            url,
            accept,
            matchers,
            extracted,
            owner_hex,
            epoch,
            timestamp_s,
            &[witness_key()],
        )
    }

    // Test helper mirroring signed_proof's parameter list plus keys.
    #[allow(clippy::too_many_arguments)]
    fn signed_proof_multi(
        url: &str,
        accept: &str,
        matchers: Vec<(String, String)>,
        extracted: serde_json::Map<String, Value>,
        owner_hex: &str,
        epoch: u64,
        timestamp_s: u64,
        keys: &[[u8; 32]],
    ) -> ProofInput {
        use k256::ecdsa::SigningKey;
        let params_value = serde_json::json!({
            "body": "",
            "headers": {"Accept": accept, "User-Agent": "omnibounty-test/1.0"},
            "method": "GET",
            "responseMatches": matchers.into_iter().map(|(t, v)| serde_json::json!({"type": t, "value": v})).collect::<Vec<_>>(),
            "responseRedactions": [],
            "url": url,
        });
        let params_raw = canon::canonicalize(&params_value).unwrap();
        let ctx_raw = canon::canonicalize(&serde_json::json!({
            "extractedParameters": extracted,
            "providerHash": "0x1234",
        }))
        .unwrap();
        let owner = normalize::parse_address("owner", owner_hex).unwrap().0;
        let identifier = reclaim::identifier_of("http", &params_raw, &ctx_raw);
        let data = reclaim::sign_data(
            &normalize::Hex32(identifier),
            &normalize::EthAddr(owner),
            timestamp_s,
            epoch,
        );
        let hash = reclaim::eth_message_hash(&data);
        let mut signatures = Vec::with_capacity(keys.len());
        for key in keys {
            let signing = SigningKey::from_bytes(key.into()).unwrap();
            let (sig, recid) = signing.sign_prehash_recoverable(&hash).unwrap();
            let r: [u8; 32] = sig.r().to_bytes().into();
            let s: [u8; 32] = sig.s().to_bytes().into();
            let mut sig65 = [0u8; 65];
            sig65[..32].copy_from_slice(&r);
            sig65[32..64].copy_from_slice(&s);
            sig65[64] = 27 + recid.to_byte();
            signatures.push(format!("0x{}", hex::encode(sig65)));
        }
        ProofInput {
            claim_info: reclaim::ClaimInfoInput {
                provider: "http".to_string(),
                parameters: params_raw,
                context: ctx_raw,
            },
            signed_claim: reclaim::SignedClaimInput {
                claim: reclaim::ClaimDataInput {
                    identifier: format!("0x{}", hex::encode(identifier)),
                    owner: owner_hex.to_string(),
                    epoch,
                    timestamp_s,
                },
                signatures,
            },
        }
    }

    /// Full passing bundle for a simple-ci bounty: PR + check-run proofs
    /// with the exact mandated matcher sets (computed, not hardcoded) and
    /// coherent extracted values.
    fn passing_bundle(
        bounty_id: u64,
        criteria_json: &str,
        recipient_hex: &str,
        pr: u64,
        head: &str,
    ) -> Vec<TaggedProofArg> {
        passing_bundle_at(bounty_id, criteria_json, recipient_hex, pr, head, NOW_S)
    }

    fn passing_bundle_at(
        bounty_id: u64,
        criteria_json: &str,
        recipient_hex: &str,
        pr: u64,
        head: &str,
        timestamp_s: u64,
    ) -> Vec<TaggedProofArg> {
        passing_bundle_full(
            bounty_id,
            criteria_json,
            recipient_hex,
            pr,
            head,
            timestamp_s,
            "acdlite",
            "10001",
            "2026-10-26T19:00:00Z",
        )
    }

    /// Full passing bundle with caller-chosen authorship triple. Identity
    /// and PR proofs always agree (see the mismatch tests for the
    /// negative controls).
    #[allow(clippy::too_many_arguments)]
    fn passing_bundle_full(
        bounty_id: u64,
        criteria_json: &str,
        recipient_hex: &str,
        pr: u64,
        head: &str,
        timestamp_s: u64,
        author: &str,
        author_id: &str,
        pr_created: &str,
    ) -> Vec<TaggedProofArg> {
        let doc = criteria::strict_parse(criteria_json).unwrap();
        let vc = criteria::validate_criteria(&doc).unwrap();
        let pr_matchers =
            rules::mandated_matchers(EvidenceType::Pr, &vc, bounty_id, recipient_hex, 0);
        let check_matchers =
            rules::mandated_matchers(EvidenceType::CheckRun, &vc, bounty_id, recipient_hex, 0);
        let id_matchers =
            rules::mandated_matchers(EvidenceType::Identity, &vc, bounty_id, recipient_hex, 0);
        let mut pr_ex = serde_json::json!({
            "author": author,
            "author_id": author_id,
            "head_sha": head,
            "merged": "true",
            "repo": "react/react",
            "number": pr.to_string(),
            "pr_created": pr_created,
        })
        .as_object()
        .unwrap()
        .clone();
        // Base-pinned criteria demand the base_sha extraction too.
        if let Some(base) = vc.base_commit {
            pr_ex.insert("base_sha".to_string(), Value::String(hex::encode(base)));
        }
        let check_ex = serde_json::json!({
            "run_name": "cleanup",
            "head_sha": head,
            "status": "completed",
            "conclusion": "success",
            "completed_at": "2026-10-26T20:17:50Z",
            "app": "github-actions",
        })
        .as_object()
        .unwrap()
        .clone();
        vec![
            TaggedProofArg {
                evidence_type: 1,
                proof: signed_proof(
                    &format!("https://api.github.com/repos/react/react/pulls/{pr}"),
                    "application/vnd.github+json",
                    pr_matchers,
                    pr_ex,
                    recipient_hex,
                    1,
                    timestamp_s,
                ),
            },
            TaggedProofArg {
                evidence_type: 2,
                proof: signed_proof(
                    "https://api.github.com/repos/react/react/check-runs/128113730680",
                    "application/vnd.github+json",
                    check_matchers,
                    check_ex,
                    recipient_hex,
                    1,
                    timestamp_s,
                ),
            },
            TaggedProofArg {
                evidence_type: 7,
                proof: signed_proof(
                    "https://api.github.com/user",
                    "application/vnd.github+json",
                    id_matchers,
                    serde_json::json!({
                        "id_login": author,
                        "id_num": author_id,
                    })
                    .as_object()
                    .unwrap()
                    .clone(),
                    recipient_hex,
                    1,
                    timestamp_s,
                ),
            },
        ]
    }

    /// Identity proof with caller-chosen owner/timestamp/login/id, for
    /// mismatch/expiry/substitution cases (the passing builders pin the
    /// matching values).
    fn identity_tagged(
        owner_hex: &str,
        timestamp_s: u64,
        login: &str,
        id_num: &str,
    ) -> TaggedProofArg {
        let doc = criteria::strict_parse(SIMPLE).unwrap();
        let vc = criteria::validate_criteria(&doc).unwrap();
        TaggedProofArg {
            evidence_type: 7,
            proof: signed_proof(
                "https://api.github.com/user",
                "application/vnd.github+json",
                rules::mandated_matchers(EvidenceType::Identity, &vc, 7, owner_hex, 0),
                serde_json::json!({"id_login": login, "id_num": id_num})
                    .as_object()
                    .unwrap()
                    .clone(),
                owner_hex,
                1,
                timestamp_s,
            ),
        }
    }

    /// Base-anchored check-run proof for fail-to-pass tests.
    fn basecheck_tagged(head_hex: &str, conclusion: &str) -> TaggedProofArg {
        let doc = criteria::strict_parse(SIMPLE).unwrap();
        let vc = criteria::validate_criteria(&doc).unwrap();
        TaggedProofArg {
            evidence_type: 8,
            proof: signed_proof(
                "https://api.github.com/repos/react/react/check-runs/424242",
                "application/vnd.github+json",
                rules::mandated_matchers(EvidenceType::BaseCheck, &vc, 7, RECIPIENT, 0),
                serde_json::json!({
                    "run_name": "cleanup",
                    "head_sha": head_hex,
                    "status": "completed",
                    "conclusion": conclusion,
                    "completed_at": "2026-01-02T00:00:00Z",
                    "app": "github-actions",
                })
                .as_object()
                .unwrap()
                .clone(),
                RECIPIENT,
                1,
                NOW_S,
            ),
        }
    }

    fn qualify(
        contract: &mut Contract,
        id: u64,
        criteria_json: &str,
        proofs: Vec<TaggedProofArg>,
        recipient: &str,
    ) -> Result<ClaimView, String> {
        qualify_at(contract, id, criteria_json, proofs, recipient, ts())
    }

    fn qualify_at(
        contract: &mut Contract,
        id: u64,
        criteria_json: &str,
        proofs: Vec<TaggedProofArg>,
        recipient: &str,
        block_timestamp: u64,
    ) -> Result<ClaimView, String> {
        ctx("caller.testnet", ONE_NEAR, block_timestamp);
        contract.qualify_claim(id, criteria_json.to_string(), proofs, recipient.to_string())
    }

    // -- Bounty creation ------------------------------------------------------

    #[test]
    fn create_commits_criteria_and_copies_slots() {
        let mut c = new_contract();
        let v = create_simple(&mut c, 7);
        assert_eq!(v.id, 7);
        assert_eq!(v.sponsor, SPONSOR);
        assert_eq!(v.token, "0x036cbd53842c5426634e7929541ec2318f3dcf7e");
        assert_eq!(v.slots, vec!["1000000".to_string()]);
        assert_eq!(v.total_amount, "1000000");
        assert!(!v.funded);
        assert_eq!(v.status, "open");
        assert_eq!(v.slots_filled, 0);
        assert_eq!(v.seq, 0);
        let hash = criteria::criteria_hash(SIMPLE).unwrap();
        assert_eq!(v.criteria_hash, to_hex_prefixed(&hash));
        // Registry + views agree.
        assert_eq!(c.list_bounties(0, 10).len(), 1);
        assert_eq!(c.get_bounty(7).unwrap().total_amount, "1000000");
        assert!(c.get_bounty(8).is_none());
    }

    #[test]
    fn create_rejects_duplicates_bad_input_and_paused() {
        let mut c = new_contract();
        create_simple(&mut c, 7);
        ctx(SPONSOR, ONE_NEAR, ts());
        assert_eq!(
            c.create_bounty(7, TOKEN.to_string(), SIMPLE.to_string())
                .unwrap_err(),
            ClaimError::BountyExists(7).to_string()
        );
        assert!(c
            .create_bounty(8, "not-an-address".to_string(), SIMPLE.to_string())
            .unwrap_err()
            .contains("token"));
        let unknown_field =
            include_str!("../../../testdata/v3/criteria-invalid/unknown-field.json");
        assert!(c
            .create_bounty(8, TOKEN.to_string(), unknown_field.to_string())
            .unwrap_err()
            .starts_with("INVALID_CRITERIA"));
        // No partial state: failed creates store nothing.
        assert!(c.get_bounty(8).is_none());
        assert_eq!(c.get_config().bounty_count, 1);
        // Paused blocks creation.
        ctx(OWNER, 0, ts());
        c.set_paused(true);
        ctx(SPONSOR, ONE_NEAR, ts());
        assert_eq!(
            c.create_bounty(9, TOKEN.to_string(), SIMPLE.to_string())
                .unwrap_err(),
            ClaimError::Paused.to_string()
        );
    }

    // NOTE: storage-deposit enforcement (assert_storage_covered) is covered
    // in tests/xsuite.rs: the unit-test mock never updates storage_usage, so
    // the grown-bytes term is always 0 there and the error path is
    // unreachable. (A mock test asserting 0-deposit success would LIE about
    // production behavior, so none exists.)

    #[test]
    fn slot_bounds_and_total_overflow() {
        let mut c = new_contract();
        // 17 slots: criteria validation rejects first.
        let seventeen = (0..17).map(|_| "1").collect::<Vec<_>>();
        ctx(SPONSOR, ONE_NEAR, ts());
        assert!(c
            .create_bounty(1, TOKEN.to_string(), criteria_custom(&seventeen, "0", "0"))
            .unwrap_err()
            .starts_with("INVALID_CRITERIA"));
        // 16 slots of 1 wei: boundary OK, total 16.
        let sixteen = (0..16).map(|_| "1").collect::<Vec<_>>();
        let v = c
            .create_bounty(2, TOKEN.to_string(), criteria_custom(&sixteen, "0", "0"))
            .unwrap();
        assert_eq!(v.total_amount, "16");
        // 2 x (2^256 - 1): checked sum overflows.
        let max = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
        assert_eq!(
            c.create_bounty(3, TOKEN.to_string(), criteria_custom(&[max, max], "0", "0"))
                .unwrap_err(),
            ClaimError::InvalidAmount.to_string()
        );
        // Zero slot rejected by validation.
        assert!(c
            .create_bounty(4, TOKEN.to_string(), criteria_custom(&["0"], "0", "0"))
            .unwrap_err()
            .starts_with("INVALID_CRITERIA"));
        assert!(c.get_bounty(1).is_none());
        assert!(c.get_bounty(3).is_none());
    }

    // -- Funding, admin, epochs -------------------------------------------------

    #[test]
    fn funding_is_sponsor_only_and_once() {
        let mut c = new_contract();
        create_simple(&mut c, 7);
        // Stranger cannot mark funded.
        ctx("mallory.testnet", 0, ts());
        assert_eq!(
            c.mark_funded(7).unwrap_err(),
            ClaimError::NotSponsor.to_string()
        );
        assert_eq!(
            c.mark_funded(404).unwrap_err(),
            ClaimError::BountyNotFound(404).to_string()
        );
        fund(&mut c, 7);
        assert!(c.get_bounty(7).unwrap().funded);
        assert_eq!(c.get_bounty(7).unwrap().status, "funded");
        // Second funding rejected.
        ctx(SPONSOR, 0, ts());
        assert!(c.mark_funded(7).unwrap_err().starts_with("INVALID_CONFIG"));
    }

    #[test]
    fn ownership_transfer_is_two_step() {
        let mut c = new_contract();
        ctx(OWNER, 0, ts());
        c.transfer_ownership("next.testnet".parse().unwrap());
        assert_eq!(
            c.get_config().pending_owner,
            Some("next.testnet".to_string())
        );
        // Owner still owner until accept.
        c.set_paused(true);
        assert!(c.get_config().paused);
        // Successor accepts. (Wrong-account acceptance panics — covered in
        // xsuite, since env::panic_str aborts unit-test binaries.)
        ctx("next.testnet", 0, ts());
        c.accept_ownership();
        assert_eq!(c.get_config().owner, "next.testnet");
        assert!(c.get_config().pending_owner.is_none());
    }

    #[test]
    fn admin_guards_and_epoch_registry() {
        let mut c = new_contract();
        // (Non-owner admin panics — covered in xsuite, since env::panic_str
        // aborts unit-test binaries.)
        pin_witness(&mut c, 1, &[&witness_hex()]);
        let e = c.get_epoch(1).unwrap();
        assert_eq!(e.witnesses, vec![witness_hex()]);
        // Duplicate / empty / oversized sets rejected.
        ctx(OWNER, ONE_NEAR, ts());
        assert!(c
            .upsert_epoch(2, vec![witness_hex(), witness_hex()])
            .unwrap_err()
            .starts_with("INVALID_CONFIG"));
        assert!(c
            .upsert_epoch(2, vec![])
            .unwrap_err()
            .starts_with("INVALID_LENGTH"));
        let many = (0..17).map(|_| witness_hex()).collect::<Vec<_>>();
        assert!(c
            .upsert_epoch(2, many)
            .unwrap_err()
            .starts_with("INVALID_LENGTH"));
        assert!(c.get_epoch(2).is_none());
        c.remove_epoch(1);
        assert!(c.get_epoch(1).is_none());
        // Config view reflects admin state.
        ctx(OWNER, 0, ts());
        c.set_mpc_signer(OTHER.to_string()).unwrap();
        c.set_chain_id(1);
        let cfg = c.get_config();
        assert_eq!(cfg.mpc_signer, Some(OTHER.to_lowercase()));
        assert_eq!(cfg.chain_id, 1);
        assert_eq!(cfg.pending_timeout_sec, DEFAULT_PENDING_TIMEOUT_SEC);
    }

    // -- Qualification: structural failures (no crypto needed) -------------------

    fn bare_proof(provider: &str, epoch: u64) -> ProofInput {
        ProofInput {
            claim_info: reclaim::ClaimInfoInput {
                provider: provider.to_string(),
                parameters: "{}".to_string(),
                context: "{}".to_string(),
            },
            signed_claim: reclaim::SignedClaimInput {
                claim: reclaim::ClaimDataInput {
                    identifier: "0x00".to_string(),
                    owner: RECIPIENT.to_string(),
                    epoch,
                    timestamp_s: NOW_S,
                },
                signatures: vec!["0x00".to_string()],
            },
        }
    }

    #[test]
    fn qualify_structural_gates() {
        let mut c = new_contract();
        assert_eq!(
            qualify(&mut c, 404, SIMPLE, vec![], RECIPIENT).unwrap_err(),
            ClaimError::BountyNotFound(404).to_string()
        );
        create_simple(&mut c, 7);
        // Unfunded.
        assert_eq!(
            qualify(&mut c, 7, SIMPLE, vec![], RECIPIENT).unwrap_err(),
            ClaimError::BountyNotFunded(7).to_string()
        );
        fund(&mut c, 7);
        // Bad recipient hex.
        assert!(qualify(&mut c, 7, SIMPLE, vec![], "0xZZZ")
            .unwrap_err()
            .starts_with("INVALID_"));
        // Criteria mismatch (valid document, different hash).
        let other = criteria_custom(&["1000001"], "0", "0");
        assert_eq!(
            qualify(&mut c, 7, &other, vec![], RECIPIENT).unwrap_err(),
            ClaimError::CriteriaMismatch.to_string()
        );
        // Malformed criteria.
        assert!(qualify(&mut c, 7, "{not json", vec![], RECIPIENT)
            .unwrap_err()
            .starts_with("INVALID_CRITERIA"));
        // Empty / oversized bundles.
        assert_eq!(
            qualify(&mut c, 7, SIMPLE, vec![], RECIPIENT).unwrap_err(),
            ClaimError::EmptyClaim.to_string()
        );
        let many = (0..41)
            .map(|_| TaggedProofArg {
                evidence_type: 1,
                proof: bare_proof("http", 1),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            qualify(&mut c, 7, SIMPLE, many, RECIPIENT).unwrap_err(),
            ClaimError::TooManyProofs.to_string()
        );
        // Unknown tag, unknown epoch, bad provider — in pipeline order.
        let one = |t: u8, p: ProofInput| {
            vec![TaggedProofArg {
                evidence_type: t,
                proof: p,
            }]
        };
        assert_eq!(
            qualify(&mut c, 7, SIMPLE, one(99, bare_proof("http", 1)), RECIPIENT).unwrap_err(),
            ClaimError::InvalidEvidenceType(99).to_string()
        );
        assert_eq!(
            qualify(
                &mut c,
                7,
                SIMPLE,
                one(1, bare_proof("http", 999)),
                RECIPIENT
            )
            .unwrap_err(),
            ClaimError::UnknownEpoch(999).to_string()
        );
        pin_witness(&mut c, 1, &[&witness_hex()]);
        assert_eq!(
            qualify(&mut c, 7, SIMPLE, one(1, bare_proof("ftp", 1)), RECIPIENT).unwrap_err(),
            ClaimError::InvalidProvider.to_string()
        );
        // Failed claims consume nothing.
        let b = c.get_bounty(7).unwrap();
        assert_eq!(b.slots_filled, 0);
        assert_eq!(b.seq, 0);
    }

    // -- Qualification: verified crypto paths ------------------------------------

    #[test]
    fn qualify_success_consumes_slot_seq_and_nullifiers() {
        let mut c = new_contract();
        // Two slots so the replay below reaches the nullifier gate instead
        // of NoOpenSlot (a full single-slot bounty short-circuits first).
        let two = criteria_custom(&["600000", "400000"], "0", "0");
        ctx(SPONSOR, ONE_NEAR, ts());
        c.create_bounty(7, TOKEN.to_string(), two.clone()).unwrap();
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        let bundle = passing_bundle(7, &two, RECIPIENT, 38132, HEAD_A);
        let v = qualify(&mut c, 7, &two, bundle, RECIPIENT).unwrap();
        assert_eq!(v.slot, 0);
        assert_eq!(v.claim_seq, 0);
        assert_eq!(v.pr_number, 38132);
        assert_eq!(v.head_sha, format!("0x{HEAD_A}"));
        assert_eq!(v.recipient, RECIPIENT.to_lowercase());
        assert_eq!(v.status, "challengeable");
        assert!(!v.signed);
        // Nullifiers consumed (replay the SAME bundle → IdentifierReplay).
        let again = passing_bundle(7, &two, RECIPIENT, 38132, HEAD_A);
        assert_eq!(
            qualify(&mut c, 7, &two, again, RECIPIENT).unwrap_err(),
            ClaimError::IdentifierReplay.to_string()
        );
        // Slot + sequence advanced; failed replay consumed nothing further.
        let b = c.get_bounty(7).unwrap();
        assert_eq!((b.slots_filled, b.seq), (1, 1));
        assert_eq!(c.get_claim_by_pr(7, 38132), Some(0));
    }

    #[test]
    fn qualify_rejects_wrong_binding_stale_and_future_proofs() {
        let mut c = new_contract();
        create_simple(&mut c, 7);
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        // Owner/proof says RECIPIENT but claim names OTHER.
        let bundle = passing_bundle(7, SIMPLE, RECIPIENT, 38132, HEAD_A);
        assert_eq!(
            qualify(&mut c, 7, SIMPLE, bundle, OTHER).unwrap_err(),
            ClaimError::RecipientMismatch.to_string()
        );
        // Stale proof (older than the criteria evidence window).
        let stale = passing_bundle(7, SIMPLE, RECIPIENT, 1, HEAD_A)
            .into_iter()
            .map(|mut t| {
                t.proof.signed_claim.claim.timestamp_s = NOW_S - 700_000;
                t
            })
            .collect::<Vec<_>>();
        // NOTE: retimestamping breaks the signature binding — recovery
        // over the tampered sign-data yields an address outside the pinned
        // set. Genuine freshness violations (properly-signed stale proofs)
        // are covered below.
        assert_eq!(
            qualify(&mut c, 7, SIMPLE, stale, RECIPIENT).unwrap_err(),
            ClaimError::UnknownWitness.to_string()
        );
        assert_eq!(c.get_bounty(7).unwrap().slots_filled, 0);
    }

    #[test]
    fn qualify_enforces_freshness_windows() {
        let mut c = new_contract();
        create_simple(&mut c, 7);
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        // Properly-signed but stale proof: rebuild the bundle at an old
        // timestamp (signature covers the old timestamp, so crypto passes
        // and the freshness gate is what fires).
        let doc = criteria::strict_parse(SIMPLE).unwrap();
        let vc = criteria::validate_criteria(&doc).unwrap();
        let mk = |ts: u64| {
            let prm = rules::mandated_matchers(EvidenceType::Pr, &vc, 7, RECIPIENT, 0);
            vec![TaggedProofArg {
                evidence_type: 1,
                proof: signed_proof(
                    "https://api.github.com/repos/react/react/pulls/9",
                    "application/vnd.github+json",
                    prm,
                    serde_json::json!({"author": "a", "head_sha": HEAD_A})
                        .as_object()
                        .unwrap()
                        .clone(),
                    RECIPIENT,
                    1,
                    ts,
                ),
            }]
        };
        assert_eq!(
            qualify(&mut c, 7, SIMPLE, mk(NOW_S - 700_000), RECIPIENT).unwrap_err(),
            ClaimError::ProofTooOld.to_string()
        );
        assert_eq!(
            qualify(&mut c, 7, SIMPLE, mk(NOW_S + 10_000), RECIPIENT).unwrap_err(),
            ClaimError::ProofFromFuture.to_string()
        );
    }

    #[test]
    fn qualify_rejects_unknown_and_miscounted_witnesses() {
        let mut c = new_contract();
        create_simple(&mut c, 7);
        fund(&mut c, 7);
        // Pinned set does not contain the actual signer.
        pin_witness(&mut c, 1, &[OTHER]);
        let bundle = passing_bundle(7, SIMPLE, RECIPIENT, 38132, HEAD_A);
        assert_eq!(
            qualify(&mut c, 7, SIMPLE, bundle, RECIPIENT).unwrap_err(),
            ClaimError::UnknownWitness.to_string()
        );
        // Count mismatch: 2 pinned, 1 signature.
        pin_witness(&mut c, 1, &[&witness_hex(), OTHER]);
        let bundle = passing_bundle(7, SIMPLE, RECIPIENT, 38132, HEAD_A);
        assert_eq!(
            qualify(&mut c, 7, SIMPLE, bundle, RECIPIENT).unwrap_err(),
            ClaimError::WitnessCountMismatch.to_string()
        );
    }

    #[test]
    fn duplicate_pr_and_ordered_multi_slot() {
        let mut c = new_contract();
        let two = criteria_custom(&["600", "400"], "0", "0");
        ctx(SPONSOR, ONE_NEAR, ts());
        c.create_bounty(7, TOKEN.to_string(), two.clone()).unwrap();
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        // Slot 0 takes PR 100.
        let v0 = qualify(
            &mut c,
            7,
            &two,
            passing_bundle(7, &two, RECIPIENT, 100, HEAD_A),
            RECIPIENT,
        )
        .unwrap();
        assert_eq!((v0.slot, v0.claim_seq), (0, 0));
        // Same PR, fresh head (fresh nullifiers): passes crypto + rules,
        // then fails on the PR lock.
        let dup = passing_bundle(7, &two, RECIPIENT, 100, HEAD_B);
        assert_eq!(
            qualify(&mut c, 7, &two, dup, RECIPIENT).unwrap_err(),
            ClaimError::DuplicatePr {
                bounty_id: 7,
                pr_number: 100
            }
            .to_string()
        );
        // PR 101 fills slot 1 with sequence 1.
        let v1 = qualify(
            &mut c,
            7,
            &two,
            passing_bundle(7, &two, RECIPIENT, 101, HEAD_B),
            RECIPIENT,
        )
        .unwrap();
        assert_eq!((v1.slot, v1.claim_seq), (1, 1));
        // All slots filled.
        let full = passing_bundle(7, &two, RECIPIENT, 102, HEAD_A);
        assert_eq!(
            qualify(&mut c, 7, &two, full, RECIPIENT).unwrap_err(),
            ClaimError::NoOpenSlot(7).to_string()
        );
    }

    // -- Finalization ------------------------------------------------------------

    // -- Challenge-window deadline gate --------------------------------------------

    fn nullifier_used(
        contract: &Contract,
        bounty: u64,
        recipient: &str,
        tag: u8,
        proof: &ProofInput,
    ) -> bool {
        let id: [u8; 32] =
            normalize::parse_hex("id", &proof.signed_claim.claim.identifier).unwrap();
        let recip = normalize::parse_address("r", recipient).unwrap().0;
        let key = reclaim::nullifier_key(bounty, &recip, tag, &id);
        contract.is_nullifier_used(to_hex_prefixed(&key)).unwrap()
    }

    fn windowed_setup(contract: &mut Contract, id: u64, deadline: u64, window: u64) -> String {
        let doc = criteria_custom(&["600"], &deadline.to_string(), &window.to_string());
        ctx(SPONSOR, ONE_NEAR, ts());
        contract
            .create_bounty(id, TOKEN.to_string(), doc.clone())
            .unwrap();
        fund(contract, id);
        pin_witness(contract, 1, &[&witness_hex()]);
        doc
    }

    #[test]
    fn qualify_window_deadline_boundary() {
        let mut c = new_contract();
        // Exact boundary (now + window == deadline): allowed, full success.
        let doc = windowed_setup(&mut c, 7, NOW_S + 3600, 3600);
        let bundle = passing_bundle(7, &doc, RECIPIENT, 100, HEAD_A);
        qualify_at(&mut c, 7, &doc, bundle, RECIPIENT, ts()).unwrap();
        // One second later: rejected with the dedicated code.
        let doc = windowed_setup(&mut c, 8, NOW_S + 3600, 3600);
        let bundle = passing_bundle(8, &doc, RECIPIENT, 100, HEAD_A);
        let t = ts() + 1_000_000_000;
        assert_eq!(
            qualify_at(&mut c, 8, &doc, bundle, RECIPIENT, t).unwrap_err(),
            ClaimError::ChallengeWindowExceedsDeadline.to_string()
        );
        // Rejection consumed nothing: slot, sequence, and nullifiers intact.
        let b = c.get_bounty(8).unwrap();
        assert_eq!((b.slots_filled, b.seq), (0, 0));
        let bundle = passing_bundle(8, &doc, RECIPIENT, 100, HEAD_A);
        for tagged in &bundle {
            assert!(!nullifier_used(
                &c,
                8,
                RECIPIENT,
                tagged.evidence_type,
                &tagged.proof
            ));
        }
        // Zero window at exactly the deadline: allowed (immediate finality).
        let doc = windowed_setup(&mut c, 9, NOW_S, 0);
        let bundle = passing_bundle(9, &doc, RECIPIENT, 100, HEAD_A);
        qualify_at(&mut c, 9, &doc, bundle, RECIPIENT, ts()).unwrap();
    }

    #[test]
    fn qualify_window_gate_deadline_zero_and_overflow() {
        let mut c = new_contract();
        // deadline == 0: no horizon, any window allowed (even u64::MAX).
        let doc = criteria_custom(&["600"], "0", "18446744073709551615");
        ctx(SPONSOR, ONE_NEAR, ts());
        c.create_bounty(7, TOKEN.to_string(), doc.clone()).unwrap();
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        let bundle = passing_bundle(7, &doc, RECIPIENT, 100, HEAD_A);
        qualify(&mut c, 7, &doc, bundle, RECIPIENT).unwrap();
        // Near-u64::MAX arithmetic: now=1.8e10s (max representable in nanos
        // is ~1.84e10), deadline=u64::MAX, window=u64::MAX. Exact math says
        // window > remaining → reject (a saturating-add formulation would
        // wrongly allow this). The gate fires before crypto, so the stale
        // (by 500 years) proofs never reach freshness checks.
        let big_now: u64 = 18_000_000_000;
        let doc = windowed_setup(&mut c, 8, u64::MAX, u64::MAX);
        let bundle = passing_bundle(8, &doc, RECIPIENT, 100, HEAD_A);
        assert_eq!(
            qualify_at(&mut c, 8, &doc, bundle, RECIPIENT, big_now * 1_000_000_000).unwrap_err(),
            ClaimError::ChallengeWindowExceedsDeadline.to_string()
        );
        // And the dry-run reports the identical deterministic rejection.
        let bundle = passing_bundle(8, &doc, RECIPIENT, 100, HEAD_A);
        let d = c.dry_qualify(8, doc.clone(), bundle, RECIPIENT.to_string());
        assert!(!d.ok);
        assert!(d
            .errors
            .iter()
            .any(|e| e.starts_with("CHALLENGE_WINDOW_EXCEEDS_DEADLINE")));
    }

    #[test]
    fn evidence_commitment_auditor_reproducible_and_pinned() {
        // Simulate the external auditor: start from the qualify_claim
        // arguments as JSON (as observed on-chain), extract (tag,
        // identifier) per proof, sort, hash — must equal the contract's
        // own computation over the same bundle.
        let mut c = new_contract();
        create_simple(&mut c, 7);
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        let bundle = passing_bundle(7, SIMPLE, RECIPIENT, 38132, HEAD_A);
        let as_json = serde_json::to_value(&bundle).unwrap();
        let mut records: Vec<(u8, [u8; 32])> = Vec::new();
        for p in as_json.as_array().unwrap() {
            let tag = p["evidence_type"].as_u64().unwrap() as u8;
            let id_hex = p["proof"]["signedClaim"]["claim"]["identifier"]
                .as_str()
                .unwrap();
            let id: [u8; 32] = normalize::parse_hex("id", id_hex).unwrap();
            records.push((tag, id));
        }
        let auditor_digest = reclaim::evidence_records_digest(&records);
        // Contract-side computation over the verified proofs (same inputs
        // the claim_qualified event commits to).
        let doc = criteria::strict_parse(SIMPLE).unwrap();
        let vc = criteria::validate_criteria(&doc).unwrap();
        let recip = normalize::parse_address("r", RECIPIENT).unwrap().0;
        let mut arena: Vec<(Value, Value)> = Vec::new();
        let (eval, _) = c
            .verify_bundle(7, &vc, &recip, &bundle, NOW_S, &mut arena)
            .unwrap();
        let contract_records: Vec<(u8, [u8; 32])> =
            eval.iter().map(|p| (p.kind as u8, p.identifier)).collect();
        assert_eq!(
            reclaim::evidence_records_digest(&contract_records),
            auditor_digest
        );
        // Golden pin: fixed bundle (deterministic identifiers) →
        // fixed digest, independently cross-checked against ethers
        // keccak256 over the 99-byte preimage (PR + check-run + identity).
        assert_eq!(
            format!("0x{}", hex::encode(auditor_digest)),
            "0x9a44c0dedd91983d7f9bc6ae6cc6c7ac3bf9367158077fa8e954e96be187a028"
        );
    }

    /// Matured single-slot bounty with one qualified claim; returns the
    /// pending digest after a successful prepare.
    fn setup_finalizable(challenge: &str) -> (Contract, [u8; 32]) {
        let mut c = new_contract();
        let doc = criteria_custom(&["600"], "0", challenge);
        ctx(SPONSOR, ONE_NEAR, ts());
        c.create_bounty(7, TOKEN.to_string(), doc.clone()).unwrap();
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        ctx(OWNER, 0, ts());
        c.set_mpc_signer(mpc_addr_hex()).unwrap();
        qualify(
            &mut c,
            7,
            &doc,
            passing_bundle(7, &doc, RECIPIENT, 100, HEAD_A),
            RECIPIENT,
        )
        .unwrap();
        ctx("caller.testnet", ONE_NEAR, ts());
        let (_, digest) = c.prepare_finalize(7, 0).unwrap();
        (c, digest)
    }

    #[test]
    fn finalize_gates_window_signer_and_double_dispatch() {
        // Challenge window enforced.
        let mut c = new_contract();
        let doc = criteria_custom(&["600"], "0", "3600");
        ctx(SPONSOR, ONE_NEAR, ts());
        c.create_bounty(7, TOKEN.to_string(), doc.clone()).unwrap();
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        qualify(
            &mut c,
            7,
            &doc,
            passing_bundle(7, &doc, RECIPIENT, 100, HEAD_A),
            RECIPIENT,
        )
        .unwrap();
        ctx("caller.testnet", ONE_NEAR, ts());
        assert_eq!(
            c.prepare_finalize(7, 0).unwrap_err(),
            ClaimError::ChallengeWindowClosed
        );
        // Unknown claim.
        assert_eq!(
            c.prepare_finalize(7, 3).unwrap_err(),
            ClaimError::ClaimNotFound {
                bounty_id: 7,
                slot: 3
            }
        );
        // MPC signer unconfigured (window-0 bounty for the rest). NOTE: this
        // second contract shares the test's mock storage, so it uses bounty
        // 8 — reusing id 7 would collide with the nullifiers above.
        let mut c = new_contract();
        let doc = criteria_custom(&["600"], "0", "0");
        ctx(SPONSOR, ONE_NEAR, ts());
        c.create_bounty(8, TOKEN.to_string(), doc.clone()).unwrap();
        fund(&mut c, 8);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        qualify(
            &mut c,
            8,
            &doc,
            passing_bundle(8, &doc, RECIPIENT, 100, HEAD_A),
            RECIPIENT,
        )
        .unwrap();
        ctx("caller.testnet", ONE_NEAR, ts());
        assert_eq!(
            c.prepare_finalize(8, 0).unwrap_err(),
            ClaimError::MpcNotConfigured
        );
        // Configure + dispatch: voucher fields come from storage, and the
        // nonce is consumed exactly once.
        ctx(OWNER, 0, ts());
        c.set_mpc_signer(mpc_addr_hex()).unwrap();
        ctx("caller.testnet", ONE_NEAR, ts());
        let (voucher, digest) = c.prepare_finalize(8, 0).unwrap();
        assert_eq!(voucher.nonce, 0);
        assert_eq!(voucher.slot_index, 0);
        assert_eq!(u256_to_decimal(&voucher.amount), "600");
        assert_eq!(voucher.chain_id, DEFAULT_CHAIN_ID);
        assert_eq!(c.get_config().next_nonce, 1);
        assert!(c.pending.get(&digest).is_some());
        // Second dispatch while in flight: blocked.
        assert_eq!(
            c.prepare_finalize(8, 0).unwrap_err(),
            ClaimError::SlotPending {
                bounty_id: 8,
                slot: 0
            }
        );
    }

    #[test]
    fn stuck_dispatch_superseded_after_timeout() {
        let (mut c, old_digest) = setup_finalizable("0");
        // Advance chain time past the pending timeout.
        let later = ts() + (DEFAULT_PENDING_TIMEOUT_SEC + 1) * 1_000_000_000;
        ctx("caller.testnet", ONE_NEAR, later);
        let (voucher2, new_digest) = c.prepare_finalize(7, 0).unwrap();
        assert_ne!(old_digest, new_digest);
        assert_eq!(voucher2.nonce, 1);
        // Stale entry removed: a late MPC response for it would find no
        // pending entry and Reject instead of applying.
        assert!(c.pending.get(&old_digest).is_none());
        assert!(c.pending.get(&new_digest).is_some());
        // Fresh dispatch is now the in-flight one.
        assert_eq!(
            c.prepare_finalize(7, 0).unwrap_err(),
            ClaimError::SlotPending {
                bounty_id: 7,
                slot: 0
            }
        );
    }

    #[test]
    fn u256_checked_arithmetic() {
        let max = [0xffu8; 32];
        assert!(u256_add(&max, &[0u8; 32]).unwrap() == max);
        let mut one = [0u8; 32];
        one[31] = 1;
        assert!(u256_add(&max, &one).is_none());
        assert!(u256_sum(&[max, max]).is_none());
        assert_eq!(u256_sum(&[one, one]).unwrap()[31], 2);
        assert_eq!(u256_to_decimal(&one), "1");
    }

    #[test]
    fn relay_queue_and_views() {
        let (mut c, digest) = setup_finalizable("0");
        // No signed voucher yet: queue empty, claim unsigned.
        assert!(c.list_unrelayed(10).is_empty());
        assert!(!c.get_claim(7, 0).unwrap().signed);
        // Sign via the MPC leg (tested below), then list.
        let resp = mpc_response(mpc_test_key(), &digest);
        ctx("v3.testnet", 0, ts());
        c.apply_mpc_signature(&digest, &resp).unwrap();
        let q = c.list_unrelayed(10);
        assert_eq!(q.len(), 1);
        assert_eq!((q[0].bounty_id, q[0].slot), (7, 0));
        assert_eq!(q[0].digest, to_hex_prefixed(&digest));
        assert_eq!(q[0].voucher.amount, "600");
        assert!(c.get_claim(7, 0).unwrap().signed);
        // Relay hint removes it from the queue (escrow stays ground truth).
        ctx("relayer.testnet", ONE_NEAR, ts());
        assert!(c.mark_relayed(to_hex_prefixed(&digest)).unwrap());
        assert!(c.list_unrelayed(10).is_empty());
        assert!(c.is_relayed(to_hex_prefixed(&digest)).unwrap());
        assert!(c.get_voucher(7, 0).is_some());
        assert!(c.get_voucher(7, 1).is_none());
        // Pagination over the registry.
        ctx(SPONSOR, ONE_NEAR, ts());
        c.create_bounty(8, TOKEN.to_string(), SIMPLE.to_string())
            .unwrap();
        assert_eq!(c.list_bounties(0, 1).len(), 1);
        assert_eq!(c.list_bounties(1, 10).len(), 1);
        assert!(c.list_bounties(0, 0).is_empty());
    }

    // -- MPC application (real ECDSA) ---------------------------------------------

    fn mpc_test_key() -> [u8; 32] {
        [0x42; 32]
    }

    fn mpc_addr_hex() -> String {
        mpc_addr_for(&mpc_test_key())
    }

    fn mpc_addr_for(key: &[u8; 32]) -> String {
        use k256::ecdsa::SigningKey;
        let signing = SigningKey::from_bytes(key.into()).unwrap();
        let point = signing.verifying_key().to_encoded_point(false);
        let hash = near_sdk::env::keccak256(&point.as_bytes()[1..]);
        to_hex_prefixed(&hash[12..])
    }

    fn mpc_response(key: [u8; 32], digest: &[u8; 32]) -> MpcSignature {
        use k256::ecdsa::SigningKey;
        let signing = SigningKey::from_bytes((&key).into()).unwrap();
        let (sig, recid) = signing.sign_prehash_recoverable(digest).unwrap();
        let r: [u8; 32] = sig.r().to_bytes().into();
        let s: [u8; 32] = sig.s().to_bytes().into();
        let prefix = if recid.is_y_odd() { "03" } else { "02" };
        MpcSignature {
            scheme: Some("Secp256k1".to_string()),
            big_r: mpc::AffinePoint {
                affine_point: format!("{prefix}{}", normalize::to_hex(&r)),
            },
            s: mpc::Scalar {
                scalar: normalize::to_hex(&s),
            },
            recovery_id: recid.to_byte(),
        }
    }

    #[test]
    fn mpc_apply_success_failure_and_retry_loop() {
        let (mut c, digest) = setup_finalizable("0");
        // Wrong key: rejected, dispatch INTACT (apply never releases; the
        // callback releases exactly once around it).
        let bad = mpc_response([0x99; 32], &digest);
        assert_eq!(
            c.apply_mpc_signature(&digest, &bad).unwrap_err(),
            ClaimError::MpcSignerMismatch
        );
        assert!(c.pending.get(&digest).is_some());
        // Malformed envelopes rejected without state change.
        let mut no_scheme = mpc_response(mpc_test_key(), &digest);
        no_scheme.scheme = None;
        assert!(matches!(
            c.apply_mpc_signature(&digest, &no_scheme).unwrap_err(),
            ClaimError::MpcBadResponse(_)
        ));
        let mut flipped = mpc_response(mpc_test_key(), &digest);
        flipped.recovery_id ^= 1;
        assert!(matches!(
            c.apply_mpc_signature(&digest, &flipped).unwrap_err(),
            ClaimError::MpcBadResponse(_)
        ));
        assert!(c.pending.get(&digest).is_some());
        // Release (as the callback would), then retry with a fresh digest.
        c.release_pending(&digest);
        assert!(c.pending.get(&digest).is_none());
        assert!(c.get_claim(7, 0).unwrap().pending_digest.is_none());
        ctx("caller.testnet", ONE_NEAR, ts());
        let (_, digest2) = c.prepare_finalize(7, 0).unwrap();
        assert_ne!(digest, digest2);
        let good = mpc_response(mpc_test_key(), &digest2);
        let view = c.apply_mpc_signature(&digest2, &good).unwrap();
        assert!(view.v == 27 || view.v == 28);
        assert_eq!(view.voucher.amount, "600");
        assert_eq!(view.voucher.nonce, 1);
        assert!(c.pending.get(&digest2).is_none());
        assert!(c.get_pending(to_hex_prefixed(&digest2)).unwrap().is_none());
        // Completed slot refuses another dispatch.
        assert_eq!(
            c.prepare_finalize(7, 0).unwrap_err(),
            ClaimError::AlreadyFinalized {
                bounty_id: 7,
                slot: 0
            }
        );
        // Unknown digest: stale callback finds nothing, touches nothing.
        assert_eq!(
            c.apply_mpc_signature(&[9u8; 32], &good).unwrap_err(),
            ClaimError::NoPendingVoucher
        );
    }

    #[test]
    fn finalize_claim_dispatches_mpc_promise() {
        let mut c = new_contract();
        let doc = criteria_custom(&["600"], "0", "0");
        ctx(SPONSOR, ONE_NEAR, ts());
        c.create_bounty(7, TOKEN.to_string(), doc.clone()).unwrap();
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        ctx(OWNER, 0, ts());
        c.set_mpc_signer(mpc_addr_hex()).unwrap();
        qualify(
            &mut c,
            7,
            &doc,
            passing_bundle(7, &doc, RECIPIENT, 100, HEAD_A),
            RECIPIENT,
        )
        .unwrap();
        // Public dispatch path (promise creation is mock-recorded).
        ctx("caller.testnet", ONE_NEAR, ts());
        let _ = c.finalize_claim(7, 0);
        let claim = c.get_claim(7, 0).unwrap();
        assert_eq!(claim.status, "finalized");
        assert!(claim.pending_digest.is_some());
    }

    // -- Transparency + gas ----------------------------------------------------------

    #[test]
    fn dry_qualify_mirrors_qualify_without_mutating() {
        let mut c = new_contract();
        // Unknown bounty: total outcome, no panic.
        let d = c.dry_qualify(404, SIMPLE.to_string(), vec![], RECIPIENT.to_string());
        assert!(!d.ok);
        assert_eq!(d.errors, vec![ClaimError::BountyNotFound(404).to_string()]);
        create_simple(&mut c, 7);
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        // Success dry-run: ok + join keys + all-pass verdicts.
        let bundle = passing_bundle(7, SIMPLE, RECIPIENT, 38132, HEAD_A);
        let d = c.dry_qualify(7, SIMPLE.to_string(), bundle, RECIPIENT.to_string());
        assert!(d.ok, "errors: {:?}", d.errors);
        assert_eq!(d.pr_number, Some(38132));
        assert_eq!(d.head_sha, Some(format!("0x{HEAD_A}")));
        assert!(!d.verdicts.is_empty());
        assert!(d.verdicts.iter().all(|v| v.status == "pass"));
        // Dry-run consumed nothing: the real claim still succeeds.
        assert_eq!(c.get_bounty(7).unwrap().slots_filled, 0);
        let bundle = passing_bundle(7, SIMPLE, RECIPIENT, 38132, HEAD_A);
        qualify(&mut c, 7, SIMPLE, bundle, RECIPIENT).unwrap();
        // Post-fill dry-run reports the filled slot AND the replay.
        let bundle = passing_bundle(7, SIMPLE, RECIPIENT, 38132, HEAD_A);
        let d = c.dry_qualify(7, SIMPLE.to_string(), bundle, RECIPIENT.to_string());
        assert!(!d.ok);
        assert!(d.errors.iter().any(|e| e.starts_with("NO_OPEN_SLOT")));
        assert!(d.errors.iter().any(|e| e.starts_with("IDENTIFIER_REPLAY")));
        // Criteria mismatch short-circuits evaluation (no misleading
        // verdicts against the wrong document).
        let other = criteria_custom(&["1000001"], "0", "0");
        let bundle = passing_bundle(7, &other, RECIPIENT, 38132, HEAD_A);
        let d = c.dry_qualify(7, other, bundle, RECIPIENT.to_string());
        assert!(!d.ok);
        assert!(d.errors.iter().any(|e| e.starts_with("CRITERIA_MISMATCH")));
        assert!(d.verdicts.is_empty());
    }

    // NOTE: gas-floor and auth panics (assert_gas, assert_owner,
    // finalize_claim/finalize error paths) abort unit-test binaries because
    // env::panic_str cannot unwind through the mock's extern "C" shim.
    // They are covered in tests/xsuite.rs against a real sandbox node.

    /// Regen the xsuite claim fixture with FRESH timestamps. Proofs are only
    /// valid for 7d (criteria evidence cap), so the file is a snapshot, not
    /// a golden vector — regenerate immediately before xsuite runs:
    /// `cargo test regen_xsuite_fixture -- --ignored --nocapture`.
    /// `XSUITE_FIXTURE_TIME` (u64 seconds) pins timestamps and
    /// `XSUITE_FIXTURE_PATH` redirects output so CI can verify that two
    /// regens with identical inputs are byte-identical.
    #[test]
    #[ignore]
    fn regen_xsuite_fixture() {
        use std::time::{SystemTime, UNIX_EPOCH};
        ctx(OWNER, 0, ts());
        // Determinism knobs (CI): fixed timestamp + alternate output path
        // make back-to-back regens byte-comparable. Defaults preserve the
        // normal fresh-timestamp behavior.
        let now = match std::env::var("XSUITE_FIXTURE_TIME") {
            Ok(v) => v
                .parse::<u64>()
                .expect("XSUITE_FIXTURE_TIME must be u64 seconds"),
            Err(_) => SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        };
        let doc = criteria_custom(&["600000", "400000", "300000"], "0", "0");
        let windowed = criteria_custom(&["600000"], "0", "3600");
        let bundle = |pr: u64, head: &str| passing_bundle_at(7, &doc, RECIPIENT, pr, head, now);
        // Impostor variants: mallory's login / wrong numeric id over
        // acdlite's PR (identity is always the last bundle element).
        let mut mallory = bundle(100, HEAD_A);
        mallory.pop();
        mallory.push(identity_tagged(RECIPIENT, now, "mallory", "10001"));
        let mut wrong_id = bundle(100, HEAD_A);
        wrong_id.pop();
        wrong_id.push(identity_tagged(RECIPIENT, now, "acdlite", "99999"));
        let fx = serde_json::json!({
            "bounty_id": 7,
            "criteria": doc,
            "criteria_windowed": windowed,
            "recipient": RECIPIENT,
            "epoch": 1,
            "witness": witness_hex(),
            "generated_at": now,
            "bundles": {
                "a": bundle(100, HEAD_A),
                "b": bundle(101, HEAD_B),
                "c": bundle(100, HEAD_B),
                "d": bundle(102, HEAD_C),
                "e": bundle(103, HEAD_D),
                "m": mallory,
                "n": wrong_id,
            },
        });
        let path = std::env::var("XSUITE_FIXTURE_PATH").unwrap_or_else(|_| {
            format!(
                "{}/../../testdata/v3/xsuite-claim.json",
                env!("CARGO_MANIFEST_DIR")
            )
        });
        std::fs::write(&path, serde_json::to_string_pretty(&fx).unwrap()).unwrap();
        eprintln!("wrote {path} (generated_at={now})");
    }

    /// Regen the cross-chain e2e fixture: REAL NEAR-produced claims and
    /// vouchers (test MPC key) serialized exactly as the views emit them,
    /// for the Hardhat e2e harness (`integration/scripts/e2e-v3-run.mjs`).
    /// `E2E_ESCROW_ADDRESS` / `E2E_TOKEN_ADDRESS` / `E2E_CHAIN_ID` /
    /// `E2E_OUT_PATH` override the standalone defaults.
    ///
    /// Deterministic test clock: `E2E_FIXTURE_TIME` pins the fixture epoch
    /// (all deadlines, expiries, proofs, and nonces derive from it), making
    /// regen byte-reproducible — same inputs, same file, verifiable with
    /// `cmp`. Unset, it defaults to wall-clock time, so the standard flow
    /// (`npm run e2e:local`, which regens immediately before running) can
    /// never go stale: `cargo test regen_e2e_fixture -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn regen_e2e_fixture() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let now: u64 = match std::env::var("E2E_FIXTURE_TIME") {
            Ok(s) => s.parse().expect("E2E_FIXTURE_TIME must be unix seconds"),
            Err(_) => SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        };
        let nanos = now * 1_000_000_000;
        let escrow_env = std::env::var("E2E_ESCROW_ADDRESS")
            .unwrap_or_else(|_| "0xee5C8F3154fed8B9B2f5D820AC687fDfa8CF2C99".to_string());
        let token_env = std::env::var("E2E_TOKEN_ADDRESS")
            .unwrap_or_else(|_| "0x036CbD53842c5426634e7929541eC2318f3dCF7e".to_string());
        let chain: u64 = std::env::var("E2E_CHAIN_ID")
            .map(|s| s.parse().unwrap())
            .unwrap_or(84532);
        let out = std::env::var("E2E_OUT_PATH").unwrap_or_else(|_| {
            format!(
                "{}/../../testdata/v3/e2e-vouchers.json",
                env!("CARGO_MANIFEST_DIR")
            )
        });
        ctx(OWNER, 0, nanos);
        let mut c = Contract::new(
            OWNER.parse().unwrap(),
            MPC.parse().unwrap(),
            escrow_env.clone(),
            chain,
        );
        let doc = criteria_custom(
            &["600000", "400000", "300000", "200000", "100000"],
            &(now + 3600).to_string(),
            "0",
        );
        ctx(SPONSOR, ONE_NEAR, nanos);
        c.create_bounty(7, token_env.clone(), doc.clone()).unwrap();
        ctx(SPONSOR, 0, nanos);
        c.mark_funded(7).unwrap();
        pin_witness(&mut c, 1, &[&witness_hex()]);
        ctx(OWNER, 0, nanos);
        c.set_mpc_signer(mpc_addr_hex()).unwrap();
        let specs = [
            (100u64, HEAD_A, RECIPIENT),
            (101u64, HEAD_B, OTHER),
            (102u64, HEAD_C, RECIPIENT),
            (103u64, HEAD_D, RECIPIENT),
            (104u64, HEAD_E, RECIPIENT),
        ];
        let mut claims = Vec::new();
        let mut base_voucher: Option<VoucherV2> = None;
        for (i, &(pr, head, recip)) in specs.iter().enumerate() {
            let bundle = passing_bundle_at(7, &doc, recip, pr, head, now);
            qualify_at(&mut c, 7, &doc, bundle, recip, nanos).unwrap();
            let (voucher, digest) = c.prepare_finalize(7, i as u8).unwrap();
            if i == 4 {
                base_voucher = Some(voucher.clone());
            }
            let resp = mpc_response(mpc_test_key(), &digest);
            let signed = c.apply_mpc_signature(&digest, &resp).unwrap();
            claims.push(serde_json::json!({
                "slot": i,
                "recipient": recip,
                "pr": pr,
                "claim": serde_json::to_value(c.get_claim(7, i as u8).unwrap()).unwrap(),
                "voucher": serde_json::to_value(&signed).unwrap(),
            }));
        }
        // Negatives: mutate slot-4's voucher (unclaimed until scenario E,
        // so field checks — not the bitmap — decide), re-sign over the new
        // digest with the MPC test key (wrong-signer uses another key).
        let v0 = base_voucher.unwrap();
        let sign_as = |v: VoucherV2, key: [u8; 32], flip_v: bool| -> Value {
            let d = voucher_digest(&v);
            let resp = mpc_response(key, &d);
            let sig = mpc::parse_mpc_signature(&resp).unwrap();
            let vv = if flip_v {
                if sig.v == 27 {
                    28
                } else {
                    27
                }
            } else {
                sig.v
            };
            let signed = voucher::SignedVoucher {
                voucher: v,
                v: vv,
                r: sig.r,
                s: sig.s,
            };
            serde_json::to_value(signed_view(&signed)).unwrap()
        };
        let mut with_amount = v0.clone();
        with_amount.amount[31] = with_amount.amount[31].wrapping_add(1);
        let mut with_token = v0.clone();
        with_token.token = [0xddu8; 20];
        let mut with_criteria = v0.clone();
        with_criteria.criteria_hash = [0xccu8; 32];
        let mut with_chain = v0.clone();
        with_chain.chain_id = 1;
        let mut with_escrow = v0.clone();
        with_escrow.escrow = [0xeeu8; 20];
        let mut expired = v0.clone();
        expired.expiry = now - 1;
        let mut other_bounty = v0.clone();
        other_bounty.bounty_id = 404;
        let key = mpc_test_key();
        let negatives = serde_json::json!([
            {"tag": "wrong-amount", "signed": sign_as(with_amount, key, false), "expect": "AmountMismatch"},
            {"tag": "wrong-token", "signed": sign_as(with_token, key, false), "expect": "TokenMismatch"},
            {"tag": "wrong-criteria", "signed": sign_as(with_criteria, key, false), "expect": "CriteriaMismatch"},
            {"tag": "wrong-chain", "signed": sign_as(with_chain, key, false), "expect": "WrongChain"},
            {"tag": "wrong-escrow", "signed": sign_as(with_escrow, key, false), "expect": "WrongEscrow"},
            {"tag": "expired", "signed": sign_as(expired, key, false), "expect": "VoucherExpired"},
            {"tag": "wrong-signer", "signed": sign_as(v0.clone(), [0x99u8; 32], false), "expect": "BadSignature"},
            {"tag": "bad-v", "signed": sign_as(v0.clone(), key, true), "expect": "BadSignature"},
            {"tag": "unknown-bounty", "signed": sign_as(other_bounty, key, false), "expect": "BountyNotFound"},
        ]);
        let fx = serde_json::json!({
            "generated_at": now,
            "config": {
                "chainId": chain,
                "escrow": escrow_env,
                "token": token_env,
                "mpcSigner": mpc_addr_hex(),
                "contractId": "v3.omnibounty.testnet",
            },
            "bounty": {
                "bountyId": 7,
                "criteria": doc,
                "criteriaHash": to_hex_prefixed(&criteria::criteria_hash(&doc).unwrap()),
                "slots": ["600000", "400000", "300000", "200000", "100000"],
                "deadline": now + 3600,
            },
            "claims": claims,
            "negatives": negatives,
            "unrelayed": serde_json::to_value(c.list_unrelayed(10)).unwrap(),
            "bountyView": serde_json::to_value(c.get_bounty(7).unwrap()).unwrap(),
        });
        std::fs::write(&out, serde_json::to_string_pretty(&fx).unwrap()).unwrap();
        eprintln!("wrote {out} (generated_at={now})");
    }

    // -- Authorship identity -----------------------------------------------------

    #[test]
    fn identity_impostor_cannot_claim_others_pr() {
        let mut c = new_contract();
        create_simple(&mut c, 7);
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        // Mallory's identity over acdlite's PR: login gate fires first.
        let mut bundle = passing_bundle(7, SIMPLE, RECIPIENT, 100, HEAD_A);
        assert_eq!(bundle.last().unwrap().evidence_type, 7);
        bundle.pop();
        bundle.push(identity_tagged(RECIPIENT, NOW_S, "mallory", "10001"));
        let err = qualify(&mut c, 7, SIMPLE, bundle, RECIPIENT).unwrap_err();
        assert!(err.contains("identity.login"), "unexpected: {err}");
        // Same login, wrong numeric id: the rename-proof gate fires.
        let mut bundle = passing_bundle(7, SIMPLE, RECIPIENT, 100, HEAD_A);
        bundle.pop();
        bundle.push(identity_tagged(RECIPIENT, NOW_S, "acdlite", "99999"));
        let err = qualify(&mut c, 7, SIMPLE, bundle, RECIPIENT).unwrap_err();
        assert!(err.contains("identity.id"), "unexpected: {err}");
        // Failed attempts reserve nothing: the genuine claim still takes
        // slot 0 with its authorship timestamp recorded.
        let bundle = passing_bundle(7, SIMPLE, RECIPIENT, 100, HEAD_A);
        let v = qualify(&mut c, 7, SIMPLE, bundle, RECIPIENT).unwrap();
        assert_eq!((v.slot, v.claim_seq), (0, 0));
        let claim = c.get_claim(7, 0).unwrap();
        assert_eq!(
            claim.github_created,
            rules::parse_github_time("2026-10-26T19:00:00Z").unwrap()
        );
    }

    #[test]
    fn forged_identity_first_rejected_at_qualify() {
        // Full-pipeline version of the substitution attack: a forged
        // victim-valued identity proof (custom matchers) FIRST, genuine
        // attacker identity second. Values must bind to the covering
        // proof, so the login gate fires instead of the theft succeeding.
        let mut c = new_contract();
        create_simple(&mut c, 7);
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        let victim = passing_bundle(7, SIMPLE, RECIPIENT, 100, HEAD_A);
        let forged = TaggedProofArg {
            evidence_type: 7,
            proof: signed_proof(
                "https://api.github.com/user",
                "application/vnd.github+json",
                vec![
                    (
                        "regex".to_string(),
                        "\"bio\":\"(?<id_login>[^\"]+)\"".to_string(),
                    ),
                    ("regex".to_string(), "id_is_(?<id_num>[0-9]+)".to_string()),
                ],
                serde_json::json!({"id_login": "acdlite", "id_num": "10001"})
                    .as_object()
                    .unwrap()
                    .clone(),
                RECIPIENT,
                1,
                NOW_S,
            ),
        };
        let bundle = vec![
            victim[0].clone(),
            victim[1].clone(),
            forged,
            identity_tagged(RECIPIENT, NOW_S, "mallory", "99999"),
        ];
        let err = qualify(&mut c, 7, SIMPLE, bundle, RECIPIENT).unwrap_err();
        assert!(err.contains("identity.login"), "unexpected: {err}");
    }

    #[test]
    fn identity_missing_expired_and_foreign_rejected() {
        let mut c = new_contract();
        create_simple(&mut c, 7);
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        // Missing identity proof fails structurally.
        let mut bundle = passing_bundle(7, SIMPLE, RECIPIENT, 100, HEAD_A);
        bundle.pop();
        let err = qualify(&mut c, 7, SIMPLE, bundle, RECIPIENT).unwrap_err();
        assert!(err.contains("identity proof"), "unexpected: {err}");
        // Stale identity proof fails freshness like any other proof.
        let mut bundle = passing_bundle(7, SIMPLE, RECIPIENT, 100, HEAD_A);
        bundle.pop();
        bundle.push(identity_tagged(
            RECIPIENT,
            NOW_S - 8 * 86400,
            "acdlite",
            "10001",
        ));
        let err = qualify(&mut c, 7, SIMPLE, bundle, RECIPIENT).unwrap_err();
        assert!(err.contains("PROOF_TOO_OLD"), "unexpected: {err}");
        // Another recipient's identity proof cannot be substituted.
        let mut bundle = passing_bundle(7, SIMPLE, RECIPIENT, 100, HEAD_A);
        bundle.pop();
        bundle.push(identity_tagged(OTHER, NOW_S, "acdlite", "10001"));
        let err = qualify(&mut c, 7, SIMPLE, bundle, RECIPIENT).unwrap_err();
        assert!(err.contains("RECIPIENT_MISMATCH"), "unexpected: {err}");
    }

    #[test]
    fn identity_reusable_across_bounties_but_bound_per_claim() {
        // Cross-bounty reuse policy preserved: the same identity (and the
        // same PR) legitimately backs claims on distinct bounties.
        let mut c = new_contract();
        create_simple(&mut c, 7);
        create_simple(&mut c, 8);
        fund(&mut c, 7);
        fund(&mut c, 8);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        qualify(
            &mut c,
            7,
            SIMPLE,
            passing_bundle(7, SIMPLE, RECIPIENT, 100, HEAD_A),
            RECIPIENT,
        )
        .unwrap();
        qualify(
            &mut c,
            8,
            SIMPLE,
            passing_bundle(8, SIMPLE, RECIPIENT, 100, HEAD_A),
            RECIPIENT,
        )
        .unwrap();
        assert_eq!(c.get_claim(7, 0).unwrap().claim_seq, 0);
        assert_eq!(c.get_claim(8, 0).unwrap().claim_seq, 0);
    }

    #[test]
    fn fail_to_pass_end_to_end() {
        const BASE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let mut v: Value = serde_json::from_str(SIMPLE).unwrap();
        v["base_commit"] = Value::String(BASE.to_string());
        v["checks"]["required"][0]["fail_at_base"] = Value::Bool(true);
        let doc = serde_json::to_string(&v).unwrap();
        // Criteria without the base anchor is rejected at validation.
        let mut bad = v.clone();
        bad.as_object_mut().unwrap().remove("base_commit");
        assert!(criteria::validate_criteria(&bad).is_err());
        for (id, leg, ok) in [
            (7u64, Some((BASE, "failure")), true),
            (8u64, Some((BASE, "success")), false),
            (9u64, Some((HEAD_A, "failure")), false),
            (10u64, None, false),
        ] {
            let mut c = new_contract();
            ctx(SPONSOR, ONE_NEAR, ts());
            c.create_bounty(id, TOKEN.to_string(), doc.clone()).unwrap();
            fund(&mut c, id);
            pin_witness(&mut c, 1, &[&witness_hex()]);
            let mut bundle = passing_bundle(id, &doc, RECIPIENT, 100, HEAD_A);
            if let Some((head, conclusion)) = leg {
                bundle.push(basecheck_tagged(head, conclusion));
            }
            let res = qualify(&mut c, id, &doc, bundle, RECIPIENT);
            if ok {
                res.unwrap();
            } else {
                let err = res.unwrap_err();
                assert!(err.contains("check:cleanup:base"), "unexpected: {err}");
            }
        }
    }

    #[test]
    fn callback_applies_while_paused() {
        // Pause gates new actions; in-flight settlement still completes.
        let (mut c, digest) = setup_finalizable("0");
        ctx(OWNER, 0, ts());
        c.set_paused(true);
        let good = mpc_response(mpc_test_key(), &digest);
        let view = c.apply_mpc_signature(&digest, &good).unwrap();
        assert!(view.v == 27 || view.v == 28);
        assert!(c.get_voucher(7, 0).is_some());
    }

    #[test]
    fn signer_rotation_midflight_releases_and_retries_clean() {
        let (mut c, digest) = setup_finalizable("0");
        // Rotate to an unrelated key while the dispatch is in flight.
        let other_key = [0x99u8; 32];
        ctx(OWNER, 0, ts());
        c.set_mpc_signer(mpc_addr_for(&other_key)).unwrap();
        // The old response no longer verifies: release, no voucher.
        let stale = mpc_response(mpc_test_key(), &digest);
        assert_eq!(
            c.apply_mpc_signature(&digest, &stale).unwrap_err(),
            ClaimError::MpcSignerMismatch
        );
        assert!(c.get_voucher(7, 0).is_none());
        // Mirroring on_voucher_signed: release, then retry under the new
        // signer completes the slot.
        c.release_pending(&digest);
        ctx("caller.testnet", ONE_NEAR, ts());
        let (_, digest2) = c.prepare_finalize(7, 0).unwrap();
        assert_ne!(digest, digest2);
        let fresh = mpc_response(other_key, &digest2);
        c.apply_mpc_signature(&digest2, &fresh).unwrap();
        assert!(c.get_voucher(7, 0).is_some());
    }

    #[test]
    fn expired_voucher_reaped_for_fresh_retry_live_voucher_blocks() {
        let (mut c, digest) = setup_finalizable("0");
        let good = mpc_response(mpc_test_key(), &digest);
        c.apply_mpc_signature(&digest, &good).unwrap();
        // Live voucher: re-dispatch refused as before.
        ctx("caller.testnet", ONE_NEAR, ts());
        assert_eq!(
            c.prepare_finalize(7, 0).unwrap_err(),
            ClaimError::AlreadyFinalized {
                bounty_id: 7,
                slot: 0
            }
        );
        // Past expiry with no relay: the dead voucher is reaped and a
        // fresh dispatch (new digest, new nonce) proceeds.
        ctx(
            "caller.testnet",
            ONE_NEAR,
            ts() + (DEFAULT_VOUCHER_TTL_SEC + 100) * 1_000_000_000,
        );
        let (_, digest2) = c.prepare_finalize(7, 0).unwrap();
        assert_ne!(digest, digest2);
        let fresh = mpc_response(mpc_test_key(), &digest2);
        let view = c.apply_mpc_signature(&digest2, &fresh).unwrap();
        assert_eq!(view.voucher.nonce, 1);
        assert!(c.get_voucher(7, 0).is_some());
    }

    #[test]
    fn qualified_claims_survive_deadline_and_epoch_removal() {
        // Deadline gates new qualifications only.
        let mut c = new_contract();
        let doc = criteria_custom(&["600"], &format!("{}", NOW_S + 3600), "0");
        ctx(SPONSOR, ONE_NEAR, ts());
        c.create_bounty(7, TOKEN.to_string(), doc.clone()).unwrap();
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        ctx(OWNER, 0, ts());
        c.set_mpc_signer(mpc_addr_hex()).unwrap();
        qualify(
            &mut c,
            7,
            &doc,
            passing_bundle(7, &doc, RECIPIENT, 100, HEAD_A),
            RECIPIENT,
        )
        .unwrap();
        ctx("caller.testnet", ONE_NEAR, ts() + 7200 * 1_000_000_000);
        c.prepare_finalize(7, 0).unwrap();
        // Epoch removal affects future verifies, never recorded claims.
        // (Fresh bounty id: mock storage persists across new_contract().)
        let mut c = new_contract();
        let doc = criteria_custom(&["600"], "0", "0");
        ctx(SPONSOR, ONE_NEAR, ts());
        c.create_bounty(8, TOKEN.to_string(), doc.clone()).unwrap();
        fund(&mut c, 8);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        ctx(OWNER, 0, ts());
        c.set_mpc_signer(mpc_addr_hex()).unwrap();
        qualify(
            &mut c,
            8,
            &doc,
            passing_bundle(8, &doc, RECIPIENT, 100, HEAD_A),
            RECIPIENT,
        )
        .unwrap();
        ctx(OWNER, 0, ts());
        c.remove_epoch(1);
        ctx("caller.testnet", ONE_NEAR, ts());
        c.prepare_finalize(8, 0).unwrap();
    }

    #[test]
    fn relay_queue_orders_by_verified_authorship_time() {
        // Settlement priority follows GitHub authorship (oldest first),
        // not submission order; ties break by bounty id, then slot.
        let mut c = new_contract();
        ctx(OWNER, 0, ts());
        c.set_mpc_signer(mpc_addr_hex()).unwrap();
        pin_witness(&mut c, 1, &[&witness_hex()]);
        let settle = |c: &mut Contract, id: u64, pr: u64, head: &str, created: &str| {
            let doc = criteria_custom(&["600"], "0", "0");
            ctx(SPONSOR, ONE_NEAR, ts());
            c.create_bounty(id, TOKEN.to_string(), doc.clone()).unwrap();
            fund(&mut *c, id);
            qualify(
                &mut *c,
                id,
                &doc,
                passing_bundle_full(
                    id, &doc, RECIPIENT, pr, head, NOW_S, "acdlite", "10001", created,
                ),
                RECIPIENT,
            )
            .unwrap();
            ctx("caller.testnet", ONE_NEAR, ts());
            let (_, digest) = c.prepare_finalize(id, 0).unwrap();
            let good = mpc_response(mpc_test_key(), &digest);
            c.apply_mpc_signature(&digest, &good).unwrap();
        };
        // Submitted newest-first; the queue must still list oldest-first,
        // with the authorship tie broken by bounty id.
        settle(&mut c, 7, 100, HEAD_A, "2026-10-26T19:00:00Z");
        settle(&mut c, 8, 101, HEAD_B, "2026-10-20T10:00:00Z");
        settle(&mut c, 9, 102, HEAD_C, "2026-10-20T10:00:00Z");
        let listed: Vec<(u64, u8)> = c
            .list_unrelayed(10)
            .iter()
            .map(|v| (v.bounty_id, v.slot))
            .collect();
        assert_eq!(listed, vec![(8, 0), (9, 0), (7, 0)]);
        // Relayed entries leave the queue; order of the rest is stable.
        let first = c.list_unrelayed(10)[0].digest.clone();
        ctx("relayer.testnet", ONE_NEAR, ts());
        c.mark_relayed(first).unwrap();
        let listed: Vec<(u64, u8)> = c
            .list_unrelayed(10)
            .iter()
            .map(|v| (v.bounty_id, v.slot))
            .collect();
        assert_eq!(listed, vec![(9, 0), (7, 0)]);
    }

    // -- Gas calibration (carryover A) ------------------------------------------
    //
    // These tests MEASURE host-call gas via the mock's VMLogic gas counter,
    // which charges production mainnet fees (near-parameters test config =
    // real schedule). NOT measured here: WASM compute (serde parsing, k256
    // recovery math) — native test execution has no op metering. See
    // NEAR_V3_DESIGN.md §8 for the combined model, operational limits, and
    // the Linux sandbox confirmation task.

    /// Build a passing PR+Check bundle where every proof carries `keys`.
    fn multi_sig_bundle(
        bounty_id: u64,
        criteria_json: &str,
        recipient_hex: &str,
        pr: u64,
        head: &str,
        keys: &[[u8; 32]],
    ) -> Vec<TaggedProofArg> {
        let doc = criteria::strict_parse(criteria_json).unwrap();
        let vc = criteria::validate_criteria(&doc).unwrap();
        let prm = rules::mandated_matchers(EvidenceType::Pr, &vc, bounty_id, recipient_hex, 0);
        let chm =
            rules::mandated_matchers(EvidenceType::CheckRun, &vc, bounty_id, recipient_hex, 0);
        let idm =
            rules::mandated_matchers(EvidenceType::Identity, &vc, bounty_id, recipient_hex, 0);
        let mut pr_ex = serde_json::json!({
            "author": "acdlite",
            "author_id": "10001",
            "head_sha": head,
            "merged": "true",
            "repo": "react/react",
            "number": pr.to_string(),
            "pr_created": "2026-10-26T19:00:00Z",
        })
        .as_object()
        .unwrap()
        .clone();
        // Base-pinned criteria demand the base_sha extraction too.
        if let Some(base) = vc.base_commit {
            pr_ex.insert("base_sha".to_string(), Value::String(hex::encode(base)));
        }
        let check_ex = serde_json::json!({
            "run_name": "cleanup",
            "head_sha": head,
            "status": "completed",
            "conclusion": "success",
            "completed_at": "2026-10-26T20:17:50Z",
            "app": "github-actions",
        })
        .as_object()
        .unwrap()
        .clone();
        vec![
            TaggedProofArg {
                evidence_type: 1,
                proof: signed_proof_multi(
                    &format!("https://api.github.com/repos/react/react/pulls/{pr}"),
                    "application/vnd.github+json",
                    prm,
                    pr_ex,
                    recipient_hex,
                    1,
                    NOW_S,
                    keys,
                ),
            },
            TaggedProofArg {
                evidence_type: 2,
                proof: signed_proof_multi(
                    "https://api.github.com/repos/react/react/check-runs/128113730680",
                    "application/vnd.github+json",
                    chm,
                    check_ex,
                    recipient_hex,
                    1,
                    NOW_S,
                    keys,
                ),
            },
            TaggedProofArg {
                evidence_type: 7,
                proof: signed_proof_multi(
                    "https://api.github.com/user",
                    "application/vnd.github+json",
                    idm,
                    serde_json::json!({
                        "id_login": "acdlite",
                        "id_num": "10001",
                    })
                    .as_object()
                    .unwrap()
                    .clone(),
                    recipient_hex,
                    1,
                    NOW_S,
                    keys,
                ),
            },
        ]
    }

    fn measure_qualify(
        contract: &mut Contract,
        id: u64,
        criteria_json: &str,
        proofs: Vec<TaggedProofArg>,
        recipient: &str,
    ) -> u64 {
        ctx("caller.testnet", ONE_NEAR, ts());
        let before = env::used_gas().as_gas();
        contract
            .qualify_claim(id, criteria_json.to_string(), proofs, recipient.to_string())
            .unwrap();
        env::used_gas().as_gas() - before
    }

    #[test]
    fn gas_host_cost_by_bundle_shape() {
        // 2 proofs x 1 witness (standard claim).
        let mut c = new_contract();
        let doc = criteria_custom(&["600", "400", "300", "200"], "0", "0");
        ctx(SPONSOR, ONE_NEAR, ts());
        c.create_bounty(7, TOKEN.to_string(), doc.clone()).unwrap();
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        let g21 = measure_qualify(
            &mut c,
            7,
            &doc,
            passing_bundle(7, &doc, RECIPIENT, 100, HEAD_A),
            RECIPIENT,
        );
        eprintln!("GAS_HOST proofs=2 sigs=2 gas={g21}");
        // 2 proofs x 4 witnesses.
        let keys4: Vec<[u8; 32]> = [0x11u8, 0x22, 0x33, 0x44].map(|b| [b; 32]).to_vec();
        let addrs4: Vec<String> = keys4
            .iter()
            .map(|k| format!("0x{}", hex::encode(witness_addr_for(k))))
            .collect();
        pin_witness(
            &mut c,
            1,
            &addrs4.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        );
        let g24 = measure_qualify(
            &mut c,
            7,
            &doc,
            multi_sig_bundle(7, &doc, RECIPIENT, 101, HEAD_B, &keys4),
            RECIPIENT,
        );
        eprintln!("GAS_HOST proofs=2 sigs=8 gas={g24}");
        // 2 proofs x 8 witnesses.
        let keys8: Vec<[u8; 32]> = [0x11u8, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]
            .map(|b| [b; 32])
            .to_vec();
        let addrs8: Vec<String> = keys8
            .iter()
            .map(|k| format!("0x{}", hex::encode(witness_addr_for(k))))
            .collect();
        pin_witness(
            &mut c,
            1,
            &addrs8.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        );
        let g28 = measure_qualify(
            &mut c,
            7,
            &doc,
            multi_sig_bundle(7, &doc, RECIPIENT, 102, HEAD_C, &keys8),
            RECIPIENT,
        );
        eprintln!("GAS_HOST proofs=2 sigs=16 gas={g28}");
        // Phase 5.1: recovery is host-metered (0.294 Tgas/sig), so these
        // totals INCLUDE witness verification — the sig-count slope below
        // is the per-signature price. Loose regression bounds below.
        assert!(g21 < 5_000_000_000_000, "2x1 host gas {g21}");
        assert!(g28 < 10_000_000_000_000, "2x8 host gas {g28}");
        assert!(g28 >= g21, "monotonicity {g28} vs {g21}");
    }

    /// Build an n-proof bundle: ONE PR proof (a claim joins to a single
    /// PR number) plus n-1 check-run proofs with distinct run ids, each
    /// proof signed by `keys`. Proofs are rule-coherent, so qualifying
    /// bundles exercise the full pass path. `pad_pr`/`pad_chk` are
    /// per-kind context pad lengths (0 = off; matcher top-up included
    /// when set) for size-term measurement and exact-cap construction.
    /// Padding uses permitted extras (matcher-subset semantics + ignored
    /// extracted keys) within the per-proof 16KB caps.
    #[allow(clippy::too_many_arguments)]
    /// `n` counts the PR + check-run proofs; an identity proof is always
    /// appended last, so the bundle holds `n + 1` proofs total.
    fn n_proof_bundle(
        bounty_id: u64,
        criteria_json: &str,
        recipient_hex: &str,
        n: usize,
        pr_start: u64,
        head: &str,
        keys: &[[u8; 32]],
        pad_pr: usize,
        pad_chk: usize,
        pad_id: usize,
    ) -> Vec<TaggedProofArg> {
        assert!(n >= 1, "bundle needs the PR proof");
        let doc = criteria::strict_parse(criteria_json).unwrap();
        let vc = criteria::validate_criteria(&doc).unwrap();
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let (evidence_type, url, mut matchers, mut ex) = if i == 0 {
                (
                    1,
                    format!("https://api.github.com/repos/react/react/pulls/{pr_start}"),
                    rules::mandated_matchers(EvidenceType::Pr, &vc, bounty_id, recipient_hex, 0),
                    serde_json::json!({
                        "author": "acdlite",
                        "author_id": "10001",
                        "head_sha": head,
                        "merged": "true",
                        "repo": "react/react",
                        "number": pr_start.to_string(),
                        "pr_created": "2026-10-26T19:00:00Z",
                    })
                    .as_object()
                    .unwrap()
                    .clone(),
                )
            } else {
                let run = 128113730680 + i as u64;
                (
                    2,
                    format!("https://api.github.com/repos/react/react/check-runs/{run}"),
                    rules::mandated_matchers(
                        EvidenceType::CheckRun,
                        &vc,
                        bounty_id,
                        recipient_hex,
                        0,
                    ),
                    serde_json::json!({
                        "run_name": "cleanup",
                        "head_sha": head,
                        "status": "completed",
                        "conclusion": "success",
                        "completed_at": "2026-10-26T20:17:50Z",
                        "app": "github-actions",
                    })
                    .as_object()
                    .unwrap()
                    .clone(),
                )
            };
            let pad_len = if i == 0 { pad_pr } else { pad_chk };
            if pad_len > 0 {
                while matchers.len() < rules::MAX_MATCHERS_PER_PROOF {
                    matchers.push(("contains".to_string(), "x".repeat(500)));
                }
                ex.insert(
                    "pad".to_string(),
                    serde_json::Value::String("y".repeat(pad_len)),
                );
            }
            out.push(TaggedProofArg {
                evidence_type,
                proof: signed_proof_multi(
                    &url,
                    "application/vnd.github+json",
                    matchers,
                    ex,
                    recipient_hex,
                    1,
                    NOW_S,
                    keys,
                ),
            });
        }
        let mut id_matchers =
            rules::mandated_matchers(EvidenceType::Identity, &vc, bounty_id, recipient_hex, 0);
        let mut id_ex = serde_json::json!({
            "id_login": "acdlite",
            "id_num": "10001",
        })
        .as_object()
        .unwrap()
        .clone();
        if pad_id > 0 {
            while id_matchers.len() < rules::MAX_MATCHERS_PER_PROOF {
                id_matchers.push(("contains".to_string(), "x".repeat(500)));
            }
            id_ex.insert(
                "pad".to_string(),
                serde_json::Value::String("y".repeat(pad_id)),
            );
        }
        out.push(TaggedProofArg {
            evidence_type: 7,
            proof: signed_proof_multi(
                "https://api.github.com/user",
                "application/vnd.github+json",
                id_matchers,
                id_ex,
                recipient_hex,
                1,
                NOW_S,
                keys,
            ),
        });
        out
    }

    #[test]
    fn gas_qualify_many_shapes() {
        // 48 / 64 sigs must pass (realistic-to-generous; 64 is the cap).
        // Totals include the appended identity proof's witnesses.
        let keys16: Vec<[u8; 32]> = (1u8..=16).map(|b| [b; 32]).collect();
        let addrs16: Vec<String> = keys16
            .iter()
            .map(|k| format!("0x{}", hex::encode(witness_addr_for(k))))
            .collect();
        let refs16: Vec<&str> = addrs16.iter().map(|s| s.as_str()).collect();
        let mut prev = 0u64;
        // Distinct bounty ids: mock storage persists across testing_env!.
        // Counts include the appended identity proof (n + 1 proofs total).
        for (id, n, pr_start, head) in [(7u64, 2usize, 300u64, HEAD_C), (8, 3, 400, HEAD_D)] {
            let mut c = new_contract();
            let doc = criteria_custom(&["600", "400", "300", "200"], "0", "0");
            ctx(SPONSOR, ONE_NEAR, ts());
            c.create_bounty(id, TOKEN.to_string(), doc.clone()).unwrap();
            fund(&mut c, id);
            pin_witness(&mut c, 1, &refs16);
            let bundle = n_proof_bundle(id, &doc, RECIPIENT, n, pr_start, head, &keys16, 0, 0, 0);
            let arg_bytes = serde_json::to_vec(&bundle).unwrap().len();
            ctx("caller.testnet", ONE_NEAR, ts());
            let before = env::used_gas().as_gas();
            let res = c.qualify_claim(id, doc, bundle, RECIPIENT.to_string());
            let g = env::used_gas().as_gas() - before;
            eprintln!(
                "GAS_MANY proofs={} sigs={} arg_bytes={arg_bytes} passed={} gas={g}",
                n + 1,
                (n + 1) * 16,
                res.is_ok()
            );
            res.unwrap();
            assert!(g > prev, "monotonicity across shapes");
            prev = g;
        }
        // 64-sig worst case: ~19T recovery + small overhead. Loose bound
        // holds for mock and Linux alike (Linux adds WASM serde on top).
        assert!(prev < 60_000_000_000_000, "64-sig shape {prev}");
        // 640-sig structural max: rejected pre-crypto (cheap, deterministic).
        let mut c = new_contract();
        let doc = criteria_custom(&["600", "400", "300", "200"], "0", "0");
        ctx(SPONSOR, ONE_NEAR, ts());
        c.create_bounty(9, TOKEN.to_string(), doc.clone()).unwrap();
        fund(&mut c, 9);
        pin_witness(&mut c, 1, &refs16);
        let bundle = n_proof_bundle(9, &doc, RECIPIENT, 39, 500, HEAD_E, &keys16, 0, 0, 0);
        ctx("caller.testnet", ONE_NEAR, ts());
        let before = env::used_gas().as_gas();
        let err = c
            .qualify_claim(9, doc, bundle, RECIPIENT.to_string())
            .unwrap_err();
        let g = env::used_gas().as_gas() - before;
        assert!(err.contains("TOO_MANY_SIGNATURES"), "unexpected: {err}");
        eprintln!("GAS_MANY proofs=40 sigs=640 REJECTED gas={g}");
        assert!(g < 5_000_000_000_000, "rejection must be cheap, got {g}");
    }

    /// Total-signature cap boundaries: 64 passes, 65 fails identically on
    /// qualify and dry, rejection burns no nullifiers (same identifiers
    /// still qualify afterwards), empty signatures fail closed.
    #[test]
    fn total_signature_cap_boundaries() {
        let keys13: Vec<[u8; 32]> = (1u8..=13).map(|b| [b; 32]).collect();
        let addrs13: Vec<String> = keys13
            .iter()
            .map(|k| format!("0x{}", hex::encode(witness_addr_for(k))))
            .collect();
        let refs13: Vec<&str> = addrs13.iter().map(|s| s.as_str()).collect();
        let mut c = new_contract();
        let doc = criteria_custom(&["600", "400", "300", "200"], "0", "0");
        ctx(SPONSOR, ONE_NEAR, ts());
        c.create_bounty(7, TOKEN.to_string(), doc.clone()).unwrap();
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &refs13);
        // 78 sigs (5 x 13 + identity x 13): qualify rejects...
        let over = n_proof_bundle(7, &doc, RECIPIENT, 5, 700, HEAD_B, &keys13, 0, 0, 0);
        let err = qualify(&mut c, 7, &doc, over, RECIPIENT).unwrap_err();
        assert!(err.contains("TOO_MANY_SIGNATURES"), "unexpected: {err}");
        // ...dry reports the identical deterministic rejection...
        let over = n_proof_bundle(7, &doc, RECIPIENT, 5, 700, HEAD_B, &keys13, 0, 0, 0);
        let d = c.dry_qualify(7, doc.clone(), over, RECIPIENT.to_string());
        assert!(!d.ok);
        assert!(d
            .errors
            .iter()
            .any(|e| e.starts_with("TOO_MANY_SIGNATURES")));
        // ...no nullifiers burned: 3 x 13 + identity (52 sigs) now pass.
        let under = n_proof_bundle(7, &doc, RECIPIENT, 3, 700, HEAD_B, &keys13, 0, 0, 0);
        qualify(&mut c, 7, &doc, under, RECIPIENT).unwrap();
        // Exactly 64 passes: 3 x 16 + identity x 16 with fresh identifiers.
        let keys16: Vec<[u8; 32]> = (1u8..=16).map(|b| [b; 32]).collect();
        let addrs16: Vec<String> = keys16
            .iter()
            .map(|k| format!("0x{}", hex::encode(witness_addr_for(k))))
            .collect();
        pin_witness(
            &mut c,
            1,
            &addrs16.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        );
        let exact = n_proof_bundle(7, &doc, RECIPIENT, 3, 800, HEAD_C, &keys16, 0, 0, 0);
        assert_eq!(
            exact
                .iter()
                .map(|t| t.proof.signed_claim.signatures.len())
                .sum::<usize>(),
            64
        );
        qualify(&mut c, 7, &doc, exact, RECIPIENT).unwrap();
        // Empty signatures fail closed (per-proof pre-crypto check).
        let mut empty = n_proof_bundle(7, &doc, RECIPIENT, 2, 900, HEAD_D, &keys16, 0, 0, 0);
        empty[0].proof.signed_claim.signatures.clear();
        let err = qualify(&mut c, 7, &doc, empty, RECIPIENT).unwrap_err();
        assert!(err.contains("INVALID_LENGTH"), "unexpected: {err}");
    }

    #[test]
    fn gas_create_bounty_by_criteria_size() {
        let goldens: [(&str, &str); 8] = [
            (
                "simple-ci",
                include_str!("../../../testdata/v3/criteria-valid/simple-ci.json"),
            ),
            (
                "multi-check",
                include_str!("../../../testdata/v3/criteria-valid/multi-check.json"),
            ),
            (
                "protected",
                include_str!("../../../testdata/v3/criteria-valid/protected.json"),
            ),
            (
                "forbidden",
                include_str!("../../../testdata/v3/criteria-valid/forbidden.json"),
            ),
            (
                "merged",
                include_str!("../../../testdata/v3/criteria-valid/merged.json"),
            ),
            (
                "multi-winner",
                include_str!("../../../testdata/v3/criteria-valid/multi-winner.json"),
            ),
            (
                "weighted",
                include_str!("../../../testdata/v3/criteria-valid/weighted.json"),
            ),
            (
                "deadline-challenge",
                include_str!("../../../testdata/v3/criteria-valid/deadline-challenge.json"),
            ),
        ];
        // Distinct bounty ids: mock storage persists across testing_env!.
        for (i, (name, doc)) in goldens.into_iter().enumerate() {
            let mut c = new_contract();
            ctx(SPONSOR, ONE_NEAR, ts());
            let before = env::used_gas().as_gas();
            c.create_bounty(100 + i as u64, TOKEN.to_string(), doc.to_string())
                .unwrap();
            let g = env::used_gas().as_gas() - before;
            eprintln!("GAS_CREATE {name} bytes={} gas={g}", doc.len());
            assert!(g < 50_000_000_000_000, "{name} create gas {g}");
        }
    }

    #[test]
    fn gas_finalize_path() {
        // setup_finalizable("0") inlined with measurement around prepare.
        let mut c = new_contract();
        let doc = criteria_custom(&["600"], "0", "0");
        ctx(SPONSOR, ONE_NEAR, ts());
        c.create_bounty(7, TOKEN.to_string(), doc.clone()).unwrap();
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &[&witness_hex()]);
        ctx(OWNER, 0, ts());
        c.set_mpc_signer(mpc_addr_hex()).unwrap();
        qualify(
            &mut c,
            7,
            &doc,
            passing_bundle(7, &doc, RECIPIENT, 100, HEAD_A),
            RECIPIENT,
        )
        .unwrap();
        ctx("caller.testnet", ONE_NEAR, ts());
        let before = env::used_gas().as_gas();
        let _ = c.prepare_finalize(7, 0).unwrap();
        let g = env::used_gas().as_gas() - before;
        eprintln!("GAS_FINALIZE slot0 gas={g}");
        assert!(g < 20_000_000_000_000, "finalize gas {g}");
    }

    #[test]
    fn gas_max_payload_bundle() {
        // Size-term measurement, both arms within the 256KB total cap
        // (guarded by assert). Mock numbers = LOWER BOUNDS (WASM JSON
        // parse unmetered here; Linux measures it). Outcome-tolerant:
        // both gates pass by construction, so crypto always runs and
        // any rules outcome still measures the size term.
        let keys1: Vec<[u8; 32]> = vec![[0x11u8; 32]];
        let addr = format!("0x{}", hex::encode(witness_addr_for(&keys1[0])));
        for (id, n, pr, pad) in [(7u64, 39usize, 600u64, 0usize), (8, 11, 700, 15_000usize)] {
            let mut c = new_contract();
            let doc = criteria_custom(&["600", "400", "300", "200"], "0", "0");
            ctx(SPONSOR, ONE_NEAR, ts());
            c.create_bounty(id, TOKEN.to_string(), doc.clone()).unwrap();
            fund(&mut c, id);
            pin_witness(&mut c, 1, &[addr.as_str()]);
            let bundle = n_proof_bundle(id, &doc, RECIPIENT, n, pr, HEAD_A, &keys1, pad, pad, 0);
            let ev_bytes: usize = bundle
                .iter()
                .map(|t| t.proof.claim_info.parameters.len() + t.proof.claim_info.context.len())
                .sum();
            assert!(
                ev_bytes <= reclaim::MAX_TOTAL_EVIDENCE_BYTES,
                "arm exceeds cap: {ev_bytes}"
            );
            ctx("caller.testnet", ONE_NEAR, ts());
            let before = env::used_gas().as_gas();
            let res = c.qualify_claim(id, doc, bundle, RECIPIENT.to_string());
            let g = env::used_gas().as_gas() - before;
            eprintln!(
                "GAS_PAYLOAD proofs={n} ev_bytes={ev_bytes} passed={} err={:?} gas={g}",
                res.is_ok(),
                res.err()
            );
        }
    }

    /// Total-payload cap boundaries: 16 proofs x exactly 16384 evidence
    /// bytes = 262144 (at cap) qualifies; +1 byte per check proof is
    /// rejected by qualify and dry alike with ProofTooLarge("bundle").
    #[test]
    fn total_payload_cap_boundaries() {
        fn ev_total(bundle: &[TaggedProofArg]) -> usize {
            bundle
                .iter()
                .map(|t| t.proof.claim_info.parameters.len() + t.proof.claim_info.context.len())
                .sum()
        }
        let keys1: Vec<[u8; 32]> = vec![[0x11u8; 32]];
        let addr = format!("0x{}", hex::encode(witness_addr_for(&keys1[0])));
        let mut c = new_contract();
        let doc = criteria_custom(&["600", "400", "300", "200"], "0", "0");
        ctx(SPONSOR, ONE_NEAR, ts());
        c.create_bounty(7, TOKEN.to_string(), doc.clone()).unwrap();
        fund(&mut c, 7);
        pin_witness(&mut c, 1, &[addr.as_str()]);
        // Measure per-kind base sizes with matcher top-up active (pad=1).
        // Fifteen PR/check proofs plus the appended identity proof.
        let probe = n_proof_bundle(7, &doc, RECIPIENT, 15, 700, HEAD_B, &keys1, 1, 1, 1);
        let pr_base = probe[0].proof.claim_info.parameters.len()
            + probe[0].proof.claim_info.context.len()
            - 1;
        let chk_base = probe[1].proof.claim_info.parameters.len()
            + probe[1].proof.claim_info.context.len()
            - 1;
        let id_base = probe[15].proof.claim_info.parameters.len()
            + probe[15].proof.claim_info.context.len()
            - 1;
        // Context grows 1:1 with pad length ("y" needs no JSON escaping).
        let pad_pr = 16_384 - pr_base;
        let pad_chk = 16_384 - chk_base;
        let pad_id = 16_384 - id_base;
        let at = n_proof_bundle(
            7, &doc, RECIPIENT, 15, 700, HEAD_B, &keys1, pad_pr, pad_chk, pad_id,
        );
        assert_eq!(ev_total(&at), 262_144);
        for t in &at {
            assert!(t.proof.claim_info.parameters.len() <= 16_384);
            assert!(t.proof.claim_info.context.len() <= 16_384);
        }
        // Over by 14 bytes (one per check proof): dry and qualify agree.
        let over = n_proof_bundle(
            7,
            &doc,
            RECIPIENT,
            15,
            700,
            HEAD_B,
            &keys1,
            pad_pr,
            pad_chk + 1,
            pad_id,
        );
        assert_eq!(ev_total(&over), 262_144 + 14);
        let d = c.dry_qualify(7, doc.clone(), over, RECIPIENT.to_string());
        assert!(!d.ok);
        assert!(d.errors.iter().any(|e| e.starts_with("PROOF_TOO_LARGE")));
        let over = n_proof_bundle(
            7,
            &doc,
            RECIPIENT,
            15,
            700,
            HEAD_B,
            &keys1,
            pad_pr,
            pad_chk + 1,
            pad_id,
        );
        let err = qualify(&mut c, 7, &doc, over, RECIPIENT).unwrap_err();
        assert!(err.contains("PROOF_TOO_LARGE"), "unexpected: {err}");
        assert!(err.contains("bundle"), "unexpected: {err}");
        // At cap qualifies (failed over-claim poisoned nothing).
        qualify(&mut c, 7, &doc, at, RECIPIENT).unwrap();
    }

    #[test]
    fn gas_k256_recovery_native_timing() {
        // PRE-MIGRATION REFERENCE (Phase 5.1): native cost of the REMOVED
        // in-WASM k256 recovery, kept as the "before" anchor for the gas
        // write-up. Production now uses host ecrecover (protocol-metered
        // 0.294 Tgas/call; see GAS_HOST numbers below, which INCLUDE
        // recovery). Lower bound ONLY: native x86 is far faster per op
        // than metered WASM.
        use k256::ecdsa::SigningKey;
        use std::time::Instant;
        let key = SigningKey::from_bytes((&[0x11u8; 32]).into()).unwrap();
        let digest = [0x42u8; 32];
        let (sig, recid) = key.sign_prehash_recoverable(&digest).unwrap();
        let mut rs = [0u8; 64];
        rs[..32].copy_from_slice(&sig.r().to_bytes());
        rs[32..].copy_from_slice(&sig.s().to_bytes());
        let v = recid.to_byte();
        // Warmup.
        for _ in 0..5 {
            let _ = crate::ecrecover_equiv::k256_raw(&digest, v, &rs);
        }
        let iters = 50u32;
        let t0 = Instant::now();
        for _ in 0..iters {
            crate::ecrecover_equiv::k256_raw(&digest, v, &rs).unwrap();
        }
        let avg_ns = t0.elapsed().as_nanos() / iters as u128;
        eprintln!("K256_NATIVE_NS_PER_RECOVER {avg_ns}");
        // Absurdly generous smoke bound (debug builds are ~100x slower than
        // release; run this test with --release for the anchor number used
        // in the §8 calibration write-up).
        assert!(avg_ns < 100_000_000, "absurdly slow recovery: {avg_ns}ns");
    }

    /// System-level pin for the Phase 5.1 recovery migration: a bundle
    /// whose first witness signature per proof is malleated to high-S
    /// (`s' = N - s`, `27 <-> 28`) still qualifies — the pre-migration
    /// k256 path rejected it with `RecoveryFailed`. The twin recovers the
    /// same witness address, so set-membership and nullifiers are
    /// unaffected.
    #[test]
    fn high_s_witness_signature_qualifies() {
        use crate::ecrecover_equiv::{be_gt, be_sub, SECP_N, SECP_N_HALF};
        let mut c = new_contract();
        let doc = criteria_custom(&["600", "400", "300", "200"], "0", "0");
        ctx(SPONSOR, ONE_NEAR, ts());
        c.create_bounty(7, TOKEN.to_string(), doc.clone()).unwrap();
        fund(&mut c, 7);
        let keys: Vec<[u8; 32]> = [0x11u8, 0x22].map(|b| [b; 32]).to_vec();
        let addrs: Vec<String> = keys
            .iter()
            .map(|k| format!("0x{}", hex::encode(witness_addr_for(k))))
            .collect();
        pin_witness(
            &mut c,
            1,
            &addrs.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        );
        let mut bundle = multi_sig_bundle(7, &doc, RECIPIENT, 104, HEAD_A, &keys);
        for tagged in bundle.iter_mut() {
            let raw = tagged.proof.signed_claim.signatures[0].clone();
            let bytes = hex::decode(raw.strip_prefix("0x").unwrap()).unwrap();
            let mut sig = [0u8; 65];
            sig.copy_from_slice(&bytes);
            let mut s = [0u8; 32];
            s.copy_from_slice(&sig[32..64]);
            // k256 signs low-S: strict, so the twin is strictly high-S
            // (non-vacuous: the pre-migration path MUST have rejected it).
            assert!(be_gt(&SECP_N_HALF, &s), "fixture sig must start low-S");
            let twin = be_sub(&SECP_N, &s);
            assert!(be_gt(&twin, &SECP_N_HALF), "malleated sig must be high-S");
            sig[32..64].copy_from_slice(&twin);
            sig[64] = if sig[64] == 27 { 28 } else { 27 };
            tagged.proof.signed_claim.signatures[0] = format!("0x{}", hex::encode(sig));
        }
        ctx("caller.testnet", ONE_NEAR, ts());
        c.qualify_claim(7, doc, bundle, RECIPIENT.to_string())
            .unwrap();
    }

    #[test]
    fn storage_state_sizes_bounded() {
        // Exact serialized sizes (Borsh) for storage-deposit guidance.
        // Worst case: 16-slot bounty.
        let bounty = BountyV3 {
            id: 7,
            sponsor: "sponsor.testnet".parse().unwrap(),
            token: [0x11u8; 20],
            criteria_hash: [0x22u8; 32],
            slots: vec![[0x33u8; 32]; 16],
            slots_filled: 0,
            total_amount: [0x44u8; 32],
            funded: false,
            deadline: 1,
            challenge_window: 2,
            created_at: 3,
            seq: 4,
        };
        let claim = ClaimRecord {
            bounty_id: 7,
            slot: 0,
            recipient: [0x55u8; 20],
            pr_number: 100,
            head_sha: [0x66u8; 20],
            github_created: 1794421000,
            claim_seq: 0,
            qualified_at: 1,
            status: CLAIM_CHALLENGEABLE,
            pending_digest: Some([0x77u8; 32]),
        };
        let bl = borsh::to_vec(&bounty).unwrap().len();
        let cl = borsh::to_vec(&claim).unwrap().len();
        eprintln!("STATE_BYTES bounty16={bl} claim={cl}");
        assert!(bl < 1024, "bounty too big: {bl}");
        assert!(cl < 256, "claim too big: {cl}");
    }

    #[test]
    fn storage_bounty_ids_push_is_eight_bytes() {
        // Locks the root-growth constant in `create_bounty`'s deposit
        // check: `Vec<u64>` Borsh layout is a u32 len plus 8 bytes per
        // element, so one push grows the serialized state by exactly 8.
        // Mock-independent (pure serialization lengths).
        let before: Vec<u64> = vec![1, 2, 3];
        let mut after = before.clone();
        after.push(4);
        let dl = borsh::to_vec(&after).unwrap().len() - borsh::to_vec(&before).unwrap().len();
        assert_eq!(dl, 8);
    }

    /// Serialized root-state length. Test-only ruler for owner-path
    /// growth bounds: map caches are `#[borsh(skip)]`, so the delta
    /// across a root-only mutation is exactly what `state_write` adds.
    /// Mock-independent (pure serialization, no `storage_usage`).
    fn root_len(c: &Contract) -> usize {
        borsh::to_vec(c).unwrap().len()
    }

    #[test]
    fn storage_owner_mpc_signer_first_set_is_twenty_bytes() {
        let mut c = new_contract();
        ctx(OWNER, 0, ts());
        let before = root_len(&c);
        c.set_mpc_signer(mpc_addr_hex()).unwrap();
        // None (1 B) -> Some([u8; 20]) (21 B).
        assert_eq!(root_len(&c) as i64 - before as i64, 20);
        // Re-setting is a same-size overwrite.
        let before = root_len(&c);
        c.set_mpc_signer(OTHER.to_string()).unwrap();
        assert_eq!(root_len(&c), before);
    }

    #[test]
    fn storage_owner_mpc_contract_delta_is_name_length_delta() {
        let mut c = new_contract();
        ctx(OWNER, 0, ts());
        let short = "ab".to_string();
        let long = format!("sub.{}", "a".repeat(60));
        assert_eq!(long.len(), 64);
        let before = root_len(&c);
        c.set_mpc_contract(short.parse().unwrap());
        // "mpc.testnet" (11) -> 2 chars.
        assert_eq!(root_len(&c) as i64 - before as i64, 2 - 11);
        let before = root_len(&c);
        c.set_mpc_contract(long.parse().unwrap());
        // Widest possible single-call swing: 62 bytes.
        assert_eq!(root_len(&c) as i64 - before as i64, 62);
    }

    #[test]
    fn storage_owner_transfer_bounded_by_name_length() {
        let mut c = new_contract();
        ctx(OWNER, 0, ts());
        let before = root_len(&c);
        let long = format!("sub.{}", "a".repeat(60));
        c.transfer_ownership(long.parse().unwrap());
        // None (1 B) -> Some (1 + 4 + 64 B): maximum +68.
        assert_eq!(root_len(&c) as i64 - before as i64, 68);
        let before = root_len(&c);
        c.transfer_ownership("ab".parse().unwrap());
        // Re-proposal swaps Some(64-char) for Some(2-char): -62.
        assert_eq!(root_len(&c) as i64 - before as i64, -62);
    }

    #[test]
    fn storage_owner_accept_always_shrinks() {
        for pending in [
            "next.testnet".to_string(),
            format!("sub.{}", "a".repeat(60)),
        ] {
            let mut c = new_contract();
            ctx(OWNER, 0, ts());
            c.transfer_ownership(pending.parse().unwrap());
            let before = root_len(&c);
            ctx(&pending, 0, ts());
            c.accept_ownership();
            // take() frees (4 + plen); owner swap adds (plen - olen):
            // net is -4 - olen regardless of the pending name.
            assert_eq!(
                root_len(&c) as i64 - before as i64,
                -(4 + OWNER.len() as i64)
            );
        }
    }
}
