"use client";

import { useWallets } from "./wallets";
import { shortenAddress } from "../lib/display.mjs";
import { shouldShowNearInitError } from "../lib/walletInit.mjs";

export default function WalletControls() {
  const {
    nearReady,
    nearStatus,
    nearError,
    retryNear,
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
          <button
            className="linklike"
            onClick={disconnectNear}
            title="Disconnect NEAR wallet"
            aria-label="Disconnect NEAR wallet"
          >
            <span aria-hidden="true">×</span>
          </button>
        </span>
      ) : shouldShowNearInitError(nearStatus, nearAccount) ? (
        <span className="wallet-chip wallet-chip-warn" title={nearError ?? "NEAR wallet setup failed"} role="alert">
          <span className="dot dot-warn" aria-hidden="true" />
          <span>NEAR setup failed</span>
          <button className="linklike" onClick={retryNear} title="Retry NEAR wallet setup">
            Retry
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
      {evmError && (
        <span className="wallet-error" role="alert">
          {evmError}
        </span>
      )}
    </div>
  );
}
