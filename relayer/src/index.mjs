// Relayer main loop: finalize matured claims -> discover vouchers ->
// validate -> escrow.usedVoucher ground-truth check -> submit claim ->
// confirm -> record.
//
// V2 discovery enumerates bounties -> claim slots -> signed vouchers
// directly and NEVER consults the on-chain `relayed` hint set, which any
// account can write to: a planted digest cannot suppress a voucher here.
// V1 discovery still uses `list_unrelayed` (frozen production behavior).
//
// V3 auto-finalization (V2 mode only, operator key required): each poll
// first submits the permissionless `finalize_claim` for unsigned claims
// whose challenge window has expired, so qualification flows to MPC
// signing with no second claimant action and no scheduler wait. The pass
// is strictly best-effort and fully isolated: per-claim failures (and a
// whole-pass discovery failure) are recorded as results while voucher
// settlement proceeds untouched. Races with the GitHub Actions scheduler
// or a manual finalizer collapse into benign SlotPending/AlreadyFinalized
// outcomes — the contract's pending entry + voucher map decide, so a
// duplicate dispatch is impossible.
//
// Idempotency: a voucher is submitted only if (a) it validates, (b) it is
// not in local state, and (c) the escrow reports it unused. A crash between
// submission and recording is safe: the next poll re-checks (c) on-chain.
//
// Daemon mode also serves a liveness endpoint (see health.mjs) when PORT
// is set, and handles SIGTERM/SIGINT with a bounded graceful shutdown.
// Neither path is consulted by validation, discovery, or submission.
import { ethers } from "ethers";
import { NearRpc, NearSubmitter } from "./near.mjs";
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
import { shouldStartServer, resolvePort, startHealthServer, createShutdownCoordinator } from "./health.mjs";

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
  constructor({ config, near, escrow, store, submitter = null, log = console.log, testNowSec = null }) {
    this.config = config;
    this.near = near;
    this.escrow = escrow;
    this.store = store;
    this.submitter = submitter;
    this.log = log;
    // Test-only clock override (local replay): when set, voucher expiry
    // is evaluated against this timestamp instead of wall-clock time.
    // Only the e2e harness sets it; production construction (fromEnv)
    // never does, so live validation always uses real time.
    this.testNowSec = testNowSec;
    // Health/shutdown bookkeeping only; never consulted by validation,
    // discovery, or submission logic.
    this.health = { startedAt: new Date().toISOString(), lastPollAt: null, lastPollOk: null, lastError: null };
    this.polling = false;
    this.stopped = false;
  }

  // Liveness payload for the HTTP health endpoint. Uses the redacted
  // config summary (never keys) and the last recorded poll outcome.
  healthStatus() {
    const intervalMs = Number(this.config.pollIntervalMs) || 30000;
    const lastAt = this.health.lastPollAt ? Date.parse(this.health.lastPollAt) : null;
    return {
      status: "ok",
      uptimeSec: Math.floor(process.uptime()),
      startedAt: this.health.startedAt,
      lastPollAt: this.health.lastPollAt,
      lastPollOk: this.health.lastPollOk,
      lastError: this.health.lastError,
      polling: this.polling,
      loopStale: lastAt === null ? false : Date.now() - lastAt > Math.max(3 * intervalMs, 5 * 60 * 1000),
      pollIntervalMs: intervalMs,
      config: summarize(this.config),
    };
  }

  static async fromEnv() {
    const config = loadConfig();
    const provider = new ethers.JsonRpcProvider(config.baseRpcUrl);
    const wallet = new ethers.Wallet(config.privateKey, provider);
    const abi = wantsVoucherV2(config) ? ESCROW_ABI_V2 : ESCROW_ABI_V1;
    const escrow = new ethers.Contract(config.escrowAddress, abi, wallet);
    let submitter = null;
    if (config.finalizeEnabled && config.operatorAccountId && config.operatorPrivateKey) {
      try {
        submitter = await NearSubmitter.connect({
          rpcUrl: config.nearRpcUrl,
          accountId: config.operatorAccountId,
          privateKey: config.operatorPrivateKey,
          contractId: config.contractId,
        });
      } catch (e) {
        throw new Error(`NEAR operator submitter unusable: ${e.message}`);
      }
    }
    return new Relayer({
      config,
      near: new NearRpc(config.nearRpcUrl),
      escrow,
      store: new StateStore(config.statePath),
      submitter,
    });
  }

  async pollOnce() {
    const results = [];
    if (wantsVoucherV2(this.config) && this.submitter && this.config.finalizeEnabled !== false) {
      results.push(...(await this.finalizePass()));
    }
    let vouchers;
    try {
      vouchers = wantsVoucherV2(this.config)
        ? await this.discoverVouchersV2()
        : await this.near.listUnrelayed(this.config.contractId, 50);
    } catch (e) {
      this.log(`poll failed: ${e.message}`);
      return [...results, { status: "poll-error", error: e.message }];
    }
    if (!Array.isArray(vouchers)) {
      this.log("unexpected discovery shape");
      return [...results, { status: "poll-error", error: "bad shape" }];
    }
    for (const signed of vouchers) {
      results.push(await this.handleOne(signed));
    }
    return results;
  }

  // Independent V3 voucher discovery: page every bounty, probe each
  // filled slot's claim, and fetch vouchers for signed claims. Shares
  // nothing with `list_unrelayed` or the on-chain `relayed` set, so a
  // digest planted there by any account cannot hide a voucher. Settlement
  // truth stays where it was: escrow `usedVoucher`, checked per voucher
  // in handleOne. A fetch failure fails the poll (retried next cycle),
  // exactly like discovery failures before.
  async discoverVouchersV2() {
    const out = [];
    const PAGE = 100; // == NEAR MAX_LIST_LIMIT
    let from = 0;
    for (;;) {
      const page = await this.near.listBounties(this.config.contractId, from, PAGE);
      if (!Array.isArray(page)) {
        throw new Error(`unexpected list_bounties shape at offset ${from}`);
      }
      if (page.length === 0) break;
      for (const b of page) {
        if (!b || typeof b.id !== "number") continue;
        const slots = Array.isArray(b.slots) ? b.slots.length : 0;
        if (b.slots_filled === 0 || slots === 0) continue;
        for (let slot = 0; slot < slots; slot++) {
          const claim = await this.near.getClaim(this.config.contractId, b.id, slot);
          if (!claim || claim.signed !== true) continue;
          const signed = await this.near.getVoucher(this.config.contractId, b.id, slot);
          if (!signed) continue;
          out.push(signed);
        }
      }
      if (page.length < PAGE) break;
      from += page.length;
    }
    return out;
  }

  // V3 finalization prefilter: unsigned claims with no in-flight dispatch
  // whose challenge window has expired. Skipping `pending_digest != null`
  // claims avoids burning operator gas on doomed SlotPending resubmits;
  // the contract re-checks maturity at dispatch, so wall-clock skew fails
  // safe (ChallengeWindowClosed -> retried next poll). Malformed entries
  // are skipped fail-closed; a failed page fetch throws and fails the
  // pass loudly (settlement still proceeds).
  async discoverMaturedClaims(nowSec = Math.floor(Date.now() / 1000)) {
    const out = [];
    const PAGE = 100; // == NEAR MAX_LIST_LIMIT
    let from = 0;
    for (;;) {
      const page = await this.near.listBounties(this.config.contractId, from, PAGE);
      if (!Array.isArray(page)) {
        throw new Error(`unexpected list_bounties shape at offset ${from}`);
      }
      if (page.length === 0) break;
      for (const b of page) {
        if (!b || typeof b.id !== "number" || !Array.isArray(b.slots)) continue;
        if (b.slots_filled === 0) continue;
        const n = Math.min(b.slots.length, 64);
        for (let slot = 0; slot < n; slot++) {
          const claim = await this.near.getClaim(this.config.contractId, b.id, slot);
          if (!claim) continue;
          if (claim.signed === true) continue;
          if (claim.pending_digest !== null && claim.pending_digest !== undefined) continue;
          if (typeof claim.challenge_ends_at !== "number") continue;
          if (nowSec < claim.challenge_ends_at) continue;
          out.push({ bountyId: b.id, slot, claim });
        }
      }
      if (page.length < PAGE) break;
      from += page.length;
    }
    return out;
  }

  async finalizePass() {
    let matured;
    try {
      matured = await this.discoverMaturedClaims();
    } catch (e) {
      this.log(`finalize discovery failed: ${e.message}`);
      return [{ status: "finalize-pass-error", error: e.message }];
    }
    const out = [];
    for (const m of matured) {
      out.push(await this.finalizeOne(m.bountyId, m.slot));
    }
    return out;
  }

  async finalizeOne(bountyId, slot) {
    try {
      const txHash = await this.submitter.finalizeClaim(bountyId, slot);
      this.log(`finalized bounty=${bountyId} slot=${slot} in ${txHash}`);
      return { status: "finalized", bountyId, slot, txHash };
    } catch (e) {
      const msg = e.message ?? String(e);
      // Lost a race with the scheduler / a manual finalizer / another
      // relayer: the slot is already dispatched or signed. Benign — the
      // voucher arrives through the normal path.
      if (/SlotPending|AlreadyFinalized/.test(msg)) {
        return { status: "finalize-race", bountyId, slot, detail: msg.slice(0, 160) };
      }
      // Wall-clock skew (our clock ahead of chain time): still immature
      // on-chain. Retried next poll; not an error.
      if (/ChallengeWindowClosed/.test(msg)) {
        return { status: "finalize-immature", bountyId, slot };
      }
      this.log(`finalize failed bounty=${bountyId} slot=${slot}: ${msg.slice(0, 120)}`);
      return { status: "finalize-error", bountyId, slot, error: msg.slice(0, 200) };
    }
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
      // Null in production (validate falls back to wall-clock time);
      // the fixture epoch under local replay. Expiry only — digest,
      // signature, and schedule checks are clock-independent.
      nowSec: this.testNowSec,
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
    while (!this.stopped) {
      this.polling = true;
      try {
        const results = await this.pollOnce();
        const failed = results.filter((r) => r.status === "poll-error");
        this.health.lastPollAt = new Date().toISOString();
        this.health.lastPollOk = failed.length === 0;
        this.health.lastError = failed.length > 0 ? String(failed[0].error ?? "poll-error").slice(0, 300) : null;
      } catch (e) {
        // pollOnce is not supposed to throw (every known failure surfaces
        // as a result status), but an unexpected throw must degrade to
        // log-and-continue rather than take down the loop and the server.
        const msg = e.message ?? String(e);
        this.health.lastPollAt = new Date().toISOString();
        this.health.lastPollOk = false;
        this.health.lastError = String(msg).slice(0, 300);
        this.log(`poll iteration threw: ${String(msg).slice(0, 300)}`);
      } finally {
        this.polling = false;
      }
      if (this.stopped) break;
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
    let server = null;
    if (shouldStartServer()) {
      const started = await startHealthServer({
        port: resolvePort(),
        getStatus: () => relayer.healthStatus(),
        log: (m) => relayer.log(m),
      });
      server = started.server;
    }
    const shutdown = createShutdownCoordinator({
      isPolling: () => relayer.polling,
      onStop: () => {
        relayer.stopped = true;
      },
      closeServer: () => {
        if (server) server.close();
      },
      exit: (code) => process.exit(code),
    });
    process.on("SIGTERM", () => shutdown.onSignal("SIGTERM"));
    process.on("SIGINT", () => shutdown.onSignal("SIGINT"));
    await relayer.runForever();
  }
}
