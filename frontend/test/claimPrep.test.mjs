import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ENV_LOCAL_TEMPLATE,
  assembleClaimBundle,
  buildProveCommand,
  checkWizardBinding,
  parsePrUrl,
  splitPastedProofs,
  validatePastedIdentityProof,
  validatePastedPrProof,
} from "../lib/claimPrep.mjs";
import { planClaimSubmission } from "../lib/settlement.mjs";

// Guided claim preparation: PR-link parsing, per-proof paste validation,
// bundle-output splitting, authorship binding, and automatic bundle
// assembly. Fixture style mirrors test/settlement.test.mjs (raw zkFetch
// shape + normalized on-chain shape); no network, no secrets.
const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const SIG = "0x" + "ab".repeat(65);
const ID32 = "0x" + "cd".repeat(32);
const PR_EX = {
  merged: "true", author: "octocat", repo: "o/r", number: "7",
  head_sha: "a".repeat(40), author_id: "10001", pr_created: "2026-10-26T19:00:00Z",
};
const ID_EX = { id_login: "octocat", id_num: "10001" };
const rawProof = (extracted, owner = OWNER) => ({
  claimData: {
    provider: "http", parameters: "{\"url\":\"https://api.github.com\"}",
    context: JSON.stringify({ extractedParameters: extracted }),
    identifier: ID32, owner, epoch: 1, timestampS: 100,
  },
  signatures: [SIG],
});
const onchainProof = (extracted, owner = OWNER) => ({
  claimInfo: {
    provider: "http", parameters: "{\"url\":\"https://api.github.com\"}",
    context: JSON.stringify({ extractedParameters: extracted }),
  },
  signedClaim: {
    claim: { identifier: ID32, owner, epoch: 1, timestampS: 100 },
    signatures: [SIG],
  },
});
const EXPECTED = { repo: "o/r", prNumber: "7" };

describe("parsePrUrl", () => {
  it("parses full PR URLs and the short owner/repo#n form", () => {
    assert.deepEqual(parsePrUrl("https://github.com/o/r/pull/7"), { ok: true, errors: [], repo: "o/r", prNumber: "7" });
    assert.deepEqual(parsePrUrl("o/r#7"), { ok: true, errors: [], repo: "o/r", prNumber: "7" });
    assert.deepEqual(parsePrUrl("https://github.com/o/r/pull/7/files?x=1").repo, "o/r");
    assert.deepEqual(parsePrUrl("https://github.com/o/r/pull/7/").prNumber, "7");
  });

  it("canonicalizes the PR number", () => {
    assert.equal(parsePrUrl("o/r#007").prNumber, "7");
  });

  it("rejects empty, non-GitHub, and non-PR input", () => {
    for (const bad of ["", "   ", "o/r", "o/r/pull", "https://github.com/o/r", "https://gitlab.com/o/r/pull/7", "https://github.com/o/r/issues/7", "o/r#0", "o/r#x", null, 42]) {
      const r = parsePrUrl(bad);
      assert.equal(r.ok, false, `must reject ${JSON.stringify(bad)}`);
      assert.ok(r.errors.length > 0);
    }
  });
});

describe("validatePastedPrProof", () => {
  it("accepts raw and normalized proofs bound to the PR", () => {
    for (const proof of [rawProof(PR_EX), onchainProof(PR_EX)]) {
      const r = validatePastedPrProof(JSON.stringify(proof), EXPECTED);
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      assert.deepEqual(r.facts, { merged: "true", author: "octocat", repo: "o/r", number: "7", owner: OWNER });
      assert.equal(r.proof.signedClaim.claim.owner, OWNER);
      assert.ok(!("claimData" in r.proof), "returned proof is normalized");
    }
  });

  it("rejects non-JSON, wrong repo/number, and unmerged PRs", () => {
    assert.equal(validatePastedPrProof("", EXPECTED).ok, false);
    assert.equal(validatePastedPrProof("{oops", EXPECTED).ok, false);
    assert.equal(validatePastedPrProof(JSON.stringify(rawProof({ ...PR_EX, repo: "o/other" })), EXPECTED).ok, false);
    assert.equal(validatePastedPrProof(JSON.stringify(rawProof({ ...PR_EX, number: "8" })), EXPECTED).ok, false);
    const unmerged = validatePastedPrProof(JSON.stringify(rawProof({ ...PR_EX, merged: "false" })), EXPECTED);
    assert.equal(unmerged.ok, false);
    assert.ok(unmerged.errors.join(" ").includes("merged"));
    assert.equal(validatePastedPrProof(JSON.stringify({ nope: true }), EXPECTED).ok, false);
  });
});

describe("validatePastedIdentityProof", () => {
  it("accepts raw and normalized identity proofs", () => {
    for (const proof of [rawProof(ID_EX), onchainProof(ID_EX)]) {
      const r = validatePastedIdentityProof(JSON.stringify(proof));
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      assert.deepEqual(r.facts, { id_login: "octocat", id_num: "10001", owner: OWNER });
    }
  });

  it("rejects non-JSON and login-less proofs", () => {
    assert.equal(validatePastedIdentityProof("", EXPECTED).ok, false);
    assert.equal(validatePastedIdentityProof("{oops").ok, false);
    assert.equal(validatePastedIdentityProof(JSON.stringify(rawProof({ id_num: "10001" }))).ok, false);
    assert.equal(validatePastedIdentityProof(JSON.stringify({ nope: true })).ok, false);
  });
});

describe("splitPastedProofs", () => {
  it("splits prove_bundle output into its two proofs", () => {
    const r = splitPastedProofs(JSON.stringify({ prProof: rawProof(PR_EX), identityProof: rawProof(ID_EX) }));
    assert.equal(r.ok, true);
    assert.equal(r.kind, "bundle-output");
    assert.equal(validatePastedPrProof(r.prText, EXPECTED).ok, true);
    assert.equal(validatePastedIdentityProof(r.identityText).ok, true);
  });

  it("passes single proofs through untouched", () => {
    const text = JSON.stringify(rawProof(PR_EX));
    const r = splitPastedProofs(text);
    assert.equal(r.ok, true);
    assert.equal(r.kind, "single");
    assert.equal(r.text, text);
  });

  it("rejects empty, non-JSON, and malformed bundle files", () => {
    assert.equal(splitPastedProofs("").ok, false);
    assert.equal(splitPastedProofs("{oops").ok, false);
    assert.equal(splitPastedProofs(JSON.stringify({ prProof: 42, identityProof: {} })).ok, false);
  });
});

describe("checkWizardBinding", () => {
  it("passes when the identity is the PR author under one owner", () => {
    assert.deepEqual(checkWizardBinding({ prProof: onchainProof(PR_EX), identityProof: onchainProof(ID_EX) }), []);
  });

  it("flags author and owner mismatches", () => {
    const stranger = checkWizardBinding({ prProof: onchainProof(PR_EX), identityProof: onchainProof({ id_login: "mallory", id_num: "999" }) });
    assert.ok(stranger.length > 0 && stranger.join(" ").includes("mallory"));
    const mixed = checkWizardBinding({ prProof: onchainProof(PR_EX, OWNER), identityProof: onchainProof(ID_EX, OTHER) });
    assert.ok(mixed.length > 0 && mixed.join(" ").includes("owner"));
    assert.ok(checkWizardBinding({}).length > 0);
  });
});

describe("assembleClaimBundle", () => {
  const pr = validatePastedPrProof(JSON.stringify(rawProof(PR_EX)), EXPECTED).proof;
  const id = validatePastedIdentityProof(JSON.stringify(rawProof(ID_EX))).proof;

  it("assembles evidence 1+7 with the verified criteria", () => {
    const r = assembleClaimBundle({ criteriaJson: JSON.stringify({ repo: "o/r" }), prProof: pr, identityProof: id });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const bundle = JSON.parse(r.bundleText);
    assert.deepEqual(bundle.criteria_json, { repo: "o/r" });
    assert.deepEqual(bundle.proofs.map((p) => p.evidence_type), [1, 7]);
  });

  it("refuses to assemble without verified criteria or validated proofs", () => {
    assert.equal(assembleClaimBundle({ prProof: pr, identityProof: id }).ok, false);
    assert.equal(assembleClaimBundle({ criteriaJson: "{oops", prProof: pr, identityProof: id }).ok, false);
    assert.equal(assembleClaimBundle({ criteriaJson: "{}", identityProof: id }).ok, false);
    assert.equal(assembleClaimBundle({ criteriaJson: "{}", prProof: pr }).ok, false);
  });

  it("round-trips through the real submit analysis", () => {
    const r = assembleClaimBundle({ criteriaJson: JSON.stringify({ repo: "o/r" }), prProof: pr, identityProof: id });
    assert.equal(r.ok, true);
    const planned = planClaimSubmission(r.bundleText);
    assert.equal(planned.ok, true, JSON.stringify(planned.errors));
    assert.equal(planned.facts.owner, OWNER);
    assert.equal(planned.facts.number, "7");
  });
});

describe("command and env template", () => {
  it("builds the one local command without secrets", () => {
    const cmd = buildProveCommand({ repo: "o/r", prNumber: "7" });
    assert.ok(cmd.includes("node scripts/prove_bundle.mjs o/r 7 ./claim-proofs.json"));
    assert.ok(!cmd.includes("SECRET") && !cmd.includes("TOKEN"));
  });

  it("templates placeholder-only env vars", () => {
    assert.ok(ENV_LOCAL_TEMPLATE.includes("RECLAIM_APP_ID=0x..."));
    assert.ok(ENV_LOCAL_TEMPLATE.includes("GITHUB_TOKEN=<your-own-token>"));
  });
});
