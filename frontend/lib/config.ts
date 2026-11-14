// Frontend configuration. NEXT_PUBLIC_* values are embedded in the browser
// bundle — only public endpoints and addresses belong here. Secrets (Reclaim
// app secret, relayer key) live server-side / in scripts, never in this file.

export interface FrontendConfig {
  nearRpcUrl: string;
  contractId: string;
  networkId: "testnet" | "mainnet";
  baseRpcUrl: string;
  escrowAddress: string;
  expectedChainId: number;
  usdcAddress: string;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export const config: FrontendConfig = {
  nearRpcUrl: env("NEXT_PUBLIC_NEAR_RPC_URL", "https://rpc.testnet.near.org"),
  // V3-only frontend: the deployed V3 NEAR contract and Base Sepolia V2
  // escrow are the defaults (see testdata/production_testnet_v3.json), so
  // every run targets V3 unless explicitly overridden.
  contractId: env("NEXT_PUBLIC_CONTRACT_ID", "omnibounty-v3.testnet"),
  networkId: env("NEXT_PUBLIC_NETWORK_ID", "testnet") === "mainnet" ? "mainnet" : "testnet",
  baseRpcUrl: env("NEXT_PUBLIC_BASE_RPC_URL", "https://sepolia.base.org"),
  escrowAddress: env("NEXT_PUBLIC_ESCROW_ADDRESS", "0x63391c272A49c30f79eb6c3d8E10F0652Bb0F767"),
  expectedChainId: Number(env("NEXT_PUBLIC_CHAIN_ID", "84532")),
  // Base Sepolia USDC (Circle). Override per deployment.
  usdcAddress: env("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
};
