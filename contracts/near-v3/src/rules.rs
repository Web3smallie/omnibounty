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
}

pub fn match_endpoint_url(kind: EvidenceType, url: &str, repo: &str) -> Option<UrlMatch> {
    let rest = repo_remainder(url, repo)?;
    match kind {
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

/// Mandated matcher multiset for one proof: Vec<(type, value)> that MUST be
/// a subset of the signed params.responseMatches. Extras are permitted
/// (unknown extracted keys are ignored by rule evaluation; the identifier
/// binds the full params, so extras cannot smuggle alternate meanings).
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
            rx(r#""merged":(?<merged>.*?)[,}]"#.to_string());
            rx(r#""login":"(?<author>.*?)"#.to_string() + "\"");
            rx(r#""full_name":"(?<repo>.*?)"#.to_string() + "\"");
            rx(r#""number":(?<number>.*?)[,}]"#.to_string());
            rx(r#""sha":"(?<head_sha>[0-9a-f]{40})""#.to_string());
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
                    let alts: Vec<String> = issue
                        .keywords
                        .iter()
                        .map(|k| format!("{} #{}", escape_regex_literal(k), issue.number))
                        .collect();
                    rx(format!("(?<close_ref>{})", alts.join("|")));
                }
            }
            if criteria.identity == crate::criteria::IdentityPolicy::Commitment {
                out.push((
                    "contains".to_string(),
                    format!("omnibounty:{bounty_id}:{recipient_hex}"),
                ));
            }
        }
        EvidenceType::CheckRun => {
            rx(r#""name":"(?<run_name>.*?)"#.to_string() + "\"");
            rx(r#""head_sha":"(?<head_sha>[0-9a-f]{40})""#.to_string());
            rx(r#""status":"(?<status>.*?)"#.to_string() + "\"");
            rx(r#""conclusion":"(?<conclusion>.*?)"#.to_string() + "\"");
            rx(r#""completed_at":"(?<completed_at>.*?)"#.to_string() + "\"");
            rx(r#""app":\{[^}]*?"slug":"(?<app>.*?)"#.to_string() + "\"");
        }
        EvidenceType::Files => {
            for k in 1..=row_count {
                rx(row_pattern(k));
            }
        }
        EvidenceType::Review => {
            for (i, r) in criteria.reviews.iter().enumerate() {
                let login = escape_regex_literal(&r.login);
                rx(format!(
                    "\"login\":\"{login}\"[\\s\\S]*?\"state\":\"(?<review_{i}_state>.*?)\""
                ));
                // Commit binding excludes stale approvals: the reviewed commit
                // must equal the joined head (checked in evaluate()).
                rx(format!(
                    "\"login\":\"{login}\"[\\s\\S]*?\"commit_id\":\"(?<review_{i}_commit>[0-9a-f]{{40}})\""
                ));
                if !r.associations.is_empty() {
                    rx(format!(
                        "\"login\":\"{login}\"[\\s\\S]*?\"author_association\":\"(?<review_{i}_assoc>.*?)\""
                    ));
                }
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
}

pub fn join_evidence(proofs: &[EvaluatedProof<'_>], repo: &str) -> Result<JoinedClaim, ClaimError> {
    if proofs.is_empty() || proofs.len() > MAX_CLAIM_PROOFS {
        return Err(ClaimError::MissingEvidence(
            "empty or oversized bundle".to_string(),
        ));
    }
    let mut pr_number: Option<u64> = None;
    let mut heads: Vec<[u8; 20]> = Vec::new();
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
    Ok(JoinedClaim {
        pr_number,
        head_sha: *first,
    })
}

/// Parse a 20-byte hex SHA via the shared normalizer (accepts mixed case
/// and 0x prefix; comparison always happens on normalized bytes).
pub(crate) fn parse_sha20(s: &str) -> Result<[u8; 20], ClaimError> {
    crate::normalize::parse_hex("sha", s)
}

/// Coverage: the union of actual matcher sets across all proofs of one
/// kind must include every mandated matcher (multiset semantics per proof
/// list). Lets large mandate sets split across several same-endpoint proofs
/// without weakening anything (each proof still verifies independently).
fn coverage_satisfied(mandated: &[(String, String)], proofs: &[&EvaluatedProof<'_>]) -> bool {
    let mut remaining: Vec<&(String, String)> = Vec::new();
    for p in proofs {
        let actual = match params_matchers(p.params) {
            Ok(a) => a,
            Err(_) => return false,
        };
        for m in actual {
            remaining.push(Box::leak(Box::new(m)));
        }
    }
    matchers_satisfied(
        mandated,
        &remaining.into_iter().cloned().collect::<Vec<_>>(),
    )
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

    // Mandated coverage per kind present in the criteria. Kinds with no
    // criterion need no proofs; kinds with criteria need coverage.
    // PR proofs are always required (the anchor).
    let pr_proofs = by_kind(EvidenceType::Pr);
    if pr_proofs.is_empty() {
        return Err(ClaimError::MissingEvidence("no PR proof".to_string()));
    }
    let pr_mandated = mandated_matchers(EvidenceType::Pr, criteria, bounty_id, recipient_hex, 0);
    if !coverage_satisfied(&pr_mandated, &pr_proofs) {
        return Err(ClaimError::TemplateMismatch("PR mandated matchers"));
    }
    out.push(pass("pr.matchers"));

    // Cross-proof join (URLs, PR numbers, heads).
    let joined = join_evidence(proofs, &criteria.repo)?;
    out.push(pass("bundle.join"));

    // From here on, per-criterion verdicts (all evaluated, none short-circuit
    // except through missing prerequisites, which yield UNVERIFIED).
    let pr = pr_proofs[0];
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
    // Commitment identity: marker presence was already enforced by the
    // mandated-subset check; record the verdict explicitly.
    if criteria.identity == crate::criteria::IdentityPolicy::Commitment {
        out.push(pass("identity.commitment"));
    }

    // Checks: each required entry needs a satisfying proof.
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
            satisfied = true;
            break;
        }
        // A covering proof must also carry the mandated check matchers.
        let mandated = mandated_matchers(
            EvidenceType::CheckRun,
            criteria,
            bounty_id,
            recipient_hex,
            0,
        );
        let covered = by_kind(EvidenceType::CheckRun).iter().any(|p| {
            params_matchers(p.params)
                .map(|actual| matchers_satisfied(&mandated, &actual))
                .unwrap_or(false)
        });
        if !satisfied || !covered {
            out.push(fail(&format!("check:{}", req.name), detail));
        } else {
            out.push(pass(&format!("check:{}", req.name)));
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
        let covered = file_proofs.iter().any(|p| {
            params_matchers(p.params)
                .map(|actual| matchers_satisfied(&want, &actual))
                .unwrap_or(false)
        });
        if !covered {
            return Err(ClaimError::TemplateMismatch("files row patterns"));
        }
        // Collect rows from the covering proof (first one that covers all).
        let mut rows: Vec<(String, String, u64, u64)> = Vec::new();
        let mut rows_ok = false;
        for p in file_proofs {
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
        if !rows_ok {
            return Err(ClaimError::MissingEvidence("files rows".to_string()));
        }
        out.push(pass("files.rows"));
        let matches_pat = |path: &str, pat: &str| -> bool {
            if let Some(dir) = pat.strip_suffix('/') {
                path == &dir[..dir.len()] || path.starts_with(pat)
            } else {
                path == pat
            }
        };
        if !files.allowed.is_empty() {
            let bad = rows
                .iter()
                .find(|r| !files.allowed.iter().any(|p| matches_pat(&r.0, p)));
            match bad {
                None => out.push(pass("files.allowed")),
                Some(r) => out.push(fail("files.allowed", format!("{} not allowed", r.0))),
            }
        }
        let mut forbidden_hit = None;
        for r in &rows {
            if files.forbidden.iter().any(|p| matches_pat(&r.0, p)) {
                forbidden_hit = Some(r.0.clone());
                break;
            }
        }
        match forbidden_hit {
            None => out.push(pass("files.forbidden")),
            Some(p) => out.push(fail("files.forbidden", format!("{p} forbidden"))),
        }
        for need in &files.required_touched {
            if rows.iter().any(|r| matches_pat(&r.0, need)) {
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
        for prot in &files.protected {
            let mut ok = false;
            for p in by_kind(EvidenceType::Contents) {
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
        let mut ok = false;
        for p in by_kind(EvidenceType::Review) {
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

    // Issue close reference.
    if let Some(issue) = criteria.issue.as_ref() {
        if issue.require_close_reference {
            let mut ok = false;
            for p in by_kind(EvidenceType::Pr) {
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
            ("regex".into(), "\"full_name\":\"(?<repo>.*?)\"".into()),
            ("regex".into(), r#""number":(?<number>.*?)[,}]"#.into()),
            (
                "regex".into(),
                "\"sha\":\"(?<head_sha>[0-9a-f]{40})\"".into(),
            ),
        ]
    }

    fn base_extracted() -> serde_json::Map<String, Value> {
        ex(&[
            ("merged", "true"),
            ("author", "acdlite"),
            ("repo", "react/react"),
            ("number", "38132"),
            ("head_sha", HEAD),
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
        // exactly the 5 base matchers.
        assert_eq!(m.len(), 5);
        assert!(m
            .iter()
            .any(|(t, v)| t == "regex" && v.contains("(?<merged>")));
        assert!(m
            .iter()
            .any(|(t, v)| t == "regex" && v.contains("(?<head_sha>")));
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
        let pr_ex: &'static serde_json::Map<String, Value> = Box::leak(Box::new(base_extracted()));
        let check_ex: &'static serde_json::Map<String, Value> = Box::leak(Box::new(ex(&[
            ("run_name", "cleanup"),
            ("head_sha", HEAD),
            ("status", "completed"),
            ("conclusion", "success"),
            ("completed_at", "2026-10-26T20:17:50Z"),
            ("app", "github-actions"),
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
}
