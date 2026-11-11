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
  contractId: env("NEXT_PUBLIC_CONTRACT_ID", "v2.omnibounty.testnet"),
  networkId: env("NEXT_PUBLIC_NETWORK_ID", "testnet") === "mainnet" ? "mainnet" : "testnet",
  baseRpcUrl: env("NEXT_PUBLIC_BASE_RPC_URL", "https://sepolia.base.org"),
  escrowAddress: env("NEXT_PUBLIC_ESCROW_ADDRESS", "0xee5C8F3154fed8B9B2f5D820AC687fDfa8CF2C99"),
  expectedChainId: Number(env("NEXT_PUBLIC_CHAIN_ID", "84532")),
  // Base Sepolia USDC (Circle). Override per deployment.
  usdcAddress: env("NEXT_PUBLIC_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
};
