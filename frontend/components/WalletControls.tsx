"use client";

import { useWallets } from "./wallets";
import { shortenAddress } from "../lib/display.mjs";

export default function WalletControls() {
  const {
    nearReady,
    nearAccount,
    connectNear,
    disconnectNear,
    evmAddress,
    evmReady,
    evmOnBaseSepolia,
    connectEvm,
    switchEvmNetwork,
    evmError,
  } = useWallets();

  return (
    <div className="wallet-controls">
      {nearAccount ? (
        <span className="wallet-chip wallet-chip-on" title={`NEAR account ${nearAccount}`}>
          <span className="dot dot-on" aria-hidden="true" />
          <code>{nearAccount}</code>
          <button className="linklike" onClick={disconnectNear} title="Disconnect NEAR wallet">
            ×
          </button>
        </span>
      ) : (
        <button className="wallet-btn" disabled={!nearReady} onClick={connectNear}>
          {nearReady ? "Connect NEAR" : "Loading…"}
        </button>
      )}
      {evmAddress ? (
        <span
          className={`wallet-chip ${evmOnBaseSepolia ? "wallet-chip-on" : "wallet-chip-warn"}`}
          title={`EVM account ${evmAddress}`}
        >
          <span className={`dot ${evmOnBaseSepolia ? "dot-on" : "dot-warn"}`} aria-hidden="true" />
          <code>{shortenAddress(evmAddress)}</code>
          {evmOnBaseSepolia === false && (
            <button className="linklike" onClick={switchEvmNetwork} title="Switch to Base Sepolia">
              Switch network
            </button>
          )}
        </span>
      ) : (
        <button className="wallet-btn" disabled={!evmReady} onClick={connectEvm} title={evmReady ? "Connect an EVM wallet (MetaMask, …)" : "No injected EVM wallet detected"}>
          {evmReady ? "Connect EVM" : "No EVM wallet"}
        </button>
      )}
      {evmError && <span className="wallet-error">{evmError}</span>}
    </div>
  );
}
