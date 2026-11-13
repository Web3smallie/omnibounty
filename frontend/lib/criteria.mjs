// OmniBounty V3 acceptance-criteria: canonicalization, hashing, validation,
// proof-join and nullifier-key helpers. Pure, dependency-light (canonicalize
// for key sorting, ethers for keccak), shared by tooling and node:test.
// Normative companion: docs/v3/CRITERIA_SCHEMA.json + docs/v3/CANONICALIZATION.md
import canonicalize from "canonicalize";
import { ethers } from "ethers";
import { isRepoSlug } from "./validation.mjs";

export const CRITERIA_SCHEMA_ID = "omnibounty/criteria";
export const CRITERIA_VERSION = "1";
export const MAX_EVIDENCE_AGE_SEC = 604800n; // 7d protocol ceiling
export const U64_MAX = 18446744073709551615n;
export const U256_MAX = (1n << 256n) - 1n;
export const NULLIFIER_DOMAIN = "OMNIBOUNTY-V3-NULL";

// Evidence-type tags for nullifier scoping (frozen once funded criteria exist).
export const EVIDENCE_TYPE = Object.freeze({
  PR: 1,
  CHECK_RUN: 2,
  FILES: 3,
  REVIEW: 4,
  CONTENTS: 5,
  DIFF: 6,
});

const UINT_RE = /^(0|[1-9][0-9]*)$/;
const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX40_ANY_RE = /^[0-9a-fA-F]{40}$/;
const LOGIN_RE = /^[A-Za-z0-9-]+$/;
const ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIMER",
  "FIRST_TIME_CONTRIBUTOR",
  "MANNEQUIN",
  "NONE",
]);

// -- Strict JSON scan ------------------------------------------------------
// Rejects (a) duplicate object keys incl. escaped-encoding variants,
// (b) numeric literals, (c) null literals anywhere. Booleans/strings/
// objects/arrays pass through to JSON.parse. Throws Error listing the
// first violation with its byte offset.
function unescapeJsonString(raw) {
  // raw includes surrounding quotes; returns the decoded value.
  let out = "";
  for (let i = 1; i < raw.length - 1; i++) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const esc = raw[++i];
    if (esc === "u") {
      const hex = raw.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad \\u escape at ${i}`);
      let cp = parseInt(hex, 16);
      i += 4;
      if (cp >= 0xd800 && cp <= 0xdbff && raw[i + 1] === "\\" && raw[i + 2] === "u") {
        const lo = parseInt(raw.slice(i + 3, i + 7), 16);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
          i += 6;
        }
      }
      out += String.fromCodePoint(cp);
    } else {
      const map = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (!(esc in map)) throw new Error(`bad escape \\${esc} at ${i}`);
      out += map[esc];
    }
  }
  return out;
}

export function strictParseJson(text) {
  const stack = []; // entries: {keys: Map<string, number>} for '{', or 'array' for '['
  const n = text.length;
  let i = 0;
  const readString = () => {
    // text[i] === '"'; returns {raw, value, end} with end past closing quote.
    let j = i + 1;
    while (j < n) {
      if (text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text[j] === '"') break;
      j++;
    }
    if (j >= n) throw new Error(`unterminated string at ${i}`);
    const raw = text.slice(i, j + 1);
    return { raw, value: unescapeJsonString(raw), end: j + 1 };
  };
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      const s = readString();
      // A string is a KEY iff the next non-ws char is ':'.
      let k = s.end;
      while (k < n && " \t\n\r".includes(text[k])) k++;
      if (text[k] === ":") {
        const top = stack[stack.length - 1];
        if (!top || top === "array") throw new Error(`object key outside object at ${i}`);
        if (top.keys.has(s.value)) throw new Error(`duplicate key ${JSON.stringify(s.value)} at ${i}`);
        top.keys.set(s.value, i);
      }
      i = s.end;
      continue;
    }
    if (ch === "{") {
      stack.push({ keys: new Map() });
      i++;
      continue;
    }
    if (ch === "[") {
      stack.push("array");
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (stack.length === 0) throw new Error(`unbalanced ${ch} at ${i}`);
      stack.pop();
      i++;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
      throw new Error(`numeric literal forbidden at ${i} (${m ? m[0].slice(0, 24) : ch})`);
    }
    if (text.startsWith("null", i) && !/[A-Za-z0-9_]/.test(text[i + 4] || "")) {
      throw new Error(`null literal forbidden at ${i}`);
    }
    i++;
  }
  if (stack.length !== 0) throw new Error("unbalanced brackets");
  return JSON.parse(text);
}

// -- Canonical form + hash ---------------------------------------------------
/// Canonical bytes of a criteria document: strict-parse (if string) then
/// canonicalize@2.1.0 key ordering. Byte-identical to Rust canon::canonicalize_str.
export function canonicalizeCriteria(docOrText) {
  const value = typeof docOrText === "string" ? strictParseJson(docOrText) : docOrText;
  return canonicalize(value);
}

/// criteria_hash = keccak256(canonical_bytes), 0x-prefixed lowercase hex.
export function hashCriteriaDocument(docOrText) {
  const canon = canonicalizeCriteria(docOrText);
  return ethers.keccak256(ethers.toUtf8Bytes(canon));
}

// -- Validation --------------------------------------------------------------
function isUintStr(v) {
  return typeof v === "string" && UINT_RE.test(v);
}

function toBig(v) {
  return BigInt(v);
}

function checkPathPattern(p, { allowTrailingSlash }) {
  // No leading slash, no empty segments, no dot segments, no backslash or
  // controls, no glob metacharacters except the trailing-slash convention.
  if (typeof p !== "string" || p.length === 0 || p.length > 512) return "must be 1..512 chars";
  if (p.startsWith("/") || p.includes("\\") || /[\0-\x1f\x7f]/.test(p)) return "bad characters or leading slash";
  if (/[*?[\]{}()|+^$]/.test(p)) return "glob metacharacters forbidden (only trailing-slash subtree convention)";
  const body = allowTrailingSlash && p.endsWith("/") ? p.slice(0, -1) : p;
  if (p.endsWith("/") && !allowTrailingSlash) return "trailing slash not allowed here";
  if (body.length === 0) return "empty path";
  for (const seg of body.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return "empty or dot segment";
  }
  return null;
}

/// Full shape + semantic validation. Returns {ok, errors[]} with EVERY
/// violation listed (never fail-fast). Mirrors CRITERIA_SCHEMA.json plus the
/// semantic rules that JSON Schema cannot express (u64 range, path segments,
/// slug charset, policy/slots consistency, issue-URL repo binding).
export function validateCriteria(doc) {
  const errors = [];
  const at = (path, msg) => errors.push(`${path}: ${msg}`);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, errors: ["$: must be an object"] };

  const allowedTop = new Set([
    "schema", "version", "title", "description", "repo", "base_commit",
    "merge_policy", "allow_forks", "author_association", "identity_policy",
    "checks", "files", "labels", "reviews", "issue",
    "policy", "slots", "unfilled", "deadline", "challenge_window_sec", "evidence_max_age_sec",
  ]);
  for (const k of Object.keys(doc)) if (!allowedTop.has(k)) at("$", `unknown field '${k}'`);
  for (const k of ["schema", "version", "title", "description", "repo", "merge_policy", "allow_forks", "identity_policy", "policy", "slots", "unfilled", "deadline", "challenge_window_sec", "evidence_max_age_sec"]) {
    if (!(k in doc)) at("$", `missing required field '${k}'`);
  }

  if (doc.schema !== undefined && doc.schema !== CRITERIA_SCHEMA_ID) at("schema", `must be '${CRITERIA_SCHEMA_ID}'`);
  if (doc.version !== undefined && doc.version !== CRITERIA_VERSION) at("version", `must be '${CRITERIA_VERSION}' (only v1 exists)`);
  if (doc.title !== undefined && (typeof doc.title !== "string" || doc.title.length < 1 || doc.title.length > 120)) at("title", "must be 1..120 chars");
  if (doc.description !== undefined && (typeof doc.description !== "string" || doc.description.length < 1 || doc.description.length > 8000)) at("description", "must be 1..8000 chars");
  if (doc.repo !== undefined && !isRepoSlug(doc.repo)) at("repo", "must look like 'owner/name' (charset + length rules)");
  if (doc.base_commit !== undefined && (typeof doc.base_commit !== "string" || !HEX40_RE.test(doc.base_commit))) at("base_commit", "must be lowercase 40-hex");
  if (doc.base_commit === undefined && doc.checks && Array.isArray(doc.checks.required) && doc.checks.required.some((r) => r && r.fail_at_base === true)) at("checks", "fail_at_base requires base_commit");
  if (doc.merge_policy !== undefined && doc.merge_policy !== "merged" && doc.merge_policy !== "ci_verified") at("merge_policy", "must be 'merged' or 'ci_verified'");
  if (doc.allow_forks !== undefined && typeof doc.allow_forks !== "boolean") at("allow_forks", "must be boolean (explicit, no default)");
  if (doc.identity_policy !== undefined && doc.identity_policy !== "open" && doc.identity_policy !== "commitment") at("identity_policy", "must be 'open' or 'commitment'");
  if (doc.unfilled !== undefined && doc.unfilled !== "refund_sponsor") at("unfilled", "must be 'refund_sponsor' (only policy defined)");

  const checkUint = (path, v, { min = 0n, max = U64_MAX } = {}) => {
    if (v === undefined) return;
    if (!isUintStr(v)) return at(path, "must be a canonical decimal string (no leading zeros, no sign)");
    const b = toBig(v);
    if (b < min || b > max) at(path, `out of range [${min}, ${max}]`);
  };
  checkUint("deadline", doc.deadline);
  checkUint("challenge_window_sec", doc.challenge_window_sec);
  if (doc.evidence_max_age_sec !== undefined) {
    if (!isUintStr(doc.evidence_max_age_sec)) at("evidence_max_age_sec", "must be a canonical decimal string");
    else {
      const b = toBig(doc.evidence_max_age_sec);
      if (b < 1n || b > MAX_EVIDENCE_AGE_SEC) at("evidence_max_age_sec", `must be in [1, ${MAX_EVIDENCE_AGE_SEC}]`);
    }
  }

  if (doc.author_association !== undefined) {
    if (!Array.isArray(doc.author_association) || doc.author_association.length < 1) at("author_association", "must be a non-empty array");
    else {
      const seen = new Set();
      doc.author_association.forEach((a, i) => {
        if (!ASSOCIATIONS.has(a)) at(`author_association[${i}]`, `unknown association '${a}'`);
        if (seen.has(a)) at(`author_association[${i}]`, "duplicate entry");
        seen.add(a);
      });
    }
  }

  if (doc.checks !== undefined) {
    const c = doc.checks;
    if (!c || typeof c !== "object" || Array.isArray(c)) at("checks", "must be an object");
    else {
      for (const k of Object.keys(c)) if (k !== "required" && k !== "max_age_sec") at("checks", `unknown field '${k}'`);
      if (!Array.isArray(c.required) || c.required.length < 1 || c.required.length > 16) at("checks.required", "must be 1..16 entries");
      else {
        const names = new Set();
        c.required.forEach((r, i) => {
          const p = `checks.required[${i}]`;
          if (!r || typeof r !== "object" || Array.isArray(r)) return at(p, "must be an object");
          for (const k of Object.keys(r)) if (k !== "name" && k !== "apps" && k !== "fail_at_base") at(p, `unknown field '${k}'`);
          if (r.fail_at_base !== undefined && typeof r.fail_at_base !== "boolean") at(`${p}.fail_at_base`, "must be a boolean");
          if (typeof r.name !== "string" || r.name.length < 1 || r.name.length > 256) at(`${p}.name`, "must be 1..256 chars");
          if (names.has(r.name)) at(`${p}.name`, "duplicate check name");
          names.add(r.name);
          if (!Array.isArray(r.apps) || r.apps.length < 1) at(`${p}.apps`, "must be a non-empty array");
          else {
            const seen = new Set();
            r.apps.forEach((a, j) => {
              if (typeof a !== "string" || a.length < 1 || a.length > 128) at(`${p}.apps[${j}]`, "must be 1..128 chars");
              if (seen.has(a)) at(`${p}.apps[${j}]`, "duplicate entry");
              seen.add(a);
            });
          }
        });
      }
      if (c.max_age_sec !== undefined) {
        if (!isUintStr(c.max_age_sec)) at("checks.max_age_sec", "must be a canonical decimal string");
        else if (toBig(c.max_age_sec) > U64_MAX) at("checks.max_age_sec", "exceeds u64");
      }
    }
  }

  const checkPathList = (path, v) => {
    if (v === undefined) return;
    if (!Array.isArray(v) || v.length < 1) return at(path, "must be a non-empty array");
    const seen = new Set();
    v.forEach((p, i) => {
      const err = checkPathPattern(p, { allowTrailingSlash: true });
      if (err) at(`${path}[${i}]`, err);
      if (seen.has(p)) at(`${path}[${i}]`, "duplicate entry");
      seen.add(p);
    });
  };
  if (doc.files !== undefined) {
    const f = doc.files;
    if (!f || typeof f !== "object" || Array.isArray(f)) at("files", "must be an object");
    else {
      for (const k of Object.keys(f)) {
        if (!["allowed_paths", "forbidden_paths", "required_touched", "protected", "max_changed_files", "max_additions", "max_deletions", "patch_contains_all"].includes(k)) at("files", `unknown field '${k}'`);
      }
      if (Object.keys(f).length === 0) at("files", "must contain >=1 constraint when present");
      checkPathList("files.allowed_paths", f.allowed_paths);
      checkPathList("files.forbidden_paths", f.forbidden_paths);
      checkPathList("files.required_touched", f.required_touched);
      if (f.protected !== undefined) {
        if (!Array.isArray(f.protected) || f.protected.length < 1 || f.protected.length > 16) at("files.protected", "must be 1..16 entries");
        else {
          const seen = new Set();
          f.protected.forEach((p, i) => {
            const q = `files.protected[${i}]`;
            if (!p || typeof p !== "object" || Array.isArray(p)) return at(q, "must be an object");
            for (const k of Object.keys(p)) if (k !== "path" && k !== "blob_sha") at(q, `unknown field '${k}'`);
            const perr = checkPathPattern(p.path, { allowTrailingSlash: false });
            if (perr) at(`${q}.path`, perr);
            if (typeof p.blob_sha !== "string" || !HEX40_RE.test(p.blob_sha)) at(`${q}.blob_sha`, "must be lowercase 40-hex");
            if (seen.has(p.path)) at(`${q}.path`, "duplicate protected path");
            seen.add(p.path);
          });
        }
      }
      checkUint("files.max_changed_files", f.max_changed_files);
      checkUint("files.max_additions", f.max_additions);
      checkUint("files.max_deletions", f.max_deletions);
      if (f.patch_contains_all !== undefined) {
        if (!Array.isArray(f.patch_contains_all) || f.patch_contains_all.length < 1 || f.patch_contains_all.length > 8) at("files.patch_contains_all", "must be 1..8 entries");
        else {
          const seen = new Set();
          f.patch_contains_all.forEach((s, i) => {
            if (typeof s !== "string" || s.length < 1 || s.length > 256) at(`files.patch_contains_all[${i}]`, "must be 1..256 chars");
            if (seen.has(s)) at(`files.patch_contains_all[${i}]`, "duplicate entry");
            seen.add(s);
          });
        }
      }
    }
  }

  if (doc.labels !== undefined) {
    const l = doc.labels;
    if (!l || typeof l !== "object" || Array.isArray(l)) at("labels", "must be an object");
    else {
      for (const k of Object.keys(l)) if (k !== "required_all") at("labels", `unknown field '${k}'`);
      if (!Array.isArray(l.required_all) || l.required_all.length < 1 || l.required_all.length > 8) at("labels.required_all", "must be 1..8 entries");
      else {
        const seen = new Set();
        l.required_all.forEach((s, i) => {
          if (typeof s !== "string" || s.length < 1 || s.length > 64) at(`labels.required_all[${i}]`, "must be 1..64 chars");
          if (seen.has(s)) at(`labels.required_all[${i}]`, "duplicate entry");
          seen.add(s);
        });
      }
    }
  }

  if (doc.reviews !== undefined) {
    const r = doc.reviews;
    if (!r || typeof r !== "object" || Array.isArray(r)) at("reviews", "must be an object");
    else {
      for (const k of Object.keys(r)) if (k !== "required_approvals") at("reviews", `unknown field '${k}'`);
      if (!Array.isArray(r.required_approvals) || r.required_approvals.length < 1 || r.required_approvals.length > 8) at("reviews.required_approvals", "must be 1..8 entries");
      else {
        const seen = new Set();
        r.required_approvals.forEach((a, i) => {
          const p = `reviews.required_approvals[${i}]`;
          if (!a || typeof a !== "object" || Array.isArray(a)) return at(p, "must be an object");
          for (const k of Object.keys(a)) if (k !== "login" && k !== "association") at(p, `unknown field '${k}'`);
          if (typeof a.login !== "string" || a.login.length < 1 || a.login.length > 128) at(`${p}.login`, "must be 1..128 chars");
          if (seen.has(a.login)) at(`${p}.login`, "duplicate reviewer");
          seen.add(a.login);
          if (a.association !== undefined) {
            if (!Array.isArray(a.association) || a.association.length < 1) at(`${p}.association`, "must be a non-empty array");
            else {
              const as = new Set();
              a.association.forEach((x, j) => {
                if (!ASSOCIATIONS.has(x)) at(`${p}.association[${j}]`, `unknown association '${x}'`);
                if (as.has(x)) at(`${p}.association[${j}]`, "duplicate entry");
                as.add(x);
              });
            }
          }
        });
      }
    }
  }

  if (doc.issue !== undefined) {
    const g = doc.issue;
    if (!g || typeof g !== "object" || Array.isArray(g)) at("issue", "must be an object");
    else {
      for (const k of Object.keys(g)) if (!["url", "require_close_reference", "keywords"].includes(k)) at("issue", `unknown field '${k}'`);
      for (const k of ["url", "require_close_reference", "keywords"]) if (!(k in g)) at("issue", `missing required field '${k}'`);
      if (typeof g.url === "string" && typeof doc.repo === "string") {
        const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/([1-9][0-9]*)$/.exec(g.url);
        if (!m) at("issue.url", "must look like https://github.com/<owner/name>/(issues|pull)/<number>");
        else if (m[1] !== doc.repo) at("issue.url", `repo segment '${m[1]}' must equal criteria repo '${doc.repo}' byte-for-byte`);
      } else if (g.url !== undefined) at("issue.url", "must be a string");
      if (g.require_close_reference !== undefined && typeof g.require_close_reference !== "boolean") at("issue.require_close_reference", "must be boolean");
      if (g.keywords !== undefined) {
        if (!Array.isArray(g.keywords) || g.keywords.length < 1 || g.keywords.length > 4) at("issue.keywords", "must be 1..4 entries");
        else {
          const seen = new Set();
          g.keywords.forEach((s, i) => {
            if (typeof s !== "string" || s.length < 1 || s.length > 32) at(`issue.keywords[${i}]`, "must be 1..32 chars");
            if (seen.has(s)) at(`issue.keywords[${i}]`, "duplicate entry");
            seen.add(s);
          });
        }
      }
    }
  }

  if (doc.policy !== undefined && doc.policy !== "single_winner" && doc.policy !== "ordered_slots") at("policy", "must be 'single_winner' or 'ordered_slots'");
  if (doc.slots !== undefined) {
    if (!Array.isArray(doc.slots) || doc.slots.length < 1 || doc.slots.length > 16) at("slots", "must be 1..16 entries");
    else {
      doc.slots.forEach((s, i) => {
        const p = `slots[${i}]`;
        if (!s || typeof s !== "object" || Array.isArray(s)) return at(p, "must be an object");
        for (const k of Object.keys(s)) if (k !== "amount") at(p, `unknown field '${k}'`);
        if (!isUintStr(s.amount)) return at(`${p}.amount`, "must be a canonical decimal string");
        const b = toBig(s.amount);
        if (b <= 0n) at(`${p}.amount`, "must be > 0");
        if (b > U256_MAX) at(`${p}.amount`, "exceeds u256");
      });
      if (doc.policy === "single_winner" && doc.slots.length !== 1) at("policy", "single_winner requires exactly 1 slot");
      if (doc.policy === "ordered_slots" && doc.slots.length < 1) at("policy", "ordered_slots requires >= 1 slot");
    }
  }

  return { ok: errors.length === 0, errors };
}

/// Full document pipeline: strict-parse text -> validate -> canonical bytes.
/// Throws on malformed JSON; returns {ok, errors[], canonical?}.
export function parseAndValidateCriteria(text) {
  let doc;
  try {
    doc = strictParseJson(text);
  } catch (e) {
    return { ok: false, errors: [`$: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const v = validateCriteria(doc);
  if (!v.ok) return v;
  return { ok: true, errors: [], canonical: canonicalize(doc) };
}

// -- Cross-proof join ----------------------------------------------------------
/// Match a proof URL against its endpoint template for a repo. Returns the
/// extracted join keys or null. Mirrors the V3 template URL pinning.
export function matchEndpointUrl(kind, url, repo) {
  if (typeof url !== "string" || typeof repo !== "string") return null;
  // Identity proofs hit the authenticated user endpoint: exact match, no
  // repo scope. Mirrors the Rust early branch case-for-case.
  if (kind === "identity") {
    return url === "https://api.github.com/user" ? {} : null;
  }
  const base = `https://api.github.com/repos/${repo}`;
  let m;
  switch (kind) {
    case "pr":
      m = new RegExp(`^${escapeRegExp(base)}/pulls/([1-9][0-9]*)$`).exec(url);
      return m ? { prNumber: m[1] } : null;
    case "check_run":
      m = new RegExp(`^${escapeRegExp(base)}/check-runs/([1-9][0-9]*)$`).exec(url);
      return m ? { runId: m[1] } : null;
    case "base_check":
      m = new RegExp(`^${escapeRegExp(base)}/check-runs/([1-9][0-9]*)$`).exec(url);
      return m ? { runId: m[1] } : null;
    case "check_runs_list":
      m = new RegExp(`^${escapeRegExp(base)}/commits/([0-9a-f]{40})/check-runs(\\?.*)?$`).exec(url);
      return m ? { sha: m[1].toLowerCase() } : null;
    case "files":
      m = new RegExp(`^${escapeRegExp(base)}/pulls/([1-9][0-9]*)/files(\\?.*)?$`).exec(url);
      return m ? { prNumber: m[1] } : null;
    case "reviews":
      m = new RegExp(`^${escapeRegExp(base)}/pulls/([1-9][0-9]*)/reviews(\\?.*)?$`).exec(url);
      return m ? { prNumber: m[1] } : null;
    case "contents":
      m = new RegExp(`^${escapeRegExp(base)}/contents/(.+?)\\?ref=([0-9a-fA-F]{40})$`).exec(url);
      return m ? { path: m[1], ref: m[2].toLowerCase() } : null;
    default:
      return null;
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/// Cross-proof join over one claim's evidence bundle. Every proof supplies
/// {kind, url, extracted} where extracted holds that proof's fields.
/// Rules (see VERIFICATION_MATRIX.md):
/// - >=1 pr proof; all PR numbers (from URLs) identical.
/// - all head SHAs equal: pr.head_sha, check_run.head_sha, review commit,
///   contents ref, check-runs-list sha.
/// Returns {ok, head, prNumber, errors[]}.
export function checkCrossProofJoin(proofs, repo) {
  const errors = [];
  if (!Array.isArray(proofs) || proofs.length === 0) return { ok: false, head: null, prNumber: null, errors: ["claim must reference >= 1 proof"] };
  let prNumber = null;
  const heads = new Set();
  const use = (label, value, want) => {
    if (value == null || value === "") {
      errors.push(`${label}: missing value`);
      return;
    }
    if (want === "pr") {
      if (prNumber === null) prNumber = value;
      else if (prNumber !== value) errors.push(`${label}: pr_number ${value} != ${prNumber}`);
    } else {
      heads.add(String(value).toLowerCase());
    }
  };
  for (const [i, p] of proofs.entries()) {
    const tag = `proof[${i}](${p && p.kind})`;
    if (!p || typeof p !== "object") {
      errors.push(`${tag}: malformed entry`);
      continue;
    }
    const parts = matchEndpointUrl(p.kind, p.url, repo);
    if (!parts) {
      errors.push(`${tag}: URL does not match the ${p.kind} template for ${repo}`);
      continue;
    }
    const ex = (p.extracted && typeof p.extracted === "object") ? p.extracted : {};
    if (p.kind === "pr") {
      use(`${tag}.url`, parts.prNumber, "pr");
      use(`${tag}.head_sha`, ex.head_sha, "head");
    } else if (p.kind === "check_run") {
      use(`${tag}.head_sha`, ex.head_sha, "head");
    } else if (p.kind === "check_runs_list") {
      use(`${tag}.url-sha`, parts.sha, "head");
    } else if (p.kind === "files" || p.kind === "reviews") {
      use(`${tag}.url`, parts.prNumber, "pr");
    } else if (p.kind === "contents") {
      use(`${tag}.ref`, parts.ref, "head");
    } else if (p.kind === "identity" || p.kind === "base_check") {
      // URL already pinned above; neither contributes PR/head join keys
      // (identity binds logins, base legs anchor to base_commit downstream).
    } else {
      errors.push(`${tag}: unknown evidence kind '${p.kind}'`);
    }
  }
  if (!proofs.some((p) => p && p.kind === "pr")) errors.push("claim must include exactly the PR proof anchor (>= 1 pr proof)");
  if (heads.size > 1) errors.push(`head SHAs diverge: ${[...heads].join(", ")}`);
  if (prNumber === null) errors.push("no PR number established");
  if (heads.size === 0) errors.push("no head SHA established");
  return { ok: errors.length === 0, head: heads.size === 1 ? [...heads][0] : null, prNumber, errors };
}

// -- Nullifier scoping -----------------------------------------------------------
/// V3 replay key: keccak256("OMNIBOUNTY-V3-NULL" || bounty_id:u64be ||
/// recipient:20B || evidence_type:u8 || identifier:32B). Scopes every proof
/// to one (bounty, recipient, evidence type) so the same evidence can back
/// distinct bounties/recipients without cross-replay, and no proof can be
/// reused. Returns 0x-prefixed lowercase hex. Throws on malformed inputs.
export function buildNullifierKey({ bountyId, recipient, evidenceType, identifier }) {
  const bid = typeof bountyId === "bigint" ? bountyId : BigInt(bountyId);
  if (bid < 0n || bid > U64_MAX) throw new Error("buildNullifierKey: bountyId out of u64 range");
  const recip = String(recipient).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(recip)) throw new Error("buildNullifierKey: recipient must be 20-byte hex");
  if (!Number.isInteger(evidenceType) || evidenceType < 1 || evidenceType > 255) {
    throw new Error("buildNullifierKey: evidenceType must be a u8");
  }
  const ident = String(identifier).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(ident)) throw new Error("buildNullifierKey: identifier must be 32-byte hex");
  const u64be = bid.toString(16).padStart(16, "0");
  const preimage = ethers.concat([
    ethers.toUtf8Bytes(NULLIFIER_DOMAIN),
    ethers.getBytes(`0x${u64be}`),
    ethers.getBytes(`0x${recip}`),
    ethers.getBytes(`0x${evidenceType.toString(16).padStart(2, "0")}`),
    ethers.getBytes(`0x${ident}`),
  ]);
  return ethers.keccak256(preimage);
}
