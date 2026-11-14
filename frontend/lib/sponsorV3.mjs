// V3 sponsorship planner + flow runner: pure bounty-setup logic with all
// chain access injected, so the whole cross-chain flow is unit-testable
// with mocks. SponsorFormV3 is a thin adapter supplying real near.ts /
// base.ts calls and rendering progress. Step order mirrors the deployed
// workflow (E2E RUN4 setup): NEAR create -> Base create -> approve ->
// fund -> NEAR mark_funded. mark_funded runs last because the NEAR
// contract cannot observe Base: the frontend must verify escrow funding
// before calling (lib.rs mark_funded docs).
import {
  CRITERIA_SCHEMA_ID,
  CRITERIA_VERSION,
  hashCriteriaDocument,
  parseAndValidateCriteria,
} from "./criteria.mjs";
import { parseUsdcToBaseUnits, validateDeadline } from "./validation.mjs";
import { interpretNearTxOutcome, thrownTxHash } from "./display.mjs";

/// Step order, shared by reconcile + runner + UI labels.
export const SPONSOR_V3_STEPS = ["nearCreate", "escrowCreate", "approve", "fund", "markFunded"];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// -- Form validation -----------------------------------------------------

/// Validate the V3 sponsor form: a u64-safe non-negative bounty id plus a
/// criteria document that strictly parses, validates, and hashes.
/// Returns { ok, errors[], params? } with params carrying the canonical
/// criteria text (what the contract hashes), its hash, the slot schedule,
/// the summed funding total, and the deadline for the Base leg.
export function validateSponsorV3Form({ bountyId, criteriaText }) {
  const errors = [];
  const id =
    typeof bountyId === "string" && bountyId.trim() !== "" ? Number(bountyId) : bountyId;
  if (!Number.isInteger(id) || id < 0) errors.push("bounty ID must be a non-negative integer");
  else if (id > Number.MAX_SAFE_INTEGER) errors.push("bounty ID exceeds the safe integer range");
  let canonical = null;
  let hash = null;
  let doc = null;
  if (typeof criteriaText !== "string" || criteriaText.trim() === "") {
    errors.push("criteria JSON must not be empty");
  } else {
    const v = parseAndValidateCriteria(criteriaText);
    if (!v.ok) {
      errors.push(...v.errors.map((e) => `criteria: ${e}`));
    } else {
      canonical = v.canonical;
      try {
        doc = JSON.parse(canonical);
        hash = hashCriteriaDocument(canonical);
      } catch (e) {
        errors.push(`criteria: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const slots = doc.slots.map((s) => s.amount);
  const total = slots.reduce((sum, a) => sum + BigInt(a), 0n).toString();
  return {
    ok: true,
    errors: [],
    params: {
      bountyId: id,
      criteriaJson: canonical,
      hash,
      slots,
      total,
      deadline: doc.deadline,
      title: doc.title,
      description: doc.description,
      repo: doc.repo,
      policy: doc.policy,
    },
  };
}

/// Compose a criteria document from structured sponsor-form fields. Every
/// key comes straight from the schema (validateSponsorV3Form stays the
/// downstream gate, so strict validation and hashing are unchanged);
/// unset optionals are omitted and advanced knobs carry documented
/// values. Returns { ok, errors[], json? }. Pure.
export function buildCriteriaDocument({
  title,
  description,
  repo,
  issueUrl = "",
  issueKeywords = "",
  closeReference = true,
  slotAmounts,
  deadline = "",
  challengeWindowSec = "0",
  mergePolicy = "merged",
  allowForks = true,
  identityPolicy = "open",
}) {
  const errors = [];
  const t = typeof title === "string" ? title.trim() : "";
  const d = typeof description === "string" ? description.trim() : "";
  const r = typeof repo === "string" ? repo.trim() : "";
  if (t === "") errors.push("title must not be empty");
  if (d === "") errors.push("description must not be empty");
  if (r === "") errors.push("repo must not be empty");
  const amounts = [];
  const raws = Array.isArray(slotAmounts) ? slotAmounts : [];
  if (raws.length < 1 || raws.length > 16) {
    errors.push("add between 1 and 16 slot amounts");
  } else {
    raws.forEach((raw, i) => {
      const p = parseUsdcToBaseUnits(raw);
      if (!p.ok) errors.push(`slot #${i}: ${p.errors[0]}`);
      else amounts.push(p.baseUnits);
    });
  }
  let deadlineStr = "0";
  const dl = validateDeadline(deadline);
  if (!dl.ok) errors.push(`deadline: ${dl.errors[0]}`);
  else deadlineStr = String(dl.expiry);
  let windowStr = "0";
  const w = typeof challengeWindowSec === "string" ? challengeWindowSec.trim() : "";
  if (w !== "") {
    try {
      const b = BigInt(w);
      if (b < 0n) errors.push("challenge window must be a whole number of seconds");
      else windowStr = b.toString();
    } catch {
      errors.push("challenge window must be a whole number of seconds");
    }
  }
  let issue;
  const url = typeof issueUrl === "string" ? issueUrl.trim() : "";
  if (url !== "") {
    const kws =
      typeof issueKeywords === "string"
        ? issueKeywords
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== "")
        : [];
    if (kws.length < 1 || kws.length > 4) {
      errors.push("issue keywords must be 1..4 comma-separated entries when an issue URL is set");
    } else {
      issue = { url, require_close_reference: closeReference !== false, keywords: kws };
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const doc = {
    schema: CRITERIA_SCHEMA_ID,
    version: CRITERIA_VERSION,
    title: t,
    description: d,
    repo: r,
    merge_policy: mergePolicy,
    allow_forks: allowForks,
    identity_policy: identityPolicy,
    ...(issue ? { issue } : {}),
    policy: amounts.length === 1 ? "single_winner" : "ordered_slots",
    slots: amounts.map((amount) => ({ amount })),
    unfilled: "refund_sponsor",
    deadline: deadlineStr,
    challenge_window_sec: windowStr,
    evidence_max_age_sec: "604800",
  };
  return { ok: true, errors: [], json: JSON.stringify(doc) };
}

// -- Contract argument builders ------------------------------------------

/// Exact `create_bounty` args (lib.rs + xsuite helper): token is the 0x
/// USDC address, criteria_json the canonical document text.
export function buildCreateBountyV3Args({ bountyId, token, criteriaJson }) {
  return { bounty_id: bountyId, token, criteria_json: criteriaJson };
}

/// Exact `mark_funded` args (non-payable, sponsor-only).
export function buildMarkFundedArgs(bountyId) {
  return { bounty_id: bountyId };
}

/// Exact `OmniEscrowV2.createBounty` inputs: schedule + deadline +
/// criteria commitment copied from the validated criteria document.
export function buildEscrowCreateArgs({ bountyId, token, slots, deadline, hash }) {
  return { bountyId, token, amounts: [...slots], deadline, criteriaHash: hash };
}

/// True only for a V3 NEAR contract: `pending_owner` exists solely on the
/// V3 ConfigView (contracts/near-v3 vs contracts/near ConfigView).
export function isV3ContractConfig(cfg) {
  return !!cfg && typeof cfg === "object" && "pending_owner" in cfg;
}

// -- Resume reconciliation -----------------------------------------------

function sameSchedule(esc, params) {
  if (!Array.isArray(esc.amounts) || esc.amounts.length !== params.slots.length) return false;
  for (let i = 0; i < esc.amounts.length; i++) {
    try {
      if (BigInt(esc.amounts[i]) !== BigInt(params.slots[i])) return false;
    } catch {
      return false;
    }
  }
  if (String(esc.deadline) !== String(params.deadline)) return false;
  if (String(esc.criteriaHash ?? "").toLowerCase() !== String(params.hash).toLowerCase()) return false;
  return true;
}

/// Reconcile validated params + wallets + live chain snapshots into the
/// remaining work: { blockers[], warnings[], adopted[5] }. Already-complete
/// steps (verified against the same params) are adopted so resume never
/// re-submits; foreign or mismatched state blocks with an explanation.
/// `near`: null | { sponsor, criteria_hash, funded }. `escrow`: null |
/// V2 struct (zero-sponsor counts as missing). `allowance`/`balance`:
/// bigint | null when unreadable. Pure: no network.
export function reconcileSponsorV3({
  params,
  wallets,
  contractIsV3,
  paused,
  near,
  escrow,
  allowance,
  balance,
}) {
  const blockers = [];
  const warnings = [];
  const adopted = [false, false, false, false, false];
  const nearAccount = wallets?.nearAccount ?? null;
  const evmAddress = wallets?.evmAddress ?? null;
  if (!nearAccount) blockers.push("Connect your NEAR wallet first — the bounty is registered from that account.");
  if (!evmAddress) blockers.push("Connect your EVM wallet first — funding happens from that account on Base Sepolia.");
  if (wallets?.evmOnBaseSepolia !== true) {
    blockers.push("Your EVM wallet is on the wrong network. Switch to Base Sepolia and retry.");
  }
  if (contractIsV3 !== true) {
    blockers.push("This form targets the V3 contract. Point the app at omnibounty-v3.testnet to continue.");
  }
  if (paused === true) blockers.push("The NEAR contract is paused. Bounty creation is disabled right now.");
  if (balance == null) {
    blockers.push("Could not read your USDC balance. Retry once Base Sepolia is reachable.");
  } else if (balance < BigInt(params.total)) {
    blockers.push("Insufficient USDC: your wallet holds less than the criteria total.");
  }

  const nearB = near && typeof near === "object" ? near : null;
  if (nearB) {
    if (nearB.sponsor !== nearAccount) {
      blockers.push(`Bounty #${params.bountyId} already exists on NEAR under a different sponsor. Pick another ID.`);
    } else if (String(nearB.criteria_hash ?? "").toLowerCase() !== String(params.hash).toLowerCase()) {
      blockers.push(`Bounty #${params.bountyId} already exists on NEAR with different criteria. Pick another ID.`);
    } else {
      adopted[0] = true;
      if (nearB.funded === true) adopted[4] = true;
    }
  }
  const esc =
    escrow && typeof escrow === "object" && String(escrow.sponsor ?? "").toLowerCase() !== ZERO_ADDRESS
      ? escrow
      : null;
  if (esc) {
    if (String(esc.sponsor).toLowerCase() !== String(evmAddress ?? "").toLowerCase()) {
      blockers.push(`Bounty #${params.bountyId} is already taken on the Base escrow. Pick another ID.`);
    } else if (!sameSchedule(esc, params)) {
      blockers.push(`Bounty #${params.bountyId} exists on the Base escrow with a different schedule. Pick another ID.`);
    } else {
      adopted[1] = true;
      if (allowance != null && allowance >= BigInt(params.total)) adopted[2] = true;
      if (esc.funded === true) {
        adopted[2] = true;
        adopted[3] = true;
      }
    }
  }
  if (adopted[4] && !(esc && esc.funded === true)) {
    warnings.push(
      "NEAR is already marked funded but the escrow is not funded yet. Resume the escrow steps below to complete the funding reality."
    );
  }
  return { blockers, warnings, adopted };
}

// -- Flow runner ---------------------------------------------------------

function receiptOk(receipt) {
  const s = receipt?.status;
  return s === 1 || s === 1n || s === "0x1";
}

/// Validate a NEAR io result carrying the wallet outcome against its
/// final execution status (defense in depth behind signAndSend, which
/// enforces the same rule): throws carrying the transaction hash when
/// the outcome reports failure or cannot be verified. Results without
/// an outcome (legacy shape) pass through — real adapters always throw
/// or resolve verified outcomes upstream.
function assertNearResult(r) {
  if (r && typeof r === "object" && r.outcome != null) {
    const v = interpretNearTxOutcome(r.outcome);
    if (!v.ok) {
      const err = new Error(v.error);
      err.txHash = v.txHash ?? (typeof r.txHash === "string" ? r.txHash : null);
      throw err;
    }
  }
}

/// Execute the non-adopted steps in order with per-step verification.
/// `token` is the 0x USDC address both chains register; `io` supplies the
/// chain calls; `onStep(i, { status, tx?, note? })` reports progress.
/// Every Base write requires a successful receipt AND a confirming state
/// re-read; NEAR steps require the post-state to be visible; mark_funded
/// re-reads escrow funding immediately before sending (the contract cannot
/// check this itself). Resolves { ok: true, done, txs } or
/// { ok: false, failedStep, message, done, txs }; fully-adopted input
/// touches no `io` at all. Rejects never.
export async function runSponsorV3Flow({ params, token, adopted, io, onStep }) {
  const done = [...adopted];
  const txs = [null, null, null, null, null];
  const report = (i, s) => {
    try {
      onStep(i, s);
    } catch {
      // Progress reporting must never break the flow.
    }
  };
  const need = (i) => !done[i];
  try {
    if (need(0)) {
      report(0, { status: "pending", note: "Confirm in your NEAR wallet…" });
      const r = await io.createNear(buildCreateBountyV3Args({ ...params, token }));
      txs[0] = r?.txHash ?? null;
      assertNearResult(r);
      const v = await io.getNear(params.bountyId);
      if (!v) throw new Error(`NEAR bounty #${params.bountyId} is not visible after creation.`);
      done[0] = true;
      report(0, { status: "done", tx: txs[0] });
    }
    if (need(1)) {
      report(1, { status: "pending", note: "Confirm in your EVM wallet…" });
      const r = await io.createEscrow(buildEscrowCreateArgs({ ...params, token }));
      txs[1] = r?.txHash ?? null;
      if (!receiptOk(r?.receipt)) throw new Error("Base createBounty transaction reverted.");
      const v = await io.getEscrow(params.bountyId);
      if (!v || String(v.sponsor ?? "").toLowerCase() === ZERO_ADDRESS) {
        throw new Error(`Base escrow bounty #${params.bountyId} is not visible after creation.`);
      }
      done[1] = true;
      report(1, { status: "done", tx: txs[1] });
    }
    if (need(2)) {
      report(2, { status: "pending", note: "Confirm in your EVM wallet…" });
      const r = await io.approveUSDC(params.total);
      txs[2] = r?.txHash ?? null;
      if (!receiptOk(r?.receipt)) throw new Error("USDC approve transaction reverted.");
      const a = await io.getAllowance();
      if (a == null || a < BigInt(params.total)) {
        throw new Error("USDC allowance is still below the funding total after approval.");
      }
      done[2] = true;
      report(2, { status: "done", tx: txs[2] });
    }
    if (need(3)) {
      report(3, { status: "pending", note: "Confirm in your EVM wallet…" });
      const r = await io.fundEscrow(params.bountyId);
      txs[3] = r?.txHash ?? null;
      if (!receiptOk(r?.receipt)) throw new Error("Base fundBounty transaction reverted.");
      const v = await io.getEscrow(params.bountyId);
      if (!v || v.funded !== true) {
        throw new Error(`Base escrow bounty #${params.bountyId} is not funded after funding.`);
      }
      done[3] = true;
      report(3, { status: "done", tx: txs[3] });
    }
    if (need(4)) {
      const v = await io.getEscrow(params.bountyId);
      if (!v || v.funded !== true) {
        throw new Error("Escrow is not funded — refusing to mark funded on NEAR.");
      }
      report(4, { status: "pending", note: "Confirm in your NEAR wallet…" });
      const r = await io.markFunded(params.bountyId);
      txs[4] = r?.txHash ?? null;
      assertNearResult(r);
      const n = await io.getNear(params.bountyId);
      if (!n || n.funded !== true) {
        throw new Error(`NEAR bounty #${params.bountyId} is not marked funded after confirmation.`);
      }
      done[4] = true;
      report(4, { status: "done", tx: txs[4] });
    }
    return { ok: true, done, txs };
  } catch (e) {
    const failedStep = done.findIndex((d) => !d);
    const message = e instanceof Error ? e.message : String(e);
    if (failedStep >= 0) {
      if (txs[failedStep] == null) txs[failedStep] = thrownTxHash(e);
      report(failedStep, { status: "error", note: message, tx: txs[failedStep] ?? undefined });
    }
    return { ok: false, failedStep, message, done, txs };
  }
}
