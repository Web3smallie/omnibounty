// Relayer main loop: NEAR `list_unrelayed` -> validate -> escrow.usedVoucher
// ground-truth check -> submit claim -> confirm -> record.
//
// Idempotency: a voucher is submitted only if (a) it validates, (b) it is
// not in local state, and (c) the escrow reports it unused. A crash between
// submission and recording is safe: the next poll re-checks (c) on-chain.
import { ethers } from "ethers";
import { NearRpc } from "./near.mjs";
import { StateStore } from "./store.mjs";
import { normalizeVoucherShape, validateSignedVoucher } from "./validate.mjs";
import { loadConfig, summarize } from "./config.mjs";

const ESCROW_ABI = [
  "function usedVoucher(bytes32) view returns (bool)",
  "function claim((uint256 bountyId,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow) v, uint8 sigV, bytes32 r, bytes32 s)",
];

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
    const escrow = new ethers.Contract(config.escrowAddress, ESCROW_ABI, wallet);
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
    const checked = validateSignedVoucher(signed, {
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
    const v = normalizeVoucherShape(signed.voucher);
    const tuple = [
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
        // error in OmniEscrow.sol by name, so finality never depends on
        // provider message phrasing. Anything else is treated as transient.
        if (/revert|VoucherUsed|VoucherExpired|BadSignature|AlreadyClaimed|BountyNotFound|TokenMismatch|AmountMismatch|NotFunded|WrongChain|WrongEscrow|ZeroAddress|ZeroAmount|TransferFailed|Reentrant|NotSponsor|BountyExists|AlreadyFunded|NotOwner|call revert/i.test(msg)) {
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
