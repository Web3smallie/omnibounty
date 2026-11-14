// Base chain access: read-only escrow views via public RPC, transactions
// via the user's injected wallet (window.ethereum). No keys handled here.
import { ethers } from "ethers";
import { config } from "./config";
import { claimedBitmapTotal } from "./display.mjs";
import {
  ESCROW_ABI,
  ESCROW_ABI_V2,
  ESCROW_VERSION_PROBES,
  VOUCHER_TYPEHASH_EXPECTED,
  VOUCHER_V2_TYPEHASH_EXPECTED,
} from "./escrowAbi.mjs";

// Escrow ABI strings live in lib/escrowAbi.mjs (single source shared with
// unit tests); re-exported here so existing import sites keep working.
export { ESCROW_ABI, ESCROW_ABI_V2 };

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
] as const;

/// First block to scan for VoucherClaimed events: the escrow deployment
/// block on Base Sepolia (testdata/base_sepolia.json). No payout can exist
/// before the escrow did.
export const ESCROW_DEPLOY_BLOCK = 56458964;

/// Parallel eth_getLogs chunk requests per scan batch.
const SCAN_BATCH = 16;

export interface EscrowBountyState {
  token: string;
  amount: string;
  sponsor: string;
  funded: boolean;
  claimed: boolean;
}

export interface EscrowBountyStateV2 {
  token: string;
  sponsor: string;
  funded: boolean;
  totalFunded: string;
  amounts: string[];
  claimedBitmap: string;
  refundedBitmap: string;
  deadline: string;
  criteriaHash: string;
}

export type EscrowVersion = "v1" | "v2" | "unknown";

function paddedBytes32(hex: string): string {
  return `0x${hex.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
}

/// Probe one version-discriminating constant getter. Returns true only
/// when the call succeeds AND returns the pinned value. A revert means
/// the selector is absent (not this version). Transport/RPC failures
/// propagate — never misreported as a version.
async function probeTypehash(name: string, fragment: string, expected: string): Promise<boolean> {
  const iface = new ethers.Interface([fragment]);
  const data = iface.encodeFunctionData(name, []);
  let raw: unknown;
  try {
    raw = await readProvider().call({ to: config.escrowAddress, data });
  } catch (e) {
    if ((e as { code?: string })?.code === "CALL_EXCEPTION") return false;
    throw e;
  }
  return typeof raw === "string" && raw.toLowerCase() === paddedBytes32(expected);
}

async function probeEscrowVersion(): Promise<EscrowVersion> {
  if (await probeTypehash("VOUCHER_V2_TYPEHASH", ESCROW_VERSION_PROBES.v2, VOUCHER_V2_TYPEHASH_EXPECTED)) {
    return "v2";
  }
  if (await probeTypehash("VOUCHER_TYPEHASH", ESCROW_VERSION_PROBES.v1, VOUCHER_TYPEHASH_EXPECTED)) {
    return "v1";
  }
  return "unknown";
}

let versionProbe: Promise<EscrowVersion> | null = null;

/// Detect the deployed escrow version (cached per session). A V1-shaped
/// `bounties` decode of V2 returndata succeeds silently with garbage
/// fields, so versioned reads refuse to decode before this check passes.
export function detectEscrowVersion(): Promise<EscrowVersion> {
  if (!versionProbe) {
    versionProbe = probeEscrowVersion().catch((e) => {
      versionProbe = null; // transport failure: retry next time, never cache
      throw e;
    });
  }
  return versionProbe;
}

async function requireEscrowVersion(expected: "v1" | "v2"): Promise<void> {
  const detected = await detectEscrowVersion();
  if (detected !== expected) {
    throw new Error(
      `Escrow version mismatch: this operation needs the ${expected.toUpperCase()} escrow but the configured escrow reported ${detected}.`
    );
  }
}

export interface PayoutTx {
  txHash: string;
  blockNumber: number;
  amount: string;
  slotIndex?: number;
}

export function readProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(config.baseRpcUrl, config.expectedChainId);
}

export function readEscrow(): ethers.Contract {
  return new ethers.Contract(config.escrowAddress, ESCROW_ABI, readProvider());
}

export async function browserSigner(): Promise<ethers.Signer> {
  const eth = (window as unknown as { ethereum?: unknown }).ethereum;
  if (!eth) throw new Error("No EVM wallet found (window.ethereum is missing)");
  const provider = new ethers.BrowserProvider(eth as ethers.Eip1193Provider);
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(config.expectedChainId)) {
    throw new Error(`Wrong network: wallet is on chain ${network.chainId}, expected ${config.expectedChainId}`);
  }
  return provider.getSigner();
}

export async function escrowWithSigner(): Promise<ethers.Contract> {
  return new ethers.Contract(config.escrowAddress, ESCROW_ABI, await browserSigner());
}

function ethereum(): ethers.Eip1193Provider {
  const eth = (window as unknown as { ethereum?: unknown }).ethereum;
  if (!eth) throw new Error("No EVM wallet found. Install MetaMask or another injected wallet, then try again.");
  return eth as ethers.Eip1193Provider;
}

/// Connect the injected EVM wallet and return the selected account.
/// Does not check the chain — callers combine with chain enforcement.
export async function connectEvm(): Promise<string> {
  const provider = new ethers.BrowserProvider(ethereum());
  const signer = await provider.getSigner();
  return signer.address;
}

export async function evmChainId(): Promise<bigint> {
  const provider = new ethers.BrowserProvider(ethereum());
  return (await provider.getNetwork()).chainId;
}

/// Ask the wallet to switch to Base Sepolia, adding the chain if unknown.
/// Surfaces user rejection as a plain Error with a readable message.
export async function switchToBaseSepolia(): Promise<void> {
  const eth = ethereum() as unknown as {
    request: (req: { method: string; params?: unknown }) => Promise<unknown>;
  };
  const chainIdHex = `0x${config.expectedChainId.toString(16)}`;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (e: unknown) {
    const code = (e as { code?: number })?.code;
    if (code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainIdHex,
            chainName: "Base Sepolia",
            rpcUrls: [config.baseRpcUrl],
            blockExplorerUrls: ["https://sepolia.basescan.org"],
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          },
        ],
      });
      return;
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}

export async function usdcBalanceOf(owner: string): Promise<bigint> {
  const usdc = new ethers.Contract(config.usdcAddress, ERC20_ABI, readProvider());
  return (await usdc.balanceOf(owner)) as bigint;
}

export async function usdcAllowance(owner: string, spender: string): Promise<bigint> {
  const usdc = new ethers.Contract(config.usdcAddress, ERC20_ABI, readProvider());
  return (await usdc.allowance(owner, spender)) as bigint;
}

export async function escrowWithSignerV2(): Promise<ethers.Contract> {
  return new ethers.Contract(config.escrowAddress, ESCROW_ABI_V2, await browserSigner());
}

export async function escrowBountyState(bountyId: number): Promise<EscrowBountyState> {
  await requireEscrowVersion("v1");
  const escrow = readEscrow();
  const b = (await escrow.bounties(bountyId)) as unknown as {
    token: string;
    amount: bigint;
    sponsor: string;
    funded: boolean;
    claimed: boolean;
  };
  return { token: b.token, amount: b.amount.toString(), sponsor: b.sponsor, funded: b.funded, claimed: b.claimed };
}

/// V2 escrow bounty struct, decoded strictly per `OmniEscrowV2.sol`
/// (token, sponsor, deadline, criteriaHash, funded, totalFunded, amounts,
/// claimedBitmap, refundedBitmap). Refuses to decode unless the deployed
/// escrow probes as V2, and validates the decoded shape before returning.
export async function escrowBountyStateV2(bountyId: number): Promise<EscrowBountyStateV2> {
  await requireEscrowVersion("v2");
  const escrow = readEscrowV2();
  const b = (await escrow.bounties(bountyId)) as unknown as {
    token: unknown;
    sponsor: unknown;
    deadline: unknown;
    criteriaHash: unknown;
    funded: unknown;
    totalFunded: unknown;
    amounts: unknown;
    claimedBitmap: unknown;
    refundedBitmap: unknown;
  };
  if (
    typeof b?.token !== "string" ||
    typeof b?.sponsor !== "string" ||
    typeof b?.deadline !== "bigint" ||
    typeof b?.criteriaHash !== "string" ||
    typeof b?.funded !== "boolean" ||
    typeof b?.totalFunded !== "bigint" ||
    !Array.isArray(b?.amounts) ||
    !b.amounts.every((a): a is bigint => typeof a === "bigint") ||
    typeof b?.claimedBitmap !== "bigint" ||
    typeof b?.refundedBitmap !== "bigint"
  ) {
    throw new Error("Escrow version mismatch: V2 bounty struct failed validation.");
  }
  return {
    token: b.token,
    sponsor: b.sponsor,
    funded: b.funded,
    totalFunded: b.totalFunded.toString(),
    amounts: b.amounts.map((a) => a.toString()),
    claimedBitmap: b.claimedBitmap.toString(),
    refundedBitmap: b.refundedBitmap.toString(),
    deadline: b.deadline.toString(),
    criteriaHash: b.criteriaHash,
  };
}

export async function isVoucherUsed(digest: string): Promise<boolean> {
  const escrow = readEscrow();
  const used: unknown = await escrow.usedVoucher(digest);
  if (typeof used !== "boolean") {
    // Null/malformed reads are unknown, never evidence: the settlement
    // poller retries these with backoff instead of spinning or settling.
    throw new Error("Base escrow returned a malformed usedVoucher result (expected boolean).");
  }
  return used;
}

export function readEscrowV2(): ethers.Contract {
  return new ethers.Contract(config.escrowAddress, ESCROW_ABI_V2, readProvider());
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/// Verified settled USDC for one V3 bounty: sums slot amounts whose
/// claimedBitmap bit is set (the escrow sets the bit atomically with the
/// USDC transfer). Unknown bounties (zero-sponsor struct) settle nothing:
/// `{ paid: 0n, ok: true }`. RPC or decoding failures report
/// `{ paid: 0n, ok: false }` — never a silent zero.
export async function escrowV2PaidTotal(bountyId: number): Promise<{ paid: bigint; ok: boolean }> {
  try {
    const escrow = readEscrowV2();
    const b = (await escrow.bounties(bountyId)) as unknown as {
      sponsor?: unknown;
      amounts?: unknown;
      claimedBitmap?: unknown;
    };
    if (typeof b?.sponsor === "string" && b.sponsor.toLowerCase() === ZERO_ADDRESS) {
      return { paid: 0n, ok: true };
    }
    if (typeof b?.sponsor !== "string") return { paid: 0n, ok: false };
    return { paid: claimedBitmapTotal(b.amounts, b.claimedBitmap), ok: true };
  } catch {
    return { paid: 0n, ok: false };
  }
}

async function ethRpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(config.baseRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "omnibounty-web", method, params }),
  });
  if (!res.ok) throw new Error(`Base RPC HTTP ${res.status}`);
  const data = (await res.json()) as { error?: unknown; result?: T };
  if (data.error) throw new Error(`Base RPC: ${JSON.stringify(data.error)}`);
  return data.result as T;
}

const toHexBlock = (n: number) => `0x${n.toString(16)}`;

async function blockTimestamp(block: number): Promise<number> {
  const blk = await ethRpc<{ timestamp: string }>("eth_getBlockByNumber", [toHexBlock(block), false]);
  return Number(blk.timestamp);
}

/// Locate the first block at or after `targetTs` by timestamp bisection.
/// Chain-speed independent: assumes nothing about block times.
async function bisectBlockAt(targetTs: number, latest: number): Promise<number> {
  let lo = ESCROW_DEPLOY_BLOCK;
  let hi = latest;
  if ((await blockTimestamp(lo)) >= targetTs) return lo;
  for (let n = 0; lo < hi && n < 25; n++) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await blockTimestamp(mid)) < targetTs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/// Find the real USDC payout transaction for a bounty by scanning the
/// escrow's VoucherClaimed logs in small RPC-safe chunks, starting from
/// the claim block (located by timestamp bisection) and stopping at the
/// first receipt-verified match. `claimTs` is unix seconds (voucher expiry
/// minus TTL). `onProgress(scanned, total)` reports chunk progress.
/// The log topic and decoder follow the detected escrow version (V1 and
/// V2 events have different topics and data layouts); an unverifiable
/// escrow refuses the scan instead of decoding with the wrong layout.
/// Returns null when no payout log exists in the scan budget — never a
/// fabricated hash.
export async function findPayoutTx(
  bountyId: number,
  opts?: { claimTs?: number; onProgress?: (scanned: number, total: number) => void }
): Promise<PayoutTx | null> {
  const {
    payoutScanSpec,
    isSuccessfulReceipt,
    chunkRanges,
    PAYOUT_START_PAD,
    PAYOUT_MAX_CHUNKS,
  } = await import("./display.mjs");
  const spec = (
    payoutScanSpec as (v: string) => {
      topic: string;
      decode: (logs: unknown, bountyId: number) => (PayoutTx & { slotIndex?: number }) | null;
    }
  )(await detectEscrowVersion());
  const latest = Number(await ethRpc<string>("eth_blockNumber", []));
  let from: number;
  if (opts?.claimTs) {
    const claimBlock = await bisectBlockAt(opts.claimTs - 1800, latest);
    from = Math.max(ESCROW_DEPLOY_BLOCK, claimBlock - PAYOUT_START_PAD);
  } else {
    from = Math.max(ESCROW_DEPLOY_BLOCK, latest - 5000);
  }
  const chunks = chunkRanges(from, latest, PAYOUT_MAX_CHUNKS) as Array<[number, number]>;
  const bountyTopic = `0x${bountyId.toString(16).padStart(64, "0")}`;
  // One slow/flaky chunk must not discard a whole scan: retry once, then fail loud.
  const fetchChunk = async (s: number, e: number): Promise<unknown[]> => {
    const params = [
      {
        fromBlock: toHexBlock(s),
        toBlock: toHexBlock(e),
        address: config.escrowAddress,
        topics: [spec.topic, bountyTopic],
      },
    ];
    try {
      return await ethRpc<unknown[]>("eth_getLogs", params);
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      return await ethRpc<unknown[]>("eth_getLogs", params);
    }
  };
  // A matched log promises a payout transaction; the receipt proves it
  // mined successfully. Same retry-once policy as log chunks; a bad or
  // missing receipt keeps the scan going instead of linking a bad hash.
  const verifyReceipt = async (txHash: string): Promise<boolean> => {
    const fetchReceipt = () => ethRpc<{ status?: unknown }>("eth_getTransactionReceipt", [txHash]);
    let receipt: { status?: unknown };
    try {
      receipt = await fetchReceipt();
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      receipt = await fetchReceipt();
    }
    return (isSuccessfulReceipt as (r: unknown) => boolean)(receipt);
  };
  let scanned = 0;
  for (let i = 0; i < chunks.length; i += SCAN_BATCH) {
    const batch = chunks.slice(i, i + SCAN_BATCH);
    const results = await Promise.all(batch.map(([s, e]) => fetchChunk(s, e)));
    scanned += batch.length;
    opts?.onProgress?.(scanned, chunks.length);
    for (const logs of results) {
      const found = spec.decode(logs, bountyId);
      if (found && (await verifyReceipt(found.txHash))) return found;
    }
  }
  return null;
}
