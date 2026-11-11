import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isHexString,
  isEvmAddress,
  isRepoSlug,
  buildPrUrl,
  validateProofShape,
  validateBountyInput,
  parseUsdcToBaseUnits,
  validateDeadline,
  validateSponsorForm,
  extractProofFacts,
} from "../lib/validation.mjs";

const fx = JSON.parse(readFileSync(new URL("../../testdata/eip712.json", import.meta.url)));
const reclaim = JSON.parse(readFileSync(new URL("../../testdata/reclaim.json", import.meta.url)));
const e2e = JSON.parse(readFileSync(new URL("../../testdata/e2e_claim.json", import.meta.url)));

function futureLocalInput() {
  const d = new Date(Date.now() + 30 * 86400 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

describe("validation", () => {
  it("hex and address checks", () => {
    assert.equal(isHexString("0x" + "ab".repeat(32), 32), true);
    assert.equal(isHexString("ab".repeat(32), 32), true);
    assert.equal(isHexString("0xab", 32), false);
    assert.equal(isHexString("0x" + "zz".repeat(32), 32), false);
    assert.equal(isEvmAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"), true);
    assert.equal(isEvmAddress("0x1234"), false);
  });

  it("repo slugs and PR urls", () => {
    assert.equal(isRepoSlug("octocat/Hello-World"), true);
    assert.equal(isRepoSlug("no-slash"), false);
    assert.equal(isRepoSlug("a/b/c"), false);
    assert.equal(buildPrUrl("o/r", 7), "https://api.github.com/repos/o/r/pulls/7");
  });

  it("accepts the real spike proof in both shapes", () => {
    const spike = reclaim.spike;
    const onchain = {
      claimInfo: spike.claimInfo,
      signedClaim: { claim: spike.claim, signatures: spike.signatures },
    };
    const r1 = validateProofShape(onchain);
    assert.equal(r1.ok, true);
    const zkfetch = { claimData: { ...spike.claim, provider: "http", parameters: spike.claimInfo.parameters, context: spike.claimInfo.context }, signatures: spike.signatures };
    const r2 = validateProofShape(zkfetch);
    assert.equal(r2.ok, true);
    assert.deepEqual(r2.normalized, onchain);
  });

  it("rejects malformed proofs", () => {
    assert.equal(validateProofShape(null).ok, false);
    assert.equal(validateProofShape({}).ok, false);
    assert.equal(validateProofShape({ claimInfo: {}, signedClaim: { claim: {}, signatures: [] } }).ok, false);
    const bad = {
      claimInfo: { provider: "http", parameters: "{}", context: "{}" },
      signedClaim: { claim: { identifier: "0x1234", owner: "0x1234", epoch: 1, timestampS: 1 }, signatures: ["0x1234"] },
    };
    const r = validateProofShape(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 3);
  });

  it("validates bounty input", () => {
    assert.equal(validateBountyInput({ repo: "o/r", prNumber: 1, token: fx.vouchers[0].value.token, amount: "100" }).ok, true);
    const bad = validateBountyInput({ repo: "o", prNumber: 0, token: "0x1", amount: "-5" });
    assert.equal(bad.ok, false);
    assert.equal(bad.errors.length, 4);
  });

  it("parses human USDC amounts into base units", () => {
    assert.deepEqual(parseUsdcToBaseUnits("1"), { ok: true, errors: [], baseUnits: "1000000" });
    assert.equal(parseUsdcToBaseUnits("25.50").baseUnits, "25500000");
    assert.equal(parseUsdcToBaseUnits("0.000001").baseUnits, "1");
    assert.equal(parseUsdcToBaseUnits(" 2.5 ").baseUnits, "2500000");
    assert.equal(parseUsdcToBaseUnits(3).baseUnits, "3000000");
  });

  it("rejects bad USDC amounts", () => {
    for (const bad of ["", "0", "0.00", "-1", "1e3", "1,000", "abc", "1.0000001", "0x10", ".5"]) {
      assert.equal(parseUsdcToBaseUnits(bad).ok, false, JSON.stringify(bad));
    }
    assert.ok(parseUsdcToBaseUnits("1.0000001").errors.join().includes("6 decimals"));
  });

  it("validates deadlines (empty = none, otherwise future local time)", () => {
    assert.deepEqual(validateDeadline(""), { ok: true, errors: [], expiry: 0 });
    assert.deepEqual(validateDeadline(null), { ok: true, errors: [], expiry: 0 });
    const good = validateDeadline(futureLocalInput());
    assert.equal(good.ok, true);
    assert.ok(good.expiry > Math.floor(Date.now() / 1000));
    assert.equal(validateDeadline("2000-01-01T00:00").ok, false);
    assert.equal(validateDeadline("not-a-date").ok, false);
    assert.equal(validateDeadline("2026-13-99T99:99").ok, false);
  });

  it("validates the whole sponsor form into create_bounty params", () => {
    const good = validateSponsorForm({
      bountyId: "5",
      repo: "octocat/Hello-World",
      prNumber: "7",
      amountUsdc: "25.50",
      deadline: "",
    });
    assert.equal(good.ok, true);
    assert.deepEqual(good.params, {
      bounty_id: 5,
      repo: "octocat/Hello-World",
      pr_number: 7,
      amount: "25500000",
      expiry: 0,
    });
    const bad = validateSponsorForm({
      bountyId: "-1",
      repo: "no-slash",
      prNumber: "0",
      amountUsdc: "0",
      deadline: "2000-01-01T00:00",
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.errors.length, 5);
  });

  it("extracts claim facts from a normalized proof", () => {
    const shape = validateProofShape(e2e.proof);
    assert.equal(shape.ok, true);
    const facts = extractProofFacts(shape.normalized);
    assert.equal(facts.ok, true);
    assert.deepEqual(facts.facts, {
      merged: "true",
      author: "octocat",
      repo: "octocat/Hello-World",
      number: "7",
    });
  });

  it("refuses to extract facts without extractedParameters", () => {
    assert.equal(extractProofFacts(null).ok, false);
    assert.equal(extractProofFacts({ claimInfo: { context: "not json" } }).ok, false);
    assert.equal(extractProofFacts({ claimInfo: { context: "{}" } }).ok, false);
    const missing = extractProofFacts({ claimInfo: { context: JSON.stringify({ extractedParameters: { merged: "true" } }) } });
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.length >= 3);
  });
});
