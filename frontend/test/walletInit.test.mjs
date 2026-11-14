import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertBrowserWalletEnv,
  createSharedInitializer,
  initErrorMessage,
  shouldShowNearInitError,
  signOutSelector,
  walletInitReducer,
} from "../lib/walletInit.mjs";

// P1-9: NEAR wallet-selector initialization lifecycle. All wallet and
// browser dependencies are mocked or injected; no real connections.
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createSharedInitializer", () => {
  it("caches success across sequential and concurrent callers", async () => {
    let calls = 0;
    const init = createSharedInitializer(async () => {
      calls++;
      await tick();
      return { selector: true };
    });
    const [a, b] = await Promise.all([init(), init()]);
    assert.equal(calls, 1);
    assert.equal(a, b);
    assert.equal(await init(), a);
    assert.equal(calls, 1);
  });

  it("clears failures so the next call retries instead of replaying rejection", async () => {
    let calls = 0;
    const init = createSharedInitializer(async () => {
      calls++;
      if (calls === 1) throw new Error("setup down");
      return { selector: true };
    });
    await assert.rejects(init(), /setup down/);
    const r = await init();
    assert.deepEqual(r, { selector: true });
    assert.equal(calls, 2);
  });

  it("settles every concurrent waiter on shared failure", async () => {
    const init = createSharedInitializer(async () => {
      await tick();
      throw new Error("boom");
    });
    const results = await Promise.allSettled([init(), init(), init()]);
    assert.ok(results.every((r) => r.status === "rejected"));
    assert.match(String(results[0].reason), /boom/);
  });

  it("converts synchronous starter throws into retryable rejections", async () => {
    let calls = 0;
    const init = createSharedInitializer(() => {
      calls++;
      if (calls === 1) throw new Error("sync blowup");
      return "late-ok";
    });
    await assert.rejects(init(), /sync blowup/);
    assert.equal(await init(), "late-ok");
  });
});

describe("assertBrowserWalletEnv", () => {
  it("rejects non-browser environments", () => {
    assert.throws(() => assertBrowserWalletEnv({}), /browser environment/);
    assert.throws(() => assertBrowserWalletEnv(null), /browser environment/);
    assert.throws(() => assertBrowserWalletEnv(), /browser environment/);
  });

  it("rejects unreadable browser storage", () => {
    const root = { window: {} };
    Object.defineProperty(root.window, "localStorage", {
      get() {
        throw new Error("SecurityError");
      },
    });
    assert.throws(() => assertBrowserWalletEnv(root), /storage is unavailable/);
  });

  it("passes capable browsers", () => {
    assert.equal(assertBrowserWalletEnv({ window: { localStorage: {} } }), true);
  });
});

describe("initErrorMessage", () => {
  it("keeps actionable messages and caps length", () => {
    assert.equal(initErrorMessage(new Error("nope")), "nope");
    assert.equal(initErrorMessage(new Error("x".repeat(300))).length, 201);
    assert.equal(initErrorMessage(new Error("   ")), "NEAR wallet setup failed.");
    assert.equal(initErrorMessage("plain"), "plain");
    assert.equal(initErrorMessage(null), "NEAR wallet setup failed.");
  });
});

describe("walletInitReducer", () => {
  const LOADING = { status: "loading", error: null, attempt: 1 };

  it("tracks attempt, resolve, and reject", () => {
    assert.deepEqual(
      walletInitReducer({ status: "loading", error: null, attempt: 0 }, { type: "ATTEMPT", attempt: 1 }),
      LOADING
    );
    assert.deepEqual(walletInitReducer(LOADING, { type: "RESOLVE", attempt: 1 }), {
      status: "ready",
      error: null,
      attempt: 1,
    });
    assert.deepEqual(walletInitReducer(LOADING, { type: "REJECT", attempt: 1, message: "bad" }), {
      status: "error",
      error: "bad",
      attempt: 1,
    });
  });

  it("ignores stale settlements from superseded attempts", () => {
    const retired = { status: "loading", error: null, attempt: 2 };
    assert.equal(walletInitReducer(retired, { type: "RESOLVE", attempt: 1 }), retired);
    assert.equal(walletInitReducer(retired, { type: "REJECT", attempt: 1, message: "late" }), retired);
  });

  it("recovers through retry after failure", () => {
    const failed = { status: "error", error: "down", attempt: 1 };
    const retrying = walletInitReducer(failed, { type: "ATTEMPT", attempt: 2 });
    assert.deepEqual(retrying, { status: "loading", error: null, attempt: 2 });
    assert.deepEqual(walletInitReducer(retrying, { type: "RESOLVE", attempt: 2 }), {
      status: "ready",
      error: null,
      attempt: 2,
    });
  });

  it("leaves state untouched on unknown actions", () => {
    assert.equal(walletInitReducer(LOADING, { type: "NOPE" }), LOADING);
    assert.equal(walletInitReducer(LOADING, null), LOADING);
  });
});

describe("shouldShowNearInitError", () => {
  it("shows the error UI only when disconnected and failed", () => {
    assert.equal(shouldShowNearInitError("error", null), true);
    assert.equal(shouldShowNearInitError("error", "a.testnet"), false);
    assert.equal(shouldShowNearInitError("loading", null), false);
    assert.equal(shouldShowNearInitError("ready", null), false);
    assert.equal(shouldShowNearInitError("ready", "a.testnet"), false);
    assert.equal(shouldShowNearInitError("loading", "a.testnet"), false);
  });
});

describe("retry recovery (initializer + reducer together)", () => {
  it("fails with an SDK error, then retry connects and restores ready state", async () => {
    let calls = 0;
    const init = createSharedInitializer(async () => {
      calls++;
      await tick();
      if (calls === 1) throw new Error('setupWalletSelector: wallet module "sender" failed to initialize');
      return { store: { getState: () => ({ accounts: [] }) } };
    });
    // Drive the provider sequence with mocks: ATTEMPT -> settle -> retry.
    let state = { status: "loading", error: null, attempt: 0 };
    state = walletInitReducer(state, { type: "ATTEMPT", attempt: 1 });
    const first = await init().then(
      () => ({ ok: true }),
      (e) => ({ ok: false, message: initErrorMessage(e) })
    );
    assert.equal(first.ok, false);
    state = walletInitReducer(state, { type: "REJECT", attempt: 1, message: first.message });
    assert.deepEqual(state, { status: "error", error: first.message, attempt: 1 });
    assert.match(state.error, /sender.*failed to initialize/);
    assert.equal(shouldShowNearInitError(state.status, null), true);
    assert.equal(shouldShowNearInitError(state.status, "alice.testnet"), false);
    // Retry: concurrent callers share the single recovery attempt, and the
    // success restores ready state (which re-enables normal connection).
    state = walletInitReducer(state, { type: "ATTEMPT", attempt: 2 });
    const [a, b] = await Promise.all([init(), init()]);
    assert.equal(a, b);
    state = walletInitReducer(state, { type: "RESOLVE", attempt: 2 });
    assert.deepEqual(state, { status: "ready", error: null, attempt: 2 });
    assert.equal(shouldShowNearInitError(state.status, null), false);
    assert.equal(calls, 2);
  });

  it("stale settlements never overwrite a newer retry result", () => {
    let state = { status: "loading", error: null, attempt: 0 };
    state = walletInitReducer(state, { type: "ATTEMPT", attempt: 1 });
    state = walletInitReducer(state, { type: "ATTEMPT", attempt: 2 });
    // Attempt 1 finally resolves — ignored while the retry is in flight.
    assert.deepEqual(walletInitReducer(state, { type: "RESOLVE", attempt: 1 }), state);
    state = walletInitReducer(state, { type: "REJECT", attempt: 2, message: "retry failed" });
    assert.deepEqual(state, { status: "error", error: "retry failed", attempt: 2 });
    // And a stale failure cannot clobber a fresh success either.
    const ok = walletInitReducer(
      { status: "loading", error: null, attempt: 2 },
      { type: "RESOLVE", attempt: 2 }
    );
    assert.equal(walletInitReducer(ok, { type: "REJECT", attempt: 1, message: "late" }), ok);
  });
});

describe("form + header init-error wiring", () => {
  it("every NEAR surface gates retry UI on the shared helper", async () => {
    const { readFile } = await import("node:fs/promises");
    const here = new URL(".", import.meta.url);
    // V1 sponsorship was removed with the V3-only switch; the legacy V1
    // claim display keeps its init-error UI.
    const consumers = [
      ["../components/WalletControls.tsx", "Retry"],
      ["../components/ClaimForm.tsx", "Retry setup"],
      ["../components/ClaimFormV3.tsx", "Retry setup"],
      ["../components/SponsorFormV3.tsx", "Retry setup"],
    ];
    for (const [rel, label] of consumers) {
      const src = await readFile(new URL(rel, here), "utf8");
      assert.ok(src.includes("shouldShowNearInitError(nearStatus, nearAccount)"), `${rel} gates on shared helper`);
      assert.ok(src.includes("onClick={retryNear}"), `${rel} retries without refresh`);
      assert.ok(src.includes(label), `${rel} shows retry action`);
      assert.ok(src.includes("nearError"), `${rel} surfaces the failure message`);
    }
    const provider = await readFile(new URL("../components/wallets.tsx", here), "utf8");
    for (const field of ["nearStatus", "nearError", "retryNear"]) {
      assert.ok(provider.includes(field), `wallets.tsx exposes ${field}`);
    }
  });
});

describe("signOutSelector", () => {
  it("signs out through the active wallet", async () => {
    const calls = [];
    await signOutSelector({
      wallet: async () => ({
        signOut: async () => {
          calls.push("signOut");
        },
      }),
    });
    assert.deepEqual(calls, ["signOut"]);
  });

  it("resolves quietly on wallet lookup and signOut failures (historic behavior)", async () => {
    await signOutSelector({ wallet: async () => { throw new Error("gone"); } });
    await signOutSelector({ wallet: async () => ({ signOut: async () => { throw new Error("nope"); } }) });
    await signOutSelector({ wallet: async () => null });
    await signOutSelector(null);
    await signOutSelector({});
  });
});
