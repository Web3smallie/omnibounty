// NEAR contract access: read-only views via plain RPC fetch, transactions
// via wallet-selector. No keys are ever handled in this module.
import { config } from "./config";
import { describeFetchFailure } from "./display.mjs";
import { createSharedInitializer } from "./walletInit.mjs";

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

// -- V3 views ----------------------------------------------------------

export interface BountyViewV3 {
  id: number;
  sponsor: string;
  token: string;
  criteria_hash: string;
  slots: string[];
  slots_filled: number;
  total_amount: string;
  funded: boolean;
  deadline: number;
  challenge_window: number;
  created_at: number;
  seq: number;
  status: string;
}

export interface ClaimViewV3 {
  bounty_id: number;
  slot: number;
  recipient: string;
  pr_number: number;
  head_sha: string;
  github_created: number;
  claim_seq: number;
  qualified_at: number;
  challenge_ends_at: number;
  status: string;
  pending_digest: string | null;
  signed: boolean;
}

export interface VoucherViewV2 {
  bounty_id: number;
  slot_index: number;
  recipient: string;
  token: string;
  amount: string;
  nonce: number;
  expiry: number;
  chain_id: number;
  escrow: string;
  criteria_hash: string;
  digest: string;
}

export interface SignedVoucherViewV2 {
  voucher: VoucherViewV2;
  v: number;
  r: string;
  s: string;
}

// V3 dry-run outcome (DryOutcome): read-only, never panics on user input.
// `ok` is true only when every check passed; otherwise `errors` holds the
// stable CODE strings and `verdicts` the per-criterion detail.
export interface DryVerdictView {
  id: string;
  status: string;
  detail: string;
}

export interface DryOutcomeV3 {
  ok: boolean;
  bounty_id: number;
  pr_number: number | null;
  head_sha: string | null;
  verdicts: DryVerdictView[];
  errors: string[];
}

export interface ContractProofArg {
  evidence_type: number;
  proof: unknown;
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
  let res: Response;
  try {
    res = await fetch(config.nearRpcUrl, {
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
  } catch (e) {
    // Transport failure (DNS/proxy/firewall/TLS): keep the failure loud
    // but attach the endpoint + underlying cause so it is diagnosable.
    throw new Error(`NEAR RPC ${describeFetchFailure(config.nearRpcUrl, e)}`);
  }
  if (!res.ok) throw new Error(`NEAR RPC HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`NEAR RPC: ${JSON.stringify(data.error)}`);
  const r = data.result;
  if (!r) throw new Error("NEAR RPC: missing result");
  if (r.error) throw new Error(r.error);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result))) as T;
}

export const listBounties = (from = 0, limit = 50) =>
  nearView<(BountyView | BountyViewV3)[]>("list_bounties", { from, limit });
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

// V3 views (slot-scoped claims and vouchers). A view-call of `qualify_claim`
// itself would always fail the storage-deposit check (views attach zero
// deposit), so preflight goes through the dedicated read-only `dry_qualify`
// view, which runs the exact qualify pipeline without mutating state.
export const dryQualifyV3 = (bountyId: number, criteriaJson: string, proofs: ContractProofArg[], recipient: string) =>
  nearView<DryOutcomeV3>("dry_qualify", { bounty_id: bountyId, criteria_json: criteriaJson, proofs, recipient });
export const getBountyV3 = (bountyId: number) =>
  nearView<BountyViewV3 | null>("get_bounty", { bounty_id: bountyId });
export const getClaim = (bountyId: number, slot: number) =>
  nearView<ClaimViewV3 | null>("get_claim", { bounty_id: bountyId, slot });
export const getClaimByPr = (bountyId: number, prNumber: number) =>
  nearView<number | null>("get_claim_by_pr", { bounty_id: bountyId, pr_number: prNumber });
export const getVoucherV3 = (bountyId: number, slot: number) =>
  nearView<SignedVoucherViewV2 | null>("get_voucher", { bounty_id: bountyId, slot });

// -- Wallet (client-side only; dynamically imported by components) ---------

export type { WalletSelector } from "@near-wallet-selector/core";

type WalletSelectorHandle = import("@near-wallet-selector/core").WalletSelector;

async function startSelector(): Promise<WalletSelectorHandle> {
  const { assertBrowserWalletEnv } = await import("./walletInit.mjs");
  assertBrowserWalletEnv();
  const { setupWalletSelector } = await import("@near-wallet-selector/core");
  const { setupModal } = await import("@near-wallet-selector/modal-ui");
  const { setupMyNearWallet } = await import("@near-wallet-selector/my-near-wallet");
  const { setupMeteorWallet } = await import("@near-wallet-selector/meteor-wallet");
  const { setupSender } = await import("@near-wallet-selector/sender");
  const { setupNightly } = await import("@near-wallet-selector/nightly");
  const { setupHereWallet } = await import("@near-wallet-selector/here-wallet");
  const selector = await setupWalletSelector({
    network: config.networkId,
    // Every module below honors the selector network (testnet here);
    // see frontend/test/wallets.test.mjs for the version/shape gate.
    modules: [
      setupMyNearWallet(),
      setupMeteorWallet(),
      setupSender(),
      setupNightly(),
      setupHereWallet(),
    ],
  });
  const modal = setupModal(selector, { contractId: config.contractId });
  // Expose sign-in through the returned selector handle.
  (selector as unknown as { showModal: () => void }).showModal = () => modal.show();
  return selector;
}

let initSelector: (() => Promise<WalletSelectorHandle>) | null = null;

export function getSelector(): Promise<WalletSelectorHandle> {
  // Shared memoized attempt: concurrent callers share one in-flight
  // initialization, and a failure clears the cache so retry starts fresh
  // instead of replaying the rejection forever.
  if (!initSelector) {
    initSelector = createSharedInitializer(startSelector);
  }
  return initSelector();
}

export function showWalletModal(selector: unknown) {
  const s = selector as { showModal?: () => void };
  if (typeof s.showModal === "function") s.showModal();
}

const CLAIM_GAS = "150000000000000"; // 150 Tgas = contract CLAIM_MIN_GAS

// V3 qualify_claim: 300 Tgas + 1 NEAR, mirroring the XSuite helper (which
// proves 1 NEAR covers qualification storage; dust deposits fail).
export const QUALIFY_GAS = "300000000000000";
export const QUALIFY_DEPOSIT_YOCTO = "1000000000000000000000000";

// V3 create_bounty: 300 Tgas + 0.05 NEAR. The contract prescribes "a few
// hundredths of a NEAR" per call and keeps overpayment without refund
// (lib.rs assert_storage_covered docs); 0.05 covers the worst-case
// 16-slot bounty (~700 bytes at 1e19 yocto/byte) several times over.
// mark_funded is non-payable: signAndSend defaults (deposit 0) apply.
export const CREATE_BOUNTY_V3_GAS = "300000000000000";
export const CREATE_BOUNTY_V3_DEPOSIT_YOCTO = "50000000000000000000000";

export interface NearTxReceipt {
  txHash: string | null;
  outcome: unknown;
}

export async function signAndSend(
  selector: import("@near-wallet-selector/core").WalletSelector,
  methodName: string,
  args: Record<string, unknown>,
  depositYocto = "0",
  gas = CLAIM_GAS
): Promise<NearTxReceipt> {
  const wallet = await selector.wallet();
  const outcome = await wallet.signAndSendTransaction({
    receiverId: config.contractId,
    actions: [
      {
        type: "FunctionCall",
        params: { methodName, args, gas, deposit: depositYocto },
      },
    ],
  });
  const { interpretNearTxOutcome } = await import("./display.mjs");
  const verdict = interpretNearTxOutcome(outcome) as {
    ok: boolean;
    txHash: string | null;
    error?: string;
  };
  if (!verdict.ok) {
    throw Object.assign(new Error(verdict.error ?? "NEAR transaction failed."), {
      txHash: verdict.txHash,
      outcome,
    });
  }
  return { txHash: verdict.txHash, outcome };
}
