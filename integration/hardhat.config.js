// Minimal Hardhat config for the V3 e2e harness. The in-process network
// is the execution environment (no sockets, no external node). Solidity
// compilation is intentionally NOT used here: the escrow bytecode comes
// from the Foundry build (contracts/base-v3/out). Always invoke with
// `npx hardhat run --no-compile` so Hardhat never tries to fetch solc.
import "@nomicfoundation/hardhat-ethers";

/** @type import('hardhat/config').HardhatUserConfig */
export default {
  solidity: "0.8.24",
  paths: {
    sources: "./contracts-empty",
    tests: "./tests-empty",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      chainId: 84532,
      mining: { auto: true, interval: 0 },
    },
  },
  mocha: { timeout: 600000 },
};
