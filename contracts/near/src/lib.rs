//! OmniBounty NEAR contract.
//!
//! Responsibilities:
//! - Own the Reclaim verification boundary (normalization, canonical JSON,
//!   identifier binding, ecrecovery) against PINNED witness sets — the
//!   deployed Reclaim verifier is never trusted at runtime.
//! - Bounty registry binding (repo, PR number, token, amount, expiry).
//! - Replay-safe claims: per-proof-identifier nullifiers + per-bounty status
//!   machine (Open -> Pending -> Claimed) so an in-flight MPC request can
//!   neither double-pay nor deadlock retries.
//! - EIP-712 voucher digests + Chain Signatures (MPC) authorization with an
//!   on-chain signer self-check.
//! - Strict grievance-free error model: every user-input failure is a stable
//!   `CODE: detail` string; no panics on user input outside `new` (deployer
//!   config). The MPC callback returns failures as data
//!   (`VoucherCallbackOutcome::Rejected`) instead of panicking, so the
//!   release-to-open COMMITS instead of rolling back.

use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault,
    Promise,
};

mod canon;
mod error;
mod mpc;
mod normalize;
mod reclaim;
mod template;
mod voucher;

use error::ClaimError;
use mpc::{MpcSignature, SignRequest};
use normalize::{
    parse_address, parse_hex, parse_identifier, parse_u256_decimal, to_hex,
    to_hex_prefixed, u256_is_zero, u256_to_decimal,
};
use reclaim::{verify_core, ProofInput};
use voucher::{digest as voucher_digest, Voucher};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Default EVM chain: Base Sepolia.
pub const DEFAULT_CHAIN_ID: u64 = 84532;
/// MPC derivation path for voucher signing.
pub const DEFAULT_VOUCHER_PATH: &str = "omnibounty-voucher-v1";
/// Gas attached to the MPC `sign` call.
pub const SIGN_GAS: Gas = Gas::from_tgas(100);
/// Gas reserved for the MPC callback.
pub const CALLBACK_GAS: Gas = Gas::from_tgas(40);
/// Callers should attach at least this much gas to `claim`.
pub const CLAIM_MIN_GAS: Gas = Gas::from_tgas(150);
/// Freshness defaults: proofs valid 7 days, 5 minutes future skew.
pub const DEFAULT_MAX_PROOF_AGE_SEC: u64 = 7 * 24 * 3600;
pub const DEFAULT_FUTURE_SKEW_SEC: u64 = 300;
/// Voucher lifetime when the bounty has no earlier expiry: 24h.
pub const DEFAULT_VOUCHER_TTL_SEC: u64 = 24 * 3600;
/// Registry DoS cap.
pub const MAX_BOUNTIES: usize = 10_000;
pub const MAX_LIST_LIMIT: u64 = 100;
pub const MAX_PATH_LEN: usize = 128;

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_PENDING: u8 = 1;
pub const STATUS_CLAIMED: u8 = 2;

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
pub struct Bounty {
    pub id: u64,
    pub repo: String,
    pub pr_number: u64,
    pub token: [u8; 20],
    /// EVM-native uint256, big-endian.
    pub amount: [u8; 32],
    pub sponsor: String,
    /// 0 = no expiry (voucher TTL still applies).
    pub expiry: u64,
    pub status: u8,
    pub created_at: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct PendingVoucher {
    pub bounty_id: u64,
    pub voucher: Voucher,
    pub identifier: [u8; 32],
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct SignedVoucher {
    pub voucher: Voucher,
    pub v: u8,
    pub r: [u8; 32],
    pub s: [u8; 32],
}

// ---------------------------------------------------------------------------
// Views (JSON)
// ---------------------------------------------------------------------------

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BountyView {
    pub id: u64,
    pub repo: String,
    pub pr_number: u64,
    pub token: String,
    pub amount: String,
    pub sponsor: String,
    pub expiry: u64,
    pub status: String,
    pub created_at: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VoucherView {
    pub bounty_id: u64,
    pub recipient: String,
    pub token: String,
    pub amount: String,
    pub nonce: u64,
    pub expiry: u64,
    pub chain_id: u64,
    pub escrow: String,
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

/// MPC callback outcome, returned as DATA (never via panic).
///
/// `on_voucher_signed` must commit its state changes on every path: a
/// panic anywhere in that receipt rolls the release back and wedges the
/// bounty in `Pending` forever (observed live on bounty #3).
/// `#[handle_result] Result<..>` does NOT help — it panics on `Err`
/// (`FunctionError::panic`) with the same rollback. So failures are
/// returned as `Rejected(code)` with a successful receipt instead; the
/// stable `CODE: detail` strings are unchanged, and every rejection also
/// emits a `voucher_rejected` log for operator monitoring.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum VoucherCallbackOutcome {
    Applied(SignedVoucherView),
    Rejected(String),
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PendingVoucherView {
    pub voucher: VoucherView,
    pub digest: String,
    pub bounty_id: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ConfigView {
    pub owner: String,
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
    pub next_nonce: u64,
    pub bounty_count: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct EpochView {
    pub epoch: u64,
    pub witnesses: Vec<String>,
}

fn status_str(s: u8) -> String {
    match s {
        STATUS_OPEN => "open",
        STATUS_PENDING => "pending",
        STATUS_CLAIMED => "claimed",
        _ => "unknown",
    }
    .to_string()
}

fn voucher_view(v: &Voucher) -> VoucherView {
    VoucherView {
        bounty_id: v.bounty_id,
        recipient: to_hex_prefixed(&v.recipient),
        token: to_hex_prefixed(&v.token),
        amount: u256_to_decimal(&v.amount),
        nonce: v.nonce,
        expiry: v.expiry,
        chain_id: v.chain_id,
        escrow: to_hex_prefixed(&v.escrow),
        digest: to_hex_prefixed(&voucher_digest(v)),
    }
}

// ---------------------------------------------------------------------------
// External contracts
// ---------------------------------------------------------------------------

#[ext_contract(ext_mpc)]
pub trait ExtMpc {
    /// MPC v3 `sign`: single `request` arg, serialized wrapped as
    /// `{"request": {"path", "payload_v2", "domain_id"}}. The deployed
    /// v3.18.0 contract rejects the legacy flat-arg shape.
    fn sign(&mut self, request: SignRequest) -> MpcSignature;
}

#[ext_contract(ext_self)]
pub trait ExtSelf {
    fn on_voucher_signed(&mut self, digest_hex: String) -> VoucherCallbackOutcome;
}

// ---------------------------------------------------------------------------
// Contract state
// ---------------------------------------------------------------------------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    paused: bool,
    mpc_contract: AccountId,
    /// Expected MPC EVM address; claims fail closed until set.
    mpc_signer: Option<[u8; 20]>,
    escrow: [u8; 20],
    chain_id: u64,
    voucher_path: String,
    /// MPC domain id (0 = legacy secp256k1 ECDSA domain).
    domain_id: u64,
    max_proof_age_sec: u64,
    future_skew_sec: u64,
    voucher_ttl_sec: u64,
    next_nonce: u64,
    bounty_ids: Vec<u64>,
    epochs: LookupMap<u64, PinnedEpoch>,
    bounties: LookupMap<u64, Bounty>,
    used_identifiers: LookupSet<[u8; 32]>,
    pending: LookupMap<[u8; 32], PendingVoucher>,
    vouchers: LookupMap<u64, SignedVoucher>,
    relayed: LookupSet<[u8; 32]>,
}

fn now_sec() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn log_event(event: &str, data: &str) {
    env::log_str(&format!(
        "{{\"standard\":\"omnibounty\",\"event\":\"{event}\",{data}}}"
    ));
}

fn log_rejected(bounty_id: Option<u64>, digest_hex: &str, reason: &str) {
    let id = bounty_id.map(|b| b.to_string()).unwrap_or_else(|| "null".to_string());
    // Reasons and digests are operator-controlled or hex; strip quotes so
    // the log line stays valid JSON regardless.
    let safe_reason = reason.replace('"', "'");
    let safe_digest = digest_hex.replace('"', "'");
    log_event(
        "voucher_rejected",
        &format!("\"bounty_id\":{id},\"digest\":\"{safe_digest}\",\"reason\":\"{safe_reason}\""),
    );
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner: AccountId,
        mpc_contract: AccountId,
        escrow: String,
        chain_id: u64,
    ) -> Self {
        let escrow_addr = parse_address("escrow", &escrow)
            .unwrap_or_else(|e| env::panic_str(&e.to_string()));
        Self {
            owner,
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
            next_nonce: 0,
            bounty_ids: Vec::new(),
            epochs: LookupMap::new(b"e".to_vec()),
            bounties: LookupMap::new(b"b".to_vec()),
            used_identifiers: LookupSet::new(b"u".to_vec()),
            pending: LookupMap::new(b"p".to_vec()),
            vouchers: LookupMap::new(b"v".to_vec()),
            relayed: LookupSet::new(b"r".to_vec()),
        }
    }

    // -- Admin ------------------------------------------------------------

    fn assert_owner(&self) {
        if env::predecessor_account_id() != self.owner {
            env::panic_str(&ClaimError::NotOwner.to_string());
        }
    }

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

    #[handle_result]
    pub fn set_voucher_path(&mut self, path: String) -> Result<(), String> {
        self.assert_owner();
        if path.is_empty() || path.len() > MAX_PATH_LEN {
            return Err(ClaimError::InvalidConfig("bad voucher path").into());
        }
        self.voucher_path = path;
        Ok(())
    }

    pub fn set_domain_id(&mut self, domain_id: u64) {
        self.assert_owner();
        self.domain_id = domain_id;
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

    #[handle_result]
    pub fn upsert_epoch(
        &mut self,
        epoch_id: u64,
        witnesses: Vec<String>,
    ) -> Result<(), String> {
        self.assert_owner();
        if witnesses.is_empty() || witnesses.len() > reclaim::MAX_SIGNATURES {
            return Err(ClaimError::InvalidLength("witnesses").into());
        }
        let mut addrs: Vec<[u8; 20]> = Vec::with_capacity(witnesses.len());
        for w in &witnesses {
            let a = parse_address("witness", w)?;
            if addrs.contains(&a.0) {
                return Err(ClaimError::DuplicateSignature.into());
            }
            addrs.push(a.0);
        }
        self.epochs.insert(epoch_id, PinnedEpoch { witnesses: addrs });
        Ok(())
    }

    pub fn remove_epoch(&mut self, epoch_id: u64) {
        self.assert_owner();
        self.epochs.remove(&epoch_id);
    }

    // -- Bounties ---------------------------------------------------------

    #[handle_result]
    pub fn create_bounty(
        &mut self,
        bounty_id: u64,
        repo: String,
        pr_number: u64,
        token: String,
        amount: String,
        expiry: u64,
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
        template::validate_repo(&repo)?;
        if pr_number == 0 {
            return Err(ClaimError::TemplateMismatch("bad pr_number").into());
        }
        let token_addr = parse_address("token", &token)?;
        let amount_val = parse_u256_decimal(&amount)?;
        if u256_is_zero(&amount_val) {
            return Err(ClaimError::ZeroAmount.into());
        }
        if expiry != 0 && expiry <= now_sec() {
            return Err(ClaimError::BountyExpired(bounty_id).into());
        }
        let bounty = Bounty {
            id: bounty_id,
            repo,
            pr_number,
            token: token_addr.0,
            amount: amount_val,
            sponsor: env::predecessor_account_id().to_string(),
            expiry,
            status: STATUS_OPEN,
            created_at: now_sec(),
        };
        self.bounties.insert(bounty_id, bounty.clone());
        self.bounty_ids.push(bounty_id);
        log_event(
            "bounty_created",
            &format!("\"bounty_id\":{bounty_id}"),
        );
        Ok(self.bounty_view(&bounty))
    }

    // -- Claims -----------------------------------------------------------

    /// Submit a proof for a bounty. On success schedules the MPC signing
    /// request; the signed voucher is available after `on_voucher_signed`.
    /// Callers must attach at least `CLAIM_MIN_GAS`.
    pub fn claim(
        &mut self,
        bounty_id: u64,
        proof: ProofInput,
        recipient: String,
    ) -> Promise {
        let (_voucher, digest) = match self.prepare_claim(bounty_id, &proof, &recipient) {
            Ok(v) => v,
            Err(e) => env::panic_str(&e.to_string()),
        };
        log_event(
            "claim_submitted",
            &format!(
                "\"bounty_id\":{bounty_id},\"digest\":\"{}\"",
                to_hex_prefixed(&digest)
            ),
        );
        ext_mpc::ext(self.mpc_contract.clone())
            .with_static_gas(SIGN_GAS)
            // 1 yoctoNEAR, paid from this contract's balance: `sign`
            // rejects zero-deposit calls. 100 Tgas >> 15 Tgas required.
            .with_attached_deposit(NearToken::from_yoctonear(
                mpc::SIGN_DEPOSIT_YOCTONEAR,
            ))
            .sign(SignRequest::ecdsa(
                self.voucher_path.clone(),
                &digest,
                self.domain_id,
            ))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_voucher_signed(to_hex(&digest)),
            )
    }

    /// MPC callback. On promise failure the bounty is released back to Open
    /// so the claim can be retried; the identifier is nullified only on
    /// success. The recovered MPC signer must equal the configured address.
    ///
    /// The promise result is read as RAW BYTES via `env::promise_result`
    /// and parsed manually. A typed `#[callback_result]` would let the
    /// framework JSON-deserialize the MPC response: any shape mismatch
    /// (or even `Vec<u8>`, which expects a JSON array, not bytes) PANICS
    /// before this method runs and wedges the bounty in Pending forever.
    ///
    /// This method itself NEVER PANICS on MPC data either: every failure
    /// is returned as `VoucherCallbackOutcome::Rejected`, so the receipt
    /// succeeds and the release COMMITS. (A panic here would roll the
    /// release back and wedge the bounty — the bounty #3 incident.
    /// `#[handle_result] Result<..>` is equally wrong: it panics on
    /// `Err`.) Every malformed-input path below releases the bounty first.
    ///
    /// Stale callbacks (unknown digest: retries consume a fresh nonce, so
    /// each attempt has a distinct digest) find no pending entry and return
    /// `Rejected` WITHOUT touching any bounty state.
    #[private]
    pub fn on_voucher_signed(&mut self, digest_hex: String) -> VoucherCallbackOutcome {
        use near_sdk::PromiseResult;

        let digest: [u8; 32] = match parse_hex("digest", &digest_hex) {
            Ok(d) => d,
            Err(e) => return VoucherCallbackOutcome::Rejected(e.to_string()),
        };
        let digest_str = to_hex_prefixed(&digest);
        // Look up the bounty id for observability only; the authoritative
        // pending check happens inside the apply path below.
        let bounty_id = self.pending.get(&digest).map(|p| p.bounty_id);
        let bytes = match env::promise_result(0) {
            PromiseResult::Successful(b) => b,
            _ => {
                self.release_pending(&digest);
                let reason = ClaimError::MpcFailed.to_string();
                log_rejected(bounty_id, &digest_str, &reason);
                return VoucherCallbackOutcome::Rejected(reason);
            }
        };
        let resp: MpcSignature = match serde_json::from_slice(&bytes) {
            Ok(r) => r,
            Err(_) => {
                self.release_pending(&digest);
                let reason = ClaimError::MpcBadResponse("unparseable json").to_string();
                log_rejected(bounty_id, &digest_str, &reason);
                return VoucherCallbackOutcome::Rejected(reason);
            }
        };
        match self.apply_mpc_signature(&digest, &resp) {
            Ok(v) => VoucherCallbackOutcome::Applied(v),
            Err(e) => {
                let reason = e.to_string();
                log_rejected(bounty_id, &digest_str, &reason);
                VoucherCallbackOutcome::Rejected(reason)
            }
        }
    }

    /// Permissionless relay hint. The relayer MUST treat the escrow's
    /// `usedVoucher` state as ground truth; this flag is UX only and a false
    /// hint cannot block a payout (relayer re-checks on-chain).
    #[handle_result]
    pub fn mark_relayed(&mut self, digest_hex: String) -> Result<bool, String> {
        let digest: [u8; 32] = parse_hex("digest", &digest_hex)?;
        self.relayed.insert(digest);
        Ok(true)
    }

    // -- Views ------------------------------------------------------------

    pub fn get_bounty(&self, bounty_id: u64) -> Option<BountyView> {
        self.bounties.get(&bounty_id).map(|b| self.bounty_view(b))
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

    pub fn get_voucher(&self, bounty_id: u64) -> Option<SignedVoucherView> {
        self.vouchers.get(&bounty_id).map(signed_view)
    }

    #[handle_result]
    pub fn get_pending(
        &self,
        digest_hex: String,
    ) -> Result<Option<PendingVoucherView>, String> {
        let digest: [u8; 32] = parse_hex("digest", &digest_hex)?;
        Ok(self.pending.get(&digest).map(|p| PendingVoucherView {
            voucher: voucher_view(&p.voucher),
            digest: to_hex_prefixed(&digest),
            bounty_id: p.bounty_id,
        }))
    }

    /// Unrelayed signed vouchers (relayer work queue). Bounded scan over the
    /// registry; the relayer confirms each against escrow state.
    pub fn list_unrelayed(&self, limit: u64) -> Vec<SignedVoucherView> {
        let limit = limit.min(MAX_LIST_LIMIT) as usize;
        let mut out = Vec::new();
        for id in &self.bounty_ids {
            if out.len() >= limit {
                break;
            }
            if let Some(s) = self.vouchers.get(id) {
                let d = voucher_digest(&s.voucher);
                if !self.relayed.contains(&d) {
                    out.push(signed_view(s));
                }
            }
        }
        out
    }

    pub fn is_identifier_used(&self, identifier_hex: String) -> bool {
        parse_hex::<32>("identifier", &identifier_hex)
            .map(|d| self.used_identifiers.contains(&d))
            .unwrap_or(false)
    }

    pub fn is_relayed(&self, digest_hex: String) -> bool {
        parse_hex::<32>("digest", &digest_hex)
            .map(|d| self.relayed.contains(&d))
            .unwrap_or(false)
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.to_string(),
            paused: self.paused,
            mpc_contract: self.mpc_contract.to_string(),
            mpc_signer: self.mpc_signer.map(|a| to_hex_prefixed(&a)),
            escrow: to_hex_prefixed(&self.escrow),
            chain_id: self.chain_id,
            voucher_path: self.voucher_path.clone(),
            domain_id: self.domain_id,
            max_proof_age_sec: self.max_proof_age_sec,
            future_skew_sec: self.future_skew_sec,
            voucher_ttl_sec: self.voucher_ttl_sec,
            next_nonce: self.next_nonce,
            bounty_count: self.bounty_ids.len() as u64,
        }
    }

    pub fn get_epoch(&self, epoch_id: u64) -> Option<EpochView> {
        self.epochs.get(&epoch_id).map(|e| EpochView {
            epoch: epoch_id,
            witnesses: e.witnesses.iter().map(|w| to_hex_prefixed(w)).collect(),
        })
    }

    /// Dry-run the full verification pipeline without state changes or MPC.
    /// Returns `OK digest=.. nonce=..` (the nonce shown is informational;
    /// the real nonce is assigned at claim time).
    #[handle_result]
    pub fn dry_run(
        &self,
        bounty_id: u64,
        proof: ProofInput,
        recipient: String,
    ) -> Result<String, String> {
        let (voucher, digest) = self.check_claim(bounty_id, &proof, &recipient)?;
        Ok(format!(
            "OK digest={} nonce={} amount={} expiry={}",
            to_hex_prefixed(&digest),
            voucher.nonce,
            u256_to_decimal(&voucher.amount),
            voucher.expiry
        ))
    }
}

// ---------------------------------------------------------------------------
// Internals (unit-testable without promise machinery)
// ---------------------------------------------------------------------------

impl Contract {
    fn bounty_view(&self, b: &Bounty) -> BountyView {
        BountyView {
            id: b.id,
            repo: b.repo.clone(),
            pr_number: b.pr_number,
            token: to_hex_prefixed(&b.token),
            amount: u256_to_decimal(&b.amount),
            sponsor: b.sponsor.clone(),
            expiry: b.expiry,
            status: status_str(b.status),
            created_at: b.created_at,
        }
    }

    /// Pure verification + voucher construction. No state mutation.
    fn check_claim(
        &self,
        bounty_id: u64,
        proof: &ProofInput,
        recipient: &str,
    ) -> Result<(Voucher, [u8; 32]), ClaimError> {
        if self.paused {
            return Err(ClaimError::Paused);
        }
        let bounty = self
            .bounties
            .get(&bounty_id)
            .ok_or(ClaimError::BountyNotFound(bounty_id))?;
        match bounty.status {
            STATUS_OPEN => {}
            STATUS_PENDING => return Err(ClaimError::BountyPending(bounty_id)),
            _ => return Err(ClaimError::BountyNotOpen(bounty_id)),
        }
        let now = now_sec();
        if bounty.expiry != 0 && now > bounty.expiry {
            return Err(ClaimError::BountyExpired(bounty_id));
        }
        if self.mpc_signer.is_none() {
            return Err(ClaimError::MpcNotConfigured);
        }

        let recipient_addr = parse_address("recipient", recipient)?;
        let epoch_cfg = self
            .epochs
            .get(&proof.signed_claim.claim.epoch)
            .ok_or(ClaimError::UnknownEpoch(proof.signed_claim.claim.epoch))?;
        let verified = verify_core(proof, &epoch_cfg.witnesses)?;

        // Binding: payout goes to the proof owner, nobody else. A frontrunner
        // replaying someone's proof cannot redirect the funds.
        if verified.owner != recipient_addr.0 {
            return Err(ClaimError::RecipientMismatch);
        }
        if self.used_identifiers.contains(&verified.identifier) {
            return Err(ClaimError::IdentifierReplay);
        }

        // Freshness window (saturating arithmetic; no overflow panics).
        if verified.timestamp_s > now.saturating_add(self.future_skew_sec) {
            return Err(ClaimError::ProofFromFuture);
        }
        if verified.timestamp_s.saturating_add(self.max_proof_age_sec) < now {
            return Err(ClaimError::ProofTooOld);
        }

        // Template: parameters re-parsed (already proven canonical inside
        // verify_core), context parsed in submitted form.
        let params_value =
            canon::parse_capped("parameters", &proof.claim_info.parameters)?;
        let context_value = if proof.claim_info.context.is_empty() {
            serde_json::Value::Null
        } else {
            canon::parse_capped("context", &proof.claim_info.context)?
        };
        template::validate_template(
            &params_value,
            &context_value,
            &bounty.repo,
            bounty.pr_number,
        )?;

        let ttl_expiry = now.saturating_add(self.voucher_ttl_sec);
        let expiry = match bounty.expiry {
            0 => ttl_expiry,
            e => e.min(ttl_expiry),
        };
        let voucher = Voucher {
            bounty_id,
            recipient: verified.owner,
            token: bounty.token,
            amount: bounty.amount,
            nonce: self.next_nonce,
            expiry,
            chain_id: self.chain_id,
            escrow: self.escrow,
        };
        let voucher_digest = voucher::digest(&voucher);
        Ok((voucher, voucher_digest))
    }

    /// Reserve state for a claim: bounty -> Pending, nonce consumed, pending
    /// voucher stored. Called only after `check_claim` succeeds.
    fn prepare_claim(
        &mut self,
        bounty_id: u64,
        proof: &ProofInput,
        recipient: &str,
    ) -> Result<(Voucher, [u8; 32]), ClaimError> {
        let (voucher, digest) = self.check_claim(bounty_id, proof, recipient)?;
        self.next_nonce =
            self.next_nonce.checked_add(1).ok_or(ClaimError::NonceOverflow)?;
        if let Some(bounty) = self.bounties.get_mut(&bounty_id) {
            bounty.status = STATUS_PENDING;
        }
        // Already validated inside check_claim; re-derive canonical bytes.
        let identifier =
            parse_identifier(&proof.signed_claim.claim.identifier)?.0;
        self.pending.insert(
            digest,
            PendingVoucher {
                bounty_id,
                voucher,
                identifier,
            },
        );
        Ok((voucher, digest))
    }

    fn release_pending(&mut self, digest: &[u8; 32]) {
        if let Some(p) = self.pending.remove(digest) {
            if let Some(bounty) = self.bounties.get_mut(&p.bounty_id) {
                if bounty.status == STATUS_PENDING {
                    bounty.status = STATUS_OPEN;
                }
            }
        }
    }

    fn apply_mpc_signature(
        &mut self,
        digest: &[u8; 32],
        resp: &MpcSignature,
    ) -> Result<SignedVoucherView, ClaimError> {
        let pending = match self.pending.remove(digest) {
            Some(p) => p,
            None => return Err(ClaimError::NoPendingVoucher),
        };
        let fail = |contract: &mut Self, pending: &PendingVoucher, e: ClaimError| {
            if let Some(bounty) = contract.bounties.get_mut(&pending.bounty_id) {
                if bounty.status == STATUS_PENDING {
                    bounty.status = STATUS_OPEN;
                }
            }
            e
        };
        // Defense: the pending voucher must reproduce this digest.
        if voucher::digest(&pending.voucher) != *digest {
            return Err(fail(
                self,
                &pending,
                ClaimError::MpcBadResponse("digest mismatch"),
            ));
        }
        let sig = match mpc::parse_mpc_signature(resp) {
            Ok(s) => s,
            Err(e) => return Err(fail(self, &pending, e)),
        };
        let expected = match self.mpc_signer {
            Some(a) => a,
            None => return Err(fail(self, &pending, ClaimError::MpcNotConfigured)),
        };
        if let Err(e) = mpc::check_mpc_signer(digest, &sig, &expected) {
            return Err(fail(self, &pending, e));
        }
        let signed = SignedVoucher {
            voucher: pending.voucher,
            v: sig.v,
            r: sig.r,
            s: sig.s,
        };
        self.vouchers.insert(pending.bounty_id, signed.clone());
        self.used_identifiers.insert(pending.identifier);
        if let Some(bounty) = self.bounties.get_mut(&pending.bounty_id) {
            bounty.status = STATUS_CLAIMED;
        }
        log_event(
            "voucher_signed",
            &format!(
                "\"bounty_id\":{},\"digest\":\"{}\"",
                pending.bounty_id,
                to_hex_prefixed(digest)
            ),
        );
        Ok(signed_view(&signed))
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

#[cfg(test)]
mod contract_tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const OWNER: &str = "owner.testnet";
    const SPONSOR: &str = "sponsor.testnet";
    const MPC: &str = "v1.signer-prod.testnet";

    fn fixture() -> serde_json::Value {
        let raw = include_str!("../../../testdata/e2e_claim.json");
        serde_json::from_str(raw).unwrap()
    }

    fn ctx(predecessor: &str, timestamp_nanos: u64) {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(predecessor.parse().unwrap());
        b.block_timestamp(timestamp_nanos);
        testing_env!(b.build());
    }

    fn block_nanos(fx: &serde_json::Value) -> u64 {
        fx["config"]["blockTimestamp"].as_u64().unwrap() * 1_000_000_000
    }

    /// Fully configured contract: epoch pinned, MPC signer set, bounty open.
    fn setup() -> (Contract, serde_json::Value) {
        let fx = fixture();
        let cfg = &fx["config"];
        ctx(OWNER, block_nanos(&fx));
        let mut c = Contract::new(
            OWNER.parse().unwrap(),
            MPC.parse().unwrap(),
            cfg["escrow"].as_str().unwrap().to_string(),
            cfg["chainId"].as_u64().unwrap(),
        );
        c.set_mpc_signer(fx["mpcSigner"].as_str().unwrap().to_string()).unwrap();
        c.upsert_epoch(1, vec![fx["witness"].as_str().unwrap().to_string()]).unwrap();
        ctx(SPONSOR, block_nanos(&fx));
        c.create_bounty(
            cfg["bountyId"].as_u64().unwrap(),
            "octocat/Hello-World".to_string(),
            7,
            cfg["token"].as_str().unwrap().to_string(),
            cfg["amount"].as_str().unwrap().to_string(),
            cfg["bountyExpiry"].as_u64().unwrap(),
        )
        .unwrap();
        (c, fx)
    }

    fn proof_input(fx: &serde_json::Value) -> ProofInput {
        serde_json::from_value(fx["proof"].clone()).unwrap()
    }

    fn mpc_response(fx: &serde_json::Value) -> MpcSignature {
        serde_json::from_value(fx["mpcResponse"].clone()).unwrap()
    }

    #[test]
    fn dry_run_matches_oracle_digest() {
        let (c, fx) = setup();
        let out = c
            .dry_run(7, proof_input(&fx), fx["proof"]["signedClaim"]["claim"]["owner"].as_str().unwrap().to_string())
            .unwrap();
        assert!(
            out.contains(fx["digest"].as_str().unwrap()),
            "dry_run output: {out}"
        );
    }

    #[test]
    fn full_claim_lifecycle() {
        let (mut c, fx) = setup();
        let owner = fx["proof"]["signedClaim"]["claim"]["owner"].as_str().unwrap();
        let proof = proof_input(&fx);

        // Reserve.
        let (voucher, digest) =
            c.prepare_claim(7, &proof, owner).unwrap();
        assert_eq!(format!("0x{}", to_hex(&digest)), fx["digest"].as_str().unwrap());
        assert_eq!(voucher.nonce, 0);
        assert_eq!(u256_to_decimal(&voucher.amount), fx["voucher"]["amount"].as_str().unwrap());
        assert_eq!(c.get_bounty(7).unwrap().status, "pending");
        assert_eq!(c.get_config().next_nonce, 1);

        // Duplicate while pending is rejected (no double MPC request).
        assert_eq!(
            c.prepare_claim(7, &proof, owner).unwrap_err(),
            ClaimError::BountyPending(7)
        );

        // MPC success finalizes.
        let signed = c.apply_mpc_signature(&digest, &mpc_response(&fx)).unwrap();
        assert_eq!(signed.voucher.digest, fx["digest"].as_str().unwrap());
        assert_eq!(signed.v, 28);
        assert_eq!(c.get_bounty(7).unwrap().status, "claimed");
        assert!(c.is_identifier_used(
            fx["proof"]["signedClaim"]["claim"]["identifier"].as_str().unwrap().to_string()
        ));
        assert!(c.get_pending(format!("0x{}", to_hex(&digest))).unwrap().is_none());

        // Replay after success is rejected.
        assert_eq!(
            c.check_claim(7, &proof, owner).unwrap_err(),
            ClaimError::BountyNotOpen(7)
        );
    }

    #[test]
    fn recipient_must_equal_owner() {
        let (c, fx) = setup();
        let proof = proof_input(&fx);
        assert_eq!(
            c.check_claim(7, &proof, "0x0000000000000000000000000000000000000001").unwrap_err(),
            ClaimError::RecipientMismatch
        );
    }

    #[test]
    fn wrong_mpc_signer_fails_closed_and_releases() {
        let (mut c, fx) = setup();
        let owner = fx["proof"]["signedClaim"]["claim"]["owner"].as_str().unwrap();
        let proof = proof_input(&fx);
        let (_, digest) = c.prepare_claim(7, &proof, owner).unwrap();
        // Attacker swaps the configured signer mid-flight (or misconfiguration).
        ctx(OWNER, block_nanos(&fx));
        c.set_mpc_signer("0x0000000000000000000000000000000000000001".to_string()).unwrap();
        assert_eq!(
            c.apply_mpc_signature(&digest, &mpc_response(&fx)).unwrap_err(),
            ClaimError::MpcSignerMismatch
        );
        // Bounty released: retry is possible, funds were never authorized.
        assert_eq!(c.get_bounty(7).unwrap().status, "open");
        assert!(!c.is_identifier_used(
            fx["proof"]["signedClaim"]["claim"]["identifier"].as_str().unwrap().to_string()
        ));
    }

    #[test]
    fn bad_mpc_response_releases() {
        let (mut c, fx) = setup();
        let owner = fx["proof"]["signedClaim"]["claim"]["owner"].as_str().unwrap();
        let proof = proof_input(&fx);
        let (_, digest) = c.prepare_claim(7, &proof, owner).unwrap();
        let mut bad = mpc_response(&fx);
        bad.recovery_id = 9;
        assert!(c.apply_mpc_signature(&digest, &bad).is_err());
        assert_eq!(c.get_bounty(7).unwrap().status, "open");
    }

    #[test]
    fn stale_and_future_proofs_rejected() {
        let (c, fx) = setup();
        let owner = fx["proof"]["signedClaim"]["claim"]["owner"].as_str().unwrap();
        let proof = proof_input(&fx);
        // 8 days later: too old (window is 7 days).
        ctx(SPONSOR, block_nanos(&fx) + 8 * 24 * 3600 * 1_000_000_000);
        assert_eq!(
            c.check_claim(7, &proof, owner).unwrap_err(),
            ClaimError::ProofTooOld
        );
        // Before the proof timestamp minus skew: from the future.
        ctx(SPONSOR, (1794129286 - 3600) * 1_000_000_000);
        assert_eq!(
            c.check_claim(7, &proof, owner).unwrap_err(),
            ClaimError::ProofFromFuture
        );
    }

    #[test]
    fn admin_and_bounty_guards() {
        let (mut c, fx) = setup();
        ctx(SPONSOR, block_nanos(&fx));
        // Non-owner cannot pass set_paused (panics); bounty validation:
        assert!(c
            .create_bounty(7, "x/y".into(), 1, fx["config"]["token"].as_str().unwrap().into(), "1".into(), 0)
            .is_err()); // duplicate id
        assert!(c
            .create_bounty(8, "bad repo!".into(), 1, fx["config"]["token"].as_str().unwrap().into(), "1".into(), 0)
            .is_err());
        assert!(c
            .create_bounty(8, "a/b".into(), 0, fx["config"]["token"].as_str().unwrap().into(), "1".into(), 0)
            .is_err()); // pr 0
        assert!(c
            .create_bounty(8, "a/b".into(), 1, fx["config"]["token"].as_str().unwrap().into(), "0".into(), 0)
            .is_err()); // zero amount
        ctx(OWNER, block_nanos(&fx));
        c.set_paused(true);
        ctx(SPONSOR, block_nanos(&fx));
        assert!(c
            .create_bounty(9, "a/b".into(), 1, fx["config"]["token"].as_str().unwrap().into(), "1".into(), 0)
            .is_err()); // paused
    }

    #[test]
    fn unknown_epoch_rejected() {
        let (c, fx) = setup();
        let mut proof = proof_input(&fx);
        proof.signed_claim.claim.epoch = 999;
        let owner = fx["proof"]["signedClaim"]["claim"]["owner"].as_str().unwrap();
        assert_eq!(
            c.check_claim(7, &proof, owner).unwrap_err(),
            ClaimError::UnknownEpoch(999)
        );
    }

    #[test]
    fn unmerged_proof_rejected_end_to_end() {
        // The real spike proof (state=closed, no merged extraction) must NOT
        // claim a bounty even though its witness signature is valid.
        let raw = include_str!("../../../testdata/reclaim.json");
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();
        let spike = &v["spike"];
        let (c, _) = setup();
        let proof: ProofInput = serde_json::from_value(serde_json::json!({
            "claimInfo": spike["claimInfo"],
            "signedClaim": {
                "claim": {
                    "identifier": spike["claim"]["identifier"],
                    "owner": spike["claim"]["owner"],
                    "epoch": spike["claim"]["epoch"],
                    "timestampS": spike["claim"]["timestampS"],
                },
                "signatures": spike["signatures"],
            }
        }))
        .unwrap();
        // Fails at template/predicate stage (wrong URL + no merged proof).
        // Epoch 1 IS pinned but to the e2e witness, so it fails at witness
        // matching first — either way it must fail, never pay.
        let owner = spike["claim"]["owner"].as_str().unwrap();
        assert!(c.check_claim(7, &proof, owner).is_err());
    }

    // -- Real-callback regression tests (bounty #3 wedge) -------------------
    //
    // These drive the ACTUAL `on_voucher_signed` with injected promise
    // results (`testing_env!` 5-arg form), asserting end state after each
    // outcome. On the pre-fix code every failure test below PANICS instead
    // of returning `Rejected` — and on-chain that panic rolls the release
    // back and wedges the bounty in `Pending` forever. (`#[private]` is
    // enforced by the macro wrapper, which unit tests bypass; the xsuite
    // covers the wrapper. Predecessor == current account here mirrors the
    // production callback context.)
    use near_sdk::{test_vm_config, PromiseResult, RuntimeFeesConfig};
    use std::collections::HashMap;

    fn ctx_callback(timestamp_nanos: u64, results: Vec<PromiseResult>) {
        let contract: AccountId = "contract.testnet".parse().unwrap();
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(contract.clone());
        b.current_account_id(contract);
        b.block_timestamp(timestamp_nanos);
        testing_env!(
            b.build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            HashMap::default(),
            results
        );
    }

    fn mpc_response_bytes(fx: &serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&fx["mpcResponse"]).unwrap()
    }

    fn digest_hex(digest: &[u8; 32]) -> String {
        format!("0x{}", to_hex(digest))
    }

    fn proof_owner(fx: &serde_json::Value) -> &str {
        fx["proof"]["signedClaim"]["claim"]["owner"].as_str().unwrap()
    }

    fn proof_identifier(fx: &serde_json::Value) -> String {
        fx["proof"]["signedClaim"]["claim"]["identifier"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// Fixed test-only MPC key for locally-signed callback responses
    /// (mirrors tests/mock-mpc key custody; never leaves unit tests).
    fn local_mpc_key() -> [u8; 32] {
        [0x42; 32]
    }

    fn local_mpc_address_hex() -> String {
        use k256::ecdsa::SigningKey;
        let key = local_mpc_key();
        let signing = SigningKey::from_bytes((&key).into()).unwrap();
        let point = signing.verifying_key().to_encoded_point(false);
        let hash = near_sdk::env::keccak256(&point.as_bytes()[1..]);
        to_hex_prefixed(&hash[12..])
    }

    /// Exact v3.18.0 MPC response bytes signing `digest` with the local
    /// test key (same envelope the mock MPC builds).
    fn local_mpc_response_bytes(digest: &[u8; 32]) -> Vec<u8> {
        use k256::ecdsa::SigningKey;
        let key = local_mpc_key();
        let signing = SigningKey::from_bytes((&key).into()).unwrap();
        let (sig, recid) = signing.sign_prehash_recoverable(digest).unwrap();
        let prefix = if recid.is_y_odd() { "03" } else { "02" };
        let r: [u8; 32] = sig.r().to_bytes().into();
        let s: [u8; 32] = sig.s().to_bytes().into();
        serde_json::to_vec(&serde_json::json!({
            "scheme": "Secp256k1",
            "big_r": {"affine_point": format!("{prefix}{}", to_hex(&r))},
            "s": {"scalar": to_hex(&s)},
            "recovery_id": recid.to_byte(),
        }))
        .unwrap()
    }

    #[test]
    fn callback_success_applies_voucher() {
        let (mut c, fx) = setup();
        let owner = proof_owner(&fx);
        let proof = proof_input(&fx);
        let (_, digest) = c.prepare_claim(7, &proof, owner).unwrap();
        ctx_callback(block_nanos(&fx), vec![PromiseResult::Successful(mpc_response_bytes(&fx))]);
        match c.on_voucher_signed(digest_hex(&digest)) {
            VoucherCallbackOutcome::Applied(v) => {
                assert_eq!(v.voucher.digest, fx["digest"].as_str().unwrap());
                assert_eq!(v.v, 28);
            }
            VoucherCallbackOutcome::Rejected(e) => panic!("rejected: {e}"),
        }
        assert_eq!(c.get_bounty(7).unwrap().status, "claimed");
        assert!(c.is_identifier_used(proof_identifier(&fx)));
        assert!(c.get_pending(digest_hex(&digest)).unwrap().is_none());
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs.iter().any(|l| l.contains("voucher_signed")), "logs: {logs:?}");
    }

    #[test]
    fn callback_garbage_response_releases_for_retry() {
        let (mut c, fx) = setup();
        let owner = proof_owner(&fx);
        let proof = proof_input(&fx);
        let (_, digest) = c.prepare_claim(7, &proof, owner).unwrap();
        ctx_callback(
            block_nanos(&fx),
            vec![PromiseResult::Successful(b"not-json{{{".to_vec())],
        );
        match c.on_voucher_signed(digest_hex(&digest)) {
            VoucherCallbackOutcome::Rejected(e) => assert!(e.contains("MPC_BAD_RESPONSE"), "{e}"),
            VoucherCallbackOutcome::Applied(_) => panic!("must not apply garbage"),
        }
        // Released, identifier untouched, nonce consumed (never reused).
        assert_eq!(c.get_bounty(7).unwrap().status, "open");
        assert!(c.get_pending(digest_hex(&digest)).unwrap().is_none());
        assert!(!c.is_identifier_used(proof_identifier(&fx)));
        assert_eq!(c.get_config().next_nonce, 1);
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs.iter().any(|l| l.contains("voucher_rejected")), "logs: {logs:?}");
        // The SAME proof is immediately re-preparable (no wedge).
        let (_, digest2) = c.prepare_claim(7, &proof, owner).unwrap();
        assert_ne!(digest, digest2);
    }

    #[test]
    fn callback_wrong_signer_releases() {
        let (mut c, fx) = setup();
        let owner = proof_owner(&fx);
        let proof = proof_input(&fx);
        let (_, digest) = c.prepare_claim(7, &proof, owner).unwrap();
        ctx(OWNER, block_nanos(&fx));
        c.set_mpc_signer("0x0000000000000000000000000000000000000001".to_string())
            .unwrap();
        ctx_callback(block_nanos(&fx), vec![PromiseResult::Successful(mpc_response_bytes(&fx))]);
        match c.on_voucher_signed(digest_hex(&digest)) {
            VoucherCallbackOutcome::Rejected(e) => {
                assert!(e.contains("MPC_SIGNER_MISMATCH"), "{e}")
            }
            VoucherCallbackOutcome::Applied(_) => panic!("must not apply wrong signer"),
        }
        assert_eq!(c.get_bounty(7).unwrap().status, "open");
        assert!(!c.is_identifier_used(proof_identifier(&fx)));
    }

    #[test]
    fn callback_failed_promise_releases() {
        let (mut c, fx) = setup();
        let owner = proof_owner(&fx);
        let proof = proof_input(&fx);
        let (_, digest) = c.prepare_claim(7, &proof, owner).unwrap();
        ctx_callback(block_nanos(&fx), vec![PromiseResult::Failed]);
        match c.on_voucher_signed(digest_hex(&digest)) {
            VoucherCallbackOutcome::Rejected(e) => assert!(e.contains("MPC_FAILED"), "{e}"),
            VoucherCallbackOutcome::Applied(_) => panic!("must not apply failed promise"),
        }
        assert_eq!(c.get_bounty(7).unwrap().status, "open");
        assert!(c.get_pending(digest_hex(&digest)).unwrap().is_none());
    }

    #[test]
    fn callback_unknown_digest_is_noop() {
        let (mut c, fx) = setup();
        ctx_callback(
            block_nanos(&fx),
            vec![PromiseResult::Successful(mpc_response_bytes(&fx))],
        );
        match c.on_voucher_signed("0x".to_string() + &"ab".repeat(32)) {
            VoucherCallbackOutcome::Rejected(e) => {
                assert!(e.contains("NO_PENDING_VOUCHER"), "{e}")
            }
            VoucherCallbackOutcome::Applied(_) => panic!("must not apply unknown digest"),
        }
        // Zero state change.
        assert_eq!(c.get_bounty(7).unwrap().status, "open");
        assert_eq!(c.get_config().next_nonce, 0);
    }

    #[test]
    fn callback_bad_digest_hex_rejects() {
        let (mut c, fx) = setup();
        ctx_callback(block_nanos(&fx), vec![PromiseResult::Failed]);
        // Wrong length and non-hex are both rejected without state change.
        for (input, expect) in
            [("zz".to_string(), "INVALID_LENGTH"), ("gg".repeat(32), "INVALID_HEX")]
        {
            match c.on_voucher_signed(input) {
                VoucherCallbackOutcome::Rejected(e) => assert!(e.contains(expect), "{e}"),
                VoucherCallbackOutcome::Applied(_) => panic!("must not apply bad digest"),
            }
        }
        assert_eq!(c.get_bounty(7).unwrap().status, "open");
        assert_eq!(c.get_config().next_nonce, 0);
    }

    #[test]
    fn stale_callback_cannot_touch_newer_attempt_and_retry_succeeds() {
        let (mut c, fx) = setup();
        let owner = proof_owner(&fx);
        let proof = proof_input(&fx);
        // Pin the local test key as the MPC signer so retries over fresh
        // digests can be signed in-test (mirrors mock-mpc key custody).
        ctx(OWNER, block_nanos(&fx));
        c.set_mpc_signer(local_mpc_address_hex()).unwrap();
        // Attempt 1 fails (garbage response) and releases.
        let (_, digest1) = c.prepare_claim(7, &proof, owner).unwrap();
        ctx_callback(
            block_nanos(&fx),
            vec![PromiseResult::Successful(b"garbage".to_vec())],
        );
        assert!(matches!(
            c.on_voucher_signed(digest_hex(&digest1)),
            VoucherCallbackOutcome::Rejected(_)
        ));
        assert_eq!(c.get_bounty(7).unwrap().status, "open");
        // Attempt 2 (fresh nonce/digest) is now pending.
        let (voucher2, digest2) = c.prepare_claim(7, &proof, owner).unwrap();
        assert_eq!(voucher2.nonce, 1);
        assert_ne!(digest1, digest2);
        // The STALE attempt-1 callback arrives late with a *valid*
        // signature for the old digest: must no-op, must not mint.
        ctx_callback(
            block_nanos(&fx),
            vec![PromiseResult::Successful(local_mpc_response_bytes(&digest1))],
        );
        match c.on_voucher_signed(digest_hex(&digest1)) {
            VoucherCallbackOutcome::Rejected(e) => {
                assert!(e.contains("NO_PENDING_VOUCHER"), "{e}")
            }
            VoucherCallbackOutcome::Applied(_) => panic!("stale callback minted!"),
        }
        assert_eq!(c.get_bounty(7).unwrap().status, "pending");
        assert!(c.get_pending(digest_hex(&digest2)).unwrap().is_some());
        assert!(!c.is_identifier_used(proof_identifier(&fx)));
        // The current attempt then succeeds normally.
        ctx_callback(
            block_nanos(&fx),
            vec![PromiseResult::Successful(local_mpc_response_bytes(&digest2))],
        );
        match c.on_voucher_signed(digest_hex(&digest2)) {
            VoucherCallbackOutcome::Applied(v) => assert_eq!(v.voucher.nonce, 1),
            VoucherCallbackOutcome::Rejected(e) => panic!("retry rejected: {e}"),
        }
        assert_eq!(c.get_bounty(7).unwrap().status, "claimed");
        assert!(c.is_identifier_used(proof_identifier(&fx)));
        // And a stale callback after success is equally inert.
        ctx_callback(
            block_nanos(&fx),
            vec![PromiseResult::Successful(local_mpc_response_bytes(&digest1))],
        );
        assert!(matches!(
            c.on_voucher_signed(digest_hex(&digest1)),
            VoucherCallbackOutcome::Rejected(_)
        ));
        assert_eq!(c.get_bounty(7).unwrap().status, "claimed");
    }
}

