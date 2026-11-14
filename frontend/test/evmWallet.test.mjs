import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evmWalletReducer,
  firstAccount,
  initialEvmState,
  parseChainId,
} from "../lib/evmWallet.mjs";

// P2-2: EVM wallet lifecycle. The provider is mocked by driving the
// reducer with the exact payloads MetaMask-family wallets emit; no live
// wallet, no network.
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, "..", p), "utf8");
const SEP = 84532n; // Base Sepolia

describe("firstAccount", () => {
  it("takes the first usable account and maps absence to null", () => {
    assert.equal(firstAccount(["0xA", "0xB"]), "0xA");
    assert.equal(firstAccount([{ address: "0xA" }]), "0xA");
    assert.equal(firstAccount(["", "0xB"]), "0xB");
    assert.equal(firstAccount([]), null);
    assert.equal(firstAccount(null), null);
    assert.equal(firstAccount(undefined), null);
    assert.equal(firstAccount("0xA"), null);
    assert.equal(firstAccount([{}, { address: "" }]), null);
  });
});

describe("parseChainId", () => {
  it("normalizes every provider chain-id shape", () => {
    assert.equal(parseChainId(84532n), SEP);
    assert.equal(parseChainId(84532), SEP);
    assert.equal(parseChainId("84532"), SEP);
    assert.equal(parseChainId("0x14a34"), SEP);
    assert.equal(parseChainId("0x14A34"), SEP);
    assert.equal(parseChainId(" 0x1 "), 1n);
  });

  it("rejects malformed and negative values", () => {
    for (const v of [null, undefined, "", "  ", "abc", "0xzz", 1.5, -1, -1n, {}, []]) {
      assert.equal(parseChainId(v), null);
    }
  });
});

describe("evmWalletReducer", () => {
  it("starts disconnected with no provider", () => {
    assert.deepEqual(initialEvmState(), {
      address: null,
      chainId: null,
      ready: false,
      error: null,
      attempt: 0,
    });
  });

  it("tracks provider presence without touching the rest", () => {
    let s = evmWalletReducer(initialEvmState(), { type: "PROVIDER_PRESENT" });
    assert.equal(s.ready, true);
    assert.equal(evmWalletReducer(s, { type: "PROVIDER_PRESENT" }), s);
    s = evmWalletReducer(
      { ...s, address: "0xA", chainId: SEP, error: "x" },
      { type: "PROVIDER_ABSENT" }
    );
    assert.deepEqual(s, { address: null, chainId: null, ready: false, error: null, attempt: 0 });
  });

  it("applies accountsChanged immediately, including disconnect-by-empty-list", () => {
    let s = evmWalletReducer(initialEvmState(), { type: "PROVIDER_PRESENT" });
    s = evmWalletReducer(s, { type: "ACCOUNTS_CHANGED", accounts: ["0xA"] });
    assert.equal(s.address, "0xA");
    s = evmWalletReducer(s, { type: "ACCOUNTS_CHANGED", accounts: ["0xB"] });
    assert.equal(s.address, "0xB", "account switch replaces, never merges");
    s = evmWalletReducer(s, { type: "ACCOUNTS_CHANGED", accounts: [] });
    assert.equal(s.address, null);
    assert.equal(s.ready, true, "provider still present, just disconnected");
  });

  it("applies chainChanged payloads and keeps prior state on garbage", () => {
    let s = { ...initialEvmState(), ready: true, chainId: SEP };
    s = evmWalletReducer(s, { type: "CHAIN_CHANGED", chainId: "0x1" });
    assert.equal(s.chainId, 1n);
    s = evmWalletReducer(s, { type: "CHAIN_CHANGED", chainId: "not-a-chain" });
    assert.equal(s.chainId, 1n);
    s = evmWalletReducer(s, { type: "CHAIN_CHANGED", chainId: "0x14a34" });
    assert.equal(s.chainId, SEP, "switching back restores the supported chain");
  });

  it("clears state on disconnect", () => {
    const s = evmWalletReducer(
      { address: "0xA", chainId: SEP, ready: true, error: "stale", attempt: 3 },
      { type: "DISCONNECTED" }
    );
    assert.deepEqual(s, { address: null, chainId: null, ready: true, error: null, attempt: 3 });
  });

  it("applies only the latest refresh and drops stale completions", () => {
    let s = evmWalletReducer(initialEvmState(), { type: "REFRESH_START", attempt: 1 });
    s = evmWalletReducer(s, { type: "REFRESH_START", attempt: 2 });
    const stale = evmWalletReducer(s, {
      type: "REFRESH_OK",
      attempt: 1,
      accounts: ["0xOLD"],
      chainId: 1n,
    });
    assert.equal(stale, s, "slow first read cannot overwrite the newer attempt");
    s = evmWalletReducer(s, {
      type: "REFRESH_OK",
      attempt: 2,
      accounts: [{ address: "0xNEW" }],
      chainId: "0x14a34",
    });
    assert.deepEqual(
      { address: s.address, chainId: s.chainId, error: s.error },
      { address: "0xNEW", chainId: SEP, error: null }
    );
  });

  it("keeps last-known state when a refresh read fails", () => {
    const s = evmWalletReducer(
      { address: "0xA", chainId: SEP, ready: true, error: null, attempt: 2 },
      { type: "REFRESH_FAILED", attempt: 2 }
    );
    assert.deepEqual(
      { address: s.address, chainId: s.chainId },
      { address: "0xA", chainId: SEP },
      "transient RPC failure must not wipe a working connection"
    );
    const older = { ...s, attempt: 3 };
    assert.equal(evmWalletReducer(older, { type: "REFRESH_FAILED", attempt: 2 }), older);
  });

  it("reports connect/switch failures once and only while current", () => {
    let s = evmWalletReducer(initialEvmState(), { type: "CONNECT_START", attempt: 1 });
    assert.equal(s.error, null);
    s = evmWalletReducer(s, { type: "CONNECT_FAILED", attempt: 1, message: "rejected" });
    assert.equal(s.error, "rejected");
    assert.equal(s.address, null);
    // A superseded failure (a newer attempt or refresh already moved on)
    // never resurfaces.
    const newer = evmWalletReducer(s, { type: "CONNECT_START", attempt: 2 });
    assert.equal(newer.error, null);
    assert.equal(
      evmWalletReducer(newer, { type: "CONNECT_FAILED", attempt: 1, message: "late" }),
      newer
    );
    let w = evmWalletReducer(initialEvmState(), { type: "SWITCH_START", attempt: 1 });
    w = evmWalletReducer(w, { type: "SWITCH_FAILED", attempt: 1, message: "rejected" });
    assert.equal(w.error, "rejected");
  });

  it("clears the error on any fresh wallet signal", () => {
    const err = { ...initialEvmState(), error: "rejected" };
    assert.equal(evmWalletReducer(err, { type: "ACCOUNTS_CHANGED", accounts: ["0xA"] }).error, null);
    assert.equal(evmWalletReducer(err, { type: "CHAIN_CHANGED", chainId: "0x1" }).error, null);
    assert.equal(
      evmWalletReducer(
        { ...err, attempt: 1 },
        { type: "REFRESH_OK", attempt: 1, accounts: ["0xA"], chainId: SEP }
      ).error,
      null
    );
  });

  it("leaves state untouched on unknown actions", () => {
    const s = initialEvmState();
    assert.equal(evmWalletReducer(s, { type: "NOPE" }), s);
    assert.equal(evmWalletReducer(s, null), s);
  });
});

describe("provider EVM wiring", () => {
  const src = read("components/wallets.tsx");

  it("drives EVM state through the reducer with attempt tracking", () => {
    assert.ok(src.includes('from "../lib/evmWallet.mjs"'), "provider uses the lifecycle module");
    assert.ok(src.includes("useReducer(evmWalletReducer"), "EVM state is reducer-owned");
    assert.ok(src.includes("evmAttemptRef"), "async completions carry attempt ids");
    assert.ok(src.includes("REFRESH_START"), "refreshes supersede each other");
  });

  it("listens for accounts, chain, and disconnect with full cleanup", () => {
    for (const ev of ["accountsChanged", "chainChanged", "disconnect"]) {
      assert.ok(src.includes(`eth.on("${ev}"`), `subscribes to ${ev}`);
      assert.ok(src.includes(`off.call(eth, "${ev}"`), `unsubscribes ${ev}`);
    }
    assert.ok(src.includes("ACCOUNTS_CHANGED"), "account payloads dispatch");
    assert.ok(src.includes("CHAIN_CHANGED"), "chain payloads dispatch");
    assert.ok(src.includes("DISCONNECTED"), "disconnect clears state");
  });

  it("guards async completions against unmount", () => {
    assert.ok(src.includes("evmMountedRef"), "mount state tracked");
    assert.ok(src.includes("if (!evmMountedRef.current) return;"), "late completions dropped");
  });

  it("serializes connect and switch prompts", () => {
    assert.ok(src.includes("evmBusyRef.current.tryAcquire()"), "double prompts prevented");
    assert.ok(src.includes("evmBusyRef.current.release()"), "guard always released");
  });

  it("derives Base Sepolia support from the live chain id", () => {
    assert.ok(
      src.includes("evm.chainId === null ? null : evm.chainId === BigInt(config.expectedChainId)"),
      "network support derives from context chain id"
    );
  });

  it("leaves NEAR initialization untouched", () => {
    for (const token of ["getSelector()", "walletInitReducer", "showWalletModal", "signOutSelector"]) {
      assert.ok(src.includes(token), `NEAR path keeps ${token}`);
    }
  });
});

describe("submission gating and prior fixes", () => {
  it("enforces chain id at signer creation and reconciles wallets pre-submit", () => {
    assert.ok(
      read("lib/base.ts").includes("expected ${config.expectedChainId}"),
      "browserSigner rejects the wrong network live"
    );
    const form = read("components/SponsorFormV3.tsx");
    assert.ok(form.includes("reconcileSponsorV3"), "resume re-checks wallets and network");
    assert.ok(form.includes("guard.assertUnchanged"), "P1-13 per-write identity checks intact");
  });

  it("keeps timeout, init, settlement, and recovery protections", () => {
    assert.ok(read("components/SponsorFormV3.tsx").includes("waitForTxReceipt"), "P2-1 intact");
    assert.ok(read("components/wallets.tsx").includes("walletInitReducer"), "P1-9 intact");
    assert.ok(read("components/SettlementPanel.tsx").includes("createSettlePoller"), "P1-10 intact");
    assert.ok(
      read("components/ClaimFormV3.tsx").includes("getClaimByPr(bountyId"),
      "P1-13 lost-receipt check intact"
    );
  });

  it("checks identity before sends, never after confirmations", () => {
    const src = read("components/SponsorFormV3.tsx");
    const guardAt = src.indexOf("guard.assertUnchanged(liveWallets())");
    assert.ok(guardAt > 0, "guard exists in the write wrapper");
    assert.ok(
      guardAt < src.indexOf("esc.createBounty("),
      "identity is verified before the first send"
    );
    assert.ok(
      !src.slice(src.indexOf("waitForTxReceipt(tx)")).includes("assertUnchanged"),
      "no post-confirmation re-check can falsely fail a mined transaction"
    );
  });
});
