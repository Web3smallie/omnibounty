// Voucher validation: recompute the EIP-712 digest independently and check
// every bound field plus MPC authorship. Mirrors the escrow's checks so the
// relayer never submits a transaction that must revert.
import { ethers } from "ethers";

const VOUCHER_TYPES = {
  Voucher: [
    { name: "bountyId", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "escrow", type: "address" },
  ],
};

export const VOUCHER_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    "Voucher(uint256 bountyId,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow)"
  )
);

export function computeDigest(voucher, domain) {
  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "address", "uint256", "uint256", "uint256", "uint256", "address"],
      [
        VOUCHER_TYPEHASH,
        voucher.bountyId,
        voucher.recipient,
        voucher.token,
        voucher.amount,
        voucher.nonce,
        voucher.expiry,
        voucher.chainId,
        voucher.escrow,
      ]
    )
  );
  const domainSeparator = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [
        ethers.keccak256(
          ethers.toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
        ),
        ethers.keccak256(ethers.toUtf8Bytes(domain.name)),
        ethers.keccak256(ethers.toUtf8Bytes(domain.version)),
        domain.chainId,
        domain.verifyingContract,
      ]
    )
  );
  return ethers.keccak256(ethers.concat(["0x1901", domainSeparator, structHash]));
}

/// Normalize a voucher view to camelCase. The NEAR contract returns
/// snake_case (bounty_id, chain_id); older shapes and mocks use camelCase.
/// Accepts both (mirrors contracts/near/tests/cross_contract.rs). Uses
/// ?? so falsy-but-valid values (id 0) survive.
export function normalizeVoucherShape(voucher) {
  return {
    ...voucher,
    bountyId: voucher.bountyId ?? voucher.bounty_id,
    chainId: voucher.chainId ?? voucher.chain_id,
  };
}

/// Validate a signed voucher from `list_unrelayed`.
/// Returns { ok:true, digest } or { ok:false, reason }.
/// opts.nowSec overrides the clock for the expiry check (tests only).
export function validateSignedVoucher(signed, opts) {
  try {
    const v = normalizeVoucherShape(signed.voucher);
    for (const f of ["bountyId", "recipient", "token", "amount", "nonce", "expiry", "chainId", "escrow"]) {
      if (v[f] === undefined || v[f] === null) return { ok: false, reason: `missing ${f}` };
    }
    for (const f of ["recipient", "token", "escrow"]) {
      if (!ethers.isAddress(v[f])) return { ok: false, reason: `bad address ${f}` };
    }
    if (BigInt(v.chainId) !== BigInt(opts.expectedChainId)) return { ok: false, reason: "chainId" };
    if (ethers.getAddress(v.escrow) !== ethers.getAddress(opts.escrowAddress)) {
      return { ok: false, reason: "escrow" };
    }
    if (v.recipient === ethers.ZeroAddress) return { ok: false, reason: "zero recipient" };
    if (BigInt(v.amount) <= 0n) return { ok: false, reason: "zero amount" };
    const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
    if (BigInt(v.expiry) <= BigInt(nowSec)) {
      return { ok: false, reason: "expired" };
    }
    if (signed.v !== 27 && signed.v !== 28) return { ok: false, reason: "bad v" };
    const digest = computeDigest(
      {
        bountyId: BigInt(v.bountyId),
        recipient: v.recipient,
        token: v.token,
        amount: BigInt(v.amount),
        nonce: BigInt(v.nonce),
        expiry: BigInt(v.expiry),
        chainId: BigInt(v.chainId),
        escrow: v.escrow,
      },
      { name: "OmniBounty", version: "1", chainId: BigInt(v.chainId), verifyingContract: v.escrow }
    );
    if (signed.voucher.digest && signed.voucher.digest.toLowerCase() !== digest.toLowerCase()) {
      return { ok: false, reason: "digest mismatch" };
    }
    const recovered = ethers
      .recoverAddress(digest, { v: signed.v, r: signed.r, s: signed.s })
      .toLowerCase();
    if (recovered !== opts.mpcSigner.toLowerCase()) return { ok: false, reason: "bad signer" };
    return { ok: true, digest };
  } catch (e) {
    return { ok: false, reason: `exception: ${e.message}` };
  }
}
