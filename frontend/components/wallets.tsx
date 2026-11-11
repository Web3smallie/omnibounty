"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { WalletSelector } from "@near-wallet-selector/core";
import type { Eip1193Provider } from "ethers";
import { getSelector, showWalletModal } from "../lib/near";
import { config } from "../lib/config";

interface WalletsState {
  nearReady: boolean;
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
  const [evmAddress, setEvmAddress] = useState<string | null>(null);
  const [evmChainId, setEvmChainId] = useState<bigint | null>(null);
  const [evmReady, setEvmReady] = useState(false);
  const [evmError, setEvmError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let unsub: (() => void) | undefined;
    getSelector()
      .then((s) => {
        if (!mounted) return;
        setSelector(s);
        const { accounts } = s.store.getState();
        setNearAccount(accounts.length > 0 ? accounts[0].accountId : null);
        const sub = s.store.observable.subscribe((state) => {
          setNearAccount(state.accounts.length > 0 ? state.accounts[0].accountId : null);
        });
        unsub = () => sub.unsubscribe();
      })
      .catch(() => {
        if (mounted) setSelector(null);
      });
    return () => {
      mounted = false;
      unsub?.();
    };
  }, []);

  const refreshEvm = useCallback(async () => {
    const eth = (window as unknown as { ethereum?: unknown }).ethereum;
    if (!eth) {
      setEvmReady(false);
      return;
    }
    setEvmReady(true);
    try {
      const { ethers } = await import("ethers");
      const provider = new ethers.BrowserProvider(eth as Eip1193Provider);
      const accounts = (await provider.listAccounts()).map((a) => a.address);
      setEvmAddress(accounts.length > 0 ? accounts[0] : null);
      setEvmChainId((await provider.getNetwork()).chainId);
    } catch {
      setEvmAddress(null);
      setEvmChainId(null);
    }
  }, []);

  useEffect(() => {
    refreshEvm();
    const eth = (window as unknown as { ethereum?: { on?: (...a: never[]) => void } }).ethereum;
    if (!eth || typeof eth.on !== "function") return;
    const onAccounts = () => refreshEvm();
    const onChain = () => refreshEvm();
    eth.on("accountsChanged" as never, onAccounts as never);
    eth.on("chainChanged" as never, onChain as never);
    return () => {
      const off = (eth as unknown as { removeListener?: (...a: never[]) => void }).removeListener;
      if (typeof off === "function") {
        off.call(eth, "accountsChanged" as never, onAccounts as never);
        off.call(eth, "chainChanged" as never, onChain as never);
      }
    };
  }, [refreshEvm]);

  const connectNear = useCallback(() => {
    if (selector) showWalletModal(selector);
  }, [selector]);

  const disconnectNear = useCallback(async () => {
    if (!selector) return;
    const wallet = await selector.wallet().catch(() => null);
    await wallet?.signOut().catch(() => null);
    setNearAccount(null);
  }, [selector]);

  const connectEvm = useCallback(async () => {
    setEvmError(null);
    try {
      const { connectEvm: doConnect, evmChainId: readChain } = await import("../lib/base");
      const addr = await doConnect();
      setEvmAddress(addr);
      setEvmChainId(await readChain());
    } catch (e) {
      setEvmError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const switchEvmNetwork = useCallback(async () => {
    setEvmError(null);
    try {
      const { switchToBaseSepolia, evmChainId: readChain } = await import("../lib/base");
      await switchToBaseSepolia();
      setEvmChainId(await readChain());
    } catch (e) {
      setEvmError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const value = useMemo<WalletsState>(
    () => ({
      nearReady: selector !== null,
      nearAccount,
      connectNear,
      disconnectNear,
      evmAddress,
      evmChainId,
      evmReady,
      evmOnBaseSepolia: evmChainId === null ? null : evmChainId === BigInt(config.expectedChainId),
      connectEvm,
      switchEvmNetwork,
      evmError,
    }),
    [
      selector,
      nearAccount,
      connectNear,
      disconnectNear,
      evmAddress,
      evmChainId,
      evmReady,
      connectEvm,
      switchEvmNetwork,
      evmError,
    ]
  );

  return <WalletsContext.Provider value={value}>{children}</WalletsContext.Provider>;
}
