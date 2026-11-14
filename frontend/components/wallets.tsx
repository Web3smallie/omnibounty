"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { WalletSelector } from "@near-wallet-selector/core";
import type { Eip1193Provider } from "ethers";
import { getSelector, showWalletModal } from "../lib/near";
import {
  initErrorMessage,
  signOutSelector,
  walletInitReducer,
} from "../lib/walletInit.mjs";
import { evmWalletReducer } from "../lib/evmWallet.mjs";
import { createBusyGuard } from "../lib/submitGuard.mjs";
import { config } from "../lib/config";

interface WalletsState {
  nearReady: boolean;
  nearStatus: "loading" | "ready" | "error";
  nearError: string | null;
  retryNear: () => void;
  nearAccount: string | null;
  connectNear: () => void;
  disconnectNear: () => Promise<void>;
  evmAddress: string | null;
  evmChainId: bigint | null;
  evmReady: boolean;
  evmOnBaseSepolia: boolean | null;
  connectEvm: () => Promise<void>;
  switchEvmNetwork: () => Promise<void>;
  evmError: string | null;
}

const WalletsContext = createContext<WalletsState | null>(null);

export function useWallets(): WalletsState {
  const ctx = useContext(WalletsContext);
  if (!ctx) throw new Error("useWallets must be used inside <WalletsProvider>");
  return ctx;
}

export function WalletsProvider({ children }: { children: ReactNode }) {
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const [nearAccount, setNearAccount] = useState<string | null>(null);
  const [evm, dispatchEvm] = useReducer(evmWalletReducer, {
    address: null,
    chainId: null,
    ready: false,
    error: null,
    attempt: 0,
  } as { address: string | null; chainId: bigint | null; ready: boolean; error: string | null; attempt: number });
  const evmAttemptRef = useRef(0);
  const evmBusyRef = useRef(createBusyGuard());
  const evmMountedRef = useRef(true);
  const [init, dispatchInit] = useReducer(walletInitReducer, {
    status: "loading",
    error: null,
    attempt: 0,
  } as { status: "loading" | "ready" | "error"; error: string | null; attempt: number });
  const attemptRef = useRef(0);
  const accountSubRef = useRef<{ unsubscribe: () => void } | null>(null);

  const runNearInit = useCallback(() => {
    attemptRef.current += 1;
    const attempt = attemptRef.current;
    dispatchInit({ type: "ATTEMPT", attempt });
    getSelector().then(
      (s) => {
        if (attempt !== attemptRef.current) return; // stale attempt: a retry superseded it
        accountSubRef.current?.unsubscribe();
        setSelector(s);
        const { accounts } = s.store.getState();
        setNearAccount(accounts.length > 0 ? accounts[0].accountId : null);
        accountSubRef.current = s.store.observable.subscribe((state) => {
          setNearAccount(state.accounts.length > 0 ? state.accounts[0].accountId : null);
        });
        dispatchInit({ type: "RESOLVE", attempt });
      },
      (e: unknown) => {
        if (attempt !== attemptRef.current) return; // stale attempt: ignore
        accountSubRef.current?.unsubscribe();
        accountSubRef.current = null;
        setSelector(null);
        setNearAccount(null);
        dispatchInit({ type: "REJECT", attempt, message: initErrorMessage(e) });
      }
    );
  }, []);

  useEffect(() => {
    runNearInit();
    return () => {
      // Invalidate any in-flight attempt and drop the account subscription.
      attemptRef.current += 1;
      accountSubRef.current?.unsubscribe();
      accountSubRef.current = null;
    };
  }, [runNearInit]);

  const retryNear = useCallback(() => {
    runNearInit();
  }, [runNearInit]);

  const refreshEvm = useCallback(async () => {
    const eth = (window as unknown as { ethereum?: unknown }).ethereum;
    if (!eth) {
      dispatchEvm({ type: "PROVIDER_ABSENT" });
      return;
    }
    dispatchEvm({ type: "PROVIDER_PRESENT" });
    evmAttemptRef.current += 1;
    const attempt = evmAttemptRef.current;
    dispatchEvm({ type: "REFRESH_START", attempt });
    try {
      const { ethers } = await import("ethers");
      const provider = new ethers.BrowserProvider(eth as Eip1193Provider);
      const accounts = await provider.listAccounts();
      const chainId = (await provider.getNetwork()).chainId;
      if (!evmMountedRef.current) return;
      dispatchEvm({ type: "REFRESH_OK", attempt, accounts, chainId });
    } catch {
      if (!evmMountedRef.current) return;
      dispatchEvm({ type: "REFRESH_FAILED", attempt });
    }
  }, []);

  useEffect(() => {
    evmMountedRef.current = true;
    refreshEvm();
    const eth = (window as unknown as { ethereum?: { on?: (...a: never[]) => void } }).ethereum;
    if (!eth || typeof eth.on !== "function") {
      return () => {
        evmMountedRef.current = false;
      };
    }
    // Event payloads apply instantly; a refresh always follows to confirm
    // against live reads. A bare disconnect clears state outright.
    const onAccounts = (accounts: unknown) => {
      dispatchEvm({ type: "ACCOUNTS_CHANGED", accounts });
      refreshEvm();
    };
    const onChain = (chainId: unknown) => {
      dispatchEvm({ type: "CHAIN_CHANGED", chainId });
      refreshEvm();
    };
    const onDisconnect = () => {
      dispatchEvm({ type: "DISCONNECTED" });
    };
    eth.on("accountsChanged" as never, onAccounts as never);
    eth.on("chainChanged" as never, onChain as never);
    eth.on("disconnect" as never, onDisconnect as never);
    return () => {
      evmMountedRef.current = false;
      evmAttemptRef.current += 1; // drop in-flight refresh results
      const off = (eth as unknown as { removeListener?: (...a: never[]) => void }).removeListener;
      if (typeof off === "function") {
        off.call(eth, "accountsChanged" as never, onAccounts as never);
        off.call(eth, "chainChanged" as never, onChain as never);
        off.call(eth, "disconnect" as never, onDisconnect as never);
      }
    };
  }, [refreshEvm]);

  const connectNear = useCallback(() => {
    if (selector) showWalletModal(selector);
  }, [selector]);

  const disconnectNear = useCallback(async () => {
    if (!selector) return;
    await signOutSelector(selector);
    setNearAccount(null);
  }, [selector]);

  const connectEvm = useCallback(async () => {
    if (!evmBusyRef.current.tryAcquire()) return;
    evmAttemptRef.current += 1;
    const attempt = evmAttemptRef.current;
    dispatchEvm({ type: "CONNECT_START", attempt });
    try {
      const { connectEvm: doConnect } = await import("../lib/base");
      await doConnect();
      if (!evmMountedRef.current) return;
      await refreshEvm();
    } catch (e) {
      if (!evmMountedRef.current) return;
      dispatchEvm({ type: "CONNECT_FAILED", attempt, message: e instanceof Error ? e.message : String(e) });
    } finally {
      evmBusyRef.current.release();
    }
  }, [refreshEvm]);

  const switchEvmNetwork = useCallback(async () => {
    if (!evmBusyRef.current.tryAcquire()) return;
    evmAttemptRef.current += 1;
    const attempt = evmAttemptRef.current;
    dispatchEvm({ type: "SWITCH_START", attempt });
    try {
      const { switchToBaseSepolia } = await import("../lib/base");
      await switchToBaseSepolia();
      if (!evmMountedRef.current) return;
      await refreshEvm();
    } catch (e) {
      if (!evmMountedRef.current) return;
      dispatchEvm({ type: "SWITCH_FAILED", attempt, message: e instanceof Error ? e.message : String(e) });
    } finally {
      evmBusyRef.current.release();
    }
  }, [refreshEvm]);

  const value = useMemo<WalletsState>(
    () => ({
      nearReady: init.status === "ready",
      nearStatus: init.status,
      nearError: init.error,
      retryNear,
      nearAccount,
      connectNear,
      disconnectNear,
      evmAddress: evm.address,
      evmChainId: evm.chainId,
      evmReady: evm.ready,
      evmOnBaseSepolia: evm.chainId === null ? null : evm.chainId === BigInt(config.expectedChainId),
      connectEvm,
      switchEvmNetwork,
      evmError: evm.error,
    }),
    [
      init,
      retryNear,
      nearAccount,
      connectNear,
      disconnectNear,
      evm,
      connectEvm,
      switchEvmNetwork,
    ]
  );

  return <WalletsContext.Provider value={value}>{children}</WalletsContext.Provider>;
}
