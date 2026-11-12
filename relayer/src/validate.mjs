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

// ---------------------------------------------------------------------------
// VoucherV2 (NEAR V3 / Base Escrow V2). Additive: V1 code above is untouched.
// Frozen interface: docs/v3/NEAR_V3_DESIGN.md §9.
// ---------------------------------------------------------------------------

export const VOUCHER_V2_TYPE_STRING =
  "VoucherV2(uint256 bountyId,uint8 slotIndex,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow,bytes32 criteriaHash)";

export const VOUCHER_V2_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes(VOUCHER_V2_TYPE_STRING));

function domainSeparator(domain) {
  return ethers.keccak256(
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
}

export function computeDigestV2(voucher, domain) {
  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "uint8", "address", "address", "uint256", "uint256", "uint256", "uint256", "address", "bytes32"],
      [
        VOUCHER_V2_TYPEHASH,
        voucher.bountyId,
        voucher.slotIndex,
        voucher.recipient,
        voucher.token,
        voucher.amount,
        voucher.nonce,
        voucher.expiry,
        voucher.chainId,
        voucher.escrow,
        voucher.criteriaHash,
      ]
    )
  );
  return ethers.keccak256(ethers.concat(["0x1901", domainSeparator(domain), structHash]));
}

/// V2 normalizer: extends the V1 mapping with slotIndex/criteriaHash.
/// NEAR V3 views emit snake_case; mocks may use camelCase; both accepted.
export function normalizeVoucherShapeV2(voucher) {
  const v = normalizeVoucherShape(voucher);
  return {
    ...v,
    slotIndex: v.slotIndex ?? voucher.slot_index,
    criteriaHash: v.criteriaHash ?? voucher.criteria_hash,
  };
}

/// Shape detector: V2 vouchers carry slotIndex + criteriaHash, V1 never does.
export function isVoucherV2Shape(signed) {
  const v = signed?.voucher;
  if (!v || typeof v !== "object") return false;
  const slot = v.slotIndex ?? v.slot_index;
  const ch = v.criteriaHash ?? v.criteria_hash;
  return slot !== undefined && slot !== null && ch !== undefined && ch !== null;
}

/// Validate a V2 signed voucher from `list_unrelayed`.
/// Returns { ok:true, digest } or { ok:false, reason }.
/// opts.nowSec overrides the clock for the expiry check (tests only).
export function validateSignedVoucherV2(signed, opts) {
  try {
    const v = normalizeVoucherShapeV2(signed.voucher);
    for (const f of ["bountyId", "slotIndex", "recipient", "token", "amount", "nonce", "expiry", "chainId", "escrow", "criteriaHash"]) {
      if (v[f] === undefined || v[f] === null) return { ok: false, reason: `missing ${f}` };
    }
    for (const f of ["recipient", "token", "escrow"]) {
      if (!ethers.isAddress(v[f])) return { ok: false, reason: `bad address ${f}` };
    }
    let slot;
    try {
      slot = BigInt(v.slotIndex);
    } catch {
      return { ok: false, reason: "bad slotIndex" };
    }
    if (slot < 0n || slot > 255n) return { ok: false, reason: "bad slotIndex" };
    if (!ethers.isHexString(v.criteriaHash, 32)) return { ok: false, reason: "bad criteriaHash" };
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
    const digest = computeDigestV2(
      {
        bountyId: BigInt(v.bountyId),
        slotIndex: Number(slot),
        recipient: v.recipient,
        token: v.token,
        amount: BigInt(v.amount),
        nonce: BigInt(v.nonce),
        expiry: BigInt(v.expiry),
        chainId: BigInt(v.chainId),
        escrow: v.escrow,
        criteriaHash: v.criteriaHash,
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

// ---------------------------------------------------------------------------
// Reward-schedule consistency (V3): the escrow's declared schedule must
// match the NEAR-committed schedule exactly, or relaying is skipped.
// Both sides are immutable after creation, so a mismatch is permanent —
// but skips are retried harmlessly (pre-submit, zero gas), exactly like
// every other skip reason. The escrow remains authoritative; this is
// defense in depth plus a clear operational signal.
// ---------------------------------------------------------------------------

/// Compare a NEAR BountyView against an escrow Bounty struct.
/// Returns { ok:true, reasons:[] } or { ok:false, reasons:[...] }.
export function validateScheduleConsistency(nearBounty, escrowBounty) {
  const reasons = [];
  try {
    if (!nearBounty || typeof nearBounty !== "object") {
      return { ok: false, reasons: ["unknown NEAR bounty"] };
    }
    if (!escrowBounty || escrowBounty.sponsor === ethers.ZeroAddress) {
      return { ok: false, reasons: ["unknown escrow bounty"] };
    }
    if (!escrowBounty.funded) reasons.push("escrow not funded");
    if (!nearBounty.funded) reasons.push("near not funded");
    const nearToken = nearBounty.token;
    const escToken = escrowBounty.token;
    if (
      !nearToken ||
      !escToken ||
      ethers.getAddress(nearToken) !== ethers.getAddress(escToken)
    ) {
      reasons.push("token mismatch");
    }
    const nearSlots = nearBounty.slots ?? [];
    const escAmounts = [...(escrowBounty.amounts ?? [])];
    if (nearSlots.length !== escAmounts.length) {
      reasons.push(`slot count ${nearSlots.length} vs ${escAmounts.length}`);
    } else {
      for (let i = 0; i < nearSlots.length; i++) {
        if (BigInt(nearSlots[i]) !== BigInt(escAmounts[i])) {
          reasons.push(`slot ${i} amount ${nearSlots[i]} vs ${escAmounts[i]}`);
        }
      }
    }
    const escTotal = escAmounts.reduce((a, b) => a + BigInt(b), 0n);
    if (escTotal !== BigInt(escrowBounty.totalFunded ?? -1)) {
      reasons.push("escrow total != sum(slots)");
    }
    if (nearBounty.total_amount !== undefined && escTotal !== BigInt(nearBounty.total_amount)) {
      reasons.push("total mismatch");
    }
    if (BigInt(nearBounty.deadline ?? -1) !== BigInt(escrowBounty.deadline ?? -2)) {
      reasons.push("deadline mismatch");
    }
    const nearHash = nearBounty.criteria_hash ?? nearBounty.criteriaHash;
    if (!nearHash || String(nearHash).toLowerCase() !== String(escrowBounty.criteriaHash).toLowerCase()) {
      reasons.push("criteria hash mismatch");
    }
    return { ok: reasons.length === 0, reasons };
  } catch (e) {
    return { ok: false, reasons: [`exception: ${e.message}`] };
  }
}
