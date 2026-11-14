import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_BOUNDARY_RETRIES,
  boundaryCanRetry,
  boundaryResetKey,
  describeComponentError,
  deriveBoundaryStateFromProps,
  initialBoundaryState,
  nextBoundaryRetryState,
  redactSecrets,
  reportComponentError,
} from "../lib/errorRecovery.mjs";

// P1-12: error-boundary policy. The repository has no React render
// harness (node:test only), so the boundary's decisions live in pure,
// dependency-free functions tested here, while ErrorBoundary.tsx stays a
// thin shell whose wiring is pinned by the placement tests below. No new
// dependencies were added for this.

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", rel), "utf8");

describe("redactSecrets", () => {
  it("redacts NEAR full-access keys", () => {
    assert.equal(
      redactSecrets("sign with ed25519:8h7Dn3JKp9QwErTyUiOpAsDfGhJkLzXcVbNm1234567890abcd="),
      "sign with ed25519:[redacted]"
    );
  });

  it("redacts PEM private-key blocks", () => {
    const pem = "key:\n-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIbad\n-----END PRIVATE KEY-----\ndone";
    assert.equal(redactSecrets(pem), "key:\n[redacted private key]\ndone");
  });

  it("redacts labeled password/secret/mnemonic/seed values", () => {
    assert.equal(redactSecrets("password=hunter2 ok"), "password=[redacted] ok");
    assert.equal(redactSecrets("config secret: abc123;"), "config secret: [redacted];");
    assert.equal(redactSecrets("mnemonic=word ".concat("x")), "mnemonic=[redacted] x");
    assert.equal(redactSecrets("seed phrase: alpha beta"), "seed phrase: [redacted] beta");
    assert.equal(redactSecrets("?next=/&secret=zzz"), "?next=/&secret=[redacted]");
  });

  it("leaves public chain data intact", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const addr = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    assert.equal(redactSecrets(`tx ${hash} to ${addr}`), `tx ${hash} to ${addr}`);
  });

  it("tolerates non-string input", () => {
    assert.equal(redactSecrets(null), "");
    assert.equal(redactSecrets(undefined), "");
    assert.equal(redactSecrets(42), "");
  });
});

describe("describeComponentError", () => {
  it("shapes Errors for display, capped and redacted", () => {
    assert.deepEqual(describeComponentError(new Error("boom")), { name: "Error", message: "boom" });
    assert.equal(describeComponentError(new Error("x".repeat(500))).message.length, 201);
    assert.equal(
      describeComponentError(new Error("bad ed25519:8h7Dn3JKp9QwErTyUiOpAsDfGhJkLzXcVbNm1234567890abcd=")).message,
      "bad ed25519:[redacted]"
    );
  });

  it("handles non-Error throws without throwing", () => {
    assert.deepEqual(describeComponentError("plain"), { name: "Error", message: "plain" });
    assert.deepEqual(describeComponentError(null), { name: "Error", message: "Something went wrong." });
    assert.deepEqual(describeComponentError(new Error("   ")), { name: "Error", message: "Something went wrong." });
  });
});

describe("reportComponentError", () => {
  it("logs one redacted record and returns it", () => {
    const calls = [];
    const record = reportComponentError({
      label: "bounty card",
      error: new Error("bad password=hunter2"),
      componentStack: "\n    in BountyCard",
      log: (...a) => calls.push(a),
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(record, {
      boundary: "bounty card",
      name: "Error",
      message: "bad password=[redacted]",
      componentStack: "\n    in BountyCard",
    });
    assert.match(String(calls[0][0]), /error-boundary:bounty card/);
    assert.ok(!JSON.stringify(calls[0]).includes("hunter2"), "secret must not reach the log");
  });

  it("defaults the label and tolerates failing loggers and weird errors", () => {
    const record = reportComponentError({
      error: null,
      log: () => {
        throw new Error("logger down");
      },
    });
    assert.deepEqual(record, {
      boundary: "component",
      name: "Error",
      message: "Something went wrong.",
      componentStack: null,
    });
  });
});

describe("boundaryResetKey", () => {
  it("joins segments and skips empties", () => {
    assert.equal(boundaryResetKey("bounty-card", 42), "bounty-card:42");
    assert.equal(boundaryResetKey("sponsor", null, "v1"), "sponsor:v1");
    assert.equal(boundaryResetKey(), "");
  });
});

describe("retry budget (error-loop prevention)", () => {
  it("allows bounded retries, then forces the reload path", () => {
    assert.equal(MAX_BOUNDARY_RETRIES, 3);
    assert.equal(boundaryCanRetry(0), true);
    assert.equal(boundaryCanRetry(2), true);
    assert.equal(boundaryCanRetry(3), false);
    assert.equal(boundaryCanRetry(99), false);
    assert.equal(boundaryCanRetry(-1), true);
  });

  it("walks throw -> fallback -> retry -> recovered", () => {
    let s = initialBoundaryState("bounty-card:7");
    // getDerivedStateFromError sets the error; the fallback renders it.
    s = { ...s, error: new Error("render blew up") };
    assert.equal(boundaryCanRetry(s.attempts), true);
    s = nextBoundaryRetryState(s);
    assert.deepEqual(s, { error: null, attempts: 1, resetKey: "bounty-card:7" });
  });

  it("spends the budget across repeated failures", () => {
    let s = initialBoundaryState("claim:9");
    for (let i = 0; i < MAX_BOUNDARY_RETRIES; i++) {
      assert.equal(boundaryCanRetry(s.attempts), true);
      s = { ...nextBoundaryRetryState(s), error: new Error(`failure ${i}`) };
    }
    assert.equal(s.attempts, MAX_BOUNDARY_RETRIES);
    assert.equal(boundaryCanRetry(s.attempts), false);
  });
});

describe("reset derivation (route/bounty changes)", () => {
  it("clears failures and the budget when the key changes", () => {
    const failed = { error: new Error("x"), attempts: 3, resetKey: "claim:1" };
    assert.deepEqual(deriveBoundaryStateFromProps({ resetKey: "claim:2" }, failed), {
      error: null,
      attempts: 0,
      resetKey: "claim:2",
    });
  });

  it("keeps state when the key is unchanged", () => {
    const failed = { error: new Error("x"), attempts: 1, resetKey: "claim:1" };
    assert.equal(deriveBoundaryStateFromProps({ resetKey: "claim:1" }, failed), null);
  });

  it("keeps sibling boundary states independent", () => {
    const a = initialBoundaryState("bounty-card:1");
    const b = initialBoundaryState("bounty-card:2");
    a.error = new Error("card 1 crashed");
    assert.equal(b.error, null);
    assert.notEqual(a, b);
  });
});

describe("ErrorBoundary shell", () => {
  const src = read("components/ErrorBoundary.tsx");

  it("is a class boundary wired to the recovery policy", () => {
    assert.ok(src.includes("extends Component"), "class component (function components cannot catch)");
    assert.ok(src.includes("getDerivedStateFromError"), "catches render/lifecycle throws");
    assert.ok(src.includes("componentDidCatch"), "reports catches");
    assert.ok(src.includes("reportComponentError"), "reports through the redacting reporter");
    assert.ok(src.includes("deriveBoundaryStateFromProps"), "resets on key change");
    assert.ok(src.includes("nextBoundaryRetryState"), "retries through the budgeted transition");
    assert.ok(src.includes("boundaryCanRetry"), "honours the retry budget");
    assert.ok(src.includes("describeComponentError"), "fallback shows the redacted message");
  });

  it("renders an alert fallback with retry and reload recovery", () => {
    assert.ok(src.includes('role="alert"'), "fallback is announced");
    assert.ok(src.includes("Something went wrong loading"), "fallback names the section");
    assert.ok(src.includes("Retry {this.props.label}"), "fallback offers retry");
    assert.ok(src.includes("Reload page"), "exhausted budget offers reload");
    assert.ok(src.includes("window.location.reload()"), "reload path is real");
  });
});

describe("route-level error files", () => {
  it("error.tsx offers segment retry with redacted reporting", () => {
    const src = read("app/error.tsx");
    assert.ok(src.includes('"use client"'), "route errors render on the client");
    assert.ok(src.includes("reset()"), "Next segment reset is wired to recovery");
    assert.ok(src.includes("Try again"), "fallback offers retry");
    assert.ok(src.includes("reportComponentError"), "route catches are reported safely");
  });

  it("global-error.tsx renders its own shell for layout failures", () => {
    const src = read("app/global-error.tsx");
    assert.ok(src.includes("<html"), "global errors own the document shell");
    assert.ok(src.includes("reset()"), "root retry is wired");
    assert.ok(src.includes("reportComponentError"), "root catches are reported safely");
  });
});

describe("boundary placement and isolation", () => {
  it("isolates each marketplace card so one crash cannot take the list", () => {
    const src = read("components/Marketplace.tsx");
    assert.ok(src.includes('from "./ErrorBoundary"'), "marketplace imports the boundary");
    assert.ok(
      src.includes('<ErrorBoundary key={b.id} label="bounty card" resetKey={`bounty-card:${b.id}`}>'),
      "every card gets its own keyed boundary"
    );
    assert.ok(src.includes("<BountyCard bounty={b} />"), "cards render inside their boundary");
  });

  it("isolates bounty-detail sections per bounty", () => {
    const src = read("app/bounties/[id]/page.tsx");
    for (const [label, key] of [
      ["claim form", "claim:${bounty.id}"],
      ["settlement tracker", "settlement:${bounty.id}"],
      ["escrow status", "escrow:${bounty.id}"],
    ]) {
      assert.ok(src.includes(`label="${label}"`), `detail page isolates ${label}`);
      assert.ok(src.includes(`resetKey={\`${key}\`}`), `${label} resets on bounty change`);
    }
  });

  it("isolates the V3-only sponsor form", () => {
    const src = read("app/bounties/new/page.tsx");
    assert.ok(src.includes('label="sponsor form"'), "sponsor form is isolated");
    assert.ok(src.includes("<SponsorFormV3 />"), "V3 form renders inside its boundary");
    assert.ok(!src.includes("version"), "no version toggle remains");
  });

  it("isolates wallet controls so header failures cannot blank the page", () => {
    const src = read("app/layout.tsx");
    assert.ok(src.includes('label="wallet controls"'), "header wallet UI is isolated");
    assert.ok(src.includes("<WalletControls />"), "controls render inside their boundary");
  });

  it("protects post-claim success views from settlement-tracker crashes", () => {
    for (const f of ["components/ClaimForm.tsx", "components/ClaimFormV3.tsx"]) {
      const src = read(f);
      assert.ok(src.includes('label="settlement tracker"'), `${f} isolates its tracker`);
      assert.ok(src.includes("resetKey={`settlement:${bountyId}`}"), `${f} resets per bounty`);
    }
  });
});

describe("prior fixes remain intact", () => {
  it("keeps P1-9 wallet-init, P1-8 validation, P1-10 polling, and P1-11 pooling wired", () => {
    assert.ok(read("components/wallets.tsx").includes("walletInitReducer"), "P1-9 init machine still drives wallets");
    assert.ok(
      read("lib/near.ts").includes("interpretNearTxOutcome"),
      "P1-8 transaction validation still gates signAndSend"
    );
    assert.ok(
      read("components/SettlementPanel.tsx").includes("createSettlePoller"),
      "P1-10 polling still drives settlement"
    );
    assert.ok(read("components/Marketplace.tsx").includes("pool.run"), "P1-11 pool still bounds escrow reads");
  });
});
