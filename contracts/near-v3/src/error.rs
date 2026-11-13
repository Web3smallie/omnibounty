//! Typed errors for the OmniBounty V3 contract.
//!
//! Every user-input failure maps to a stable `CODE: detail` string. Contract
//! code must never panic on user-controlled input; `expect`/`unwrap` are
//! forbidden outside `#[cfg(test)]` (grep-enforced in review).
//!
//! V2 codes are preserved byte-for-byte (same variants, same strings) so
//! existing tooling keeps working; V3 codes are appended below.

use std::fmt;

/// All failure modes of criteria handling, proof verification and claims.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimError {
    // -- V2 codes (stable, unchanged) --
    Paused,
    NotOwner,
    InvalidConfig(&'static str),
    BountyExists(u64),
    BountyNotFound(u64),
    BountyNotOpen(u64),
    BountyExpired(u64),
    BountyPending(u64),
    ProofTooLarge(&'static str),
    InvalidHex(&'static str),
    InvalidLength(&'static str),
    InvalidRecoveryId,
    IdentifierMismatch,
    NonCanonicalParams,
    UnknownEpoch(u64),
    ProofTooOld,
    ProofFromFuture,
    WitnessCountMismatch,
    DuplicateSignature,
    UnknownWitness,
    RecoveryFailed,
    InvalidProvider,
    InvalidParamsJson,
    InvalidContextJson,
    TemplateMismatch(&'static str),
    PredicateFailed(String),
    RecipientMismatch,
    IdentifierReplay,
    NonceOverflow,
    ZeroAmount,
    InvalidAmount,
    MpcNotConfigured,
    MpcFailed,
    MpcBadResponse(&'static str),
    MpcSignerMismatch,
    NoPendingVoucher,
    JsonTooDeep,
    NonIntegralNumber,
    // -- V3 codes --
    BountyNotFunded(u64),
    NoOpenSlot(u64),
    SlotPending { bounty_id: u64, slot: u8 },
    ClaimNotFound { bounty_id: u64, slot: u8 },
    AlreadyFinalized { bounty_id: u64, slot: u8 },
    InvalidSlot(u8),
    InvalidCriteria(&'static str),
    CriteriaMismatch,
    JoinFailed(String),
    MissingEvidence(String),
    DuplicatePr { bounty_id: u64, pr_number: u64 },
    MixedProverBundle,
    ChallengeWindowClosed,
    ChallengeWindowExceedsDeadline,
    FundingMismatch,
    StorageDepositInsufficient,
    NotSponsor,
    NoTransferPending,
    SeqOverflow,
    TooManyProofs,
    TooManySignatures,
    EmptyClaim,
    InvalidEvidenceType(u8),
}

impl fmt::Display for ClaimError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Paused => write!(f, "PAUSED: contract is paused"),
            Self::NotOwner => write!(f, "NOT_OWNER: caller is not the owner"),
            Self::InvalidConfig(d) => write!(f, "INVALID_CONFIG: {d}"),
            Self::BountyExists(id) => write!(f, "BOUNTY_EXISTS: {id}"),
            Self::BountyNotFound(id) => write!(f, "BOUNTY_NOT_FOUND: {id}"),
            Self::BountyNotOpen(id) => write!(f, "BOUNTY_NOT_OPEN: {id}"),
            Self::BountyExpired(id) => write!(f, "BOUNTY_EXPIRED: {id}"),
            Self::BountyPending(id) => {
                write!(f, "BOUNTY_PENDING: {id} has an in-flight MPC request")
            }
            Self::ProofTooLarge(field) => {
                write!(f, "PROOF_TOO_LARGE: {field} exceeds size cap")
            }
            Self::InvalidHex(field) => write!(f, "INVALID_HEX: {field}"),
            Self::InvalidLength(field) => write!(f, "INVALID_LENGTH: {field}"),
            Self::InvalidRecoveryId => write!(f, "INVALID_RECOVERY_ID"),
            Self::IdentifierMismatch => write!(f, "IDENTIFIER_MISMATCH"),
            Self::NonCanonicalParams => write!(
                f,
                "NON_CANONICAL_PARAMS: parameters must be canonical JSON bytes"
            ),
            Self::UnknownEpoch(e) => write!(f, "UNKNOWN_EPOCH: {e}"),
            Self::ProofTooOld => write!(f, "PROOF_TOO_OLD"),
            Self::ProofFromFuture => write!(f, "PROOF_FROM_FUTURE"),
            Self::WitnessCountMismatch => write!(f, "WITNESS_COUNT_MISMATCH"),
            Self::DuplicateSignature => write!(f, "DUPLICATE_SIGNATURE"),
            Self::UnknownWitness => write!(f, "UNKNOWN_WITNESS"),
            Self::RecoveryFailed => write!(f, "RECOVERY_FAILED"),
            Self::InvalidProvider => write!(f, "INVALID_PROVIDER"),
            Self::InvalidParamsJson => write!(f, "INVALID_PARAMS_JSON"),
            Self::InvalidContextJson => write!(f, "INVALID_CONTEXT_JSON"),
            Self::TemplateMismatch(d) => write!(f, "TEMPLATE_MISMATCH: {d}"),
            // NOTE: String payload (V2 used &'static str); the wire format
            // "PREDICATE_FAILED: <detail>" is byte-identical for same inputs.
            Self::PredicateFailed(d) => write!(f, "PREDICATE_FAILED: {d}"),
            Self::RecipientMismatch => {
                write!(f, "RECIPIENT_MISMATCH: recipient must equal proof owner")
            }
            Self::IdentifierReplay => write!(f, "IDENTIFIER_REPLAY"),
            Self::NonceOverflow => write!(f, "NONCE_OVERFLOW"),
            Self::ZeroAmount => write!(f, "ZERO_AMOUNT"),
            Self::InvalidAmount => write!(f, "INVALID_AMOUNT"),
            Self::MpcNotConfigured => write!(f, "MPC_NOT_CONFIGURED"),
            Self::MpcFailed => write!(f, "MPC_FAILED"),
            Self::MpcBadResponse(d) => write!(f, "MPC_BAD_RESPONSE: {d}"),
            Self::MpcSignerMismatch => write!(f, "MPC_SIGNER_MISMATCH"),
            Self::NoPendingVoucher => write!(f, "NO_PENDING_VOUCHER"),
            Self::JsonTooDeep => write!(f, "JSON_TOO_DEEP"),
            Self::NonIntegralNumber => write!(
                f,
                "NON_INTEGRAL_NUMBER: only integral JSON numbers are supported"
            ),
            Self::BountyNotFunded(id) => write!(f, "BOUNTY_NOT_FUNDED: {id}"),
            Self::NoOpenSlot(id) => write!(f, "NO_OPEN_SLOT: {id} has no unfilled slot"),
            Self::SlotPending { bounty_id, slot } => write!(
                f,
                "SLOT_PENDING: {bounty_id}/{slot} has an in-flight MPC request"
            ),
            Self::ClaimNotFound { bounty_id, slot } => {
                write!(f, "CLAIM_NOT_FOUND: {bounty_id}/{slot}")
            }
            Self::AlreadyFinalized { bounty_id, slot } => {
                write!(f, "ALREADY_FINALIZED: {bounty_id}/{slot}")
            }
            Self::InvalidSlot(s) => write!(f, "INVALID_SLOT: {s}"),
            Self::InvalidCriteria(d) => write!(f, "INVALID_CRITERIA: {d}"),
            Self::CriteriaMismatch => write!(
                f,
                "CRITERIA_MISMATCH: supplied document does not hash to committed criteria"
            ),
            Self::JoinFailed(d) => write!(f, "JOIN_FAILED: {d}"),
            Self::MissingEvidence(d) => write!(f, "MISSING_EVIDENCE: {d}"),
            Self::DuplicatePr {
                bounty_id,
                pr_number,
            } => write!(
                f,
                "DUPLICATE_PR: bounty {bounty_id} already has a claim for PR {pr_number}"
            ),
            Self::MixedProverBundle => write!(
                f,
                "MIXED_PROVER_BUNDLE: all proofs in a claim must share one owner"
            ),
            Self::ChallengeWindowClosed => write!(f, "CHALLENGE_WINDOW_CLOSED"),
            Self::ChallengeWindowExceedsDeadline => write!(
                f,
                "CHALLENGE_WINDOW_EXCEEDS_DEADLINE: challenge window extends past the bounty deadline"
            ),
            Self::FundingMismatch => write!(
                f,
                "FUNDING_MISMATCH: declared total does not equal sum(slots)"
            ),
            Self::StorageDepositInsufficient => {
                write!(
                    f,
                    "STORAGE_DEPOSIT_INSUFFICIENT: attach more NEAR for storage"
                )
            }
            Self::NotSponsor => write!(f, "NOT_SPONSOR: caller is not the bounty sponsor"),
            Self::NoTransferPending => write!(f, "NO_TRANSFER_PENDING"),
            Self::SeqOverflow => write!(f, "SEQ_OVERFLOW"),
            Self::TooManyProofs => write!(f, "TOO_MANY_PROOFS"),
            Self::TooManySignatures => write!(f, "TOO_MANY_SIGNATURES"),
            Self::EmptyClaim => write!(f, "EMPTY_CLAIM: claim references no proofs"),
            Self::InvalidEvidenceType(t) => write!(f, "INVALID_EVIDENCE_TYPE: {t}"),
        }
    }
}

impl std::error::Error for ClaimError {}

/// Convenience: convert internal errors into the stable string form used at
/// the contract boundary (`#[handle_result] Result<T, String>`).
impl From<ClaimError> for String {
    fn from(e: ClaimError) -> String {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable() {
        // V2 codes byte-identical.
        assert_eq!(ClaimError::Paused.to_string(), "PAUSED: contract is paused");
        assert_eq!(
            ClaimError::BountyNotFound(7).to_string(),
            "BOUNTY_NOT_FOUND: 7"
        );
        assert!(ClaimError::IdentifierMismatch
            .to_string()
            .starts_with("IDENTIFIER_MISMATCH"));
        // V3 codes pinned.
        assert_eq!(
            ClaimError::DuplicatePr {
                bounty_id: 3,
                pr_number: 42
            }
            .to_string(),
            "DUPLICATE_PR: bounty 3 already has a claim for PR 42"
        );
        assert_eq!(ClaimError::InvalidSlot(9).to_string(), "INVALID_SLOT: 9");
        assert!(ClaimError::CriteriaMismatch
            .to_string()
            .starts_with("CRITERIA_MISMATCH"));
        assert_eq!(
            ClaimError::ChallengeWindowExceedsDeadline.to_string(),
            "CHALLENGE_WINDOW_EXCEEDS_DEADLINE: challenge window extends past the bounty deadline"
        );
    }
}
