import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE,
  GITHUB_ACCEPT,
  IDENTITY_URL,
  USER_AGENT,
  PR_MATCHERS,
  IDENTITY_MATCHERS,
  prUrl,
  toResponseMatches,
  buildPrProofRequest,
  buildIdentityProofRequest,
  checkPrExtractions,
  checkIdentityExtractions,
  checkIdentityBinding,
  extractedOf,
} from "../lib/reclaim.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_RS = join(HERE, "..", "..", "contracts", "near-v3", "src", "rules.rs");
const RECLAIM_RS = join(HERE, "..", "..", "contracts", "near-v3", "src", "reclaim.rs");

// Extract rx("...") mandated literals from one `mandated_matchers` arm,
// evaluating the two shapes used in rules.rs: rx(r#"..."#.to_string()) and
// rx(r#"..."# + "\"").
function rustArmMatchers(src, variant) {
  const fnStart = src.indexOf("pub fn mandated_matchers");
  assert.notEqual(fnStart, -1, "missing mandated_matchers fn");
  const start = src.indexOf(`EvidenceType::${variant} => {`, fnStart);
  assert.notEqual(start, -1, `missing ${variant} arm`);
  let end = src.indexOf("\n        EvidenceType::", start + 10);
  if (end === -1) end = src.length;
  const arm = src.slice(start, end);
  const out = [];
  const re = /rx\(r#"(.*?)"#(?:\.to_string\(\))?(\s*\+\s*"\\"")?/g;
  let m;
  while ((m = re.exec(arm)) !== null) out.push(m[1] + (m[2] ? '"' : ""));
  assert.ok(out.length > 0, `no matchers parsed for ${variant}`);
  return out;
}

describe("rust cross-check (contract is truth)", () => {
  it("PR_MATCHERS equals the unconditional Pr mandated set", async () => {
    const rules = readFileSync(RULES_RS, "utf8");
    const arm = rustArmMatchers(rules, "Pr");
    // The arm also holds conditional matchers (association/base/files/...);
    // the 7 unconditional ones must each be present verbatim.
    assert.equal(PR_MATCHERS.length, 7);
    for (const want of PR_MATCHERS) {
      assert.ok(arm.includes(want), `PR matcher missing from rules.rs: ${want}`);
    }
  });

  it("IDENTITY_MATCHERS equals the Identity mandated set", async () => {
    const rules = readFileSync(RULES_RS, "utf8");
    const arm = rustArmMatchers(rules, "Identity");
    assert.deepEqual(arm, IDENTITY_MATCHERS);
  });

  it("EVIDENCE numbers match the EvidenceType enum", async () => {
    const src = readFileSync(RECLAIM_RS, "utf8");
    const body = src.slice(src.indexOf("enum EvidenceType"), src.indexOf("impl EvidenceType"));
    const nums = Object.fromEntries([...body.matchAll(/(\w+) = (\d+),/g)].map((m) => [m[1], Number(m[2])]));
    assert.deepEqual(nums, EVIDENCE);
  });

  it("endpoint, Accept header, and identity requirement match rules.rs", async () => {
    const rules = readFileSync(RULES_RS, "utf8");
    assert.ok(rules.includes(`if url != "${IDENTITY_URL}"`), "identity endpoint pinned in match_endpoint_url");
    assert.ok(rules.includes(`_ => "${GITHUB_ACCEPT}"`), "Accept pinned in required_headers");
    assert.ok(rules.includes('MissingEvidence("identity proof"'), "identity proof mandatory");
  });
});

describe("proof request builders", () => {
  it("builds the exact PR endpoint with pinned headers", async () => {
    const r = buildPrProofRequest("octocat/Hello-World", 7);
    assert.equal(r.url, "https://api.github.com/repos/octocat/Hello-World/pulls/7");
    assert.equal(r.url, prUrl("octocat/Hello-World", 7));
    assert.deepEqual(r.publicOptions, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: GITHUB_ACCEPT },
    });
    assert.deepEqual(r.privateOptions.responseMatches, toResponseMatches(PR_MATCHERS));
    assert.equal(r.privateOptions.responseMatches.length, 7);
  });

  it("keeps the GitHub token out of everything the verifier sees", async () => {
    const r = buildIdentityProofRequest("Bearer SECRET");
    assert.equal(r.url, IDENTITY_URL);
    assert.equal(r.publicOptions.headers.Accept, GITHUB_ACCEPT);
    assert.deepEqual(r.privateOptions.responseMatches, toResponseMatches(IDENTITY_MATCHERS));
    // Authorization travels ONLY in privateOptions.headers (SDK-hidden).
    assert.deepEqual(r.privateOptions.headers, { Authorization: "Bearer SECRET" });
    assert.ok(!("Authorization" in r.publicOptions.headers));
    assert.ok(!JSON.stringify({ ...r, privateOptions: { responseMatches: r.privateOptions.responseMatches } }).includes("SECRET"));
  });
});

describe("extraction checks", () => {
  const PR = {
    merged: "true", author: "octocat", repo: "o/r", number: "7",
    head_sha: "a".repeat(40), author_id: "10001", pr_created: "2026-10-26T19:00:00Z",
  };

  it("accepts all seven PR fields", async () => {
    assert.deepEqual(checkPrExtractions(PR, "o/r", 7), []);
  });

  it("flags each missing or malformed PR field", async () => {
    assert.ok(checkPrExtractions({ ...PR, merged: "false" }, "o/r", 7).length === 1);
    assert.ok(checkPrExtractions({ ...PR, repo: "x/y" }, "o/r", 7).length === 1);
    assert.ok(checkPrExtractions({ ...PR, number: "8" }, "o/r", 7).length === 1);
    assert.ok(checkPrExtractions({ ...PR, author: "" }, "o/r", 7).length === 1);
    assert.ok(checkPrExtractions({ ...PR, head_sha: "abc" }, "o/r", 7).length === 1);
    assert.ok(checkPrExtractions({ ...PR, author_id: "01" }, "o/r", 7).length === 1);
    assert.ok(checkPrExtractions({ ...PR, pr_created: "yesterday" }, "o/r", 7).length === 1);
    assert.ok(checkPrExtractions(null, "o/r", 7).length === 1);
  });

  it("accepts a complete identity extraction", async () => {
    assert.deepEqual(checkIdentityExtractions({ id_login: "octocat", id_num: "10001" }), []);
    assert.equal(checkIdentityExtractions({ id_login: "", id_num: "10001" }).length, 1);
    assert.equal(checkIdentityExtractions({ id_login: "octocat", id_num: "1x" }).length, 1);
  });

  it("binds identity to PR author and proofs to recipient", async () => {
    const base = {
      prAuthor: "octocat", prAuthorId: "10001", idLogin: "octocat", idNum: "10001",
      proofOwners: ["0xAAA"], recipient: "0xaaa",
    };
    assert.deepEqual(checkIdentityBinding(base), []);
    assert.match(checkIdentityBinding({ ...base, idLogin: "mallory" }).join(";"), /not the PR author/);
    assert.match(checkIdentityBinding({ ...base, idNum: "999" }).join(";"), /not the PR author/);
    assert.match(checkIdentityBinding({ ...base, recipient: "0xbbb" }).join(";"), /does not match recipient/);
  });

  it("extractedOf reads normalized context or returns null", async () => {
    const norm = { claimInfo: { context: JSON.stringify({ extractedParameters: { a: 1 } }) } };
    assert.deepEqual(extractedOf(norm), { a: 1 });
    assert.equal(extractedOf({ claimInfo: { context: "nope" } }), null);
    assert.equal(extractedOf(null), null);
  });
});

describe("prove script wiring", () => {
  it("both scripts build requests from lib/reclaim.mjs (no divergent copies)", async () => {
    const prove = readFileSync(join(HERE, "..", "scripts", "prove.mjs"), "utf8");
    assert.ok(prove.includes("buildPrProofRequest"), "prove.mjs uses the shared PR builder");
    assert.ok(prove.includes("checkPrExtractions"), "prove.mjs uses the shared PR check");
    assert.ok(!prove.includes('"merged":(?<merged>'), "prove.mjs holds no matcher literals of its own");
    const ident = readFileSync(join(HERE, "..", "scripts", "prove_identity.mjs"), "utf8");
    assert.ok(ident.includes("buildIdentityProofRequest"), "prove_identity.mjs uses the shared identity builder");
    assert.ok(ident.includes("checkIdentityExtractions"), "prove_identity.mjs uses the shared identity check");
    assert.ok(!ident.includes("console.log(process.env"), "identity script never logs env");
    assert.ok(ident.includes("serialized.includes(githubToken)"), "identity script refuses token-bearing output");
  });
});
