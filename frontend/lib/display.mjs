// Pure display + chain-data shaping helpers shared by the UI and tests.
// No dependencies, no network: every function here is deterministic and
// safe to unit-test. Anything shown to users but NOT derived from chain
// data must never be formatted here — this module only presents values
// that came from the NEAR contract, the Base escrow, or the user's proof.

// -- RPC failure diagnosis -------------------------------------------------
/// Render a fetch-level RPC failure with its underlying cause. Node's
/// undici fetch reports transport problems (DNS, proxy, firewall, TLS,
/// refused/reset connections) as a bare "fetch failed" TypeError with the
/// real reason on `cause` — surfacing it is the difference between a
/// diagnosable error and a mystery. Pure: no network.
export function describeFetchFailure(url, error) {
  const base =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  let detail = "";
  if (cause instanceof Error) {
    const code = typeof cause.code === "string" ? `${cause.code}: ` : "";
    detail = ` [cause: ${code}${cause.message}]`;
  } else if (cause !== undefined && cause !== null) {
    detail = ` [cause: ${String(cause)}]`;
  }
  return `fetch failed (${url}): ${base}${detail}`;
}

// -- Money ---------------------------------------------------------------

/// Format USDC base units (6 decimals) for display: "1000000" -> "1.00",
/// "2500000000" -> "2,500.00", "1000001" -> "1.000001". Accepts a decimal
/// string, number, or bigint. Throws on malformed input (caller error,
//  never user input — user input goes through parseUsdcToBaseUnits first).
export function formatUsdc(baseUnits) {
  const v = typeof baseUnits === "bigint" ? baseUnits : BigInt(baseUnits);
  if (v < 0n) throw new Error("formatUsdc: negative amount");
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0");
  const trimmed = frac.replace(/0+$/, "");
  const decimals = (trimmed + "00").slice(0, Math.max(2, trimmed.length));
  return `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${decimals}`;
}

// -- Addresses, time -----------------------------------------------------

export function shortenAddress(addr) {
  if (typeof addr !== "string" || addr.length < 12) return String(addr);
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/// Unix seconds -> "2026-11-09 08:41 UTC".
export function formatDateTime(unixSec) {
  const d = new Date(Number(unixSec) * 1000);
  if (!Number.isFinite(d.getTime())) return "unknown time";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/// Bounty expiry -> "No deadline" or a formatted date.
export function formatExpiry(expiry) {
  if (!expiry) return "No deadline";
  return formatDateTime(expiry);
}

/// Relative age ("just now", "5m ago", "3h ago", "2d ago"). `nowSec` is
/// injectable so tests stay deterministic; callers omit it.
export function timeAgo(unixSec, nowSec = Math.floor(Date.now() / 1000)) {
  const diff = Math.max(0, Math.floor(nowSec - Number(unixSec)));
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// -- Explorer + external links --------------------------------------------

export function nearTxUrl(networkId, hash) {
  const host = networkId === "mainnet" ? "nearblocks.io" : "testnet.nearblocks.io";
  return `https://${host}/txns/${hash}`;
}

export function nearAccountUrl(networkId, accountId) {
  const host = networkId === "mainnet" ? "nearblocks.io" : "testnet.nearblocks.io";
  return `https://${host}/address/${accountId}`;
}

/// Base Sepolia-first: the only chain this frontend targets.
export function baseTxUrl(hash) {
  return `https://sepolia.basescan.org/tx/${hash}`;
}

export function baseAddressUrl(addr) {
  return `https://sepolia.basescan.org/address/${addr}`;
}

export function baseBlockUrl(blockNumber) {
  return `https://sepolia.basescan.org/block/${blockNumber}`;
}

export function githubPrUrl(repo, prNumber) {
  return `https://github.com/${repo}/pull/${prNumber}`;
}

// -- Bounty presentation --------------------------------------------------

/// Marketplace title, derived from the on-chain template (the contract
/// stores no free-text title).
export function bountyTitle(bounty) {
  return `${bounty.repo}#${bounty.pr_number}`;
}

/// Human criteria line, derived from the on-chain template.
export function bountyCriteria(bounty) {
  return `Merged PR ${bounty.repo}#${bounty.pr_number}, verified with Reclaim zkTLS. Payout goes to the proof owner.`;
}

export function isBountyExpired(bounty, nowSec = Math.floor(Date.now() / 1000)) {
  return bounty.expiry !== 0 && Number(bounty.expiry) <= nowSec;
}

// -- Bounty list (V1 + V3) -------------------------------------------------

/// V1/V3 shape guard for list views. V3 bounties carry `criteria_hash`
/// (contracts/near-v3 BountyView) and have no `repo`, `pr_number`, or
/// `amount`; V1/V2 bounties have no `criteria_hash`. Same detection the
/// bounty detail page uses. Pure: no RPC.
export function isBountyV3(bounty) {
  return bounty !== null && typeof bounty === "object" && bounty.criteria_hash !== undefined;
}

/// Parse a USDC base-units value without throwing: returns the bigint,
/// or null when the value is absent, malformed, or negative. List stats
/// and cards use this so one bad record can never crash the page. Pure.
export function parseAmountValue(value) {
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    return null;
  }
  try {
    const v = typeof value === "bigint" ? value : BigInt(value);
    return v < 0n ? null : v;
  } catch {
    return null;
  }
}

/// Total USDC base units claimed across a bounty list (homepage stat).
/// Sums `amount` of `claimed` records with a valid amount; V3 records
/// carry `total_amount` (the whole bounty, not the claimed part) with
/// `expired`/`funded`/`open` statuses, so they never contribute here.
/// Missing, malformed, and negative amounts are skipped, never thrown.
export function claimedAmountsTotal(bounties) {
  if (!Array.isArray(bounties)) return 0n;
  let sum = 0n;
  for (const b of bounties) {
    if (b?.status !== "claimed") continue;
    const v = parseAmountValue(b.amount);
    if (v !== null) sum += v;
  }
  return sum;
}

/// Settled-slot total from a V2 escrow bounty struct: sums `amounts[i]`
/// for every set bit `i` of `claimedBitmap`. The escrow sets the bit
/// atomically with the USDC transfer, so this is settlement ground truth —
/// pending, qualified, signed-but-unrelayed, and rejected vouchers all
/// leave the bit unset and contribute nothing. Bits at or beyond
/// `amounts.length` are ignored; malformed, negative, or invalid amounts
/// are skipped. Never throws on malformed input. Pure: no RPC.
export function claimedBitmapTotal(amounts, claimedBitmap) {
  if (!Array.isArray(amounts)) return 0n;
  if (typeof claimedBitmap === "string" && claimedBitmap.trim() === "") return 0n;
  if (typeof claimedBitmap !== "string" && typeof claimedBitmap !== "number" && typeof claimedBitmap !== "bigint") {
    return 0n;
  }
  let bits;
  try {
    bits = typeof claimedBitmap === "bigint" ? claimedBitmap : BigInt(claimedBitmap);
  } catch {
    return 0n;
  }
  if (bits < 0n) return 0n;
  let sum = 0n;
  for (let i = 0; i < amounts.length; i++) {
    if ((bits & (1n << BigInt(i))) === 0n) continue;
    const v = parseAmountValue(amounts[i]);
    if (v !== null) sum += v;
  }
  return sum;
}

/// Aggregate verified V3 payouts across a bounty list (homepage stat).
/// For every V3-shaped bounty that may hold fills, calls the injected
/// `readPaid(bountyId)` reader — which must return
/// `{ paid: bigint, ok: boolean }` (see `escrowV2PaidTotal` in
/// lib/base.ts) — with at most `maxParallel` reads in flight (default 8).
/// V1 records never go through the V3 path; V3 records with a valid
/// `slots_filled` of 0 are skipped without a read. Returns
/// `{ total, incomplete }`: failed, malformed, or unaddressable
/// reads contribute 0 and set `incomplete`, so failures are reported,
/// never silently zeroed. Pure orchestration: chain access happens only
/// inside `readPaid`.
export async function aggregateV3Paid(bounties, readPaid, opts = {}) {
  const maxParallel =
    opts && Number.isInteger(opts.maxParallel) && opts.maxParallel > 0 ? opts.maxParallel : 8;
  const list = Array.isArray(bounties) ? bounties : [];
  const targets = [];
  let incomplete = false;
  for (const b of list) {
    if (!isBountyV3(b)) continue; // V1 records stay on the V1 path.
    if (!Number.isInteger(b.id)) {
      incomplete = true; // Cannot even address the escrow read.
      continue;
    }
    if (Number.isInteger(b.slots_filled) && b.slots_filled <= 0) continue; // Nothing filled.
    targets.push(b.id);
  }
  let total = 0n;
  for (let i = 0; i < targets.length; i += maxParallel) {
    const batch = targets.slice(i, i + maxParallel).map(async (id) => {
      try {
        const r = await readPaid(id);
        if (!r || typeof r !== "object" || r.ok !== true) return { paid: 0n, ok: false };
        if (typeof r.paid !== "bigint" || r.paid < 0n) return { paid: 0n, ok: false };
        return { paid: r.paid, ok: true };
      } catch {
        return { paid: 0n, ok: false };
      }
    });
    for (const r of await Promise.all(batch)) {
      total += r.paid;
      if (!r.ok) incomplete = true;
    }
  }
  return { total, incomplete };
}

/// Card amount line for a V1 or V3 bounty: the formatted USDC value, or
/// null when the record carries no usable amount (the caller then shows
/// an honest fallback instead of crashing or inventing a figure). Pure.
export function bountyCardAmountText(bounty) {
  const raw = isBountyV3(bounty) ? bounty.total_amount : bounty?.amount;
  const v = parseAmountValue(raw);
  return v === null ? null : formatUsdc(v);
}

/// Marketplace search match for a V1 or V3 bounty. `q` is the already
/// trimmed, lowercased query. Matches #id always, `repo` when present,
/// and `criteria_hash` when present. Never throws on missing fields. Pure.
export function bountyMatchesQuery(bounty, q) {
  if (q === "") return true;
  if (!bounty || typeof bounty !== "object") return false;
  if (String(bounty.id) === q || `#${bounty.id}` === q) return true;
  if (typeof bounty.repo === "string" && bounty.repo.toLowerCase().includes(q)) return true;
  if (typeof bounty.criteria_hash === "string" && bounty.criteria_hash.toLowerCase().includes(q)) {
    return true;
  }
  return false;
}

/// Slots line for a V3 card ("2 slots (1 claimed)"), or null for V1
/// bounties and for V3 records with a malformed slots shape. Pure.
export function bountyCardSlotsText(bounty) {
  if (!isBountyV3(bounty)) return null;
  if (!Array.isArray(bounty.slots)) return null;
  const filled = bounty.slots_filled ?? 0;
  if (!Number.isInteger(filled) || filled < 0) return null;
  const n = bounty.slots.length;
  return `${n} slot${n === 1 ? "" : "s"} (${filled} claimed)`;
}

/// Marketplace card state from a V2 escrow bounty struct: V1-shaped
/// `{ token, amount, sponsor, funded, claimed }` with real fields
/// (`amount` is the schedule total) so V3 cards render through the same
/// funding pill. `claimed` is true only when every slot settled; partial
/// fills keep the honest "Funded" pill. Returns null when the struct is
/// malformed (callers then show the escrow-error pill). Pure: no RPC.
export function v3EscrowCardState(v2) {
  if (!v2 || typeof v2 !== "object") return null;
  const { token, sponsor, funded, totalFunded, amounts, claimedBitmap } = v2;
  if (typeof token !== "string" || typeof sponsor !== "string" || typeof funded !== "boolean") {
    return null;
  }
  if (!Array.isArray(amounts)) return null;
  const total = parseAmountValue(totalFunded);
  if (total === null) return null;
  if (typeof claimedBitmap === "string" && claimedBitmap.trim() === "") return null;
  if (typeof claimedBitmap !== "string" && typeof claimedBitmap !== "number" && typeof claimedBitmap !== "bigint") {
    return null;
  }
  let bits;
  try {
    bits = typeof claimedBitmap === "bigint" ? claimedBitmap : BigInt(claimedBitmap);
  } catch {
    return null;
  }
  if (bits < 0n) return null;
  const claimed =
    amounts.length > 0 && amounts.every((_, i) => (bits & (1n << BigInt(i))) !== 0n);
  return { token, amount: total.toString(), sponsor, funded, claimed };
}

/// GitHub PR link for a card, or null when the record carries no
/// repo/PR template (V3 bounties commit to a criteria hash instead).
/// Callers omit the link rather than point at /undefined/. Pure.
export function bountyCardPrUrl(bounty) {
  if (!bounty || typeof bounty !== "object") return null;
  if (typeof bounty.repo !== "string" || bounty.repo.length === 0) return null;
  if (!Number.isInteger(bounty.pr_number)) return null;
  return githubPrUrl(bounty.repo, bounty.pr_number);
}

// -- NEAR outcome parsing -------------------------------------------------

/// Extract the transaction hash from a wallet-selector
/// `signAndSendTransaction` outcome. Shapes differ by wallet/transport, so
/// probe defensively; returns null when no hash is present (callers then
/// omit the explorer link rather than fabricate one).
export function extractNearTxHash(outcome) {
  if (!outcome || typeof outcome !== "object") {
    return typeof outcome === "string" && outcome.length > 0 ? outcome : null;
  }
  const o = outcome;
  if (typeof o.transaction?.hash === "string" && o.transaction.hash.length > 0) {
    return o.transaction.hash;
  }
  if (typeof o.transaction_outcome?.id === "string" && o.transaction_outcome.id.length > 0) {
    return o.transaction_outcome.id;
  }
  if (typeof o.final_execution_status !== "undefined" && typeof o.transaction?.hash === "string") {
    return o.transaction.hash;
  }
  return null;
}

/// Flatten a NEAR ExecutionError into a one-line message: prefer the
/// contract's error_message, else a capped JSON of the typed detail.
function describeNearFailure(err) {
  if (typeof err === "string") return err.length > 0 ? err : "transaction execution failed";
  if (!err || typeof err !== "object") return "transaction execution failed";
  if (typeof err.error_message === "string" && err.error_message.length > 0) return err.error_message;
  try {
    const s = JSON.stringify(err.error_type ?? err);
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  } catch {
    return "transaction execution failed";
  }
}

/// Interpret a wallet-selector `signAndSendTransaction` outcome
/// (FinalExecutionOutcome shape: { status, transaction, ... }) against
/// its final execution status. Returns { ok, txHash, error? }:
/// SuccessValue (string) is the ONLY success; Failure, pending/basic
/// statuses, and missing or malformed results all fail closed — the hash
/// is still returned so callers can link the explorer. Pure: no RPC.
export function interpretNearTxOutcome(outcome) {
  const txHash = extractNearTxHash(outcome);
  const fail = (error) => ({ ok: false, txHash, error });
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
    return fail("NEAR transaction could not be verified (unreadable result).");
  }
  const status = outcome.status;
  if (status && typeof status === "object" && !Array.isArray(status)) {
    if ("Failure" in status) {
      return fail(`NEAR transaction failed: ${describeNearFailure(status.Failure)}`);
    }
    if (typeof status.SuccessValue === "string") return { ok: true, txHash };
    return fail("NEAR transaction could not be verified (unrecognized execution status).");
  }
  if (typeof status === "string") {
    if (status === "Failure") return fail("NEAR transaction failed.");
    return fail(`NEAR transaction could not be verified (execution status: ${status}).`);
  }
  return fail("NEAR transaction could not be verified (missing execution status).");
}

/// Read a transaction hash carried by a thrown NEAR failure (see
/// near.ts signAndSend): string-and-present or null. Pure.
export function thrownTxHash(e) {
  return e && typeof e === "object" && typeof e.txHash === "string" && e.txHash.length > 0
    ? e.txHash
    : null;
}

// -- Base settlement parsing ----------------------------------------------

/// keccak256("VoucherClaimed(uint256,address,uint256,uint256,bytes32)").
/// Cross-checked against ethers in the test suite.
export const VOUCHER_CLAIMED_TOPIC =
  "0x4d6e87a106811ec1860b64b16b64e3bb1d328b4eddf3cfa1779e7340dd5e74a5";

/// keccak256("VoucherClaimed(uint256,uint8,address,uint256,uint256,bytes32,bytes32)")
/// for `OmniEscrowV2.sol`: (bountyId indexed, slotIndex, recipient indexed,
/// amount, nonce, criteriaHash, digest). topics[1] is still the bounty id;
/// data word 0 is the slot index and word 1 the amount. Cross-checked
/// against ethers and the Solidity declaration in the test suite.
export const VOUCHER_CLAIMED_TOPIC_V2 =
  "0xf40a6b7a2d537a1623a4a0ca6eb6eb08f1070280c99383201a00bf8b3905b5df";

/// Payout-scan chunking: public Base RPCs cap eth_getLogs ranges
/// (sepolia.base.org refuses ranges over 200 blocks), so settlement scans
/// are split into ascending [fromBlock, toBlock] chunks of at most
/// PAYOUT_LOG_RANGE blocks. Pure: no RPC.
export const PAYOUT_LOG_RANGE = 190;
/// Blocks of padding before the claim block (chain-speed independent).
export const PAYOUT_START_PAD = 2000;
/// Forward-scan budget: 1200 chunks x 190 blocks = 228k blocks, which
/// covers 12+ hours of settlement delay even at 5 blocks/second. Typical
/// relayer delay is minutes, so scans exit in the first batches.
export const PAYOUT_MAX_CHUNKS = 1200;

export function chunkRanges(from, to, maxChunks = PAYOUT_MAX_CHUNKS) {
  const ranges = [];
  for (let start = from, n = 0; start <= to && n < maxChunks; start += PAYOUT_LOG_RANGE, n++) {
    ranges.push([start, Math.min(to, start + PAYOUT_LOG_RANGE - 1)]);
  }
  return ranges;
}

/// Find the USDC payout transaction for a bounty inside raw JSON-RPC
/// `eth_getLogs` results for the escrow's VoucherClaimed event. Returns
/// { txHash, blockNumber, amount } (amount in base units) or null when no
/// matching log exists. Pure: no RPC, no ethers.
export function findVoucherClaimedTx(logs, bountyId) {
  if (!Array.isArray(logs)) return null;
  const want = BigInt(bountyId).toString(16).padStart(64, "0").toLowerCase();
  for (const log of logs) {
    if (log?.removed === true) continue; // reorged out: not canonical, never a payout
    const topics = log?.topics ?? [];
    if (topics.length < 3) continue;
    if (String(topics[0]).toLowerCase() !== VOUCHER_CLAIMED_TOPIC) continue;
    if (String(topics[1]).toLowerCase().replace(/^0x/, "") !== want) continue;
    const data = String(log.data ?? "");
    if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 2 + 64) continue;
    const amount = BigInt("0x" + data.slice(2, 2 + 64)).toString();
    const blockNumber = Number.parseInt(String(log.blockNumber), 16);
    if (!log.transactionHash || !Number.isInteger(blockNumber)) continue;
    return { txHash: log.transactionHash, blockNumber, amount };
  }
  return null;
}

/// V2 counterpart for `OmniEscrowV2.sol` VoucherClaimed logs: same
/// topics[1] bounty filter, but data is (slotIndex, amount, nonce,
/// criteriaHash, digest) — the amount is data word 1, not word 0.
/// Returns { txHash, blockNumber, amount, slotIndex } or null. Reorged
/// (`removed`) logs are never payouts. Pure: no RPC, no ethers.
export function findVoucherClaimedTxV2(logs, bountyId) {
  if (!Array.isArray(logs)) return null;
  const want = BigInt(bountyId).toString(16).padStart(64, "0").toLowerCase();
  for (const log of logs) {
    if (log?.removed === true) continue; // reorged out: not canonical, never a payout
    const topics = log?.topics ?? [];
    if (topics.length < 3) continue;
    if (String(topics[0]).toLowerCase() !== VOUCHER_CLAIMED_TOPIC_V2) continue;
    if (String(topics[1]).toLowerCase().replace(/^0x/, "") !== want) continue;
    const data = String(log.data ?? "");
    if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 2 + 64 * 5) continue;
    const slot = Number(BigInt("0x" + data.slice(2, 2 + 64)));
    if (!Number.isInteger(slot) || slot < 0 || slot > 255) continue;
    const amount = BigInt("0x" + data.slice(2 + 64, 2 + 64 * 2)).toString();
    const blockNumber = Number.parseInt(String(log.blockNumber), 16);
    if (!log.transactionHash || !Number.isInteger(blockNumber)) continue;
    return { txHash: log.transactionHash, blockNumber, amount, slotIndex: slot };
  }
  return null;
}

/// Version-aware payout discovery spec: the log topic plus the matching
/// decoder for a detected escrow version. Throws on anything but "v1" /
/// "v2" so an unverified escrow can never be scanned with the wrong
/// layout. Pure: no RPC.
export function payoutScanSpec(version) {
  if (version === "v2") return { topic: VOUCHER_CLAIMED_TOPIC_V2, decode: findVoucherClaimedTxV2 };
  if (version === "v1") return { topic: VOUCHER_CLAIMED_TOPIC, decode: findVoucherClaimedTx };
  throw new Error(`unsupported escrow version for payout discovery: ${String(version)}`);
}

/// True only for a mined successful receipt (`eth_getTransactionReceipt`
/// status QUANTITY "0x1"). Reverted transactions emit no logs, so matched
/// logs imply success; this check closes the residual reorg window where
/// a log was canonical at scan time but its transaction is not. Pure.
export function isSuccessfulReceipt(receipt) {
  return !!receipt && typeof receipt === "object" && receipt.status === "0x1";
}
