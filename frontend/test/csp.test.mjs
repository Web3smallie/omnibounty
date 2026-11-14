import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// P2-6: CSP header pins. The policy lives in next.config.ts headers() and
// is REPORT-ONLY (see the rationale there). These tests pin its presence,
// its inventoried directives, and the properties that must hold for the
// policy to stay honest: no wildcards, no eval/inline escape hatches, no
// secrets, and coverage of the configured RPC origins.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const nextConfig = read("frontend/next.config.ts");

function policyValue() {
  const m = nextConfig.match(/const REPORT_ONLY_CSP = \[([\s\S]*?)\]\.join\("; "\)/);
  assert.ok(m, "next.config.ts must define REPORT_ONLY_CSP");
  return m[1];
}

function directives() {
  const out = {};
  for (const m of policyValue().matchAll(/"([a-z-]+)( [^"]*)?"/g)) {
    out[m[1]] = (m[2] ?? "").trim();
  }
  return out;
}

describe("CSP header presence (P2-6)", () => {
  it("serves a report-only policy on every route", () => {
    assert.ok(nextConfig.includes('key: "Content-Security-Policy-Report-Only"'), "report-only header key present");
    assert.ok(nextConfig.includes('source: "/:path*"'), "header applies to every route");
  });

  it("does not claim enforcement", () => {
    assert.ok(!/key:\s*"Content-Security-Policy"/.test(nextConfig), "no enforcing CSP header may be present");
  });

  it("declares every required directive", () => {
    const d = directives();
    for (const name of [
      "default-src",
      "script-src",
      "style-src",
      "connect-src",
      "img-src",
      "font-src",
      "frame-src",
      "frame-ancestors",
      "object-src",
      "base-uri",
      "form-action",
      "upgrade-insecure-requests",
    ]) {
      assert.ok(name in d, `policy must declare ${name}`);
    }
  });
});

describe("CSP origin inventory (P2-6)", () => {
  it("covers the configured NEAR and Base RPC origins", () => {
    const configSrc = read("frontend/lib/config.ts");
    const rpcDefaults = [...configSrc.matchAll(/env\("NEXT_PUBLIC_(?:NEAR|BASE)_RPC_URL",\s*"(https:\/\/[^"]+)"/g)].map(
      (m) => m[1]
    );
    assert.deepEqual(rpcDefaults, ["https://rpc.testnet.near.org", "https://sepolia.base.org"]);
    const connect = directives()["connect-src"];
    assert.ok(connect.includes("'self'"), "connect-src keeps same-origin criteria fetches");
    for (const origin of rpcDefaults) {
      assert.ok(connect.includes(origin), `connect-src must cover configured RPC ${origin}`);
    }
  });

  it("covers the configured NEAR indexer origin", () => {
    const configSrc = read("frontend/lib/config.ts");
    const m = configSrc.match(/NEAR_INDEXER_URLS = \{[\s\S]*?testnet: "(https:\/\/[^"]+)"/);
    assert.ok(m, "config.ts must pin a testnet indexer default");
    assert.equal(m[1], "https://api-testnet.nearblocks.io");
    const connect = directives()["connect-src"];
    assert.ok(connect.includes(m[1]), `connect-src must cover configured indexer ${m[1]}`);
  });

  it("covers wallet integration origins precisely", () => {
    const d = directives();
    assert.ok(d["connect-src"].includes("https://h4n.app"), "HERE proxy API covered for non-injected flows");
    assert.equal(d["frame-src"], "https://my.herewallet.app", "only the HERE widget connector may frame");
    assert.ok(d["style-src"].includes("https://fonts.googleapis.com"), "wallet modal font CSS covered");
    assert.ok(d["font-src"].includes("https://fonts.gstatic.com"), "wallet modal font files covered");
  });

  it("needs no Reclaim origin (browser never fetches)", () => {
    const reclaim = read("frontend/lib/reclaim.mjs");
    assert.ok(!reclaim.includes("fetch("), "reclaim.mjs must stay fetch-free");
    assert.ok(!reclaim.includes("WebSocket") && !reclaim.includes("XMLHttpRequest"), "no other browser transports");
    const d = directives();
    assert.ok(!d["connect-src"].includes("github"), "no GitHub fetch origin (prove scripts are node-only)");
    assert.ok(!d["connect-src"].includes("reclaim"), "no Reclaim fetch origin");
  });

  it("allows no wildcard or arbitrary external origins", () => {
    assert.ok(!policyValue().includes("*"), "policy must contain no wildcards");
    for (const host of ["https://fonts.googleapis.com", "https://fonts.gstatic.com", "https://h4n.app"]) {
      assert.ok(policyValue().includes(host), `expected precise origin ${host}`);
    }
  });
});

describe("CSP strictness (P2-6)", () => {
  it("grants no unsafe-eval anywhere", () => {
    assert.ok(!policyValue().includes("unsafe-eval"), "no unsafe-eval (nothing needs it)");
  });

  it("grants no unsafe-inline (observe-first; enforcement is a follow-up)", () => {
    assert.ok(!policyValue().includes("unsafe-inline"), "no unsafe-inline while report-only");
  });

  it("restricts framing, objects, and base", () => {
    const d = directives();
    assert.equal(d["frame-ancestors"], "'none'", "app must never be embedded");
    assert.equal(d["object-src"], "'none'", "no plugin content");
    assert.equal(d["base-uri"], "'self'", "base tag hijack blocked");
    assert.equal(d["form-action"], "'self'", "no external form posts");
  });

  it("exposes no secrets or deployment config", () => {
    const policy = policyValue();
    const configSrc = read("frontend/lib/config.ts");
    // Contract, escrow, and token values must never leak into headers.
    const sensitive = [...configSrc.matchAll(/env\("NEXT_PUBLIC_(?:CONTRACT_ID|ESCROW_ADDRESS|USDC_ADDRESS)",\s*"([^"]+)"/g)].map(
      (m) => m[1]
    );
    assert.ok(sensitive.length === 3, "expected three sensitive config defaults");
    for (const value of sensitive) {
      assert.ok(!policy.includes(value), `policy must not contain ${value}`);
    }
    const forbidden = ["RECLAIM", "SECRET", "PRIVATE", "MNEMONIC", "PASSWORD", "TOKEN"];
    for (const word of forbidden) {
      assert.ok(!policy.toUpperCase().includes(word), `policy must not mention ${word}`);
    }
  });

  it("keeps application behavior files untouched by the policy", () => {
    // The policy is headers-only: config, RPC clients, and wallet setup
    // must not have been reshaped to fit it.
    assert.ok(read("frontend/lib/config.ts").includes("https://rpc.testnet.near.org"), "NEAR default intact");
    assert.ok(read("frontend/lib/config.ts").includes("https://sepolia.base.org"), "Base default intact");
    assert.ok(read("frontend/lib/near.ts").includes("setupMyNearWallet"), "wallet modules intact");
  });
});
