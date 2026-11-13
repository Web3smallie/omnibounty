//! V3 criterion evaluation over verified, joined evidence.
//!
//! Pipeline (pure functions; state effects live in lib.rs):
//! 1. `match_endpoint_url` — pin each proof's URL to its endpoint template.
//! 2. `mandated_matchers` — build the exact matcher multiset each proof must
//!    contain (fixed shapes + criteria-derived anchored patterns).
//! 3. `matchers_satisfied` — subset check over signed params (extras allowed).
//! 4. `join_evidence` — cross-proof equality: PR numbers, head SHAs, refs.
//! 5. `evaluate` — every criterion rule over joined evidence, returning the
//!    full verdict vector (shared by `qualify_claim` and `dry_qualify`).
//!
//! Tri-state: PASS (evidence present, rule holds), FAIL (present, violated),
//! UNVERIFIED (evidence missing/incomplete). UNVERIFIED never passes.
//!
//! Design notes (audited, see docs/v3/VERIFICATION_MATRIX.md):
//! - Interpolated values (labels, keywords) are regex-escaped by
//!   `escape_regex_literal`; check names and logins are never interpolated
//!   (extracted + compared instead).
//! - Array binding uses anchored occurrence patterns validated live in
//!   Phase 1/2 (P2-03); row counts bind to attested `changed_files`.
//! - There is deliberately NO challenge counter-evidence engine: with
//!   deterministic point-in-time verification, counter-evidence challenges
//!   are vacuous (mutable classes cannot be absence-proven; immutable
//!   classes cannot regress). The challenge window is a transparency delay
//!   plus a pause hook. See NEAR_V3_DESIGN.md.

use crate::error::ClaimError;
use crate::reclaim::EvidenceType;
use serde_json::Value;

/// Maximum proofs evaluated in one claim (gas-bounded).
pub const MAX_CLAIM_PROOFS: usize = 40;
/// Maximum changed files a files-constrained claim can enumerate
/// (one anchored row pattern per file; see matrix R-File).
pub const MAX_ATTESTED_ROWS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    Fail,
    Unverified,
}

#[derive(Debug, Clone)]
pub struct CriterionVerdict {
    pub id: String,
    pub status: Verdict,
    pub detail: String,
}

fn pass(id: &str) -> CriterionVerdict {
    CriterionVerdict {
        id: id.to_string(),
        status: Verdict::Pass,
        detail: String::new(),
    }
}

fn fail(id: &str, detail: String) -> CriterionVerdict {
    CriterionVerdict {
        id: id.to_string(),
        status: Verdict::Fail,
        detail,
    }
}

fn unverified(id: &str, detail: String) -> CriterionVerdict {
    CriterionVerdict {
        id: id.to_string(),
        status: Verdict::Unverified,
        detail,
    }
}

// -- Endpoint URL templates (mirror TS matchEndpointUrl exactly) -------------

/// Split a URL of the exact form `https://api.github.com/repos/{repo}/...`.
/// Returns the path remainder or None. Byte-exact; no normalization.
fn repo_remainder<'a>(url: &'a str, repo: &str) -> Option<&'a str> {
    let prefix = format!("https://api.github.com/repos/{repo}/");
    url.strip_prefix(&prefix)
}

fn is_canonical_number(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 20
        && (s == "0" || (s.as_bytes()[0] != b'0' && s.bytes().all(|b| b.is_ascii_digit())))
}

/// Match a proof URL against its endpoint template. Returns join keys.
/// Mirrors `matchEndpointUrl` in frontend/lib/criteria.mjs case-for-case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UrlMatch {
    Pr {
        pr_number: String,
    },
    CheckRun {
        run_id: String,
    },
    // No constructor: list proofs have no consumer in V3 (existential
    // single-run design). The variant is kept so `join_evidence` fails
    // closed — never silently ignores — if one is ever produced.
    #[allow(dead_code)]
    CheckRunsList {
        sha: String,
    },
    Files {
        pr_number: String,
    },
    Reviews {
        pr_number: String,
    },
    Contents {
        path: String,
        git_ref: String,
    },
    Identity,
    BaseCheck {
        run_id: String,
    },
}

pub fn match_endpoint_url(kind: EvidenceType, url: &str, repo: &str) -> Option<UrlMatch> {
    // Identity proofs hit the authenticated user endpoint: exact match, no
    // repo scope, no query string. The session behind the TLS connection —
    // not the URL — is what binds the response to the prover.
    if kind == EvidenceType::Identity {
        if url != "https://api.github.com/user" {
            return None;
        }
        return Some(UrlMatch::Identity);
    }
    let rest = repo_remainder(url, repo)?;
    match kind {
        EvidenceType::Identity => None, // handled above
        EvidenceType::BaseCheck => {
            let id = rest.strip_prefix("check-runs/")?;
            if id.is_empty() || !is_canonical_number(id) || id == "0" || id.contains('/') {
                return None;
            }
            Some(UrlMatch::BaseCheck {
                run_id: id.to_string(),
            })
        }
        EvidenceType::Pr => {
            let n = rest.strip_prefix("pulls/")?;
            if n.is_empty() || !is_canonical_number(n) || n == "0" || n.contains('/') {
                return None;
            }
            Some(UrlMatch::Pr {
                pr_number: n.to_string(),
            })
        }
        EvidenceType::CheckRun => {
            let id = rest.strip_prefix("check-runs/")?;
            if id.is_empty() || !is_canonical_number(id) || id == "0" || id.contains('/') {
                return None;
            }
            Some(UrlMatch::CheckRun {
                run_id: id.to_string(),
            })
        }
        EvidenceType::Files => {
            let inner = rest.strip_prefix("pulls/")?;
            let (num, tail) = inner.split_once('/')?;
            if num.is_empty() || !is_canonical_number(num) || num == "0" {
                return None;
            }
            if tail != "files" && !tail.starts_with("files?") {
                return None;
            }
            Some(UrlMatch::Files {
                pr_number: num.to_string(),
            })
        }
        EvidenceType::Review => {
            let inner = rest.strip_prefix("pulls/")?;
            let (num, tail) = inner.split_once('/')?;
            if num.is_empty() || !is_canonical_number(num) || num == "0" {
                return None;
            }
            if tail != "reviews" && !tail.starts_with("reviews?") {
                return None;
            }
            Some(UrlMatch::Reviews {
                pr_number: num.to_string(),
            })
        }
        EvidenceType::Contents => {
            let inner = rest.strip_prefix("contents/")?;
            let (path, query) = inner.split_once('?')?;
            if path.is_empty() || path.contains('?') {
                return None;
            }
            let git_ref = query.strip_prefix("ref=")?;
            if git_ref.len() != 40 || !git_ref.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            Some(UrlMatch::Contents {
                path: path.to_string(),
                git_ref: git_ref.to_lowercase(),
            })
        }
        EvidenceType::Diff => {
            // Diff proofs share the PR URL shape; representation is pinned by
            // the Accept header rule (see required_headers), not the URL.
            let n = rest.strip_prefix("pulls/")?;
            if n.is_empty() || !is_canonical_number(n) || n == "0" || n.contains('/') {
                return None;
            }
            Some(UrlMatch::Pr {
                pr_number: n.to_string(),
            })
        }
    }
}

/// Escape a literal for interpolation into an attested regex pattern.
/// Backslash-escapes every regex metacharacter; the set is valid in PCRE,
/// Go regexp and Rust regex alike. Used for sponsor-authored free text
/// (labels, keywords) so injection can only fail closed, never rebind.
pub fn escape_regex_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if matches!(
            c,
            '\\' | '^' | '$' | '.' | '|' | '?' | '*' | '+' | '(' | ')' | '[' | ']' | '{' | '}'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Required request headers per evidence type, checked against signed params.
/// `None` value means "must be absent or differ" (the PR-vs-diff split).
/// Pinned request headers per evidence kind (VERIFICATION_MATRIX
/// conventions): the `Accept` value selects GitHub's response
/// representation, so it is exact-matched. Without this pin a PR-tagged
/// proof could fetch `Accept: diff` and match JSON-key regexes against
/// attacker-planted diff lines (full identity forgery), or a Diff-tagged
/// proof could match patch strings against PR JSON metadata. JSON proofs
/// MUST set `Accept: application/vnd.github+json` (custom Accept headers
/// are proven recordable per EXP-08, which pins the diff value the same
/// way); extra headers (User-Agent, …) are permitted.
pub fn required_headers(kind: EvidenceType) -> Vec<(&'static str, &'static str)> {
    let accept = match kind {
        EvidenceType::Diff => "application/vnd.github.diff",
        _ => "application/vnd.github+json",
    };
    vec![("Accept", accept)]
}

/// Issue close-reference matcher, shared by mandated-set construction and
/// rule evaluation so they cannot disagree (same precedent as
/// `label_pattern`).
pub(crate) fn close_ref_matcher(issue: &crate::criteria::IssueRule) -> (String, String) {
    let alts: Vec<String> = issue
        .keywords
        .iter()
        .map(|k| format!("{} #{}", escape_regex_literal(k), issue.number))
        .collect();
    (
        "regex".to_string(),
        format!("(?<close_ref>{})", alts.join("|")),
    )
}

/// Commitment marker matcher (`contains`, no captures), shared likewise.
pub(crate) fn commitment_marker(bounty_id: u64, recipient_hex: &str) -> (String, String) {
    (
        "contains".to_string(),
        format!("omnibounty:{bounty_id}:{recipient_hex}"),
    )
}

/// Per-reviewer-slot mandated matchers, shared likewise. Slots are
/// independent: each reviewer's proof carries only its own slot's
/// matchers, so multi-reviewer criteria never hit the per-proof cap.
pub(crate) fn review_slot_matchers(
    r: &crate::criteria::ReviewRule,
    index: usize,
) -> Vec<(String, String)> {
    let login = escape_regex_literal(&r.login);
    let mut out = vec![
        (
            "regex".to_string(),
            format!(
                "\"login\":\"{login}\"[\\s\\S]*?\"state\":\"(?<review_{index}_state>.*?)\""
            ),
        ),
        // Commit binding excludes stale approvals: the reviewed commit
        // must equal the joined head (checked in evaluate()).
        (
            "regex".to_string(),
            format!(
                "\"login\":\"{login}\"[\\s\\S]*?\"commit_id\":\"(?<review_{index}_commit>[0-9a-f]{{40}})\""
            ),
        ),
    ];
    if !r.associations.is_empty() {
        out.push((
            "regex".to_string(),
            format!(
                "\"login\":\"{login}\"[\\s\\S]*?\"author_association\":\"(?<review_{index}_assoc>.*?)\""
            ),
        ));
    }
    out
}

/// Mandated matcher multiset for one proof: Vec<(type, value)> that MUST be
/// a subset of the signed params.responseMatches. Extras are permitted
/// with one exception (see `proof_covers`): no extra matcher may redefine
/// a capture group belonging to the mandated set, since duplicate-group
/// resolution is engine-defined and unverified.
/// `row_count` (files only): number of anchored row patterns required.
pub fn mandated_matchers(
    kind: EvidenceType,
    criteria: &crate::criteria::ValidatedCriteria,
    bounty_id: u64,
    recipient_hex: &str,
    row_count: usize,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rx = |v: String| out.push(("regex".to_string(), v));
    match kind {
        EvidenceType::Pr => {
            // Base set is unconditional (identity + join keys). Conditional
            // fields join only when the criteria constrains them, keeping
            // typical proofs small while preserving exact coverage checks.
            // First-occurrence patterns over compact API responses. These
            // are injection-safe as written: inside JSON string values
            // every quote is backslash-escaped, so a `"key":"` shape can
            // only match real structure — never attacker text in titles
            // or bodies (verified by engine-level adversarial vectors in
            // frontend/test/attestor-patterns.test.mjs). Do NOT "tighten"
            // with positional anchors without re-running those vectors:
            // GitHub serialization order is load-bearing.
            rx(r#""merged":(?<merged>.*?)[,}]"#.to_string());
            rx(r#""login":"(?<author>.*?)"#.to_string() + "\"");
            rx(r#""full_name":"(?<repo>.*?)"#.to_string() + "\"");
            rx(r#""number":(?<number>.*?)[,}]"#.to_string());
            rx(r#""sha":"(?<head_sha>[0-9a-f]{40})""#.to_string());
            // Author numeric id, read inside the PR user object (the only
            // `"user":{` whose `"id":` follows before any `}` — user
            // objects carry scalars only). Binds the identity proof by
            // immutable id, immune to login renames.
            rx(r#""user":\{[^}]*?"id":(?<author_id>[0-9]+)[,}]"#.to_string());
            // Authorship timestamp: first top-level `created_at` (strict
            // shape; nested milestone timestamps sort later in GitHub's
            // serialization order). Parsed + sanity-checked at evaluation.
            rx(r#""created_at":"(?<pr_created>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)""#
                .to_string());
            if !criteria.author_association.is_empty() {
                rx(r#""author_association":"(?<author_association>.*?)"#.to_string() + "\"");
            }
            if criteria.base_commit.is_some() {
                rx(r#""base":\{[\s\S]*?"sha":"(?<base_sha>[0-9a-f]{40})""#.to_string());
            }
            if criteria.files.is_some() {
                rx(r#""changed_files":(?<changed_files>[0-9]+)[,}]"#.to_string());
            }
            for (i, label) in criteria.labels.iter().enumerate() {
                rx(label_pattern(label, i));
            }
            if let Some(issue) = criteria.issue.as_ref() {
                if issue.require_close_reference {
                    let (_, value) = close_ref_matcher(issue);
                    rx(value);
                }
            }
            if criteria.identity == crate::criteria::IdentityPolicy::Commitment {
                out.push(commitment_marker(bounty_id, recipient_hex));
            }
        }
        // Head-anchored runs and base-anchored fail-to-pass legs share
        // the extraction set; the evaluation rules split them by commit.
        EvidenceType::CheckRun | EvidenceType::BaseCheck => {
            rx(r#""name":"(?<run_name>.*?)"#.to_string() + "\"");
            rx(r#""head_sha":"(?<head_sha>[0-9a-f]{40})""#.to_string());
            rx(r#""status":"(?<status>.*?)"#.to_string() + "\"");
            rx(r#""conclusion":"(?<conclusion>.*?)"#.to_string() + "\"");
            rx(r#""completed_at":"(?<completed_at>.*?)"#.to_string() + "\"");
            rx(r#""app":\{[^}]*?"slug":"(?<app>.*?)"#.to_string() + "\"");
        }
        EvidenceType::Identity => {
            // Authenticated /user response: top-level login first, numeric
            // id second. `[^"]+` (not `.*?`) — logins cannot quote.
            // `node_id` cannot collide: it lacks the `"id":` prefix shape.
            rx(r#""login":"(?<id_login>[^"]+)""#.to_string());
            rx(r#""id":(?<id_num>[0-9]+)[,}]"#.to_string());
        }
        EvidenceType::Files => {
            for k in 1..=row_count {
                rx(row_pattern(k));
            }
        }
        EvidenceType::Review => {
            for (i, r) in criteria.reviews.iter().enumerate() {
                out.extend(review_slot_matchers(r, i));
            }
        }
        EvidenceType::Contents => {
            rx(r#""path":"(?<path>.*?)"#.to_string() + "\"");
            rx(r#""sha":"(?<blob_sha>[0-9a-f]{40})""#.to_string());
            rx(r#""size":(?<size>[0-9]+)[,}]"#.to_string());
        }
        EvidenceType::Diff => {
            if let Some(files) = criteria.files.as_ref() {
                for s in &files.patch_contains_all {
                    out.push(("contains".to_string(), s.clone()));
                }
            }
        }
    }
    out
}

/// Anchored k-th row pattern for the files endpoint (1-based k).
/// Proven live (P2-03): skip k-1 complete filename keys, span to the next,
/// capture filename/status/additions/deletions.
pub fn row_pattern(k: usize) -> String {
    // Internal invariant (callers iterate 1..=N); debug-only so release
    // builds carry no panic path on this internal index.
    debug_assert!(k >= 1, "row index is 1-based");
    let prefix = if k == 1 {
        String::new()
    } else {
        format!("(?:[\\s\\S]*?\"filename\":\"){{{}}}", k - 1)
    };
    format!(
        "{prefix}\"filename\":\"(?<r{k}_file>[^\"]*)\",\"status\":\"(?<r{k}_status>[^\"]*)\",\"additions\":(?<r{k}_add>[0-9]+),\"deletions\":(?<r{k}_del>[0-9]+)"
    )
}

/// Maximum matchers accepted per proof (carries V2's bound; attestor-side
/// capacity for more is unproven — see P2-04 experiment notes).
pub const MAX_MATCHERS_PER_PROOF: usize = 16;
/// Maximum individual matcher value length (carries V2's bound).
pub const MAX_MATCHER_LEN: usize = 512;
/// Maximum file rows enumerable in one files proof (one anchored row
/// pattern per row; see row_pattern). PRs with more changed files cannot
/// One verified proof as seen by the evaluator: signed params + extracted
/// values. Crypto (identifier, signatures, freshness, replay) is verified
/// by the caller before evaluation; this layer checks binding + rules.
#[derive(Debug, Clone)]
pub struct EvaluatedProof<'a> {
    pub kind: EvidenceType,
    pub params: &'a Value,
    pub extracted: &'a serde_json::Map<String, Value>,
    pub owner: [u8; 20],
    /// Proof identifier (carried for the claim's evidence commitment).
    pub identifier: [u8; 32],
}

fn params_matchers(params: &Value) -> Result<Vec<(String, String)>, ClaimError> {
    let arr = params
        .get("responseMatches")
        .and_then(Value::as_array)
        .ok_or(ClaimError::TemplateMismatch("missing responseMatches"))?;
    if arr.is_empty() || arr.len() > MAX_MATCHERS_PER_PROOF {
        return Err(ClaimError::TemplateMismatch("bad responseMatches"));
    }
    let mut out = Vec::with_capacity(arr.len());
    for m in arr {
        let obj = m
            .as_object()
            .ok_or(ClaimError::TemplateMismatch("bad matcher"))?;
        let typ = obj
            .get("type")
            .and_then(Value::as_str)
            .ok_or(ClaimError::TemplateMismatch("bad matcher type"))?;
        if typ != "regex" && typ != "contains" {
            return Err(ClaimError::TemplateMismatch("bad matcher type"));
        }
        let value = obj
            .get("value")
            .and_then(Value::as_str)
            .ok_or(ClaimError::TemplateMismatch("bad matcher value"))?;
        if value.is_empty() || value.len() > MAX_MATCHER_LEN {
            return Err(ClaimError::TemplateMismatch("bad matcher value"));
        }
        out.push((typ.to_string(), value.to_string()));
    }
    if let Some(redactions) = params.get("responseRedactions") {
        if !redactions.is_array() {
            return Err(ClaimError::TemplateMismatch("bad responseRedactions"));
        }
    }
    Ok(out)
}

fn params_url(params: &Value) -> Result<&str, ClaimError> {
    params
        .get("url")
        .and_then(Value::as_str)
        .ok_or(ClaimError::TemplateMismatch("missing url"))
}

fn params_method_is_get(params: &Value) -> bool {
    params.get("method").and_then(Value::as_str) == Some("GET")
}

fn params_header<'a>(params: &'a Value, name: &str) -> Option<&'a str> {
    let headers = params.get("headers")?.as_object()?;
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .and_then(|(_, v)| v.as_str())
}

/// Multiset subset: every mandated (type, value) must occur in actuals.
/// Extras are permitted (unknown extracted keys are ignored downstream).
fn matchers_satisfied(mandated: &[(String, String)], actual: &[(String, String)]) -> bool {
    let mut remaining: Vec<&(String, String)> = actual.iter().collect();
    'outer: for want in mandated {
        for (i, got) in remaining.iter().enumerate() {
            if got.0 == want.0 && got.1 == want.1 {
                remaining.remove(i);
                continue 'outer;
            }
        }
        return false;
    }
    true
}

fn get_str<'a>(map: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str)
}

/// Joined claim evidence: every proof URL-pinned, PR numbers and head SHAs
/// unified. Mirrors TS `checkCrossProofJoin` verdicts exactly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinedClaim {
    pub pr_number: u64,
    pub head_sha: [u8; 20],
    /// Verified PR authorship timestamp (unix seconds), unified across
    /// all PR proofs like head SHAs. Recorded per claim for ordering.
    pub github_created: u64,
}

pub fn join_evidence(proofs: &[EvaluatedProof<'_>], repo: &str) -> Result<JoinedClaim, ClaimError> {
    if proofs.is_empty() || proofs.len() > MAX_CLAIM_PROOFS {
        return Err(ClaimError::MissingEvidence(
            "empty or oversized bundle".to_string(),
        ));
    }
    let mut pr_number: Option<u64> = None;
    let mut heads: Vec<[u8; 20]> = Vec::new();
    let mut created: Vec<u64> = Vec::new();
    let mut saw_pr = false;
    for p in proofs {
        let url = params_url(p.params)?;
        if !params_method_is_get(p.params) {
            return Err(ClaimError::TemplateMismatch("method must be GET"));
        }
        match match_endpoint_url(p.kind, url, repo) {
            None => return Err(ClaimError::TemplateMismatch("url mismatch")),
            Some(UrlMatch::Pr { pr_number: n }) => {
                // PR and Diff kinds share the URL shape; representation is
                // split by the Accept rule checked in evaluate().
                let n: u64 = n
                    .parse()
                    .map_err(|_| ClaimError::TemplateMismatch("bad pr number"))?;
                if p.kind == EvidenceType::Pr {
                    saw_pr = true;
                    // Authorship timestamp rides with the PR anchor (every
                    // PR proof carries it, like head_sha).
                    let ts = get_str(p.extracted, "pr_created")
                        .and_then(parse_github_time)
                        .ok_or_else(|| ClaimError::MissingEvidence("pr created_at".to_string()))?;
                    created.push(ts);
                }
                match pr_number {
                    None => pr_number = Some(n),
                    Some(m) if m == n => {}
                    _ => return Err(ClaimError::JoinFailed("pr number diverge".to_string())),
                }
            }
            Some(UrlMatch::CheckRun { .. }) => {}
            Some(UrlMatch::CheckRunsList { .. }) => {
                // No consumer in V3 (existential single-run design):
                // dangling evidence fails closed, never ignored.
                return Err(ClaimError::TemplateMismatch("unsupported evidence kind"));
            }
            // Identity proofs carry no PR/head keys: the URL template
            // already pinned them, and the identity rule below consumes
            // their extracted login + numeric id.
            Some(UrlMatch::Identity) => {}
            // Base-anchored fail-to-pass legs must NOT join head unity
            // (their head is the base commit by design); the checks rule
            // anchors them to the pinned base instead.
            Some(UrlMatch::BaseCheck { .. }) => {}
            Some(UrlMatch::Files { pr_number: n }) | Some(UrlMatch::Reviews { pr_number: n }) => {
                let n: u64 = n
                    .parse()
                    .map_err(|_| ClaimError::TemplateMismatch("bad pr number"))?;
                match pr_number {
                    None => pr_number = Some(n),
                    Some(m) if m == n => {}
                    _ => return Err(ClaimError::JoinFailed("pr number diverge".to_string())),
                }
            }
            Some(UrlMatch::Contents { ref git_ref, .. }) => {
                heads.push(parse_sha20(git_ref)?);
            }
        }
        // Head-bearing extractions join here; kinds without head fields skip.
        // Reviews bind their commits in the reviews rule (per-reviewer keys),
        // not here, because review commit keys are reviewer-indexed.
        if p.kind == EvidenceType::Pr || p.kind == EvidenceType::CheckRun {
            let h = get_str(p.extracted, "head_sha")
                .ok_or_else(|| ClaimError::MissingEvidence("head_sha".to_string()))?;
            heads.push(parse_sha20(h)?);
        }
    }
    if !saw_pr {
        return Err(ClaimError::MissingEvidence("pr anchor".to_string()));
    }
    let pr_number =
        pr_number.ok_or_else(|| ClaimError::MissingEvidence("pr number".to_string()))?;
    let first = heads
        .first()
        .ok_or_else(|| ClaimError::MissingEvidence("head sha".to_string()))?;
    if heads.iter().any(|h| h != first) {
        return Err(ClaimError::JoinFailed("head diverge".to_string()));
    }
    let created_first = created
        .first()
        .ok_or_else(|| ClaimError::MissingEvidence("pr created_at".to_string()))?;
    if created.iter().any(|t| t != created_first) {
        return Err(ClaimError::JoinFailed("created_at diverge".to_string()));
    }
    Ok(JoinedClaim {
        pr_number,
        head_sha: *first,
        github_created: *created_first,
    })
}

/// Parse a 20-byte hex SHA via the shared normalizer (accepts mixed case
/// and 0x prefix; comparison always happens on normalized bytes).
pub(crate) fn parse_sha20(s: &str) -> Result<[u8; 20], ClaimError> {
    crate::normalize::parse_hex("sha", s)
}

/// Capture-group names defined by one matcher value. Three textual forms
/// are recognized — `(?<name>...)`, `(?'name'...)`, and `(?P<name>...)` —
/// covering every mainstream engine's named-group syntax, since the
/// attestor's accepted set is not verifiable from here and a missed form
/// would be a bypass (an over-counted form only fails closed).
/// Backslash-escaped characters are skipped as a unit, `[...]` character
/// classes are skipped whole (with `]`-first literal handling, and an
/// unterminated class is treated as literal text so no group is hidden),
/// `(?#...)` comments are skipped to their closer for the same reason,
/// and non-capturing groups (`(?:...)`), lookarounds (`(?<=`, `(?<!` —
/// excluded by name-start rule), and backreferences (`(?P=name)`)
/// never match as definitions.
fn matcher_captures(value: &str) -> Vec<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    // Finds the closing `]` of the class opened at `open`, honoring a
    // leading `]`/`^]` literal and backslash escapes. `None` when
    // unterminated — callers then treat `[` as literal (fail-closed:
    // skipping to EOF could hide a real group from the count).
    let class_end = |open: usize| -> Option<usize> {
        let mut j = open + 1;
        if j < bytes.len() && bytes[j] == b'^' {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b']' {
            j += 1;
        }
        while j < bytes.len() {
            if bytes[j] == b'\\' {
                j += 2;
                continue;
            }
            if bytes[j] == b']' {
                return Some(j + 1);
            }
            j += 1;
        }
        None
    };
    while i + 3 <= bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] == b'[' {
            if let Some(end) = class_end(i) {
                i = end;
                continue;
            }
        }
        if i + 3 <= bytes.len() && &bytes[i..i + 3] == b"(?#" {
            let mut j = i + 3;
            while j < bytes.len() && bytes[j] != b')' {
                if bytes[j] == b'\\' {
                    j += 1;
                }
                j += 1;
            }
            if j < bytes.len() {
                i = j + 1;
                continue;
            }
        }
        let angle = &bytes[i..i + 3] == b"(?<";
        let tick = &bytes[i..i + 3] == b"(?'";
        let pform = i + 4 <= bytes.len() && &bytes[i..i + 4] == b"(?P<";
        // Lookbehinds (`(?<=`, `(?<!`) share the `(?<` prefix but define
        // no group: a name never starts with `=` or `!`.
        let lookaround =
            angle && i + 3 < bytes.len() && (bytes[i + 3] == b'=' || bytes[i + 3] == b'!');
        if (angle || tick || pform) && !lookaround {
            let closer = if tick { b'\'' } else { b'>' };
            let start = if pform { i + 4 } else { i + 3 };
            let mut j = start;
            while j < bytes.len() && bytes[j] != closer {
                if bytes[j] == b'\\' {
                    j += 1;
                }
                j += 1;
            }
            if j < bytes.len() && j > start {
                if let Ok(name) = core::str::from_utf8(&bytes[start..j]) {
                    out.push(name.to_string());
                }
                i = j + 1;
                continue;
            }
            // Malformed (unterminated/empty): keep scanning rather than
            // break — stopping could hide a later real group (fail-open).
            i += 1;
            continue;
        }
        i += 1;
    }
    out
}

/// Single-proof coverage: this proof's OWN matcher set must include every
/// mandated matcher, and every capture group belonging to the mandated
/// set must be defined exactly once across the proof's regex matchers.
/// A duplicate definition could redirect extraction to attacker-chosen
/// content, and duplicate-group resolution is engine-defined — so any
/// duplicate fails closed. `contains` matchers define no captures.
fn proof_covers(params: &Value, mandated: &[(String, String)]) -> bool {
    let actual = match params_matchers(params) {
        Ok(a) => a,
        Err(_) => return false,
    };
    if !matchers_satisfied(mandated, &actual) {
        return false;
    }
    let mut required: Vec<String> = Vec::new();
    for (t, v) in mandated {
        if t == "regex" {
            required.extend(matcher_captures(v));
        }
    }
    for name in &required {
        let mut count = 0;
        for (t, v) in &actual {
            if t != "regex" {
                continue;
            }
            count += matcher_captures(v).iter().filter(|n| *n == name).count();
        }
        if count != 1 {
            return false;
        }
    }
    true
}

/// First proof of the group whose own matchers cover the mandated set.
/// Values are read only from the selected proof: coverage can never be
/// borrowed from one proof while values come from another. Bundle order
/// decides ties only; any single covering proof suffices.
fn select_covering<'a, 'b>(
    proofs: &[&'a EvaluatedProof<'b>],
    mandated: &[(String, String)],
) -> Option<&'a EvaluatedProof<'b>> {
    proofs
        .iter()
        .find(|p| proof_covers(p.params, mandated))
        .copied()
}

/// PR matchers whose extracted values are read from the selected PR proof:
/// the unconditional base plus the conditional association/base/files
/// keys. Labels, the issue close reference, and the commitment marker are
/// enforced separately (per-proof coverage / bound reads), so the core
/// set stays small however many labels a bounty carries.
fn pr_core_matchers(
    criteria: &crate::criteria::ValidatedCriteria,
    bounty_id: u64,
    recipient_hex: &str,
) -> Vec<(String, String)> {
    let full = mandated_matchers(EvidenceType::Pr, criteria, bounty_id, recipient_hex, 0);
    let close = criteria
        .issue
        .as_ref()
        .filter(|i| i.require_close_reference)
        .map(close_ref_matcher);
    let commitment = (criteria.identity == crate::criteria::IdentityPolicy::Commitment)
        .then(|| commitment_marker(bounty_id, recipient_hex));
    full.into_iter()
        .filter(|m| {
            if Some(m) == close.as_ref() || Some(m) == commitment.as_ref() {
                return false;
            }
            !criteria
                .labels
                .iter()
                .enumerate()
                .any(|(i, l)| *m == ("regex".to_string(), label_pattern(l, i)))
        })
        .collect()
}

/// Full criterion evaluation over a joined bundle. Structural stages
/// (shape, owner, matchers, join) return `Err` directly; per-criterion
/// rules return the complete verdict vector so `dry_qualify` stays
/// transparent. `qualify_claim` fails on the first non-PASS verdict via
/// [`first_failure`]. Pure function — no state access.
pub fn evaluate(
    criteria: &crate::criteria::ValidatedCriteria,
    bounty_id: u64,
    recipient_hex: &str,
    proofs: &[EvaluatedProof<'_>],
    now_sec: u64,
) -> Result<(JoinedClaim, Vec<CriterionVerdict>), ClaimError> {
    let mut out = Vec::new();
    if proofs.is_empty() || proofs.len() > MAX_CLAIM_PROOFS {
        return Err(ClaimError::MissingEvidence(
            "empty or oversized bundle".to_string(),
        ));
    }
    if let Some(first) = proofs.first() {
        if proofs.iter().any(|p| p.owner != first.owner) {
            return Err(ClaimError::MixedProverBundle);
        }
    }
    out.push(pass("bundle.shape"));

    // Group proofs by kind for coverage checks.
    let by_kind = |k: EvidenceType| -> Vec<&EvaluatedProof<'_>> {
        proofs.iter().filter(|p| p.kind == k).collect()
    };
    // Every proof's matcher shapes must be well-formed (bounded, typed),
    // and its pinned request headers must exact-match (representation
    // discriminator — see required_headers).
    for p in proofs.iter() {
        params_matchers(p.params)
            .map_err(|_| ClaimError::TemplateMismatch("bad responseMatches"))?;
        for (name, want) in required_headers(p.kind) {
            if params_header(p.params, name) != Some(want) {
                return Err(ClaimError::TemplateMismatch("bad Accept header"));
            }
        }
    }
    out.push(pass("bundle.matchers"));

    // Mandated coverage binds values to proofs: every authorization value
    // is read only from a proof whose OWN matcher set covers the matchers
    // for that value. Union coverage across proofs is never used — one
    // proof must not borrow coverage from another while supplying values.
    // PR proofs are always required (the anchor).
    let pr_proofs = by_kind(EvidenceType::Pr);
    if pr_proofs.is_empty() {
        return Err(ClaimError::MissingEvidence("no PR proof".to_string()));
    }
    let pr_core = pr_core_matchers(criteria, bounty_id, recipient_hex);
    let pr = select_covering(&pr_proofs, &pr_core)
        .ok_or(ClaimError::TemplateMismatch("PR mandated matchers"))?;
    out.push(pass("pr.matchers"));
    // Commitment marker: coverage-only, so any single PR proof may carry
    // it (checked separately to keep the value-bound core set small).
    if criteria.identity == crate::criteria::IdentityPolicy::Commitment {
        let marker = commitment_marker(bounty_id, recipient_hex);
        let covered = pr_proofs.iter().any(|p| {
            params_matchers(p.params)
                .map(|actual| matchers_satisfied(core::slice::from_ref(&marker), &actual))
                .unwrap_or(false)
        });
        if !covered {
            return Err(ClaimError::TemplateMismatch("PR commitment marker"));
        }
    }

    // Identity anchor: every claim carries the prover's authenticated
    // GitHub identity; without it authorship is unbound.
    let id_proofs = by_kind(EvidenceType::Identity);
    if id_proofs.is_empty() {
        return Err(ClaimError::MissingEvidence("identity proof".to_string()));
    }
    let id_mandated = mandated_matchers(
        EvidenceType::Identity,
        criteria,
        bounty_id,
        recipient_hex,
        0,
    );
    let id_selected = select_covering(&id_proofs, &id_mandated)
        .ok_or(ClaimError::TemplateMismatch("identity mandated matchers"))?;
    out.push(pass("identity.matchers"));

    // Cross-proof join (URLs, PR numbers, heads).
    let joined = join_evidence(proofs, &criteria.repo)?;
    out.push(pass("bundle.join"));

    // From here on, per-criterion verdicts (all evaluated, none short-circuit
    // except through missing prerequisites, which yield UNVERIFIED).
    let prx = pr.extracted;
    let get = |k: &str| get_str(prx, k);

    // Identity + merge + fork + association + base.
    match criteria.merge_policy {
        crate::criteria::MergePolicy::Merged => match get("merged") {
            Some("true") => out.push(pass("pr.merged")),
            Some(_) => out.push(fail("pr.merged", "merged != true".to_string())),
            None => out.push(unverified("pr.merged", "missing merged".to_string())),
        },
        crate::criteria::MergePolicy::CiVerified => out.push(pass("pr.merged")),
    }
    match get("author") {
        Some(a) if !a.is_empty() && a.len() <= 128 => out.push(pass("pr.author")),
        Some(_) => out.push(fail("pr.author", "bad author".to_string())),
        None => out.push(unverified("pr.author", "missing author".to_string())),
    }
    if !criteria.allow_forks {
        match get("repo") {
            Some(r) if r == criteria.repo => out.push(pass("pr.forks")),
            Some(_) => out.push(fail("pr.forks", "fork head rejected".to_string())),
            None => out.push(unverified("pr.forks", "missing repo".to_string())),
        }
    } else {
        out.push(pass("pr.forks"));
    }
    if !criteria.author_association.is_empty() {
        match get("author_association") {
            Some(a) if criteria.author_association.iter().any(|x| x == a) => {
                out.push(pass("pr.association"))
            }
            Some(_) => out.push(fail(
                "pr.association",
                "association not allowed".to_string(),
            )),
            None => out.push(unverified(
                "pr.association",
                "missing association".to_string(),
            )),
        }
    }
    if let Some(base) = criteria.base_commit {
        match get("base_sha").and_then(|s| parse_sha20(s).ok()) {
            Some(h) if h == base => out.push(pass("pr.base")),
            Some(_) => out.push(fail("pr.base", "base mismatch".to_string())),
            None => out.push(unverified("pr.base", "missing base_sha".to_string())),
        }
    }
    // Identity binding: the authenticated GitHub identity must BE the PR
    // author — immutable numeric id first, login as consistency. Together
    // with pre-evaluation owner==recipient, this closes the chain payout
    // recipient <-> proof owner <-> GitHub account <-> PR author.
    let idx = id_selected.extracted;
    let id_login = get_str(idx, "id_login");
    let id_num = get_str(idx, "id_num").filter(|s| is_canonical_number(s));
    let author_id = get("author_id").filter(|s| is_canonical_number(s));
    match (get("author"), id_login) {
        (Some(a), Some(b)) if a == b => out.push(pass("identity.login")),
        (Some(_), Some(_)) => out.push(fail(
            "identity.login",
            "identity is not the PR author".to_string(),
        )),
        _ => out.push(unverified("identity.login", "missing login".to_string())),
    }
    match (author_id, id_num) {
        (Some(a), Some(b)) if a == b => out.push(pass("identity.id")),
        (Some(_), Some(_)) => out.push(fail(
            "identity.id",
            "identity is not the PR author".to_string(),
        )),
        _ => out.push(unverified("identity.id", "missing numeric id".to_string())),
    }
    // Authorship clock sanity: PR "created in the future" is forged or
    // mis-attested (300s tolerance mirrors the check-age rule).
    if joined.github_created <= now_sec.saturating_add(300) {
        out.push(pass("pr.created_at"));
    } else {
        out.push(fail("pr.created_at", "creation in the future".to_string()));
    }
    // Commitment identity: marker presence was already enforced by the
    // mandated-subset check; record the verdict explicitly.
    if criteria.identity == crate::criteria::IdentityPolicy::Commitment {
        out.push(pass("identity.commitment"));
    }

    // Checks: each required entry needs a satisfying proof whose OWN
    // matchers cover the mandated check set (same-proof binding: values
    // and coverage can never come from different proofs).
    let check_mandated = mandated_matchers(
        EvidenceType::CheckRun,
        criteria,
        bounty_id,
        recipient_hex,
        0,
    );
    for req in &criteria.checks {
        let mut satisfied = false;
        let mut detail = String::from("no qualifying run attested");
        for p in by_kind(EvidenceType::CheckRun) {
            let ex = p.extracted;
            let name_ok = get_str(ex, "run_name") == Some(req.name.as_str());
            let status_ok = get_str(ex, "status") == Some("completed");
            let concl_ok = get_str(ex, "conclusion") == Some("success");
            let app_ok = get_str(ex, "app")
                .map(|a| req.apps.iter().any(|x| x == a))
                .unwrap_or(false);
            if !(name_ok && status_ok && concl_ok && app_ok) {
                continue;
            }
            if let Some(max_age) = criteria.check_max_age {
                match get_str(ex, "completed_at").and_then(parse_github_time) {
                    Some(ts)
                        if ts <= now_sec.saturating_add(300)
                            && now_sec.saturating_sub(ts) <= max_age => {}
                    _ => {
                        detail = "run too old or bad timestamp".to_string();
                        continue;
                    }
                }
            }
            if !proof_covers(p.params, &check_mandated) {
                detail = "qualifying run lacks mandated matchers".to_string();
                continue;
            }
            satisfied = true;
            break;
        }
        if !satisfied {
            out.push(fail(&format!("check:{}", req.name), detail));
        } else {
            out.push(pass(&format!("check:{}", req.name)));
        }
        // Fail-to-pass leg: the same check must demonstrably fail on the
        // pinned base commit. Base-anchored runs are exempt from recency
        // (their completion is supposed to be old); attestation freshness
        // still applies via the standard proof checks.
        if req.fail_at_base {
            // Same-proof binding: the leg's values and its mandated
            // matchers must come from one BaseCheck proof.
            let base_mandated = mandated_matchers(
                EvidenceType::BaseCheck,
                criteria,
                bounty_id,
                recipient_hex,
                0,
            );
            let base_ok = match criteria.base_commit {
                Some(base) => by_kind(EvidenceType::BaseCheck).iter().any(|p| {
                    let head_ok = get_str(p.extracted, "head_sha")
                        .and_then(|s| parse_sha20(s).ok())
                        .map(|h| h == base)
                        .unwrap_or(false);
                    head_ok
                        && get_str(p.extracted, "run_name") == Some(req.name.as_str())
                        && get_str(p.extracted, "status") == Some("completed")
                        && get_str(p.extracted, "conclusion") == Some("failure")
                        && get_str(p.extracted, "app")
                            .map(|a| req.apps.iter().any(|x| x == a))
                            .unwrap_or(false)
                        && proof_covers(p.params, &base_mandated)
                }),
                // Unreachable: criteria validation requires a base commit
                // whenever any rule demands a base leg.
                None => false,
            };
            if base_ok {
                out.push(pass(&format!("check:{}:base", req.name)));
            } else {
                out.push(fail(
                    &format!("check:{}:base", req.name),
                    "no failing base run attested".to_string(),
                ));
            }
        }
    }

    // Files rules.
    if let Some(files) = criteria.files.as_ref() {
        let file_proofs = by_kind(EvidenceType::Files);
        // Row count comes from the PR proof's changed_files (attested).
        let changed: Option<u64> = get("changed_files").and_then(|s| {
            if s.bytes().all(|b| b.is_ascii_digit()) && !s.is_empty() {
                s.parse::<u64>().ok()
            } else {
                None
            }
        });
        let changed = match changed {
            Some(n) => n,
            None => {
                return Err(ClaimError::MissingEvidence("files.count".to_string()));
            }
        };
        if changed as usize > MAX_ATTESTED_ROWS {
            return Err(ClaimError::MissingEvidence(
                "files.count exceeds row bound".to_string(),
            ));
        }
        if file_proofs.is_empty() {
            return Err(ClaimError::MissingEvidence("files proof".to_string()));
        }
        // Row patterns for rows 1..=changed must be covered.
        let mut want: Vec<(String, String)> = Vec::new();
        for k in 1..=changed.max(1) as usize {
            if changed == 0 {
                break;
            }
            want.push(("regex".to_string(), row_pattern(k)));
        }
        // Collect rows from the first proof that both covers every row
        // pattern and supplies complete rows (same-proof binding: rows
        // can never be borrowed from a non-covering proof).
        let mut rows: Vec<(String, String, u64, u64)> = Vec::new();
        let mut rows_ok = false;
        let mut covered_any = false;
        for p in file_proofs {
            if !proof_covers(p.params, &want) {
                continue;
            }
            covered_any = true;
            let mut candidate = Vec::new();
            let mut complete = true;
            for k in 1..=(changed as usize) {
                let key = |s: &str| format!("r{k}_{s}");
                let f = get_str(p.extracted, &key("file"));
                let st = get_str(p.extracted, &key("status"));
                let a = get_str(p.extracted, &key("add")).and_then(|s| s.parse::<u64>().ok());
                let d = get_str(p.extracted, &key("del")).and_then(|s| s.parse::<u64>().ok());
                match (f, st, a, d) {
                    (Some(f), Some(st), Some(a), Some(d)) => {
                        if f.contains('\\') || f.contains('"') {
                            complete = false; // fail-closed on quotable names
                            break;
                        }
                        candidate.push((f.to_string(), st.to_string(), a, d));
                    }
                    _ => {
                        complete = false;
                        break;
                    }
                }
            }
            if complete {
                rows = candidate;
                rows_ok = true;
                break;
            }
        }
        if !covered_any {
            return Err(ClaimError::TemplateMismatch("files row patterns"));
        }
        if !rows_ok {
            return Err(ClaimError::MissingEvidence("files rows".to_string()));
        }
        out.push(pass("files.rows"));
        if !files.allowed.is_empty() {
            let bad = rows
                .iter()
                .find(|r| !files.allowed.iter().any(|p| matches_path(&r.0, p)));
            match bad {
                None => out.push(pass("files.allowed")),
                Some(r) => out.push(fail("files.allowed", format!("{} not allowed", r.0))),
            }
        }
        let mut forbidden_hit = None;
        for r in &rows {
            if files.forbidden.iter().any(|p| matches_path(&r.0, p)) {
                forbidden_hit = Some(r.0.clone());
                break;
            }
        }
        match forbidden_hit {
            None => out.push(pass("files.forbidden")),
            Some(p) => out.push(fail("files.forbidden", format!("{p} forbidden"))),
        }
        for need in &files.required_touched {
            if rows.iter().any(|r| matches_path(&r.0, need)) {
                out.push(pass(&format!("files.touched:{need}")));
            } else {
                out.push(fail(
                    &format!("files.touched:{need}"),
                    "no changed path matches".to_string(),
                ));
            }
        }
        if let Some(m) = files.max_changed_files {
            if (rows.len() as u64) <= m {
                out.push(pass("files.max_changed"));
            } else {
                out.push(fail(
                    "files.max_changed",
                    format!("{} rows > {m}", rows.len()),
                ));
            }
        }
        let (mut add_sum, mut del_sum) = (0u64, 0u64);
        let mut overflowed = false;
        for r in &rows {
            add_sum = match add_sum.checked_add(r.2) {
                Some(v) => v,
                None => {
                    overflowed = true;
                    break;
                }
            };
            del_sum = match del_sum.checked_add(r.3) {
                Some(v) => v,
                None => {
                    overflowed = true;
                    break;
                }
            };
        }
        if overflowed {
            out.push(fail("files.sums", "addition overflow".to_string()));
            return Ok((joined.clone(), out));
        }
        if let Some(m) = files.max_additions {
            if add_sum <= m {
                out.push(pass("files.max_additions"));
            } else {
                out.push(fail("files.max_additions", format!("{add_sum} > {m}")));
            }
        }
        if let Some(m) = files.max_deletions {
            if del_sum <= m {
                out.push(pass("files.max_deletions"));
            } else {
                out.push(fail("files.max_deletions", format!("{del_sum} > {m}")));
            }
        }
        for s in &files.patch_contains_all {
            // Patch presence is proven by the diff proof's contains matchers
            // (params subset, checked below); here record the verdict id.
            let _ = s;
        }
        if !files.patch_contains_all.is_empty() {
            let diffs = by_kind(EvidenceType::Diff);
            if diffs.is_empty() {
                return Err(ClaimError::MissingEvidence("diff proof".to_string()));
            }
            let mandated =
                mandated_matchers(EvidenceType::Diff, criteria, bounty_id, recipient_hex, 0);
            let covered = diffs.iter().any(|p| {
                params_matchers(p.params)
                    .map(|actual| matchers_satisfied(&mandated, &actual))
                    .unwrap_or(false)
            });
            if covered {
                out.push(pass("files.patch"));
            } else {
                out.push(fail(
                    "files.patch",
                    "required strings not all attested".to_string(),
                ));
            }
        }
        let contents_mandated = mandated_matchers(
            EvidenceType::Contents,
            criteria,
            bounty_id,
            recipient_hex,
            0,
        );
        for prot in &files.protected {
            let mut ok = false;
            for p in by_kind(EvidenceType::Contents) {
                // Same-proof binding: path/blob values count only from a
                // proof carrying the mandated Contents matchers.
                if !proof_covers(p.params, &contents_mandated) {
                    continue;
                }
                let path_ok = get_str(p.extracted, "path") == Some(prot.path.as_str());
                let sha_ok = get_str(p.extracted, "blob_sha")
                    .and_then(|s| parse_sha20(s).ok())
                    .map(|h| h == prot.blob_sha)
                    .unwrap_or(false);
                if path_ok && sha_ok {
                    ok = true;
                    break;
                }
            }
            if ok {
                out.push(pass(&format!("files.protected:{}", prot.path)));
            } else {
                out.push(fail(
                    &format!("files.protected:{}", prot.path),
                    "blob mismatch or missing proof".to_string(),
                ));
            }
        }
    }

    // Labels.
    for (i, label) in criteria.labels.iter().enumerate() {
        // Presence is proven by the anchored label matcher in some PR proof.
        let mandated = vec![("regex".to_string(), label_pattern(label, i))];
        let covered = by_kind(EvidenceType::Pr).iter().any(|p| {
            params_matchers(p.params)
                .map(|actual| matchers_satisfied(&mandated, &actual))
                .unwrap_or(false)
        });
        if covered {
            out.push(pass(&format!("labels:{label}")));
        } else {
            out.push(fail(
                &format!("labels:{label}"),
                "label not attested".to_string(),
            ));
        }
    }

    // Reviews: APPROVED state + commit bound to the joined head (stale
    // approvals excluded) + optional association allowlist.
    for (i, r) in criteria.reviews.iter().enumerate() {
        // Per-slot binding: slot i's values count only from a proof
        // carrying slot i's own mandated matchers (login pin included).
        let slot_mandated = review_slot_matchers(r, i);
        let mut ok = false;
        for p in by_kind(EvidenceType::Review) {
            if !proof_covers(p.params, &slot_mandated) {
                continue;
            }
            let st_key = format!("review_{i}_state");
            if get_str(p.extracted, &st_key) != Some("APPROVED") {
                continue;
            }
            let ck = format!("review_{i}_commit");
            let commit_ok = get_str(p.extracted, &ck)
                .and_then(|s| parse_sha20(s).ok())
                .map(|h| h == joined.head_sha)
                .unwrap_or(false);
            if !commit_ok {
                continue;
            }
            if r.associations.is_empty() {
                ok = true;
                break;
            }
            let ak = format!("review_{i}_assoc");
            if let Some(a) = get_str(p.extracted, &ak) {
                if r.associations.iter().any(|x| x == a) {
                    ok = true;
                    break;
                }
            }
        }
        if ok {
            out.push(pass(&format!("reviews:{}", r.login)));
        } else {
            out.push(fail(
                &format!("reviews:{}", r.login),
                "no qualifying approval".to_string(),
            ));
        }
    }

    // Issue close reference, bound to a proof carrying the close
    // matcher (same-proof binding for the extracted value).
    if let Some(issue) = criteria.issue.as_ref() {
        if issue.require_close_reference {
            let close = close_ref_matcher(issue);
            let mut ok = false;
            for p in by_kind(EvidenceType::Pr) {
                if !proof_covers(p.params, core::slice::from_ref(&close)) {
                    continue;
                }
                if let Some(v) = get_str(p.extracted, "close_ref") {
                    for kw in &issue.keywords {
                        if v == format!("{kw} #{}", issue.number) {
                            ok = true;
                            break;
                        }
                    }
                }
                if ok {
                    break;
                }
            }
            if ok {
                out.push(pass("issue.close_ref"));
            } else {
                out.push(fail("issue.close_ref", "close marker absent".to_string()));
            }
        } else {
            out.push(pass("issue.close_ref"));
        }
    }

    Ok((joined, out))
}

/// Path-pattern matching for files rules: a pattern ending in `/`
/// matches the directory itself and everything beneath it (byte-prefix);
/// any other pattern matches exactly one path (byte-exact). Patterns are
/// pre-validated (no globs, backslashes, empty/`.`/`..` segments), and
/// attested row paths come canonical from the API, so neither side can
/// smuggle alternate representations through this comparison.
pub(crate) fn matches_path(path: &str, pat: &str) -> bool {
    if let Some(dir) = pat.strip_suffix('/') {
        path == dir || path.starts_with(pat)
    } else {
        path == pat
    }
}

/// Anchored single-label presence pattern, indexed so multiple labels in
/// one proof keep distinct group names. Shared by mandated-set
/// construction and rule evaluation so they cannot disagree.
pub(crate) fn label_pattern(label: &str, index: usize) -> String {
    format!(
        "\"labels\":\\[[\\s\\S]*?\"name\":\"(?<label_{index}>{})\"",
        escape_regex_literal(label)
    )
}

/// Map the first non-PASS verdict to its panic code (`qualify_claim`).
/// Structural stages already returned `Err`; this covers rule verdicts.
pub fn first_failure(verdicts: &[CriterionVerdict]) -> Option<ClaimError> {
    for v in verdicts {
        match v.status {
            Verdict::Pass => {}
            Verdict::Fail => {
                return Some(ClaimError::PredicateFailed(format!(
                    "{}: {}",
                    v.id, v.detail
                )))
            }
            Verdict::Unverified => {
                return Some(ClaimError::MissingEvidence(format!(
                    "{}: {}",
                    v.id, v.detail
                )))
            }
        }
    }
    None
}

/// Strict `YYYY-MM-DDTHH:MM:SSZ` (exactly 20 chars) to unix seconds.
/// Rejects everything else (no offsets, no fractions, no leniency).
pub fn parse_github_time(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() != 20 {
        return None;
    }
    if b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[19] != b'Z'
    {
        return None;
    }
    let num = |lo: usize, hi: usize| -> Option<u64> {
        let mut v: u64 = 0;
        for &d in &b[lo..hi] {
            if !d.is_ascii_digit() {
                return None;
            }
            v = v * 10 + (d - b'0') as u64;
        }
        Some(v)
    };
    let (y, mo, d, h, mi, se) = (
        num(0, 4)?,
        num(5, 7)?,
        num(8, 10)?,
        num(11, 13)?,
        num(14, 16)?,
        num(17, 19)?,
    );
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    // Days-from-civil (Howard Hinnant), valid for all realistic years.
    let mut y_adj = y as i64;
    if mo <= 2 {
        y_adj -= 1;
    }
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = (y_adj - era * 400) as u64;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = (era as u64) * 146097 + doe - 719468;
    days.checked_mul(86400)?
        .checked_add(h * 3600 + mi * 60 + se)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::criteria as C;
    use serde_json::json;

    const REPO: &str = "react/react";
    const HEAD: &str = "5621284babc44ced80598504e7aae22f75fb32c1";

    fn ex(pairs: &[(&str, &str)]) -> serde_json::Map<String, Value> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), Value::String(v.to_string())))
            .collect()
    }

    fn base_matchers() -> Vec<(String, String)> {
        vec![
            ("regex".into(), r#""merged":(?<merged>.*?)[,}]"#.into()),
            ("regex".into(), "\"login\":\"(?<author>.*?)\"".into()),
            ("regex".into(), r#""full_name":"(?<repo>.*?)"#.to_string() + "\""),
            ("regex".into(), r#""number":(?<number>.*?)[,}]"#.into()),
            (
                "regex".into(),
                r#""sha":"(?<head_sha>[0-9a-f]{40})""#.into(),
            ),
            (
                "regex".into(),
                r#""user":\{[^}]*?"id":(?<author_id>[0-9]+)[,}]"#.into(),
            ),
            (
                "regex".into(),
                r#""created_at":"(?<pr_created>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)""#
                    .into(),
            ),
        ]
    }

    fn base_extracted() -> serde_json::Map<String, Value> {
        ex(&[
            ("merged", "true"),
            ("author", "acdlite"),
            ("author_id", "10001"),
            ("repo", "react/react"),
            ("number", "38132"),
            ("head_sha", HEAD),
            ("pr_created", "2026-10-26T19:00:00Z"),
        ])
    }

    fn criteria_simple() -> C::ValidatedCriteria {
        let text = include_str!("../../../testdata/v3/criteria-valid/simple-ci.json");
        let v = C::strict_parse(text).unwrap();
        C::validate_criteria(&v).unwrap()
    }

    #[test]
    fn url_templates_mirror_typescript_vectors() {
        // Same vectors as frontend/test/criteria.test.mjs url tests.
        assert_eq!(
            match_endpoint_url(
                EvidenceType::Pr,
                &format!("https://api.github.com/repos/{REPO}/pulls/7"),
                REPO
            ),
            Some(UrlMatch::Pr {
                pr_number: "7".to_string()
            })
        );
        assert_eq!(
            match_endpoint_url(
                EvidenceType::Pr,
                &format!("https://api.github.com/repos/{REPO}/pulls/0"),
                REPO
            ),
            None
        );
        assert_eq!(
            match_endpoint_url(
                EvidenceType::Pr,
                &format!("http://api.github.com/repos/{REPO}/pulls/7"),
                REPO
            ),
            None
        );
        assert_eq!(
            match_endpoint_url(EvidenceType::Identity, "https://api.github.com/user", REPO),
            Some(UrlMatch::Identity)
        );
        assert_eq!(
            match_endpoint_url(
                EvidenceType::Identity,
                "https://api.github.com/user?x=1",
                REPO
            ),
            None
        );
        assert_eq!(
            match_endpoint_url(
                EvidenceType::Identity,
                "https://api.github.com/users/octocat",
                REPO
            ),
            None
        );
        assert_eq!(
            match_endpoint_url(
                EvidenceType::BaseCheck,
                &format!("https://api.github.com/repos/{REPO}/check-runs/9"),
                REPO
            ),
            Some(UrlMatch::BaseCheck {
                run_id: "9".to_string()
            })
        );
        assert_eq!(
            match_endpoint_url(
                EvidenceType::BaseCheck,
                &format!("https://api.github.com/repos/{REPO}/check-runs/0"),
                REPO
            ),
            None
        );
        assert_eq!(
            match_endpoint_url(
                EvidenceType::Contents,
                &format!("https://api.github.com/repos/{REPO}/contents/a/b.yml?ref={HEAD}"),
                REPO
            ),
            Some(UrlMatch::Contents {
                path: "a/b.yml".to_string(),
                git_ref: HEAD.to_string()
            })
        );
        assert_eq!(
            match_endpoint_url(
                EvidenceType::Contents,
                &format!("https://api.github.com/repos/{REPO}/contents/a/b.yml"),
                REPO
            ),
            None
        );
        assert!(match_endpoint_url(
            EvidenceType::Pr,
            "https://api.github.com/repos/o/r/pulls/7",
            REPO
        )
        .is_none());
        // Check runs + files + reviews shapes.
        assert!(matches!(
            match_endpoint_url(
                EvidenceType::CheckRun,
                &format!("https://api.github.com/repos/{REPO}/check-runs/5"),
                REPO
            ),
            Some(UrlMatch::CheckRun { .. })
        ));
        assert!(matches!(
            match_endpoint_url(
                EvidenceType::Files,
                &format!("https://api.github.com/repos/{REPO}/pulls/9/files?per_page=100"),
                REPO
            ),
            Some(UrlMatch::Files { .. })
        ));
        assert!(match_endpoint_url(
            EvidenceType::Files,
            &format!("https://api.github.com/repos/{REPO}/pulls/9/files/extra"),
            REPO
        )
        .is_none());
    }

    #[test]
    fn escape_and_row_patterns_pinned() {
        assert_eq!(escape_regex_literal("C++"), "C\\+\\+");
        assert_eq!(escape_regex_literal("a.c"), "a\\.c");
        assert_eq!(escape_regex_literal("plain"), "plain");
        assert_eq!(
            row_pattern(1),
            "\"filename\":\"(?<r1_file>[^\"]*)\",\"status\":\"(?<r1_status>[^\"]*)\",\"additions\":(?<r1_add>[0-9]+),\"deletions\":(?<r1_del>[0-9]+)"
        );
        assert!(row_pattern(2).starts_with("(?:[\\s\\S]*?\"filename\":\"){1}"));
        assert_eq!(
            label_pattern("CLA Signed", 0),
            "\"labels\":\\[[\\s\\S]*?\"name\":\"(?<label_0>CLA Signed)\""
        );
    }

    #[test]
    fn mandated_pr_set_matches_live_proven_shapes() {
        let c = criteria_simple();
        let m = mandated_matchers(EvidenceType::Pr, &c, 7, "0xabc", 0);
        // simple-ci has no labels/issue/association/base/files and open identity:
        // exactly the 7 base matchers (identity-bound author id + authorship
        // timestamp ride with the anchor).
        assert_eq!(m.len(), 7);
        assert!(m
            .iter()
            .any(|(t, v)| t == "regex" && v.contains("(?<merged>")));
        assert!(m
            .iter()
            .any(|(t, v)| t == "regex" && v.contains("(?<head_sha>")));
        assert!(m
            .iter()
            .any(|(t, v)| t == "regex" && v.contains("(?<author_id>")));
        assert!(m
            .iter()
            .any(|(t, v)| t == "regex" && v.contains("(?<pr_created>")));
    }

    #[test]
    fn mandated_pr_set_byte_exact_pin() {
        // Every pattern must single-quote-terminate, matching the attested
        // live shapes (EXP-02) and VERIFICATION_MATRIX templates. (Raw-string
        // terminators make `""#` vs `"#` easy to misread — this assertion
        // is the guard.)
        let c = criteria_simple();
        let m = mandated_matchers(EvidenceType::Pr, &c, 7, "0xabc", 0);
        let want: Vec<(String, String)> = base_matchers();
        assert_eq!(m, want);
    }

    #[test]
    fn join_accepts_coherent_bundle_rejects_divergence() {
        let owner = [7u8; 20];
        // Test params carry the pinned Accept header per kind, mirroring
        // real prover output (EXP-08 for diff; matrix pin for JSON).
        let mk = |kind, url: String, extracted: serde_json::Map<String, Value>| {
            let accept = match kind {
                EvidenceType::Diff => "application/vnd.github.diff",
                _ => "application/vnd.github+json",
            };
            EvaluatedProof {
                kind,
                params: Box::leak(Box::new(
                    json!({"method": "GET", "url": url, "headers": {"Accept": accept}}),
                )),
                extracted: Box::leak(Box::new(extracted)),
                owner,
                identifier: [0u8; 32],
            }
        };
        let good = vec![
            mk(
                EvidenceType::Pr,
                format!("https://api.github.com/repos/{REPO}/pulls/38132"),
                base_extracted(),
            ),
            mk(
                EvidenceType::CheckRun,
                format!("https://api.github.com/repos/{REPO}/check-runs/5"),
                ex(&[("head_sha", HEAD)]),
            ),
        ];
        let j = join_evidence(&good, REPO).unwrap();
        assert_eq!(j.pr_number, 38132);
        // Divergent head fails.
        let mut bad_ex = base_extracted();
        bad_ex.insert(
            "head_sha".to_string(),
            Value::String("00".to_string() + &HEAD[2..]),
        );
        let bad = vec![
            mk(
                EvidenceType::Pr,
                format!("https://api.github.com/repos/{REPO}/pulls/38132"),
                base_extracted(),
            ),
            mk(
                EvidenceType::CheckRun,
                format!("https://api.github.com/repos/{REPO}/check-runs/5"),
                bad_ex,
            ),
        ];
        assert!(join_evidence(&bad, REPO).is_err());
        // Missing PR anchor fails.
        assert!(join_evidence(&good[1..], REPO).is_err());
    }

    #[test]
    fn evaluate_simple_ci_end_to_end() {
        let c = criteria_simple();
        let owner = [7u8; 20];
        let pr_params = json!({
            "method": "GET",
            "url": format!("https://api.github.com/repos/{REPO}/pulls/38132"),
            "headers": {"Accept": "application/vnd.github+json"},
            "responseMatches": base_matchers().into_iter().map(|(t, v)| json!({"type": t, "value": v})).collect::<Vec<_>>(),
        });
        let check_params = json!({
            "method": "GET",
            "url": format!("https://api.github.com/repos/{REPO}/check-runs/128113730680"),
            "headers": {"Accept": "application/vnd.github+json"},
            "responseMatches": [
                {"type": "regex", "value": "\"name\":\"(?<run_name>.*?)\""},
                {"type": "regex", "value": "\"head_sha\":\"(?<head_sha>[0-9a-f]{40})\""},
                {"type": "regex", "value": "\"status\":\"(?<status>.*?)\""},
                {"type": "regex", "value": "\"conclusion\":\"(?<conclusion>.*?)\""},
                {"type": "regex", "value": "\"completed_at\":\"(?<completed_at>.*?)\""},
                {"type": "regex", "value": "\"app\":\\{[^}]*?\"slug\":\"(?<app>.*?)\""},
            ],
        });
        // Leak boxes to satisfy borrow lifetimes in-test (unit tests only).
        let pr_params: &'static Value = Box::leak(Box::new(pr_params));
        let check_params: &'static Value = Box::leak(Box::new(check_params));
        let id_matchers = mandated_matchers(EvidenceType::Identity, &c, 7, "0xabc", 0);
        let id_params: &'static Value = Box::leak(Box::new(json!({
            "method": "GET",
            "url": "https://api.github.com/user",
            "headers": {"Accept": "application/vnd.github+json"},
            "responseMatches": id_matchers.into_iter().map(|(t, v)| json!({"type": t, "value": v})).collect::<Vec<_>>(),
        })));
        let pr_ex: &'static serde_json::Map<String, Value> = Box::leak(Box::new(base_extracted()));
        let check_ex: &'static serde_json::Map<String, Value> = Box::leak(Box::new(ex(&[
            ("run_name", "cleanup"),
            ("head_sha", HEAD),
            ("status", "completed"),
            ("conclusion", "success"),
            ("completed_at", "2026-10-26T20:17:50Z"),
            ("app", "github-actions"),
        ])));
        let id_ex: &'static serde_json::Map<String, Value> = Box::leak(Box::new(ex(&[
            ("id_login", "acdlite"),
            ("id_num", "10001"),
        ])));
        let proofs = vec![
            EvaluatedProof {
                kind: EvidenceType::Pr,
                params: pr_params,
                extracted: pr_ex,
                owner,
                identifier: [0u8; 32],
            },
            EvaluatedProof {
                kind: EvidenceType::CheckRun,
                params: check_params,
                extracted: check_ex,
                owner,
                identifier: [1u8; 32],
            },
            EvaluatedProof {
                kind: EvidenceType::Identity,
                params: id_params,
                extracted: id_ex,
                owner,
                identifier: [2u8; 32],
            },
        ];
        let (joined, verdicts) = evaluate(&c, 7, "0xabc", &proofs, 1794421000).unwrap();
        assert_eq!(joined.pr_number, 38132);
        assert!(first_failure(&verdicts).is_none(), "verdicts: {verdicts:?}");
        // A failing check conclusion flips exactly its verdict.
        let bad_ex: &'static serde_json::Map<String, Value> = Box::leak(Box::new(ex(&[
            ("run_name", "cleanup"),
            ("head_sha", HEAD),
            ("status", "completed"),
            ("conclusion", "failure"),
            ("completed_at", "2026-10-26T20:17:50Z"),
            ("app", "github-actions"),
        ])));
        let mut bad_proofs = proofs.clone();
        bad_proofs[1].extracted = bad_ex;
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &bad_proofs, 1794421000).unwrap();
        let err = first_failure(&verdicts).expect("must fail");
        assert!(matches!(err, ClaimError::PredicateFailed(_)));
    }

    #[test]
    fn accept_header_pin_enforced() {
        // required_headers pins per VERIFICATION_MATRIX conventions.
        assert_eq!(
            required_headers(EvidenceType::Diff),
            vec![("Accept", "application/vnd.github.diff")]
        );
        assert_eq!(
            required_headers(EvidenceType::Pr),
            vec![("Accept", "application/vnd.github+json")]
        );
        assert_eq!(
            required_headers(EvidenceType::CheckRun),
            vec![("Accept", "application/vnd.github+json")]
        );
        assert_eq!(
            required_headers(EvidenceType::Files),
            vec![("Accept", "application/vnd.github+json")]
        );
        // evaluate() rejects a PR proof carrying the diff Accept: without
        // the pin, JSON-key regexes would run over attacker-influenced
        // diff text (full identity forgery — see required_headers docs).
        let c = criteria_simple();
        let owner = [7u8; 20];
        let bad_params: &'static Value = Box::leak(Box::new(json!({
            "method": "GET",
            "url": format!("https://api.github.com/repos/{REPO}/pulls/38132"),
            "headers": {"Accept": "application/vnd.github.diff"},
            "responseMatches": base_matchers().into_iter().map(|(t, v)| json!({"type": t, "value": v})).collect::<Vec<_>>(),
        })));
        let pr_ex: &'static serde_json::Map<String, Value> = Box::leak(Box::new(base_extracted()));
        let proofs = [EvaluatedProof {
            kind: EvidenceType::Pr,
            params: bad_params,
            extracted: pr_ex,
            owner,
            identifier: [0u8; 32],
        }];
        let err = evaluate(&c, 7, "0xabc", &proofs, 1794421000).unwrap_err();
        assert!(matches!(
            err,
            ClaimError::TemplateMismatch("bad Accept header")
        ));
        // Missing headers object likewise fails closed.
        let bare_params: &'static Value = Box::leak(Box::new(json!({
            "method": "GET",
            "url": format!("https://api.github.com/repos/{REPO}/pulls/38132"),
            "responseMatches": base_matchers().into_iter().map(|(t, v)| json!({"type": t, "value": v})).collect::<Vec<_>>(),
        })));
        let proofs = [EvaluatedProof {
            kind: EvidenceType::Pr,
            params: bare_params,
            extracted: pr_ex,
            owner,
            identifier: [0u8; 32],
        }];
        let err = evaluate(&c, 7, "0xabc", &proofs, 1794421000).unwrap_err();
        assert!(matches!(
            err,
            ClaimError::TemplateMismatch("bad Accept header")
        ));
    }

    #[test]
    fn github_time_parser_vectors() {
        assert_eq!(parse_github_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_github_time("2026-01-01T00:00:00Z"), Some(1767225600));
        assert_eq!(parse_github_time("2024-02-29T12:34:56Z"), Some(1709210096));
        assert_eq!(parse_github_time("2026-10-26T20:17:50Z"), Some(1793045870));
        // Rejections: offsets, fractions, bad shapes, out-of-range fields.
        for bad in [
            "2026-01-01T00:00:00+00:00",
            "2026-01-01T00:00:00.000Z",
            "2026-13-01T00:00:00Z",
            "2026-01-32T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T00:61:00Z",
            "2026-01-01 00:00:00Z",
            "",
            "yesterday",
        ] {
            assert_eq!(parse_github_time(bad), None, "{bad}");
        }
    }

    /// Compact evaluated-proof builder for rule-matrix tests (leaked boxes
    /// satisfy borrow lifetimes in-test only).
    fn mk_proof(
        kind: EvidenceType,
        url: String,
        matchers: Vec<(String, String)>,
        extracted: serde_json::Map<String, Value>,
    ) -> EvaluatedProof<'static> {
        let accept = required_headers(kind)[0].1;
        EvaluatedProof {
            kind,
            params: Box::leak(Box::new(json!({
                "method": "GET",
                "url": url,
                "headers": {"Accept": accept},
                "responseMatches": matchers.into_iter().map(|(t, v)| json!({"type": t, "value": v})).collect::<Vec<_>>(),
            }))),
            extracted: Box::leak(Box::new(extracted)),
            owner: [7u8; 20],
            identifier: [0u8; 32],
        }
    }

    fn identity_proof(login: &str, id: &str) -> EvaluatedProof<'static> {
        let c = criteria_simple();
        mk_proof(
            EvidenceType::Identity,
            "https://api.github.com/user".to_string(),
            mandated_matchers(EvidenceType::Identity, &c, 7, "0xabc", 0),
            ex(&[("id_login", login), ("id_num", id)]),
        )
    }

    fn pr_proof_for(
        c: &C::ValidatedCriteria,
        extracted: serde_json::Map<String, Value>,
    ) -> EvaluatedProof<'static> {
        mk_proof(
            EvidenceType::Pr,
            format!("https://api.github.com/repos/{REPO}/pulls/38132"),
            mandated_matchers(EvidenceType::Pr, c, 7, "0xabc", 0),
            extracted,
        )
    }

    fn check_proof_for() -> EvaluatedProof<'static> {
        let c = criteria_simple();
        mk_proof(
            EvidenceType::CheckRun,
            format!("https://api.github.com/repos/{REPO}/check-runs/128113730680"),
            mandated_matchers(EvidenceType::CheckRun, &c, 7, "0xabc", 0),
            ex(&[
                ("run_name", "cleanup"),
                ("head_sha", HEAD),
                ("status", "completed"),
                ("conclusion", "success"),
                ("completed_at", "2026-10-26T20:17:50Z"),
                ("app", "github-actions"),
            ]),
        )
    }

    #[test]
    fn identity_binding_matrix() {
        let c = criteria_simple();
        let now = 1794421000;
        let run = |id: EvaluatedProof<'static>| {
            evaluate(
                &c,
                7,
                "0xabc",
                &[pr_proof_for(&c, base_extracted()), check_proof_for(), id],
                now,
            )
        };
        // Match: every verdict passes.
        let (_, verdicts) = run(identity_proof("acdlite", "10001")).unwrap();
        assert!(first_failure(&verdicts).is_none(), "{verdicts:?}");
        // Login mismatch fails closed on identity.login.
        let (_, verdicts) = run(identity_proof("mallory", "10001")).unwrap();
        assert!(format!("{:?}", first_failure(&verdicts)).contains("identity.login"));
        // Numeric-id mismatch fails closed on identity.id (rename-proof).
        let (_, verdicts) = run(identity_proof("acdlite", "99999")).unwrap();
        assert!(format!("{:?}", first_failure(&verdicts)).contains("identity.id"));
        // Non-canonical numerics fail closed rather than comparing loosely.
        let (_, verdicts) = run(identity_proof("acdlite", "010001")).unwrap();
        assert!(first_failure(&verdicts).is_some());
        // Missing identity proof fails structurally (never silently skipped).
        let err = evaluate(
            &c,
            7,
            "0xabc",
            &[pr_proof_for(&c, base_extracted()), check_proof_for()],
            now,
        )
        .unwrap_err();
        assert!(matches!(err, ClaimError::MissingEvidence(_)));
    }

    /// Forged identity proof: custom matchers (no mandated pair) extracting
    /// attacker-chosen login/id — the shape of a bio-redirect attack.
    fn forged_identity_proof(login: &str, id: &str) -> EvaluatedProof<'static> {
        mk_proof(
            EvidenceType::Identity,
            "https://api.github.com/user".to_string(),
            vec![
                (
                    "regex".to_string(),
                    "\"bio\":\"(?<id_login>[^\"]+)\"".to_string(),
                ),
                ("regex".to_string(), "id_is_(?<id_num>[0-9]+)".to_string()),
            ],
            ex(&[("id_login", login), ("id_num", id)]),
        )
    }

    #[test]
    fn forged_identity_first_rejected() {
        // Attack bundle: forged (victim-valued, custom matchers) FIRST so a
        // positional [0] read would bind the victim; genuine attacker proof
        // second. Values must come from the covering proof (mallory), so
        // the login gate — not union coverage — decides.
        let c = criteria_simple();
        let now = 1794421000;
        let proofs = vec![
            pr_proof_for(&c, base_extracted()), // acdlite / 10001
            check_proof_for(),
            forged_identity_proof("acdlite", "10001"),
            identity_proof("mallory", "99999"),
        ];
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
        let first = first_failure(&verdicts).expect("attack must fail");
        assert!(
            format!("{first:?}").contains("identity.login"),
            "{verdicts:?}"
        );
    }

    #[test]
    fn genuine_identity_first_accepted_with_forged_second() {
        // Order preservation: a genuine covering proof anywhere in the
        // bundle binds values; a trailing forged proof is inert, not fatal.
        let c = criteria_simple();
        let now = 1794421000;
        let proofs = vec![
            pr_proof_for(&c, base_extracted()),
            check_proof_for(),
            identity_proof("acdlite", "10001"),
            forged_identity_proof("mallory", "99999"),
        ];
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
        assert!(first_failure(&verdicts).is_none(), "{verdicts:?}");
    }

    #[test]
    fn duplicate_mandated_capture_rejected() {
        // Genuine mandated set PLUS an extra matcher redefining id_login:
        // duplicate-group resolution is engine-defined, so fail closed even
        // though the mandated pairs are all present.
        let c = criteria_simple();
        let now = 1794421000;
        let mut m = mandated_matchers(EvidenceType::Identity, &c, 7, "0xabc", 0);
        m.push((
            "regex".to_string(),
            "\"bio\":\"(?<id_login>.*?)\"".to_string(),
        ));
        let dup = mk_proof(
            EvidenceType::Identity,
            "https://api.github.com/user".to_string(),
            m,
            ex(&[("id_login", "acdlite"), ("id_num", "10001")]),
        );
        let err = evaluate(
            &c,
            7,
            "0xabc",
            &[pr_proof_for(&c, base_extracted()), check_proof_for(), dup],
            now,
        )
        .unwrap_err();
        assert!(
            format!("{err:?}").contains("identity mandated"),
            "unexpected: {err:?}"
        );
    }

    #[test]
    fn matcher_capture_scan_shapes() {
        assert_eq!(
            matcher_captures("\"login\":\"(?<id_login>[^\"]+)\""),
            vec!["id_login".to_string()]
        );
        assert_eq!(
            matcher_captures("(?'id_num'[0-9]+)"),
            vec!["id_num".to_string()]
        );
        assert_eq!(
            matcher_captures("(?P<id_login>[a-z]+)"),
            vec!["id_login".to_string()]
        );
        assert!(matcher_captures("(?:[\\s\\S]*?\"filename\":\")").is_empty());
        assert!(matcher_captures("(?<=prefix)(?<real>.)").len() == 1);
        assert!(matcher_captures("(?<!x)(?<real>.)").len() == 1);
        assert!(matcher_captures("(?P<real>.)(?P=real)").len() == 1);
        assert!(matcher_captures("(?#comment (?<fake>.) done)").is_empty());
        assert!(matcher_captures("(?#c) (?<real>.)").len() == 1);
        // Unterminated comment: `(?#` treated as literal, inner group
        // still counted (fail-closed: never hide a possible group).
        assert!(matcher_captures("(?#unterminated (?<real>.").len() == 1);
        assert!(matcher_captures("[(?<in_class>]",).is_empty());
        assert!(matcher_captures("[]](?<real>.)").len() == 1);
        assert!(matcher_captures("[^]](?<real>.)").len() == 1);
        assert!(matcher_captures("[(?<unterminated>").len() == 1);
        assert!(matcher_captures("\\(?<not_a_group>").is_empty());
        assert_eq!(matcher_captures("(?<a>.)(?<b>.)").len(), 2);
        assert!(matcher_captures("plain literal (no groups)").is_empty());
    }

    #[test]
    fn duplicate_python_style_capture_rejected() {
        // Same duplicate rule via the `(?P<name>)` spelling: an extra
        // matcher redefining id_login fails closed however it is spelled.
        let c = criteria_simple();
        let now = 1794421000;
        let mut m = mandated_matchers(EvidenceType::Identity, &c, 7, "0xabc", 0);
        m.push((
            "regex".to_string(),
            "\"bio\":\"(?P<id_login>.*?)\"".to_string(),
        ));
        let dup = mk_proof(
            EvidenceType::Identity,
            "https://api.github.com/user".to_string(),
            m,
            ex(&[("id_login", "acdlite"), ("id_num", "10001")]),
        );
        let err = evaluate(
            &c,
            7,
            "0xabc",
            &[pr_proof_for(&c, base_extracted()), check_proof_for(), dup],
            now,
        )
        .unwrap_err();
        assert!(
            format!("{err:?}").contains("identity mandated"),
            "unexpected: {err:?}"
        );
    }

    /// Forged PR proof: custom matchers (no mandated pair) with
    /// attacker-chosen author values over the victim PR endpoint.
    fn forged_pr_proof(author: &str, author_id: &str) -> EvaluatedProof<'static> {
        let mut map = base_extracted();
        map.insert("author".to_string(), Value::String(author.to_string()));
        map.insert(
            "author_id".to_string(),
            Value::String(author_id.to_string()),
        );
        mk_proof(
            EvidenceType::Pr,
            format!("https://api.github.com/repos/{REPO}/pulls/38132"),
            vec![
                (
                    "regex".to_string(),
                    "\"body\":\"(?<author>.*?)\"".to_string(),
                ),
                (
                    "regex".to_string(),
                    "\"x\":(?<author_id>[0-9]+)".to_string(),
                ),
            ],
            map,
        )
    }

    #[test]
    fn forged_pr_first_rejected() {
        // Same substitution shape on the PR side: forged (mallory-valued,
        // custom matchers) first, genuine (acdlite, mandated) second, with
        // a genuine mallory identity. Values must come from the covering
        // proof, so the author/identity comparison fails.
        let c = criteria_simple();
        let now = 1794421000;
        let proofs = vec![
            forged_pr_proof("mallory", "99999"),
            pr_proof_for(&c, base_extracted()),
            check_proof_for(),
            identity_proof("mallory", "99999"),
        ];
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
        let first = first_failure(&verdicts).expect("attack must fail");
        assert!(
            format!("{first:?}").contains("identity.login"),
            "{verdicts:?}"
        );
    }

    #[test]
    fn legitimate_multi_proof_bundles_accepted() {
        // Redundant fully-covering proofs (either order) stay valid, and
        // label matchers may still split across PR proofs: labels are
        // coverage-only per proof while values bind to the core set.
        let c = criteria_simple();
        let now = 1794421000;
        let proofs = vec![
            pr_proof_for(&c, base_extracted()),
            pr_proof_for(&c, base_extracted()),
            check_proof_for(),
            identity_proof("acdlite", "10001"),
            identity_proof("acdlite", "10001"),
        ];
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
        assert!(first_failure(&verdicts).is_none(), "{verdicts:?}");

        let mut labeled = criteria_simple();
        labeled.labels = vec!["bug".to_string(), "fix".to_string()];
        let core = pr_core_matchers(&labeled, 7, "0xabc");
        let mut m1 = core.clone();
        m1.push(("regex".to_string(), label_pattern("bug", 0)));
        let mut m2 = core;
        m2.push(("regex".to_string(), label_pattern("fix", 1)));
        let split = vec![
            mk_proof(
                EvidenceType::Pr,
                format!("https://api.github.com/repos/{REPO}/pulls/38132"),
                m1,
                base_extracted(),
            ),
            mk_proof(
                EvidenceType::Pr,
                format!("https://api.github.com/repos/{REPO}/pulls/38132"),
                m2,
                base_extracted(),
            ),
            check_proof_for(),
            identity_proof("acdlite", "10001"),
        ];
        let (_, verdicts) = evaluate(&labeled, 7, "0xabc", &split, now).unwrap();
        assert!(first_failure(&verdicts).is_none(), "{verdicts:?}");
    }

    #[test]
    fn created_at_unified_and_future_capped() {
        // Divergent authorship timestamps across PR proofs fail the join.
        let mut other = base_extracted();
        other.insert(
            "pr_created".to_string(),
            Value::String("2026-10-27T19:00:00Z".to_string()),
        );
        let owner = [7u8; 20];
        let mk = |extracted: serde_json::Map<String, Value>| EvaluatedProof {
            kind: EvidenceType::Pr,
            params: Box::leak(Box::new(json!({
                "method": "GET",
                "url": format!("https://api.github.com/repos/{REPO}/pulls/38132"),
                "headers": {"Accept": "application/vnd.github+json"},
            }))),
            extracted: Box::leak(Box::new(extracted)),
            owner,
            identifier: [0u8; 32],
        };
        assert!(join_evidence(&[mk(base_extracted()), mk(other)], REPO).is_err());
        // Future authorship fails the evaluation verdict.
        let c = criteria_simple();
        let mut fut_ex = base_extracted();
        fut_ex.insert(
            "pr_created".to_string(),
            Value::String("2030-01-01T00:00:00Z".to_string()),
        );
        let proofs = vec![pr_proof_for(&c, fut_ex), identity_proof("acdlite", "10001")];
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, 1794421000).unwrap();
        assert!(format!("{:?}", first_failure(&verdicts)).contains("pr.created_at"));
    }

    #[test]
    fn fail_to_pass_base_legs() {
        const BASE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let mut c = criteria_simple();
        c.checks[0].fail_at_base = true;
        c.base_commit = Some(parse_sha20(BASE).unwrap());
        let now = 1794421000u64;
        let base_proof = |head: &str, conclusion: &str| {
            mk_proof(
                EvidenceType::BaseCheck,
                format!("https://api.github.com/repos/{REPO}/check-runs/42"),
                mandated_matchers(EvidenceType::BaseCheck, &c, 7, "0xabc", 0),
                ex(&[
                    ("run_name", "cleanup"),
                    ("head_sha", head),
                    ("status", "completed"),
                    ("conclusion", conclusion),
                    ("completed_at", "2026-01-02T00:00:00Z"),
                    ("app", "github-actions"),
                ]),
            )
        };
        // A head success is still required alongside the base leg.
        let head_proof = mk_proof(
            EvidenceType::CheckRun,
            format!("https://api.github.com/repos/{REPO}/check-runs/7"),
            mandated_matchers(EvidenceType::CheckRun, &c, 7, "0xabc", 0),
            ex(&[
                ("run_name", "cleanup"),
                ("head_sha", HEAD),
                ("status", "completed"),
                ("conclusion", "success"),
                ("completed_at", "2026-10-26T20:17:50Z"),
                ("app", "github-actions"),
            ]),
        );
        let mut base_pr_ex = base_extracted();
        base_pr_ex.insert("base_sha".to_string(), Value::String(BASE.to_string()));
        let run = |extra: Vec<EvaluatedProof<'static>>| {
            let mut proofs = vec![
                pr_proof_for(&c, base_pr_ex.clone()),
                head_proof.clone(),
                identity_proof("acdlite", "10001"),
            ];
            proofs.extend(extra);
            evaluate(&c, 7, "0xabc", &proofs, now)
        };
        // Fail@base + pass@head: full pass including the base leg.
        let (_, verdicts) = run(vec![base_proof(BASE, "failure")]).unwrap();
        assert!(first_failure(&verdicts).is_none(), "{verdicts:?}");
        assert!(verdicts
            .iter()
            .any(|v| v.id == "check:cleanup:base" && matches!(v.status, Verdict::Pass)));
        // Base success is not a fail-to-pass leg.
        let (_, verdicts) = run(vec![base_proof(BASE, "success")]).unwrap();
        assert!(format!("{:?}", first_failure(&verdicts)).contains("check:cleanup:base"));
        // Base run on the wrong commit does not qualify.
        let (_, verdicts) = run(vec![base_proof(HEAD, "failure")]).unwrap();
        assert!(format!("{:?}", first_failure(&verdicts)).contains("check:cleanup:base"));
        // Missing base leg fails closed.
        let (_, verdicts) = run(vec![]).unwrap();
        assert!(format!("{:?}", first_failure(&verdicts)).contains("check:cleanup:base"));
    }

    #[test]
    fn checkrun_split_values_and_coverage_rejected() {
        // Proof A has qualifying values via custom matchers; proof B has
        // the mandated matchers with non-qualifying values. Same-proof
        // binding requires one proof to do both: split must fail.
        let c = criteria_simple();
        let now = 1794421000;
        let custom = vec![("regex".to_string(), "\"z\":(?<run_name>.*?)".to_string())];
        let qualifying = ex(&[
            ("run_name", "cleanup"),
            ("head_sha", HEAD),
            ("status", "completed"),
            ("conclusion", "success"),
            ("completed_at", "2026-10-26T20:17:50Z"),
            ("app", "github-actions"),
        ]);
        let proof_a = mk_proof(
            EvidenceType::CheckRun,
            format!("https://api.github.com/repos/{REPO}/check-runs/7"),
            custom,
            qualifying,
        );
        let failing = ex(&[
            ("run_name", "cleanup"),
            ("head_sha", HEAD),
            ("status", "completed"),
            ("conclusion", "failure"),
            ("completed_at", "2026-10-26T20:17:50Z"),
            ("app", "github-actions"),
        ]);
        let proof_b = mk_proof(
            EvidenceType::CheckRun,
            format!("https://api.github.com/repos/{REPO}/check-runs/8"),
            mandated_matchers(EvidenceType::CheckRun, &c, 7, "0xabc", 0),
            failing,
        );
        for order in [
            vec![proof_a.clone(), proof_b.clone()],
            vec![proof_b, proof_a],
        ] {
            let mut proofs = vec![
                pr_proof_for(&c, base_extracted()),
                identity_proof("acdlite", "10001"),
            ];
            proofs.extend(order);
            let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
            assert!(
                format!("{:?}", first_failure(&verdicts)).contains("check:cleanup"),
                "{verdicts:?}"
            );
        }
    }

    #[test]
    fn basecheck_split_values_and_coverage_rejected() {
        const BASE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let mut c = criteria_simple();
        c.checks[0].fail_at_base = true;
        c.base_commit = Some(parse_sha20(BASE).unwrap());
        let now = 1794421000u64;
        let mut base_pr_ex = base_extracted();
        base_pr_ex.insert("base_sha".to_string(), Value::String(BASE.to_string()));
        // Satisfying values via custom matchers (no coverage).
        let proof_a = mk_proof(
            EvidenceType::BaseCheck,
            format!("https://api.github.com/repos/{REPO}/check-runs/42"),
            vec![("regex".to_string(), "\"z\":(?<run_name>.*?)".to_string())],
            ex(&[
                ("run_name", "cleanup"),
                ("head_sha", BASE),
                ("status", "completed"),
                ("conclusion", "failure"),
                ("completed_at", "2026-01-02T00:00:00Z"),
                ("app", "github-actions"),
            ]),
        );
        // Full mandated matchers with non-qualifying values (wrong commit).
        let proof_b = mk_proof(
            EvidenceType::BaseCheck,
            format!("https://api.github.com/repos/{REPO}/check-runs/43"),
            mandated_matchers(EvidenceType::BaseCheck, &c, 7, "0xabc", 0),
            ex(&[
                ("run_name", "cleanup"),
                ("head_sha", HEAD),
                ("status", "completed"),
                ("conclusion", "failure"),
                ("completed_at", "2026-01-02T00:00:00Z"),
                ("app", "github-actions"),
            ]),
        );
        let head_proof = mk_proof(
            EvidenceType::CheckRun,
            format!("https://api.github.com/repos/{REPO}/check-runs/7"),
            mandated_matchers(EvidenceType::CheckRun, &c, 7, "0xabc", 0),
            ex(&[
                ("run_name", "cleanup"),
                ("head_sha", HEAD),
                ("status", "completed"),
                ("conclusion", "success"),
                ("completed_at", "2026-10-26T20:17:50Z"),
                ("app", "github-actions"),
            ]),
        );
        for order in [
            vec![proof_a.clone(), proof_b.clone()],
            vec![proof_b, proof_a],
        ] {
            let proofs = vec![
                pr_proof_for(&c, base_pr_ex.clone()),
                head_proof.clone(),
                identity_proof("acdlite", "10001"),
                order[0].clone(),
                order[1].clone(),
            ];
            let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
            assert!(
                format!("{:?}", first_failure(&verdicts)).contains("check:cleanup:base"),
                "{verdicts:?}"
            );
        }
    }

    #[test]
    fn close_ref_bound_to_covering_proof() {
        let mut c = criteria_simple();
        c.issue = Some(C::IssueRule {
            url: format!("https://github.com/{REPO}/issues/38131"),
            number: 38131,
            require_close_reference: true,
            keywords: vec!["closes".to_string()],
        });
        let now = 1794421000;
        let close = close_ref_matcher(c.issue.as_ref().unwrap());
        // Bound proof: carries the close matcher and the matching value.
        let mut bound_ex = base_extracted();
        bound_ex.insert(
            "close_ref".to_string(),
            Value::String("closes #38131".to_string()),
        );
        let bound_m = mandated_matchers(EvidenceType::Pr, &c, 7, "0xabc", 0);
        assert!(bound_m.contains(&close));
        let bound = mk_proof(
            EvidenceType::Pr,
            format!("https://api.github.com/repos/{REPO}/pulls/38132"),
            bound_m,
            bound_ex,
        );
        let proofs = vec![bound, check_proof_for(), identity_proof("acdlite", "10001")];
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
        assert!(first_failure(&verdicts).is_none(), "{verdicts:?}");
        // Split attack: matching value via custom matchers (no coverage)
        // plus a covering proof with no usable value.
        let mut forged_ex = base_extracted();
        forged_ex.insert(
            "close_ref".to_string(),
            Value::String("closes #38131".to_string()),
        );
        let forged = mk_proof(
            EvidenceType::Pr,
            format!("https://api.github.com/repos/{REPO}/pulls/38132"),
            vec![(
                "regex".to_string(),
                "\"body\":\"(?<close_ref>.*?)\"".to_string(),
            )],
            forged_ex,
        );
        let mut bare_ex = base_extracted();
        bare_ex.remove("close_ref");
        let bare = mk_proof(
            EvidenceType::Pr,
            format!("https://api.github.com/repos/{REPO}/pulls/38132"),
            mandated_matchers(EvidenceType::Pr, &c, 7, "0xabc", 0),
            bare_ex,
        );
        for order in [vec![forged.clone(), bare.clone()], vec![bare, forged]] {
            let mut proofs = vec![check_proof_for(), identity_proof("acdlite", "10001")];
            proofs.extend(order);
            let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
            assert!(
                format!("{:?}", first_failure(&verdicts)).contains("issue.close_ref"),
                "{verdicts:?}"
            );
        }
    }

    fn files_criteria() -> C::ValidatedCriteria {
        let mut c = criteria_simple();
        c.files = Some(C::FilesRules {
            allowed: vec![],
            forbidden: vec!["secret/".to_string()],
            required_touched: vec![],
            protected: vec![
                C::ProtectedFile {
                    path: "tests/auth.rs".to_string(),
                    blob_sha: [0xAAu8; 20],
                },
                C::ProtectedFile {
                    path: ".github/workflows/ci.yml".to_string(),
                    blob_sha: [0xBBu8; 20],
                },
            ],
            max_changed_files: None,
            max_additions: None,
            max_deletions: None,
            patch_contains_all: vec![],
        });
        c
    }

    fn files_proof(rows: &[(&str, &str)]) -> EvaluatedProof<'static> {
        // Row patterns + extracted rows for exactly these files.
        let mut matchers = Vec::new();
        let mut ex_map = serde_json::Map::new();
        for (i, (f, st)) in rows.iter().enumerate() {
            let k = i + 1;
            matchers.push(("regex".to_string(), super::row_pattern(k)));
            ex_map.insert(format!("r{k}_file"), Value::String(f.to_string()));
            ex_map.insert(format!("r{k}_status"), Value::String(st.to_string()));
            ex_map.insert(format!("r{k}_add"), Value::String("10".to_string()));
            ex_map.insert(format!("r{k}_del"), Value::String("2".to_string()));
        }
        mk_proof(
            EvidenceType::Files,
            format!("https://api.github.com/repos/{REPO}/pulls/38132/files?per_page=100"),
            matchers,
            ex_map,
        )
    }

    fn contents_proof(path: &str, blob_hex40: &str) -> EvaluatedProof<'static> {
        let c = criteria_simple();
        mk_proof(
            EvidenceType::Contents,
            format!("https://api.github.com/repos/{REPO}/contents/{path}?ref={HEAD}"),
            mandated_matchers(EvidenceType::Contents, &c, 7, "0xabc", 0),
            ex(&[("path", path), ("blob_sha", blob_hex40), ("size", "2086")]),
        )
    }

    fn pr_with_changed(c: &C::ValidatedCriteria, n: u64) -> EvaluatedProof<'static> {
        let mut map = base_extracted();
        map.insert("changed_files".to_string(), Value::String(n.to_string()));
        pr_proof_for(c, map)
    }

    #[test]
    fn files_rules_end_to_end() {
        let c = files_criteria();
        let now = 1794421000;
        let base = || {
            vec![
                pr_with_changed(&c, 2),
                check_proof_for(),
                identity_proof("acdlite", "10001"),
            ]
        };
        let hex = |b: u8| -> String { format!("{:02x}", b).repeat(20) };
        // Valid: rows benign, both protected blobs match.
        let mut proofs = base();
        proofs.push(files_proof(&[
            ("src/main.rs", "modified"),
            ("tests/auth.rs", "modified"),
        ]));
        proofs.push(contents_proof("tests/auth.rs", &hex(0xAA)));
        proofs.push(contents_proof(".github/workflows/ci.yml", &hex(0xBB)));
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
        assert!(first_failure(&verdicts).is_none(), "{verdicts:?}");
        // Protected test modification (blob mismatch) rejected.
        let mut proofs = base();
        proofs.push(files_proof(&[
            ("src/main.rs", "modified"),
            ("tests/auth.rs", "modified"),
        ]));
        proofs.push(contents_proof("tests/auth.rs", &hex(0x00)));
        proofs.push(contents_proof(".github/workflows/ci.yml", &hex(0xBB)));
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
        assert!(format!("{:?}", first_failure(&verdicts)).contains("files.protected:tests/auth.rs"));
        // Protected workflow modification rejected.
        let mut proofs = base();
        proofs.push(files_proof(&[
            ("src/main.rs", "modified"),
            ("tests/auth.rs", "modified"),
        ]));
        proofs.push(contents_proof("tests/auth.rs", &hex(0xAA)));
        proofs.push(contents_proof(".github/workflows/ci.yml", &hex(0x00)));
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
        assert!(format!("{:?}", first_failure(&verdicts))
            .contains("files.protected:.github/workflows/ci.yml"));
        // Forbidden path touched rejected.
        let mut proofs = vec![
            {
                let mut map = base_extracted();
                map.insert("changed_files".to_string(), Value::String("1".to_string()));
                pr_proof_for(&c, map)
            },
            check_proof_for(),
            identity_proof("acdlite", "10001"),
        ];
        proofs.push(files_proof(&[("secret/key", "added")]));
        proofs.push(contents_proof("tests/auth.rs", &hex(0xAA)));
        proofs.push(contents_proof(".github/workflows/ci.yml", &hex(0xBB)));
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
        assert!(format!("{:?}", first_failure(&verdicts)).contains("files.forbidden"));
    }

    #[test]
    fn review_slot_binding_accepts_bound_rejects_forged() {
        let mut c = criteria_simple();
        c.reviews = vec![C::ReviewRule {
            login: "maintainer".to_string(),
            associations: vec![],
        }];
        let now = 1794421000;
        let url = format!("https://api.github.com/repos/{REPO}/pulls/38132/reviews");
        let slot = review_slot_matchers(&c.reviews[0], 0);
        let bound = mk_proof(
            EvidenceType::Review,
            url.clone(),
            slot,
            ex(&[("review_0_state", "APPROVED"), ("review_0_commit", HEAD)]),
        );
        // Valid bound approval passes.
        let proofs = vec![
            pr_proof_for(&c, base_extracted()),
            check_proof_for(),
            identity_proof("acdlite", "10001"),
            bound,
        ];
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
        assert!(first_failure(&verdicts).is_none(), "{verdicts:?}");
        // Forged approval: qualifying values WITHOUT the login-pinned slot
        // matchers (custom patterns, no coverage) must not satisfy the slot.
        let forged = mk_proof(
            EvidenceType::Review,
            url,
            vec![
                (
                    "regex".to_string(),
                    "\"body\":\"(?<review_0_state>.*?)\"".to_string(),
                ),
                (
                    "regex".to_string(),
                    "\"x\":\"(?<review_0_commit>[0-9a-f]{40})\"".to_string(),
                ),
            ],
            ex(&[("review_0_state", "APPROVED"), ("review_0_commit", HEAD)]),
        );
        let proofs = vec![
            pr_proof_for(&c, base_extracted()),
            check_proof_for(),
            identity_proof("acdlite", "10001"),
            forged,
        ];
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
        assert!(
            format!("{:?}", first_failure(&verdicts)).contains("reviews:maintainer"),
            "{verdicts:?}"
        );
    }

    #[test]
    fn review_two_slots_independently_bound() {
        // Two reviewer slots, each satisfied by its own slot-bound proof;
        // then cross-slot substitution (slot-1 values under slot-0
        // coverage and vice versa) must fail both slots.
        let mut c = criteria_simple();
        c.reviews = vec![
            C::ReviewRule {
                login: "maintainer".to_string(),
                associations: vec![],
            },
            C::ReviewRule {
                login: "reviewer2".to_string(),
                associations: vec!["MEMBER".to_string()],
            },
        ];
        let now = 1794421000;
        let url = format!("https://api.github.com/repos/{REPO}/pulls/38132/reviews");
        let bound_proof = |i: usize| {
            let mut map = ex(&[
                (&format!("review_{i}_state"), "APPROVED"),
                (&format!("review_{i}_commit"), HEAD),
            ]);
            if i == 1 {
                map.insert(
                    "review_1_assoc".to_string(),
                    Value::String("MEMBER".to_string()),
                );
            }
            mk_proof(
                EvidenceType::Review,
                url.clone(),
                review_slot_matchers(&c.reviews[i], i),
                map,
            )
        };
        let proofs = vec![
            pr_proof_for(&c, base_extracted()),
            check_proof_for(),
            identity_proof("acdlite", "10001"),
            bound_proof(0),
            bound_proof(1),
        ];
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
        assert!(first_failure(&verdicts).is_none(), "{verdicts:?}");
        // Slot-1 values under slot-0 coverage only: slot 1 stays unsatisfied.
        let cross = mk_proof(
            EvidenceType::Review,
            url.clone(),
            review_slot_matchers(&c.reviews[0], 0),
            ex(&[
                ("review_1_state", "APPROVED"),
                ("review_1_commit", HEAD),
                ("review_1_assoc", "MEMBER"),
            ]),
        );
        let proofs = vec![
            pr_proof_for(&c, base_extracted()),
            check_proof_for(),
            identity_proof("acdlite", "10001"),
            bound_proof(0),
            cross,
        ];
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
        assert!(
            format!("{:?}", first_failure(&verdicts)).contains("reviews:reviewer2"),
            "{verdicts:?}"
        );
    }

    #[test]
    fn bound_mandated_sets_fit_matcher_cap() {
        // Worst-case criteria: every PR conditional on, 8 labels (the max),
        // commitment identity. The value-bound core must fit 16 (labels,
        // close ref, and commitment are enforced separately), and every
        // other bound set must fit trivially.
        let text = serde_json::json!({
            "schema": "omnibounty/criteria", "version": "1",
            "title": "t", "description": "d", "repo": "o/r",
            "merge_policy": "merged", "allow_forks": true,
            "identity_policy": "commitment",
            "checks": {"required": [{"name": "cleanup", "apps": ["github-actions"]}]},
            "files": {
                "allowed_paths": ["src/"],
                "max_changed_files": "16",
            },
            "labels": {"required_all": ["a", "b", "c", "d", "e", "f", "g", "h"]},
            "reviews": {"required_approvals": [{"login": "m", "association": ["MEMBER"]}]},
            "issue": {"url": "https://github.com/o/r/issues/1", "require_close_reference": true, "keywords": ["closes"]},
            "policy": "single_winner", "slots": [{"amount": "1"}],
            "unfilled": "refund_sponsor", "deadline": "1893456000",
            "challenge_window_sec": "0", "evidence_max_age_sec": "604800",
            "base_commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "author_association": ["MEMBER"],
        });
        let doc = C::strict_parse(&serde_json::to_string(&text).unwrap()).unwrap();
        let c = C::validate_criteria(&doc).unwrap();
        let core = pr_core_matchers(&c, 7, "0xabc");
        assert_eq!(core.len(), 10, "core = 7 base + assoc + base + changed");
        // The un-split full set would NOT fit: documents why labels, the
        // close ref, and the commitment marker are enforced separately.
        let full = mandated_matchers(EvidenceType::Pr, &c, 7, "0xabc", 0);
        assert!(
            full.len() > MAX_MATCHERS_PER_PROOF,
            "full set = {}",
            full.len()
        );
        assert_eq!(
            mandated_matchers(EvidenceType::CheckRun, &c, 7, "0xabc", 0).len(),
            6
        );
        assert_eq!(
            mandated_matchers(EvidenceType::Identity, &c, 7, "0xabc", 0).len(),
            2
        );
        assert_eq!(
            mandated_matchers(EvidenceType::Contents, &c, 7, "0xabc", 0).len(),
            3
        );
        assert_eq!(review_slot_matchers(&c.reviews[0], 0).len(), 3);
        // Row patterns: one per row, capped at 16 rows by validation.
        assert_eq!(MAX_ATTESTED_ROWS, MAX_MATCHERS_PER_PROOF);
    }

    #[test]
    fn contents_coverage_bound_to_supplying_proof() {
        let c = files_criteria();
        let now = 1794421000;
        let hex = |b: u8| -> String { format!("{:02x}", b).repeat(20) };
        let base = || {
            vec![
                pr_with_changed(&c, 2),
                check_proof_for(),
                identity_proof("acdlite", "10001"),
                files_proof(&[("src/main.rs", "modified"), ("tests/auth.rs", "modified")]),
                contents_proof(".github/workflows/ci.yml", &hex(0xBB)),
            ]
        };
        // Bound contents proof passes.
        let mut proofs = base();
        proofs.push(contents_proof("tests/auth.rs", &hex(0xAA)));
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
        assert!(first_failure(&verdicts).is_none(), "{verdicts:?}");
        // Same values via custom (non-covering) matchers must not satisfy
        // the protected entry.
        let forged = mk_proof(
            EvidenceType::Contents,
            format!("https://api.github.com/repos/{REPO}/contents/tests/auth.rs?ref={HEAD}"),
            vec![("regex".to_string(), "\"x\":\"(?<path>.*?)\"".to_string())],
            ex(&[
                ("path", "tests/auth.rs"),
                ("blob_sha", &hex(0xAA)),
                ("size", "2086"),
            ]),
        );
        let mut proofs = base();
        proofs.push(forged);
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
        assert!(
            format!("{:?}", first_failure(&verdicts)).contains("files.protected:tests/auth.rs"),
            "{verdicts:?}"
        );
    }

    #[test]
    fn files_rows_read_only_from_covering_proof() {
        // Split attack: proof A covers the row patterns but has incomplete
        // rows; proof B has complete rows via custom matchers. Neither
        // binds rows to coverage, so row collection must fail.
        let c = files_criteria();
        let now = 1794421000;
        let files_url =
            format!("https://api.github.com/repos/{REPO}/pulls/38132/files?per_page=100");
        let mut covering_incomplete = Vec::new();
        for k in 1..=2usize {
            covering_incomplete.push(("regex".to_string(), super::row_pattern(k)));
        }
        let proof_a = mk_proof(
            EvidenceType::Files,
            files_url.clone(),
            covering_incomplete,
            ex(&[
                ("r1_file", "src/main.rs"),
                ("r1_status", "modified"),
                ("r1_add", "10"),
                ("r1_del", "2"),
            ]),
        );
        let proof_b = mk_proof(
            EvidenceType::Files,
            files_url,
            vec![("regex".to_string(), "\"y\":(?<r1_file>.*?)".to_string())],
            ex(&[
                ("r1_file", "src/main.rs"),
                ("r1_status", "modified"),
                ("r1_add", "10"),
                ("r1_del", "2"),
                ("r2_file", "tests/auth.rs"),
                ("r2_status", "modified"),
                ("r2_add", "10"),
                ("r2_del", "2"),
            ]),
        );
        for order in [
            vec![proof_a.clone(), proof_b.clone()],
            vec![proof_b, proof_a],
        ] {
            let mut proofs = vec![
                pr_with_changed(&c, 2),
                check_proof_for(),
                identity_proof("acdlite", "10001"),
            ];
            proofs.extend(order);
            let err = evaluate(&c, 7, "0xabc", &proofs, now).unwrap_err();
            assert!(
                format!("{err:?}").contains("files rows"),
                "unexpected: {err:?}"
            );
        }
    }

    #[test]
    fn changed_files_substitution_ignored() {
        // Forged PR proof (custom matchers, changed_files=1) first would
        // hide row 2 under positional reads; values must come from the
        // covering proof (changed=2), so the forbidden row is examined.
        let c = files_criteria();
        let now = 1794421000;
        let mut forged_map = base_extracted();
        forged_map.insert("changed_files".to_string(), Value::String("1".to_string()));
        let forged = mk_proof(
            EvidenceType::Pr,
            format!("https://api.github.com/repos/{REPO}/pulls/38132"),
            vec![("regex".to_string(), "\"z\":(?<merged>.*?)".to_string())],
            forged_map,
        );
        let proofs = vec![
            forged,
            pr_with_changed(&c, 2),
            check_proof_for(),
            identity_proof("acdlite", "10001"),
            files_proof(&[("src/main.rs", "modified"), ("secret/keys.txt", "added")]),
            contents_proof("tests/auth.rs", &format!("{:02x}", 0xAA).repeat(20)),
            contents_proof(
                ".github/workflows/ci.yml",
                &format!("{:02x}", 0xBB).repeat(20),
            ),
        ];
        let (_, verdicts) = evaluate(&c, 7, "0xabc", &proofs, now).unwrap();
        assert!(
            format!("{:?}", first_failure(&verdicts)).contains("files.forbidden"),
            "{verdicts:?}"
        );
    }

    #[test]
    fn protected_path_matching_adversarial() {
        // Exact files match byte-exactly; directories match themselves and
        // everything beneath; siblings, case variants, and traversals never
        // match.
        assert!(matches_path("tests/a.rs", "tests/a.rs"));
        assert!(matches_path("tests/a.rs", "tests/"));
        assert!(matches_path("tests", "tests/"));
        assert!(matches_path("a/b/c.yml", "a/"));
        assert!(!matches_path("tests-evil/a.rs", "tests/"));
        assert!(!matches_path("Tests/a.rs", "tests/"));
        assert!(!matches_path("tests/a.rs", "test"));
        assert!(!matches_path("tests/a.rs", "tests"));
        assert!(matches_path("a/b", "a/b/"));
        assert!(!matches_path("a/b/c", "a/b"));
        assert!(!matches_path("", "tests/"));
        assert!(!matches_path("tests/a.rs", ""));
    }
}
