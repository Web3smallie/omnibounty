// V3 cross-chain e2e library (Hardhat in-process EVM + REAL NEAR-produced
// vouchers). Imported by e2e-v3-prepare.mjs and e2e-v3-run.mjs, executed via
// `npx hardhat run --no-compile` (compilation comes from the Foundry build).
//
// Flow (from integration/):
//   npm run e2e:prepare            # prints E2E_* exports
//   <paste exports> (cd ../contracts/near-v3 && cargo test regen_e2e_fixture -- --ignored --nocapture)
//   npm run e2e                    # scenarios A-F
//
// Provenance discipline (never blur these):
// - NEAR execution: REAL LOGIC (Rust verify/evaluate/finalize/apply) but
//   OFFLINE — the fixture embeds actually-executed contract outputs with
//   real ECDSA witness + MPC signatures, generated seconds before the run.
//   NOT a live chain, NOT mocked logic.
// - MPC network: SUBSTITUTED by a test key (the mock-MPC trust model).
//   Unit tests + (Linux) xsuite cover the async promise/callback legs.
// - Base execution: REAL EVM (Hardhat in-process network; pure JS, no
//   sockets, no native modules) running the REAL compiled escrow bytecode
//   with REAL transactions, receipts, and events.
// - Relayer: the REAL Relayer class (validate + submit + retry logic).
//
// Every scenario emits a structured trace (states: pending/qualified/
// awaiting-signature/voucher-ready/submitted/confirmed/failed/refunded)
// to out/v3-e2e-trace-<ts>.json. Success requires a confirmed receipt PLUS
// a parsed VoucherClaimed event — never submission alone.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import hre from "hardhat";
import { ethers } from "ethers";
import { Relayer, ESCROW_ABI_V2 } from "../../relayer/src/index.mjs";
import { StateStore } from "../../relayer/src/store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const OUTDIR = join(HERE, "..", "out");
export const DUMMY_SIGNER = "0x1111111111111111111111111111111111111111";

export function loadArtifact(relPath) {
  const p = join(ROOT, relPath);
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (!j.abi || !j.bytecode?.object) throw new Error("bad artifact shape");
    return j;
  } catch (e) {
    throw new Error(
      `missing build artifact ${relPath} (${e.message}); run forge build + forge test in contracts/base-v3 first`
    );
  }
}

export async function chain() {
  const provider = hre.ethers.provider;
  const [deployer, sponsor] = await hre.ethers.getSigners();
  const net = await provider.getNetwork();
  return { provider, deployer, sponsor, chainId: net.chainId };
}

export async function deploySuite(deployer, mpcSigner) {
  const usdcArt = loadArtifact("contracts/base-v3/out/OmniEscrowV2.t.sol/MockUSDC.json");
  const escArt = loadArtifact("contracts/base-v3/out/OmniEscrowV2.sol/OmniEscrowV2.json");
  const usdcFactory = new hre.ethers.ContractFactory(usdcArt.abi, usdcArt.bytecode.object, deployer);
  const usdc = await usdcFactory.deploy();
  await usdc.waitForDeployment();
  const escFactory = new hre.ethers.ContractFactory(escArt.abi, escArt.bytecode.object, deployer);
  const escrow = await escFactory.deploy(mpcSigner);
  await escrow.waitForDeployment();
  return { token: await usdc.getAddress(), escrow: await escrow.getAddress() };
}

export function loadFixture() {
  const p = join(ROOT, "testdata", "v3", "e2e-vouchers.json");
  let fx;
  try {
    fx = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`cannot read e2e fixture at ${p} (${e.message}); run e2e:prepare, then the regen command it prints`);
  }
  for (const c of fx.claims) {
    if (BigInt(c.voucher.voucher.expiry) <= BigInt(Math.floor(Date.now() / 1000) + 300)) {
      throw new Error(
        `e2e fixture is stale (slot ${c.slot} voucher expires within 5 min); regenerate it via e2e:prepare`
      );
    }
  }
  return fx;
}

export async function assertChainSane(provider, fx) {
  const net = await provider.getNetwork();
  assert.equal(
    net.chainId,
    BigInt(fx.config.chainId),
    `chain mismatch: network ${net.chainId} vs fixture ${fx.config.chainId}`
  );
  const block = await provider.getBlock("latest");
  const drift = Math.abs(Number(block.timestamp) - Math.floor(Date.now() / 1000));
  assert.ok(drift < 3600, `chain clock drift ${drift}s too large; fixture timestamps would be meaningless`);
}

export { Relayer, ESCROW_ABI_V2, StateStore };
export { assert };

// ---------------------------------------------------------------------------
// Trace + fakes
// ---------------------------------------------------------------------------

export function newTrace(fx) {
  return {
    harness: "e2e-v3-hardhat",
    startedAt: new Date().toISOString(),
    provenance: {
      near: "offline-real-logic (Rust-executed views + real ECDSA, fixture-embedded)",
      mpc: "SUBSTITUTED test key (mock-MPC trust model, NOT live MPC)",
      base: "live-local EVM (Hardhat in-process) with real compiled escrow bytecode",
      relayer: "live (real Relayer class)",
    },
    fixtureGeneratedAt: fx.generated_at,
    scenarios: [],
  };
}

export function newScenario(trace, id, title) {
  const s = { id, title, status: "running", steps: [] };
  trace.scenarios.push(s);
  return s;
}

export function step(s, stage, status, detail, provenance = "live") {
  s.steps.push({ stage, status, detail, provenance });
  console.log(`  [${s.id}] ${stage}: ${status}${detail ? ` — ${detail}` : ""}`);
}

export function pass(s) {
  s.status = "pass";
  console.log(`PASS ${s.id}`);
}

export function fail(s, err) {
  s.status = "FAIL";
  s.error = String(err?.message ?? err);
  console.log(`FAIL ${s.id}: ${s.error}`);
  throw err;
}

/// Fake NEAR endpoint serving REAL Rust-produced views (fixture-embedded).
/// The bounty view is module state set once per run (single bounty).
let E2E_BOUNTY_VIEW = null;

export function setE2EBountyView(bv) {
  E2E_BOUNTY_VIEW = bv;
}

class FixtureNear {
  constructor(views) {
    this.views = views;
  }

  async listUnrelayed() {
    return structuredClone(this.views);
  }

  async getBounty(contractId, bountyId) {
    if (!E2E_BOUNTY_VIEW || Number(bountyId) !== E2E_BOUNTY_VIEW.id) return null;
    return structuredClone(E2E_BOUNTY_VIEW);
  }
}

export function makeRelayer({ escrow, mpcSigner, escrowAddress, chainId, views, storePath }) {
  const near = new FixtureNear(views);
  const store = new StateStore(storePath);
  const config = {
    contractId: "v3.omnibounty.testnet",
    escrowAddress,
    mpcSigner,
    expectedChainId: BigInt(chainId),
    confirmations: 1,
    maxAttempts: 3,
    voucherVersion: "2",
  };
  const logs = [];
  const relayer = new Relayer({ config, near, escrow, store, log: (m) => logs.push(m) });
  return { relayer, logs, store };
}

/// Assert a relayed result against its on-chain receipt + event.
/// Success requires BOTH — never submission alone.
export async function assertConfirmedPayout(provider, escrowFull, result, want) {
  assert.equal(result.status, "relayed", `expected relayed, got ${result.status}`);
  assert.ok(result.txHash, "missing txHash");
  const receipt = await provider.getTransactionReceipt(result.txHash);
  assert.ok(receipt, "no receipt found");
  assert.equal(receipt.status, 1, "receipt status != 1");
  const iface = escrowFull.interface;
  const events = receipt.logs
    .map((l) => {
      try {
        return iface.parseLog(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.name === "VoucherClaimed");
  assert.equal(events.length, 1, "expected exactly one VoucherClaimed event");
  const ev = events[0].args;
  assert.equal(ev.bountyId, BigInt(want.bountyId));
  assert.equal(Number(ev.slotIndex), want.slot);
  assert.equal(ev.recipient.toLowerCase(), want.recipient.toLowerCase());
  assert.equal(ev.amount, BigInt(want.amount));
  assert.equal(ev.nonce, BigInt(want.nonce));
  assert.equal(ev.criteriaHash.toLowerCase(), want.criteriaHash.toLowerCase());
  assert.equal(ev.digest.toLowerCase(), result.digest.toLowerCase());
  return receipt;
}

export async function expectRevertName(promise, name) {
  try {
    await promise;
  } catch (e) {
    // Minimal ABIs cannot decode custom-error names, so accept either the
    // decoded name or the raw 4-byte selector (all escrow errors are
    // parameterless, hence exactly 4 bytes of revert data).
    const selector = ethers.id(`${name}()`).slice(0, 10).toLowerCase();
    const text = `${e.reason ?? ""} ${e.message ?? ""} ${e.data ?? ""}`;
    assert.ok(
      text.includes(name) || text.toLowerCase().includes(selector),
      `expected revert ${name} (${selector}), got: ${text.slice(0, 300)}`
    );
    return;
  }
  assert.fail(`expected revert ${name}, but the call succeeded`);
}

export function claimRecordFor(fx, slot) {
  const c = fx.claims.find((x) => x.slot === slot);
  assert.ok(c, `fixture has no claim for slot ${slot}`);
  return c;
}

export function unrelayedFor(fx, slot) {
  const u = fx.unrelayed.find((x) => Number(x.slot) === slot);
  assert.ok(u, `fixture has no unrelayed entry for slot ${slot}`);
  return u;
}

// ---------------------------------------------------------------------------
// Scenarios (ctx: { fx, ethers, provider, escrow, usdc, sponsor, trace, tmpStore })
// ---------------------------------------------------------------------------

export async function scenarioA(ctx) {
  const { fx, ethers, provider, escrow, usdc, trace } = ctx;
  const s = newScenario(trace, "A", "successful qualification and payout (slot 0)");
  try {
    const rec = claimRecordFor(fx, 0);
    step(s, "pending", "observed", `bounty ${fx.bounty.bountyId} funded`, "fixture");
    step(s, "qualified", "observed", `PR #${rec.claim.pr_number} seq ${rec.claim.claim_seq}`, "fixture");
    step(s, "awaiting-signature", "observed", "MPC dispatch recorded", "fixture");
    step(s, "voucher-ready", "observed", `digest ${rec.voucher.voucher.digest}`, "fixture");
    const { relayer } = makeRelayer({
      escrow,
      mpcSigner: fx.config.mpcSigner,
      escrowAddress: fx.config.escrow,
      chainId: fx.config.chainId,
      views: [unrelayedFor(fx, 0)],
      storePath: ctx.tmpStore("a"),
    });
    const [res] = await relayer.pollOnce();
    step(s, "submitted", res.status === "relayed" ? "ok" : "FAILED", res.txHash ?? res.reason);
    const receipt = await assertConfirmedPayout(provider, ctx.escrowFull, res, {
      bountyId: fx.bounty.bountyId,
      slot: 0,
      recipient: rec.recipient,
      amount: fx.bounty.slots[0],
      nonce: rec.voucher.voucher.nonce,
      criteriaHash: fx.bounty.criteriaHash,
    });
    step(s, "confirmed", "ok", `block ${receipt.blockNumber} tx ${res.txHash}`);
    assert.equal((await usdc.balanceOf(rec.recipient)).toString(), fx.bounty.slots[0]);
    const [claimed] = await escrow.slotStatus(fx.bounty.bountyId, 0);
    assert.equal(claimed, true);
    pass(s);
  } catch (e) {
    fail(s, e);
  }
}

export async function scenarioB(ctx) {
  const { fx, ethers, provider, escrow, usdc, trace } = ctx;
  const s = newScenario(trace, "B", "second winner, independent slot (slot 1)");
  try {
    const rec = claimRecordFor(fx, 1);
    const { relayer } = makeRelayer({
      escrow,
      mpcSigner: fx.config.mpcSigner,
      escrowAddress: fx.config.escrow,
      chainId: fx.config.chainId,
      views: [unrelayedFor(fx, 1)],
      storePath: ctx.tmpStore("b"),
    });
    const [res] = await relayer.pollOnce();
    await assertConfirmedPayout(provider, ctx.escrowFull, res, {
      bountyId: fx.bounty.bountyId,
      slot: 1,
      recipient: rec.recipient,
      amount: fx.bounty.slots[1],
      nonce: rec.voucher.voucher.nonce,
      criteriaHash: fx.bounty.criteriaHash,
    });
    step(s, "confirmed", "ok", `tx ${res.txHash}`);
    assert.equal((await usdc.balanceOf(rec.recipient)).toString(), fx.bounty.slots[1]);
    pass(s);
  } catch (e) {
    fail(s, e);
  }
}

export async function scenarioC(ctx) {
  const { fx, escrow, usdc, trace } = ctx;
  const s = newScenario(trace, "C", "replay protection (slot 0, already paid)");
  try {
    const before = await usdc.balanceOf(claimRecordFor(fx, 0).recipient);
    const { relayer } = makeRelayer({
      escrow,
      mpcSigner: fx.config.mpcSigner,
      escrowAddress: fx.config.escrow,
      chainId: fx.config.chainId,
      views: [unrelayedFor(fx, 0)],
      storePath: ctx.tmpStore("c-fresh"),
    });
    const [res] = await relayer.pollOnce();
    assert.equal(res.status, "already");
    step(s, "voucher-ready", "skipped-pre-submit", "already used on-chain");
    // Bypass the relayer: direct submission MUST revert VoucherUsed
    // (defense in depth — the escrow never trusts the relayer's check).
    const u = unrelayedFor(fx, 0);
    const tuple = [
      BigInt(u.voucher.bounty_id),
      Number(BigInt(u.voucher.slot_index)),
      u.voucher.recipient,
      u.voucher.token,
      BigInt(u.voucher.amount),
      BigInt(u.voucher.nonce),
      BigInt(u.voucher.expiry),
      BigInt(u.voucher.chain_id),
      u.voucher.escrow,
      u.voucher.criteria_hash,
    ];
    await expectRevertName(escrow.claim(tuple, u.v, u.r, u.s), "VoucherUsed");
    step(s, "submitted", "reverted-on-chain", "VoucherUsed");
    assert.equal((await usdc.balanceOf(claimRecordFor(fx, 0).recipient)).toString(), before.toString());
    pass(s);
  } catch (e) {
    fail(s, e);
  }
}

export async function scenarioD(ctx) {
  const { fx, escrow, trace } = ctx;
  const s = newScenario(trace, "D", "invalid authorizations rejected at the right layer");
  try {
    // Field errors the relayer CANNOT see (funding state) must reach the
    // escrow and revert there; everything else must be skipped pre-submit.
    // unknown-bounty is pre-submit: no NEAR bounty exists to check against.
    const escrowLayer = new Set(["wrong-amount", "wrong-token", "wrong-criteria"]);
    for (const neg of fx.negatives) {
      const { relayer } = makeRelayer({
        escrow,
        mpcSigner: fx.config.mpcSigner,
        escrowAddress: fx.config.escrow,
        chainId: fx.config.chainId,
        views: [neg.signed],
        storePath: ctx.tmpStore(`d-${neg.tag}`),
      });
      const [res] = await relayer.pollOnce();
      assert.equal(res.status, "skipped", neg.tag);
      if (escrowLayer.has(neg.tag)) {
        // Estimation-path reverts surface as raw selectors (minimal ABI);
        // accept the decoded name or the 4-byte selector.
        const { ethers } = await import("ethers");
        const sel = ethers.id(`${neg.expect}()`).slice(0, 10).toLowerCase();
        assert.ok(
          res.reason.includes(neg.expect) || res.reason.toLowerCase().includes(sel),
          `${neg.tag}: expected on-chain ${neg.expect} (${sel}), got: ${res.reason}`
        );
        step(s, "submitted", "reverted-on-chain", `${neg.tag} -> ${neg.expect}`);
      } else {
        step(s, "voucher-ready", "rejected-pre-submit", `${neg.tag} -> ${res.reason}`);
      }
      const v = neg.signed.voucher;
      const tuple = [
        BigInt(v.bounty_id),
        Number(BigInt(v.slot_index)),
        v.recipient,
        v.token,
        BigInt(v.amount),
        BigInt(v.nonce),
        BigInt(v.expiry),
        BigInt(v.chain_id),
        v.escrow,
        v.criteria_hash,
      ];
      await expectRevertName(
        escrow.claim.staticCall(tuple, neg.signed.v, neg.signed.r, neg.signed.s),
        neg.expect
      );
    }
    pass(s);
  } catch (e) {
    fail(s, e);
  }
}

export async function scenarioFrace(ctx) {
  const { fx, ethers, provider, escrow, usdc, trace } = ctx;
  const s = newScenario(trace, "F-race", "duplicate relayer execution (slot 2)");
  try {
    const mk = (tag) =>
      makeRelayer({
        escrow,
        mpcSigner: fx.config.mpcSigner,
        escrowAddress: fx.config.escrow,
        chainId: fx.config.chainId,
        views: [unrelayedFor(fx, 2)],
        storePath: ctx.tmpStore(`f-race-${tag}`),
      }).relayer;
    const r1 = mk("a");
    const r2 = mk("b");
    const before = await usdc.balanceOf(claimRecordFor(fx, 2).recipient);
    const [a, b] = await Promise.all([r1.pollOnce(), r2.pollOnce()]);
    const statuses = [a[0].status, b[0].status].sort();
    assert.deepEqual(statuses, ["relayed", "skipped"]);
    const winner = a[0].status === "relayed" ? a[0] : b[0];
    await assertConfirmedPayout(provider, ctx.escrowFull, winner, {
      bountyId: fx.bounty.bountyId,
      slot: 2,
      recipient: claimRecordFor(fx, 2).recipient,
      amount: fx.bounty.slots[2],
      nonce: claimRecordFor(fx, 2).voucher.voucher.nonce,
      criteriaHash: fx.bounty.criteriaHash,
    });
    step(s, "confirmed", "ok", `exactly one winner: ${winner.txHash}`);
    assert.equal(
      (await usdc.balanceOf(claimRecordFor(fx, 2).recipient)) - before,
      BigInt(fx.bounty.slots[2])
    );
    pass(s);
  } catch (e) {
    fail(s, e);
  }
}

export async function scenarioFretry(ctx) {
  const { fx, ethers, provider, escrow, usdc, trace } = ctx;
  const s = newScenario(trace, "F-retry", "relayer RPC failure then recovery (slot 3)");
  try {
    const deadProvider = new ethers.JsonRpcProvider("http://127.0.0.1:9");
    const deadEscrow = new ethers.Contract(fx.config.escrow, ESCROW_ABI_V2, deadProvider);
    const { relayer: broken } = makeRelayer({
      escrow: deadEscrow,
      mpcSigner: fx.config.mpcSigner,
      escrowAddress: fx.config.escrow,
      chainId: fx.config.chainId,
      views: [unrelayedFor(fx, 3)],
      storePath: ctx.tmpStore("f-retry"),
    });
    const [err] = await broken.pollOnce();
    assert.equal(err.status, "error");
    step(s, "submitted", "rpc-failed-then-retry", String(err.error).slice(0, 120));
    const { relayer } = makeRelayer({
      escrow,
      mpcSigner: fx.config.mpcSigner,
      escrowAddress: fx.config.escrow,
      chainId: fx.config.chainId,
      views: [unrelayedFor(fx, 3)],
      storePath: ctx.tmpStore("f-retry"),
    });
    const [res] = await relayer.pollOnce();
    await assertConfirmedPayout(provider, ctx.escrowFull, res, {
      bountyId: fx.bounty.bountyId,
      slot: 3,
      recipient: claimRecordFor(fx, 3).recipient,
      amount: fx.bounty.slots[3],
      nonce: claimRecordFor(fx, 3).voucher.voucher.nonce,
      criteriaHash: fx.bounty.criteriaHash,
    });
    step(s, "confirmed", "ok", `tx ${res.txHash}`);
    pass(s);
  } catch (e) {
    fail(s, e);
  }
}

export async function scenarioE(ctx) {
  const { fx, provider, escrow, escrowFull, usdc, sponsor, trace } = ctx;
  const s = newScenario(trace, "E", "refund unclaimed slot, then claim-after-refund fails (slot 4)");
  try {
    await provider.send("evm_increaseTime", [7200]);
    await provider.send("evm_mine", []);
    const before = await usdc.balanceOf(sponsor.address);
    const tx = await escrowFull.refundSlot(fx.bounty.bountyId, 4);
    const receipt = await tx.wait(1);
    assert.equal(receipt.status, 1);
    const [, refunded] = await escrowFull.slotStatus(fx.bounty.bountyId, 4);
    assert.equal(refunded, true);
    assert.equal((await usdc.balanceOf(sponsor.address)) - before, BigInt(fx.bounty.slots[4]));
    step(s, "refunded", "ok", `tx ${receipt.hash}`);
    const { relayer } = makeRelayer({
      escrow,
      mpcSigner: fx.config.mpcSigner,
      escrowAddress: fx.config.escrow,
      chainId: fx.config.chainId,
      views: [unrelayedFor(fx, 4)],
      storePath: ctx.tmpStore("e"),
    });
    const [res] = await relayer.pollOnce();
    assert.equal(res.status, "skipped");
    assert.ok(
      res.reason.includes("AlreadyRefunded") || res.reason.toLowerCase().includes("0xa85e6f1a"),
      `expected AlreadyRefunded, got: ${res.reason}`
    );
    step(s, "submitted", "reverted-on-chain", "AlreadyRefunded");
    pass(s);
  } catch (e) {
    fail(s, e);
  }
}
