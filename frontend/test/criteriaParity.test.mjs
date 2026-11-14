import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashCriteriaDocument, parseAndValidateCriteria } from "../lib/criteria.mjs";
import { verifyCriteriaText } from "../lib/criteriaSource.mjs";
import { validateSponsorV3Form } from "../lib/sponsorV3.mjs";

// P2-3: criteria.mjs is production code reached through criteriaSource.mjs
// (claim/verify) and sponsorV3.mjs (sponsor/create), not a test-only
// utility. These tests pin that agreement: every valid fixture is accepted
// by all three layers with the same golden hash, every invalid fixture is
// rejected by all three, and the production imports keep pointing at
// lib/criteria.mjs (no silent fork).
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const GOLDEN = JSON.parse(read("testdata/v3/golden-hashes.json"));
const VALID = [
  "simple-ci",
  "multi-check",
  "protected",
  "forbidden",
  "merged",
  "multi-winner",
  "weighted",
  "deadline-challenge",
];
const INVALID = [
  "bad-slug",
  "leading-zero-amount",
  "unknown-field",
  "policy-mismatch",
  "zero-amount",
  "glob-path",
  "duplicate-keys",
  "null-value",
  "number-literal",
  "issue-repo-mismatch",
];

describe("criteria production/test agreement (P2-3)", () => {
  it("accepts every valid fixture in all three layers with the golden hash", () => {
    assert.deepEqual(Object.keys(GOLDEN).sort(), [...VALID].sort());
    for (const name of VALID) {
      const text = read(`testdata/v3/criteria-valid/${name}.json`);
      assert.equal(parseAndValidateCriteria(text).ok, true, `${name}: criteria.mjs`);
      assert.equal(hashCriteriaDocument(text), GOLDEN[name], `${name}: hash drift`);
      const v = verifyCriteriaText(text, GOLDEN[name]);
      assert.equal(v.ok, true, `${name}: criteriaSource (${v.reason ?? ""} ${v.detail ?? ""})`);
      assert.equal(v.hash, GOLDEN[name], `${name}: criteriaSource hash`);
      const s = validateSponsorV3Form({ bountyId: 7, criteriaText: text });
      assert.equal(s.ok, true, `${name}: sponsorV3 (${s.errors.join("; ")})`);
      assert.equal(s.params.hash, GOLDEN[name], `${name}: sponsorV3 hash`);
    }
  });

  it("rejects every invalid fixture in all three layers", () => {
    for (const name of INVALID) {
      const text = read(`testdata/v3/criteria-invalid/${name}.json`);
      assert.equal(parseAndValidateCriteria(text).ok, false, `${name}: criteria.mjs`);
      assert.equal(verifyCriteriaText(text, GOLDEN["simple-ci"]).ok, false, `${name}: criteriaSource`);
      assert.equal(validateSponsorV3Form({ bountyId: 7, criteriaText: text }).ok, false, `${name}: sponsorV3`);
    }
  });

  it("keeps production criteria logic imported from lib/criteria.mjs (no fork)", () => {
    for (const f of ["frontend/lib/criteriaSource.mjs", "frontend/lib/sponsorV3.mjs"]) {
      assert.ok(read(f).includes('from "./criteria.mjs"'), `${f} must import lib/criteria.mjs`);
    }
  });

  it("leaves join/nullifier helpers frontend-test-only (contract owns production)", () => {
    // matchEndpointUrl, checkCrossProofJoin, buildNullifierKey and
    // EVIDENCE_TYPE mirror contracts/near-v3 (rules.rs/reclaim.rs); the
    // frontend must not grow a second production caller. Any future
    // production use must update this pin deliberately.
    const files = [];
    const walk = (dir) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else files.push(rel);
      }
    };
    walk("frontend/lib");
    walk("frontend/components");
    walk("frontend/app");
    const needles = ["matchEndpointUrl", "checkCrossProofJoin", "buildNullifierKey", "EVIDENCE_TYPE"];
    for (const f of files) {
      if (f === "frontend/lib/criteria.mjs") continue;
      if (!/\.(mjs|ts|tsx)$/.test(f)) continue;
      const src = read(f);
      for (const n of needles) assert.ok(!src.includes(n), `${f} must not reference ${n}`);
    }
  });
});
