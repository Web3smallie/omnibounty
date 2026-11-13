// V3 Reclaim proof requests: endpoints, headers, and response matchers that
// satisfy the NEAR V3 contract's template checks. Pure, dependency-free,
// shared by the prove scripts and node:test.
//
// Every constant below is traced to the Rust source it must match:
// - evidence numbers: contracts/near-v3/src/reclaim.rs `EvidenceType`
// - PR matchers:      contracts/near-v3/src/rules.rs `mandated_matchers` (Pr arm)
// - identity matchers: same, Identity arm
// - Accept header:    contracts/near-v3/src/rules.rs `required_headers`
// - identity endpoint: contracts/near-v3/src/rules.rs `match_endpoint_url`
// frontend/test/reclaim.test.mjs cross-checks these against that source so
// contract drift fails loudly instead of shipping a subtly invalid prover.

// Numeric evidence tags: TaggedProofArg { evidence_type: u8, proof }.
export const EVIDENCE = {
  Pr: 1,
  CheckRun: 2,
  Files: 3,
  Review: 4,
  Contents: 5,
  Diff: 6,
  Identity: 7,
  BaseCheck: 8,
};

export const GITHUB_ACCEPT = "application/vnd.github+json";
export const IDENTITY_URL = "https://api.github.com/user";
export const USER_AGENT = "omnibounty-prove/1.0";

export function prUrl(repo, prNumber) {
  return `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
}

// The 7 unconditional PR matchers. Conditional criteria (author_association,
// base_commit, files, labels, issue, commitment marker) add more at
// evaluation time; the demo bounty constrains none of them, so these 7 are
// the complete set a demo proof needs. Verbatim from rules.rs.
export const PR_MATCHERS = [
  '"merged":(?<merged>.*?)[,}]',
  '"login":"(?<author>.*?)"',
  '"full_name":"(?<repo>.*?)"',
  '"number":(?<number>.*?)[,}]',
  '"sha":"(?<head_sha>[0-9a-f]{40})"',
  '"user":\\{[^}]*?"id":(?<author_id>[0-9]+)[,}]',
  '"created_at":"(?<pr_created>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)"',
];

// Identity matchers: top-level login first, numeric id second. Verbatim.
export const IDENTITY_MATCHERS = [
  '"login":"(?<id_login>[^"]+)"',
  '"id":(?<id_num>[0-9]+)[,}]',
];

export function toResponseMatches(matchers) {
  return matchers.map((value) => ({ type: "regex", value }));
}

/// zkFetch arguments for a V3 PR proof. Public headers are revealed in the
/// signed parameters (the contract pins Accept); nothing secret is involved.
export function buildPrProofRequest(repo, prNumber) {
  return {
    url: prUrl(repo, prNumber),
    publicOptions: {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: GITHUB_ACCEPT },
    },
    privateOptions: { responseMatches: toResponseMatches(PR_MATCHERS) },
  };
}

/// zkFetch arguments for a V3 identity proof. The claimant's GitHub token
/// travels ONLY in privateOptions.headers, which the SDK keeps hidden from
/// the verifier (never in the signed parameters, never on-chain). The caller
/// must pass the token straight from its own environment and never log it.
export function buildIdentityProofRequest(authorizationHeader) {
  return {
    url: IDENTITY_URL,
    publicOptions: {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: GITHUB_ACCEPT },
    },
    privateOptions: {
      headers: { Authorization: authorizationHeader },
      responseMatches: toResponseMatches(IDENTITY_MATCHERS),
    },
  };
}

function isCanonicalNumber(s) {
  return typeof s === "string" && /^[0-9]+$/.test(s) && (s === "0" || !s.startsWith("0"));
}

/// Fail-fast local check that a fresh PR proof carries every extraction the
/// contract mandates (before the user submits). `ex` is the proof's
/// extractedParameters. Returns a list of problems (empty = OK).
export function checkPrExtractions(ex, repo, prNumber) {
  const problems = [];
  if (!ex || typeof ex !== "object") return ["no extracted parameters"];
  if (ex.merged !== "true") problems.push(`merged=${JSON.stringify(ex.merged)} (PR is not merged?)`);
  if (ex.repo !== repo) problems.push(`repo=${JSON.stringify(ex.repo)} (want ${repo})`);
  if (ex.number !== String(prNumber)) problems.push(`number=${JSON.stringify(ex.number)} (want ${prNumber})`);
  if (!ex.author) problems.push("missing author");
  if (typeof ex.head_sha !== "string" || !/^[0-9a-f]{40}$/.test(ex.head_sha)) {
    problems.push(`head_sha=${JSON.stringify(ex.head_sha)} (want 40 hex chars)`);
  }
  if (!isCanonicalNumber(ex.author_id)) problems.push(`author_id=${JSON.stringify(ex.author_id)} (want numeric user id)`);
  if (typeof ex.pr_created !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(ex.pr_created)) {
    problems.push(`pr_created=${JSON.stringify(ex.pr_created)} (want RFC3339 UTC)`);
  }
  return problems;
}

/// Same for an identity proof: login + numeric id must be present.
export function checkIdentityExtractions(ex) {
  const problems = [];
  if (!ex || typeof ex !== "object") return ["no extracted parameters"];
  if (typeof ex.id_login !== "string" || ex.id_login.length === 0) problems.push("missing id_login");
  if (!isCanonicalNumber(ex.id_num)) problems.push(`id_num=${JSON.stringify(ex.id_num)} (want numeric user id)`);
  return problems;
}

/// The contract's authorship chain, mirrored client-side for early errors:
/// the authenticated identity must BE the PR author (login + immutable
/// numeric id), and every proof owner must equal the payout recipient
/// (owner==recipient is enforced per proof on-chain). Returns problems.
export function checkIdentityBinding({ prAuthor, prAuthorId, idLogin, idNum, proofOwners, recipient }) {
  const problems = [];
  if (prAuthor !== idLogin) problems.push(`identity login ${JSON.stringify(idLogin)} is not the PR author ${JSON.stringify(prAuthor)}`);
  if (prAuthorId !== idNum) problems.push(`identity id ${JSON.stringify(idNum)} is not the PR author id ${JSON.stringify(prAuthorId)}`);
  const want = String(recipient).toLowerCase();
  for (const o of proofOwners ?? []) {
    if (String(o).toLowerCase() !== want) problems.push(`proof owner ${o} does not match recipient ${recipient}`);
  }
  return problems;
}

/// extractedParameters of a NORMALIZED proof (claimInfo.context JSON).
/// Returns null when unparseable (caller reports the error).
export function extractedOf(normalized) {
  try {
    const ctx = JSON.parse(normalized?.claimInfo?.context ?? "");
    const ex = ctx?.extractedParameters;
    return ex && typeof ex === "object" ? ex : null;
  } catch {
    return null;
  }
}
