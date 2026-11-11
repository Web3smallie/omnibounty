//! Typed errors for the OmniBounty contract.
//!
//! Every user-input failure maps to a stable `CODE: detail` string. Contract
//! code must never panic on user-controlled input; `expect`/`unwrap` are
//! forbidden outside `#[cfg(test)]` (grep-enforced in review).

use std::fmt;

/// All failure modes of proof verification and claim processing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimError {
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
    PredicateFailed(&'static str),
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
            Self::PredicateFailed(d) => write!(f, "PREDICATE_FAILED: {d}"),
            Self::RecipientMismatch => write!(
                f,
                "RECIPIENT_MISMATCH: recipient must equal proof owner"
            ),
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
        assert_eq!(ClaimError::Paused.to_string(), "PAUSED: contract is paused");
        assert_eq!(
            ClaimError::BountyNotFound(7).to_string(),
            "BOUNTY_NOT_FOUND: 7"
        );
        assert!(ClaimError::IdentifierMismatch
            .to_string()
            .starts_with("IDENTIFIER_MISMATCH"));
    }
}
