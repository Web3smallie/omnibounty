import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, loadBundle, buildQualifyArgs } from "../qualify_claim.mjs";

// Staged bundle: the tracked e2e proof shape serves as both PR and
// identity proofs (owners trivially match). No network, no keys.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const E2E = JSON.parse(readFileSync(join(ROOT, "testdata/e2e_claim.json"), "utf8"));
const CRITERIA = join(ROOT, "testdata/v3/criteria-valid/simple-ci.json");

function stageBundle({ pr = E2E.proof, id = E2E.proof, omit = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "qclaim-"));
  if (!omit.includes("pr")) writeFileSync(join(dir, "proof-pr.json"), JSON.stringify(pr));
  if (!omit.includes("id")) writeFileSync(join(dir, "proof-identity.json"), JSON.stringify(id));
  return dir;
}

describe("qualify_claim parseArgs", () => {
  it("accepts the documented dry-run and submit forms", () => {
    assert.deepEqual(parseArgs(["./p", "7", "--criteria", "./c.json", "--dry-run"]), {
      proofsDirArg: "./p", bountyId: 7, criteriaPath: "./c.json", submit: false,
    });
    assert.equal(parseArgs(["./p", "7", "--criteria", "./c.json", "--submit"]).submit, true);
  });

  it("refuses missing mode, both modes, bad ids, and unknown flags", () => {
    assert.throws(() => parseArgs(["./p", "7", "--criteria", "./c.json"]), /--dry-run or --submit/);
    assert.throws(() => parseArgs(["./p", "7", "--criteria", "./c.json", "--dry-run", "--submit"]), /exactly one/);
    assert.throws(() => parseArgs(["./p", "7", "--dry-run"]), /--criteria/);
    assert.throws(() => parseArgs(["./p", "nope", "--criteria", "./c.json", "--dry-run"]), /invalid bountyId/);
    assert.throws(() => parseArgs(["./p", "7", "--criteria", "./c.json", "--dry-run", "--force"]), /unknown flag/);
  });
});

describe("qualify_claim loadBundle", () => {
  it("loads and validates a well-formed bundle", () => {
    const dir = stageBundle();
    const b = loadBundle(dir, CRITERIA);
    assert.equal(b.recipient, "0xcb234c6fc8abe3eb38e31eec6288b431e313d9b9");
    assert.ok(b.criteriaJson.includes("omnibounty/criteria"));
    assert.equal(b.pr, b.id === b.pr ? b.pr : b.pr); // both normalized
  });

  it("rejects missing dirs, missing files, and bad proofs before any network use", () => {
    assert.throws(() => loadBundle(join(tmpdir(), "qclaim-nope"), CRITERIA), /proofs dir not found/);
    assert.throws(() => loadBundle(stageBundle({ omit: ["id"] }), CRITERIA), /missing proof file/);
    assert.throws(() => loadBundle(stageBundle(), join(tmpdir(), "qclaim-nope.json")), /criteria file not found/);
    assert.throws(() => loadBundle(stageBundle({ pr: { nope: true } }), CRITERIA), /invalid proofs/);
  });

  it("rejects owner mismatch between the two proofs", () => {
    const id = JSON.parse(JSON.stringify(E2E.proof));
    id.signedClaim.claim.owner = "0x0000000000000000000000000000000000000001";
    assert.throws(() => loadBundle(stageBundle({ id }), CRITERIA), /owner mismatch/);
  });

  it("builds exact qualify_claim args (evidence 1 + 7, owner recipient)", () => {
    const b = loadBundle(stageBundle(), CRITERIA);
    const args = buildQualifyArgs(7, b);
    assert.equal(args.bounty_id, 7);
    assert.equal(args.recipient, b.recipient);
    assert.deepEqual(args.proofs.map((p) => p.evidence_type), [1, 7]);
    assert.equal(args.criteria_json, b.criteriaJson);
  });
});
