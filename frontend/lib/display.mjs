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

// -- Base settlement parsing ----------------------------------------------

/// keccak256("VoucherClaimed(uint256,address,uint256,uint256,bytes32)").
/// Cross-checked against ethers in the test suite.
export const VOUCHER_CLAIMED_TOPIC =
  "0x4d6e87a106811ec1860b64b16b64e3bb1d328b4eddf3cfa1779e7340dd5e74a5";

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
