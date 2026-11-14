import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, loadCriteriaDoc, checkFundingReady } from "../sponsor_bounty.mjs";

// Pure paths only (arg parsing, criteria gating, funding cross-check with
// injected views). Live submission paths are exercised by hand against
// testnet, never by automation.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CRITERIA = join(ROOT, "testdata/v3/criteria-valid/simple-ci.json");
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

describe("sponsor_bounty parseArgs", () => {
  it("accepts create and mark-funded forms", () => {
    assert.deepEqual(parseArgs(["create", "--bounty-id", "7", "--token", TOKEN, "--criteria", CRITERIA, "--dry-run"]), {
      action: "create", bountyId: 7, token: TOKEN, criteriaPath: CRITERIA, submit: false,
    });
    const mf = parseArgs(["mark-funded", "--bounty-id", "9", "--submit"]);
    assert.equal(mf.action, "mark-funded");
    assert.equal(mf.submit, true);
  });

  it("refuses bad actions, missing mode, and malformed inputs", () => {
    assert.throws(() => parseArgs(["delete", "--bounty-id", "7", "--dry-run"]), /create\|mark-funded/);
    assert.throws(() => parseArgs(["create", "--bounty-id", "7", "--token", TOKEN, "--criteria", CRITERIA]), /--dry-run or --submit/);
    assert.throws(() => parseArgs(["create", "--bounty-id", "7", "--token", TOKEN, "--criteria", CRITERIA, "--dry-run", "--submit"]), /exactly one/);
    assert.throws(() => parseArgs(["create", "--bounty-id", "nope", "--token", TOKEN, "--criteria", CRITERIA, "--dry-run"]), /invalid --bounty-id/);
    assert.throws(() => parseArgs(["create", "--bounty-id", "7", "--token", "xyz", "--criteria", CRITERIA, "--dry-run"]), /invalid --token/);
    assert.throws(() => parseArgs(["create", "--bounty-id", "7", "--token", TOKEN, "--dry-run"]), /--criteria/);
    assert.throws(() => parseArgs(["mark-funded", "--bounty-id", "7", "--dry-run", "--force"]), /unknown flag/);
  });
});

describe("sponsor_bounty loadCriteriaDoc", () => {
  it("validates through the production criteria gate and reports the hash", () => {
    const doc = loadCriteriaDoc(CRITERIA);
    assert.equal(doc.hash, "0x499dcdccb8acfafe8d71e42ac91ab86cacbac30bf2b33c521b1bd47a31641d10");
    assert.ok(doc.canonical.includes('"schema":"omnibounty/criteria"'));
  });

  it("rejects missing and invalid criteria before any network use", () => {
    assert.throws(() => loadCriteriaDoc(join(ROOT, "testdata/nope.json")), /criteria file not found/);
    assert.throws(
      () => loadCriteriaDoc(join(ROOT, "testdata/v3/criteria-invalid/zero-amount.json")),
      /criteria invalid/
    );
  });
});

describe("sponsor_bounty checkFundingReady", () => {
  const NEAR = { total_amount: "1000000", funded: false, sponsor: "s.testnet" };
  const escrowView = (funded, totalFunded) => ({ funded, totalFunded: { toString: () => totalFunded } });

  it("reports READY only when the escrow holds the NEAR-committed total", async () => {
    const r = await checkFundingReady(7, { nearView: NEAR, escrowView: escrowView(true, "1000000") });
    assert.equal(r.ready, true);
    assert.deepEqual(r.reasons, []);
  });

  it("reports NOT READY with reasons for every mismatch", async () => {
    const unfunded = await checkFundingReady(7, { nearView: NEAR, escrowView: escrowView(false, "1000000") });
    assert.equal(unfunded.ready, false);
    assert.ok(unfunded.reasons.some((r) => r.includes("not funded")));

    const wrongTotal = await checkFundingReady(7, { nearView: NEAR, escrowView: escrowView(true, "5") });
    assert.equal(wrongTotal.ready, false);
    assert.ok(wrongTotal.reasons.some((r) => r.includes("!=")));

    const already = await checkFundingReady(7, {
      nearView: { ...NEAR, funded: true }, escrowView: escrowView(true, "1000000"),
    });
    assert.equal(already.ready, false);
    assert.ok(already.reasons.some((r) => r.includes("already marked funded")));

    const missing = await checkFundingReady(7, { nearView: null, escrowView: escrowView(true, "1000000") });
    assert.equal(missing.ready, false);
    assert.ok(missing.reasons.some((r) => r.includes("no NEAR bounty")));
  });
});
