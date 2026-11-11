// Base chain access: read-only escrow views via public RPC, transactions
// via the user's injected wallet (window.ethereum). No keys handled here.
import { ethers } from "ethers";
import { config } from "./config";

export const ESCROW_ABI = [
  "function usedVoucher(bytes32) view returns (bool)",
  "function bounties(uint256) view returns (address token, uint256 amount, address sponsor, bool funded, bool claimed)",
  "function mpcSigner() view returns (address)",
  "function createBounty(uint256 bountyId, address token, uint256 amount)",
  "function fundBounty(uint256 bountyId)",
  "function cancelBounty(uint256 bountyId)",
  "function claim((uint256 bountyId,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow) v, uint8 sigV, bytes32 r, bytes32 s)",
  "event VoucherClaimed(uint256 indexed bountyId, address indexed recipient, uint256 amount, uint256 nonce, bytes32 digest)",
] as const;

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

export interface PayoutTx {
  txHash: string;
  blockNumber: number;
  amount: string;
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

export async function escrowBountyState(bountyId: number): Promise<EscrowBountyState> {
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

export async function isVoucherUsed(digest: string): Promise<boolean> {
  const escrow = readEscrow();
  return (await escrow.usedVoucher(digest)) as boolean;
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
/// first match. `claimTs` is unix seconds (voucher expiry minus TTL).
/// `onProgress(scanned, total)` reports chunk progress for the UI.
/// Returns null when no payout log exists in the scan budget — never a
/// fabricated hash.
export async function findPayoutTx(
  bountyId: number,
  opts?: { claimTs?: number; onProgress?: (scanned: number, total: number) => void }
): Promise<PayoutTx | null> {
  const latest = Number(await ethRpc<string>("eth_blockNumber", []));
  const {
    findVoucherClaimedTx,
    VOUCHER_CLAIMED_TOPIC,
    chunkRanges,
    PAYOUT_START_PAD,
    PAYOUT_MAX_CHUNKS,
  } = await import("./display.mjs");
  let from: number;
  if (opts?.claimTs) {
    const claimBlock = await bisectBlockAt(opts.claimTs - 1800, latest);
    from = Math.max(ESCROW_DEPLOY_BLOCK, claimBlock - PAYOUT_START_PAD);
  } else {
    from = Math.max(ESCROW_DEPLOY_BLOCK, latest - 5000);
  }
  const chunks = chunkRanges(from, latest, PAYOUT_MAX_CHUNKS) as Array<[number, number]>;
  const bountyTopic = `0x${bountyId.toString(16).padStart(64, "0")}`;
  let scanned = 0;
  for (let i = 0; i < chunks.length; i += SCAN_BATCH) {
    const batch = chunks.slice(i, i + SCAN_BATCH);
    const results = await Promise.all(
      batch.map(([s, e]) =>
        ethRpc<unknown[]>("eth_getLogs", [
          {
            fromBlock: toHexBlock(s),
            toBlock: toHexBlock(e),
            address: config.escrowAddress,
            topics: [VOUCHER_CLAIMED_TOPIC, bountyTopic],
          },
        ])
      )
    );
    scanned += batch.length;
    opts?.onProgress?.(scanned, chunks.length);
    for (const logs of results) {
      const found = (findVoucherClaimedTx as (l: unknown, b: number) => PayoutTx | null)(
        logs,
        bountyId
      );
      if (found) return found;
    }
  }
  return null;
}
