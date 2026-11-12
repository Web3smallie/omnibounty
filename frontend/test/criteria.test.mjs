import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  buildNullifierKey,
  canonicalizeCriteria,
  checkCrossProofJoin,
  hashCriteriaDocument,
  matchEndpointUrl,
  parseAndValidateCriteria,
  strictParseJson,
  validateCriteria,
} from "../lib/criteria.mjs";

const GOLDEN = JSON.parse(readFileSync(new URL("../../testdata/v3/golden-hashes.json", import.meta.url)));
const validDir = new URL("../../testdata/v3/criteria-valid/", import.meta.url);
const invalidDir = new URL("../../testdata/v3/criteria-invalid/", import.meta.url);
describe("criteria fixtures", () => {
  it("all 8 valid scenarios validate and match golden hashes deterministically", () => {
    const names = ["simple-ci", "multi-check", "protected", "forbidden", "merged", "multi-winner", "weighted", "deadline-challenge"];
    assert.deepEqual(Object.keys(GOLDEN).sort(), names.sort());
    for (const name of names) {
      const text = readFileSync(new URL(`./${name}.json`, validDir), "utf8");
      const v = parseAndValidateCriteria(text);
      assert.deepEqual(v.errors, [], `${name} should validate`);
      assert.equal(v.ok, true);
      assert.equal(hashCriteriaDocument(text), GOLDEN[name], `${name} hash drift!`);
      assert.equal(hashCriteriaDocument(text), hashCriteriaDocument(text), `${name} non-deterministic`);
    }
  });

  it("all 10 invalid fixtures are rejected with a named reason", () => {
    const expected = {
      "bad-slug": /repo/,
      "leading-zero-amount": /canonical decimal/,
      "unknown-field": /unknown field/,
      "policy-mismatch": /single_winner/,
      "zero-amount": /> 0/,
      "glob-path": /glob/,
      "duplicate-keys": /duplicate key/,
      "null-value": /null/,
      "number-literal": /numeric literal/,
      "issue-repo-mismatch": /must equal criteria repo/,
    };
    for (const [name, re] of Object.entries(expected)) {
      const text = readFileSync(new URL(`./${name}.json`, invalidDir), "utf8");
      const v = parseAndValidateCriteria(text);
      assert.equal(v.ok, false, `${name} should be rejected`);
      assert.match(v.errors.join(" | "), re, `${name} reason`);
    }
  });
});

describe("canonical form", () => {
  it("matches hand-verified byte output on a tiny document", () => {
    // Key order is UTF-16 code-unit sort at every level; no whitespace.
    assert.equal(
      canonicalizeCriteria('{"z":1,"a":{"d":4,"c":3},"m":[3,2]}'.replace(/1|2|3|4/g, (d) => `"${d}"`)),
      '{"a":{"c":"3","d":"4"},"m":["3","2"],"z":"1"}'
    );
  });

  it("rejects duplicate keys including escaped-encoding variants", () => {
    assert.throws(() => strictParseJson('{"a":true,"a":false}'), /duplicate key/);
    assert.throws(() => strictParseJson('{"a":true,"\\u0061":false}'), /duplicate key/);
    assert.throws(() => strictParseJson('{"o":{"x":true,"x":false}}'), /duplicate key/);
    assert.doesNotThrow(() => strictParseJson('{"a":"x","b":{"a":"y"}}'));
  });

  it("rejects numbers and nulls, allows booleans", () => {
    for (const bad of ['{"a":1}', '{"a":-0}', '{"a":1.5}', '{"a":1e3}', '{"a":null}', '[null]', '{"a":[1]}']) {
      assert.throws(() => strictParseJson(bad), /numeric literal|null/, bad);
    }
    assert.doesNotThrow(() => strictParseJson('{"a":true,"b":false,"c":"null","d":"123"}'));
  });

  it("any byte change alters the golden hash (modification evidence)", () => {
    const text = readFileSync(new URL("./simple-ci.json", validDir), "utf8");
    const tampered = text.replace("cleanup", "cleanUp");
    assert.notEqual(hashCriteriaDocument(tampered), GOLDEN["simple-ci"]);
  });
});

describe("cross-proof join", () => {
  // Ground truth SHAs executed live in Phase 1 (react#38132).
  const HEAD = "5621284babc44ced80598504e7aae22f75fb32c1";
  const REPO = "react/react";
  const pr = {
    kind: "pr",
    url: `https://api.github.com/repos/${REPO}/pulls/38132`,
    extracted: { head_sha: HEAD },
  };
  const check = {
    kind: "check_run",
    url: `https://api.github.com/repos/${REPO}/check-runs/128113730680`,
    extracted: { head_sha: HEAD },
  };
  const files = {
    kind: "files",
    url: `https://api.github.com/repos/${REPO}/pulls/38132/files?per_page=100`,
    extracted: {},
  };

  it("joins PR + check + files proofs on one head and PR number", () => {
    const r = checkCrossProofJoin([pr, check, files], REPO);
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
    assert.equal(r.head, HEAD);
    assert.equal(r.prNumber, "38132");
  });

  it("rejects divergent heads, wrong repos, and missing anchors", () => {
    const badHead = { ...check, extracted: { head_sha: "00" + HEAD.slice(2) } };
    assert.equal(checkCrossProofJoin([pr, badHead], REPO).ok, false);
    assert.match(checkCrossProofJoin([pr, badHead], REPO).errors.join(" "), /diverge/);
    const wrongRepo = { ...pr, url: "https://api.github.com/repos/o/r/pulls/38132" };
    assert.equal(checkCrossProofJoin([wrongRepo, check], REPO).ok, false);
    assert.equal(checkCrossProofJoin([check, files], REPO).ok, false); // no PR anchor
    assert.equal(checkCrossProofJoin([], REPO).ok, false);
    assert.equal(checkCrossProofJoin([{ kind: "nope", url: "x", extracted: {} }], REPO).ok, false);
  });

  it("matches endpoint URL templates strictly", () => {
    assert.deepEqual(matchEndpointUrl("pr", `https://api.github.com/repos/${REPO}/pulls/7`, REPO), { prNumber: "7" });
    assert.equal(matchEndpointUrl("pr", `https://api.github.com/repos/${REPO}/pulls/0`, REPO), null);
    assert.equal(matchEndpointUrl("pr", `http://api.github.com/repos/${REPO}/pulls/7`, REPO), null);
    assert.deepEqual(
      matchEndpointUrl("contents", `https://api.github.com/repos/${REPO}/contents/a/b.yml?ref=${HEAD}`, REPO),
      { path: "a/b.yml", ref: HEAD }
    );
    assert.equal(matchEndpointUrl("contents", `https://api.github.com/repos/${REPO}/contents/a/b.yml`, REPO), null);
    assert.equal(matchEndpointUrl("unknown", "https://x", REPO), null);
  });
});

describe("nullifier scoping", () => {
  const base = {
    bountyId: 7,
    recipient: "0xcb234c6fc8abe3eb38e31eec6288b431e313d9b9",
    evidenceType: 1,
    identifier: "0x3373d41d8bbf27c42c3d2f0739ea987f042ae57a626720a42bab58a8adc979d6",
  };

  it("pins the golden nullifier key (cross-language anchor)", () => {
    assert.equal(buildNullifierKey(base), "0x98da0b4df720098e6ab4cd704ffd386ba5356637410a03623678ea525b83df6e");
  });

  it("scopes differ per field and reject malformed inputs", () => {
    const k1 = buildNullifierKey(base);
    assert.notEqual(buildNullifierKey({ ...base, bountyId: 8 }), k1);
    assert.notEqual(buildNullifierKey({ ...base, evidenceType: 2 }), k1);
    assert.notEqual(buildNullifierKey({ ...base, recipient: "0x0000000000000000000000000000000000000001" }), k1);
    assert.throws(() => buildNullifierKey({ ...base, bountyId: -1 }), /u64/);
    assert.throws(() => buildNullifierKey({ ...base, recipient: "0x1234" }), /20-byte/);
    assert.throws(() => buildNullifierKey({ ...base, evidenceType: 0 }), /u8/);
    assert.throws(() => buildNullifierKey({ ...base, identifier: "0x1234" }), /32-byte/);
  });
});

describe("validator edge cases", () => {
  const minimal = () => ({
    schema: "omnibounty/criteria",
    version: "1",
    title: "t",
    description: "d",
    repo: "o/r",
    merge_policy: "ci_verified",
    allow_forks: true,
    identity_policy: "open",
    policy: "single_winner",
    slots: [{ amount: "1" }],
    unfilled: "refund_sponsor",
    deadline: "0",
    challenge_window_sec: "0",
    evidence_max_age_sec: "604800",
  });

  it("accepts the minimal document and enforces bounds", () => {
    assert.equal(validateCriteria(minimal()).ok, true);
    assert.equal(validateCriteria({ ...minimal(), evidence_max_age_sec: "604801" }).ok, false);
    assert.equal(validateCriteria({ ...minimal(), evidence_max_age_sec: "0" }).ok, false);
    assert.equal(validateCriteria({ ...minimal(), deadline: "18446744073709551616" }).ok, false);
    assert.equal(validateCriteria({ ...minimal(), deadline: "18446744073709551615" }).ok, true);
  });

  it("enforces path rules", () => {
    const withFiles = (files) => validateCriteria({ ...minimal(), files });
    assert.equal(withFiles({ allowed_paths: ["src/"] }).ok, true);
    assert.equal(withFiles({ allowed_paths: ["/src"] }).ok, false);
    assert.equal(withFiles({ allowed_paths: ["a//b"] }).ok, false);
    assert.equal(withFiles({ allowed_paths: ["../x"] }).ok, false);
    assert.equal(withFiles({ allowed_paths: ["a", "a"] }).ok, false);
    assert.equal(withFiles({}).ok, false);
    assert.equal(withFiles({ protected: [{ path: "a/b.yml", blob_sha: "8d0a698c24f00b713f6c0e44f2951e4b4ac104a9" }] }).ok, true);
    assert.equal(withFiles({ protected: [{ path: "a/", blob_sha: "8d0a698c24f00b713f6c0e44f2951e4b4ac104a9" }] }).ok, false);
  });
});
