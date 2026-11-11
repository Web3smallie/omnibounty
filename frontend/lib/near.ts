// NEAR contract access: read-only views via plain RPC fetch, transactions
// via wallet-selector. No keys are ever handled in this module.
import { config } from "./config";

export interface BountyView {
  id: number;
  repo: string;
  pr_number: number;
  token: string;
  amount: string;
  sponsor: string;
  expiry: number;
  status: "open" | "pending" | "claimed" | string;
  created_at: number;
}

export interface VoucherView {
  bounty_id: number;
  recipient: string;
  token: string;
  amount: string;
  nonce: number;
  expiry: number;
  chain_id: number;
  escrow: string;
  digest: string;
}

export interface SignedVoucherView {
  voucher: VoucherView;
  v: number;
  r: string;
  s: string;
}

export interface ConfigView {
  owner: string;
  paused: boolean;
  mpc_contract: string;
  mpc_signer: string | null;
  escrow: string;
  chain_id: number;
  voucher_path: string;
  domain_id: number;
  max_proof_age_sec: number;
  future_skew_sec: number;
  voucher_ttl_sec: number;
  next_nonce: number;
  bounty_count: number;
}

function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  // btoa exists in browsers and Node 16+.
  return btoa(bin);
}

export async function nearView<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const argsBase64 = utf8ToBase64(JSON.stringify(args));
  const res = await fetch(config.nearRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "omnibounty-web",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: config.contractId,
        method_name: method,
        args_base64: argsBase64,
      },
    }),
  });
  if (!res.ok) throw new Error(`NEAR RPC HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`NEAR RPC: ${JSON.stringify(data.error)}`);
  const r = data.result;
  if (!r) throw new Error("NEAR RPC: missing result");
  if (r.error) throw new Error(r.error);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result))) as T;
}

export const listBounties = (from = 0, limit = 50) =>
  nearView<BountyView[]>("list_bounties", { from, limit });
export const getBounty = (bountyId: number) =>
  nearView<BountyView | null>("get_bounty", { bounty_id: bountyId });
export const getVoucher = (bountyId: number) =>
  nearView<SignedVoucherView | null>("get_voucher", { bounty_id: bountyId });
export const dryRun = (bountyId: number, proof: unknown, recipient: string) =>
  nearView<string>("dry_run", { bounty_id: bountyId, proof, recipient });
export const getConfig = () => nearView<ConfigView>("get_config", {});
export const isRelayed = (digestHex: string) =>
  nearView<boolean>("is_relayed", { digest_hex: digestHex });
export const listUnrelayed = (limit = 50) =>
  nearView<SignedVoucherView[]>("list_unrelayed", { limit });
export const isIdentifierUsed = (identifierHex: string) =>
  nearView<boolean>("is_identifier_used", { identifier_hex: identifierHex });

// -- Wallet (client-side only; dynamically imported by components) ---------

export type { WalletSelector } from "@near-wallet-selector/core";

let selectorPromise: Promise<import("@near-wallet-selector/core").WalletSelector> | null = null;

export function getSelector() {
  if (!selectorPromise) {
    selectorPromise = (async () => {
      const { setupWalletSelector } = await import("@near-wallet-selector/core");
      const { setupModal } = await import("@near-wallet-selector/modal-ui");
      const { setupMyNearWallet } = await import("@near-wallet-selector/my-near-wallet");
      const selector = await setupWalletSelector({
        network: config.networkId,
        modules: [setupMyNearWallet()],
      });
      const modal = setupModal(selector, { contractId: config.contractId });
      // Expose sign-in through the returned selector handle.
      (selector as unknown as { showModal: () => void }).showModal = () => modal.show();
      return selector;
    })();
  }
  return selectorPromise;
}

export function showWalletModal(selector: unknown) {
  const s = selector as { showModal?: () => void };
  if (typeof s.showModal === "function") s.showModal();
}

const CLAIM_GAS = "150000000000000"; // 150 Tgas = contract CLAIM_MIN_GAS

export interface NearTxReceipt {
  txHash: string | null;
  outcome: unknown;
}

export async function signAndSend(
  selector: import("@near-wallet-selector/core").WalletSelector,
  methodName: string,
  args: Record<string, unknown>,
  depositYocto = "0"
): Promise<NearTxReceipt> {
  const wallet = await selector.wallet();
  const outcome = await wallet.signAndSendTransaction({
    receiverId: config.contractId,
    actions: [
      {
        type: "FunctionCall",
        params: { methodName, args, gas: CLAIM_GAS, deposit: depositYocto },
      },
    ],
  });
  const { extractNearTxHash } = await import("./display.mjs");
  return { txHash: extractNearTxHash(outcome) as string | null, outcome };
}
