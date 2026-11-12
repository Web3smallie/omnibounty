// Relayer main loop: NEAR `list_unrelayed` -> validate -> escrow.usedVoucher
// ground-truth check -> submit claim -> confirm -> record.
//
// Idempotency: a voucher is submitted only if (a) it validates, (b) it is
// not in local state, and (c) the escrow reports it unused. A crash between
// submission and recording is safe: the next poll re-checks (c) on-chain.
import { ethers } from "ethers";
import { NearRpc } from "./near.mjs";
import { StateStore } from "./store.mjs";
import {
  normalizeVoucherShape,
  normalizeVoucherShapeV2,
  validateSignedVoucher,
  validateSignedVoucherV2,
  validateScheduleConsistency,
  isVoucherV2Shape,
} from "./validate.mjs";
import { loadConfig, summarize } from "./config.mjs";

const ESCROW_ABI_V1 = [
  "function usedVoucher(bytes32) view returns (bool)",
  "function claim((uint256 bountyId,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow) v, uint8 sigV, bytes32 r, bytes32 s)",
];

const ESCROW_ABI_V2 = [
  "function usedVoucher(bytes32) view returns (bool)",
  "function claim((uint256 bountyId,uint8 slotIndex,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow,bytes32 criteriaHash) v, uint8 sigV, bytes32 r, bytes32 s)",
  "function slotStatus(uint256 bountyId, uint8 slotIndex) view returns (bool claimed, bool refunded)",
  "function bounties(uint256) view returns ((address token, address sponsor, uint64 deadline, bytes32 criteriaHash, bool funded, uint256 totalFunded, uint256[] amounts, uint256 claimedBitmap, uint256 refundedBitmap))",
  // Custom errors (decode-only: lets ethers report revert NAMES instead of
  // raw selectors in skip reasons; submission behavior unchanged).
  "error NotOwner()",
  "error NotProposedOwner()",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error BountyExists()",
  "error BountyNotFound()",
  "error AlreadyFunded()",
  "error NotFunded()",
  "error NotSponsor()",
  "error InvalidSchedule()",
  "error InvalidSlot()",
  "error SlotClaimed()",
  "error AlreadyRefunded()",
  "error RefundUnavailable()",
  "error DeadlineNotPassed()",
  "error VoucherUsed()",
  "error VoucherExpired()",
  "error WrongChain()",
  "error WrongEscrow()",
  "error AmountMismatch()",
  "error TokenMismatch()",
  "error CriteriaMismatch()",
  "error BadSignature()",
  "error TransferFailed()",
  "error Reentrant()",
];

export { ESCROW_ABI_V1, ESCROW_ABI_V2 };

export function wantsVoucherV2(config) {
  return String(config.voucherVersion ?? "1") === "2";
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class Relayer {
  constructor({ config, near, escrow, store, log = console.log }) {
    this.config = config;
    this.near = near;
    this.escrow = escrow;
    this.store = store;
    this.log = log;
  }

  static async fromEnv() {
    const config = loadConfig();
    const provider = new ethers.JsonRpcProvider(config.baseRpcUrl);
    const wallet = new ethers.Wallet(config.privateKey, provider);
    const abi = wantsVoucherV2(config) ? ESCROW_ABI_V2 : ESCROW_ABI_V1;
    const escrow = new ethers.Contract(config.escrowAddress, abi, wallet);
    return new Relayer({
      config,
      near: new NearRpc(config.nearRpcUrl),
      escrow,
      store: new StateStore(config.statePath),
    });
  }

  async pollOnce() {
    const results = [];
    let vouchers;
    try {
      vouchers = await this.near.listUnrelayed(this.config.contractId, 50);
    } catch (e) {
      this.log(`poll failed: ${e.message}`);
      return [{ status: "poll-error", error: e.message }];
    }
    if (!Array.isArray(vouchers)) {
      this.log("unexpected list_unrelayed shape");
      return [{ status: "poll-error", error: "bad shape" }];
    }
    for (const signed of vouchers) {
      results.push(await this.handleOne(signed));
    }
    return results;
  }

  async handleOne(signed) {
    const digestHint = signed?.voucher?.digest ?? "(no digest)";
    const wantsV2 = wantsVoucherV2(this.config);
    const isV2 = isVoucherV2Shape(signed);
    if (wantsV2 !== isV2) {
      const reason = `version mismatch (relayer v${wantsV2 ? 2 : 1}, voucher v${isV2 ? 2 : 1})`;
      this.log(`skip ${digestHint}: ${reason}`);
      return { status: "skipped", digest: digestHint, reason };
    }
    const validate = wantsV2 ? validateSignedVoucherV2 : validateSignedVoucher;
    const checked = validate(signed, {
      expectedChainId: this.config.expectedChainId,
      escrowAddress: this.config.escrowAddress,
      mpcSigner: this.config.mpcSigner,
    });
    if (!checked.ok) {
      this.log(`skip ${digestHint}: invalid (${checked.reason})`);
      return { status: "skipped", digest: digestHint, reason: checked.reason };
    }
    const digest = checked.digest;
    if (this.store.isRelayed(digest)) {
      return { status: "already", digest };
    }
    // Ground truth: escrow state wins over any local/NEAR hint.
    let used;
    try {
      used = await this.escrow.usedVoucher(digest);
    } catch (e) {
      this.log(`usedVoucher check failed for ${digest}: ${e.message}`);
      return { status: "error", digest, error: e.message };
    }
    if (used) {
      this.store.markRelayed(digest, "(already used on-chain)");
      return { status: "already", digest };
    }
    const v = wantsV2
      ? normalizeVoucherShapeV2(signed.voucher)
      : normalizeVoucherShape(signed.voucher);
    if (wantsV2) {
      // Reward-schedule consistency (V3 only): the escrow's declared
      // schedule must match the NEAR commitment exactly. Pre-submit, so a
      // mismatch costs zero gas. RPC failures stay transient errors.
      let nearBounty;
      let escrowBounty;
      try {
        [nearBounty, escrowBounty] = await Promise.all([
          this.near.getBounty(this.config.contractId, Number(BigInt(v.bountyId))),
          this.escrow.bounties(BigInt(v.bountyId)),
        ]);
      } catch (e) {
        this.log(`bounty fetch failed for ${digest}: ${e.message}`);
        return { status: "error", digest, error: e.message };
      }
      const sched = validateScheduleConsistency(nearBounty, escrowBounty);
      if (!sched.ok) {
        const reason = `schedule mismatch: ${sched.reasons.join("; ")}`;
        this.log(`skip ${digest}: ${reason}`);
        this.store.markSkipped(digest, reason);
        return { status: "skipped", digest, reason };
      }
    }
    const tuple = wantsV2
      ? [
          BigInt(v.bountyId),
          Number(BigInt(v.slotIndex)),
          v.recipient,
          v.token,
          BigInt(v.amount),
          BigInt(v.nonce),
          BigInt(v.expiry),
          BigInt(v.chainId),
          v.escrow,
          v.criteriaHash,
        ]
      : [
          BigInt(v.bountyId),
          v.recipient,
          v.token,
          BigInt(v.amount),
          BigInt(v.nonce),
          BigInt(v.expiry),
          BigInt(v.chainId),
          v.escrow,
        ];
    let lastError = null;
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        const tx = await this.escrow.claim(tuple, signed.v, signed.r, signed.s);
        const receipt = await tx.wait(this.config.confirmations);
        if (receipt.status !== 1) throw new Error("tx reverted");
        this.store.markRelayed(digest, receipt.hash);
        this.log(`relayed ${digest} in ${receipt.hash}`);
        return { status: "relayed", digest, txHash: receipt.hash };
      } catch (e) {
        lastError = e;
        const msg = e.message ?? String(e);
        // Reverts are final (a retry would revert identically): record skip.
        // Matches the generic execution-reverted wording AND every custom
        // error in OmniEscrow.sol / OmniEscrowV2.sol by name, so finality
        // never depends on provider message phrasing. Anything else is
        // treated as transient.
        if (/revert|VoucherUsed|VoucherExpired|BadSignature|AlreadyClaimed|BountyNotFound|TokenMismatch|AmountMismatch|NotFunded|WrongChain|WrongEscrow|ZeroAddress|ZeroAmount|TransferFailed|Reentrant|NotSponsor|BountyExists|AlreadyFunded|NotOwner|SlotClaimed|AlreadyRefunded|CriteriaMismatch|InvalidSlot|InvalidSchedule|RefundUnavailable|DeadlineNotPassed|NotProposedOwner|call revert/i.test(msg)) {
          this.store.markSkipped(digest, msg.slice(0, 200));
          this.log(`skip ${digest}: tx would revert (${msg.slice(0, 120)})`);
          return { status: "skipped", digest, reason: msg.slice(0, 200) };
        }
        this.log(`attempt ${attempt} failed for ${digest}: ${msg.slice(0, 120)}`);
        await sleep(1000 * attempt);
      }
    }
    return { status: "error", digest, error: String(lastError) };
  }

  async runForever() {
    this.log(`relayer starting: ${JSON.stringify(summarize(this.config))}`);
    for (;;) {
      await this.pollOnce();
      await sleep(this.config.pollIntervalMs);
    }
  }
}

// CLI entry: `node src/index.mjs [--once]`.
if (process.argv[1]?.endsWith("index.mjs")) {
  const relayer = await Relayer.fromEnv();
  if (process.argv.includes("--once")) {
    const results = await relayer.pollOnce();
    console.log(JSON.stringify(results, null, 2));
  } else {
    await relayer.runForever();
  }
}
