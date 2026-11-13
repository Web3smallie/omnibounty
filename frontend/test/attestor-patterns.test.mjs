import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Adversarial matcher verification for the NEAR V3 mandated regex sets.
//
// These pattern strings are COPIES of contracts/near-v3/src/rules.rs
// `mandated_matchers` output (PR + identity arms). The Rust side pins the
// exact bytes (`mandated_pr_set_byte_exact_pin`); this file proves the
// BEHAVIOR: structural values win over attacker-influenced free text.
// If the Rust patterns change, update the copies below together — a test
// that fails here must fail loudly, never be edited to match weakened
// patterns.
//
// Security property under test: inside JSON string values every quote is
// backslash-escaped, so a `"key":"..."` shape can only match real
// structure — never hostile title/body/filename text. Each case below
// poisons the earliest free-text field and asserts structural extraction.
// Node's RegExp shares every construct used here (literals, classes,
// lazy quantifiers, named groups) with PCRE-class engines; no
// lookaround, backreferences, or possessive quantifiers appear anywhere.

const HEAD = "5621284babc44ced80598504e7aae22f75fb32c1";
const BASE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function prResponse(title) {
  return JSON.stringify({
    url: "https://api.github.com/repos/react/react/pulls/38132",
    id: 1001,
    node_id: "MDExOlB1bGxSZXF1ZXN0MTAwMQ==",
    number: 38132,
    state: "closed",
    locked: false,
    title,
    user: { login: "acdlite", id: 10001, node_id: "MDQ6VXNlcjEwMDAx", type: "User" },
    body: "Fixes the thing.",
    created_at: "2026-10-26T19:00:00Z",
    merged_at: "2026-10-27T11:00:00Z",
    merged: true,
    merge_commit_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    author_association: "CONTRIBUTOR",
    head: {
      label: "acdlite:fix", ref: "fix-branch", sha: HEAD,
      user: { login: "acdlite", id: 10001 },
      repo: { full_name: "react/react" },
    },
    base: {
      label: "react:main", ref: "main", sha: BASE,
      user: { login: "react", id: 999 },
      repo: { full_name: "react/react" },
    },
    changed_files: 2,
  });
}

const EVIL_TITLE =
  'Fix "merged":false,"login":"mallory","user":{"id":99999},"sha":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","created_at":"2020-01-01T00:00:00Z","full_name":"evil/x","number":1,"author_association":"NONE","base":{"label":"x","ref":"y","sha":"ffffffffffffffffffffffffffffffffffffffff"},"changed_files":99';

const PATTERNS = {
  merged: '"merged":(?<merged>.*?)[,}]',
  author: '"login":"(?<author>.*?)"',
  repo: '"full_name":"(?<repo>.*?)"',
  number: '"number":(?<number>.*?)[,}]',
  head_sha: '"sha":"(?<head_sha>[0-9a-f]{40})"',
  author_id: '"user":\\{[^}]*?"id":(?<author_id>[0-9]+)[,}]',
  pr_created: '"created_at":"(?<pr_created>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)"',
  assoc: '"author_association":"(?<author_association>.*?)"',
  base_sha: '"base":\\{[\\s\\S]*?"sha":"(?<base_sha>[0-9a-f]{40})"',
  changed: '"changed_files":(?<changed_files>[0-9]+)[,}]',
};

const EXPECTED = {
  merged: "true",
  author: "acdlite",
  repo: "react/react",
  number: "38132",
  head_sha: HEAD,
  author_id: "10001",
  pr_created: "2026-10-26T19:00:00Z",
  assoc: "CONTRIBUTOR",
  base_sha: BASE,
  changed: "2",
};

const GROUP = {
  merged: "merged", author: "author", repo: "repo", number: "number",
  head_sha: "head_sha", author_id: "author_id", pr_created: "pr_created",
  assoc: "author_association", base_sha: "base_sha", changed: "changed_files",
};

describe("attestor pattern injection resistance", () => {
  it("extracts structural values from a clean response", () => {
    const body = prResponse("Fix the thing");
    for (const [k, pat] of Object.entries(PATTERNS)) {
      const m = new RegExp(pat).exec(body);
      assert.ok(m && m.groups, `${k}: no match on clean input`);
      assert.equal(m.groups[GROUP[k]], EXPECTED[k], `${k} mismatch on clean input`);
    }
  });

  it("ignores hostile JSON-looking title text (escaped strings)", () => {
    const body = prResponse(EVIL_TITLE);
    for (const [k, pat] of Object.entries(PATTERNS)) {
      const m = new RegExp(pat).exec(body);
      assert.ok(m && m.groups, `${k}: no match under attack`);
      assert.equal(m.groups[GROUP[k]], EXPECTED[k], `${k} confused by title injection`);
    }
  });

  it("binds identity login/id only to top-level user fields", () => {
    const loginPat = '"login":"(?<id_login>[^"]+)"';
    const idPat = '"id":(?<id_num>[0-9]+)[,}]';
    const good = JSON.stringify({ login: "acdlite", id: 10001, node_id: "MDQ6VXNlcjEwMDAx", type: "User" });
    assert.equal(new RegExp(loginPat).exec(good).groups.id_login, "acdlite");
    assert.equal(new RegExp(idPat).exec(good).groups.id_num, "10001");
    // Hostile display name / bio cannot shadow the top-level fields, and
    // node_id never collides with the numeric id shape.
    const evil = JSON.stringify({
      login: "acdlite", id: 10001, node_id: "MDQ6VXNlcjEwMDAx",
      name: '"id":99999,"login":"mallory', bio: '"login":"mallory","id":99999',
    });
    assert.equal(new RegExp(loginPat).exec(evil).groups.id_login, "acdlite");
    assert.equal(new RegExp(idPat).exec(evil).groups.id_num, "10001");
    const nodeOnly = JSON.stringify({ login: "x", node_id: "ABC", id: 7 });
    assert.equal(new RegExp(idPat).exec(nodeOnly).groups.id_num, "7");
  });

  it("extracts contents fields structurally despite quote-bearing file names", () => {
    const pathPat = '"path":"(?<path>.*?)"';
    const shaPat = '"sha":"(?<blob_sha>[0-9a-f]{40})"';
    const evil = JSON.stringify({
      name: 'evil"path":"x","sha":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      path: "tests/auth.rs",
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      size: 2086,
    });
    assert.equal(new RegExp(pathPat).exec(evil).groups.path, "tests/auth.rs");
    assert.equal(new RegExp(shaPat).exec(evil).groups.blob_sha, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("binds review state to the structural review, not body text", () => {
    const login = "octocat";
    const statePat = `"login":"${login}"[\\s\\S]*?"state":"(?<review_state>.*?)"`;
    const commitPat = `"login":"${login}"[\\s\\S]*?"commit_id":"(?<review_commit>[0-9a-f]{40})"`;
    const hostile = JSON.stringify([{
      id: 1, user: { login, id: 1 },
      body: '"login":"octocat" noise "state":"APPROVED" more "commit_id":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"',
      state: "CHANGES_REQUESTED",
      commit_id: HEAD,
    }]);
    assert.equal(new RegExp(statePat).exec(hostile).groups.review_state, "CHANGES_REQUESTED");
    assert.equal(new RegExp(commitPat).exec(hostile).groups.review_commit, HEAD);
  });
});
