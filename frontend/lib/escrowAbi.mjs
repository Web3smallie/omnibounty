// Single source of truth for the Base escrow ABI fragments used by the
// frontend. Importable from both .ts chain code and .mjs unit tests, so
// the exact strings the UI decodes with are the strings the tests verify.
// V1: contracts/base/OmniEscrow.sol (single-winner Bounty 5-tuple).
// V2: contracts/base-v3/src/OmniEscrowV2.sol (multi-slot Bounty 9-tuple).
// Field order is normative — verified against the Solidity structs.

/// V1 escrow surface used by the frontend. `bounties` returns
/// (token, amount, sponsor, funded, claimed); `createBounty` takes
/// (id, token, amount). `cancelBounty`/`allowance`/`decimals` entries are
/// retained for ABI completeness; the UI calls neither cancel path.
export const ESCROW_ABI = [
  "function usedVoucher(bytes32) view returns (bool)",
  "function bounties(uint256) view returns (address token, uint256 amount, address sponsor, bool funded, bool claimed)",
  "function mpcSigner() view returns (address)",
  "function createBounty(uint256 bountyId, address token, uint256 amount)",
  "function fundBounty(uint256 bountyId)",
  "function cancelBounty(uint256 bountyId)",
  "function claim((uint256 bountyId,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow) v, uint8 sigV, bytes32 r, bytes32 s)",
  "event VoucherClaimed(uint256 indexed bountyId, address indexed recipient, uint256 amount, uint256 nonce, bytes32 digest)",
];

/// V2 escrow surface used by the frontend: `bounties` returns the whole
/// `Bounty` struct as ONE tuple (`returns (Bounty memory)` in
/// OmniEscrowV2.sol) — the double parens below are load-bearing, not
/// style. Because `amounts` is dynamic, the tuple return is
/// offset-prefixed on the wire; the 9-output single-paren form decodes
/// only inline data and throws BAD_DATA against the real escrow. (V1's
/// struct is fully static, so both forms decode identically there.)
/// Field order inside the tuple is contract order: (token, sponsor,
/// deadline, criteriaHash, funded, totalFunded, amounts, claimedBitmap,
/// refundedBitmap). `createBounty` / `fundBounty` are the sponsor writes
/// (the claim / refund paths belong to the relayer / sponsor-withdrawal
/// flows and are not part of the sponsorship UI).
export const ESCROW_ABI_V2 = [
  "function bounties(uint256) view returns ((address token, address sponsor, uint64 deadline, bytes32 criteriaHash, bool funded, uint256 totalFunded, uint256[] amounts, uint256 claimedBitmap, uint256 refundedBitmap))",
  "function createBounty(uint256 bountyId, address token, uint256[] amounts, uint64 deadline, bytes32 criteriaHash)",
  "function fundBounty(uint256 bountyId)",
];

/// Zero-arg constant getters that discriminate escrow versions: V1
/// exposes only `VOUCHER_TYPEHASH`, V2 only `VOUCHER_V2_TYPEHASH`, and
/// neither contract has a fallback, so the absent selector reverts with
/// empty data while the present one returns its pinned constant.
export const ESCROW_VERSION_PROBES = {
  v2: "function VOUCHER_V2_TYPEHASH() view returns (bytes32)",
  v1: "function VOUCHER_TYPEHASH() view returns (bytes32)",
};

/// Expected probe values, pinned to the Solidity constants
/// (`OmniEscrowV2.sol` VOUCHER_V2_TYPEHASH, `OmniEscrow.sol`
/// VOUCHER_TYPEHASH) and cross-checked against the frozen EIP-712 type
/// strings in the test suite.
export const VOUCHER_V2_TYPEHASH_EXPECTED =
  "0x1455b35cc7864127c56d1e0d2f4e6172e7170aa94cb677c301415aac89954bfb";
export const VOUCHER_TYPEHASH_EXPECTED =
  "0xd6e33bde1cad655a2f5764a35e2642eb0cfeb06ea06b05e3019f8e798c14ffc4";
