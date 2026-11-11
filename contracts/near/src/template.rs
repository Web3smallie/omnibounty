//! Bounty-template validation: binds a verified proof to a specific GitHub
//! pull request and merge outcome.
//!
//! Security model: the witness attests that the HTTPS response for the pinned
//! URL contained the claimed matches. This module enforces that
//! (a) the request targeted EXACTLY this bounty's PR URL with a GET,
//! (b) the matchers are well-formed (so the attestation is meaningful), and
//! (c) the extracted values prove MERGED status (not merely `closed`),
//!     plus author/repo/number binding.
//!
//! Extracted-parameter contract (claim producers must request these
//! extractions; see `tools/` prove guidance and the frontend):
//! - `merged`   == "true"   (REQUIRED; `"merged":true` in the PR payload)
//! - `author`   non-empty, `<= MAX_LOGIN_LEN`, matches bounty author rule
//! - `repo`     == bounty repo `owner/name`
//! - `number`   == bounty PR number (decimal string)
//!
//! Unknown extra keys are ignored (forward compatibility).

use crate::error::ClaimError;
use serde_json::Value;

pub const MAX_MATCHERS: usize = 16;
pub const MAX_MATCHER_LEN: usize = 512;
pub const MAX_LOGIN_LEN: usize = 128;
pub const MAX_REPO_LEN: usize = 128;

/// PR URL pinned per bounty. Single canonical form (no redirects, no query).
pub fn expected_pr_url(repo: &str, pr_number: u64) -> String {
    let mut s = String::with_capacity(38 + repo.len() + 20);
    s.push_str("https://api.github.com/repos/");
    s.push_str(repo);
    s.push_str("/pulls/");
    s.push_str(&pr_number.to_string());
    s
}

/// Validate `owner/name` repo slugs.
pub fn validate_repo(repo: &str) -> Result<(), ClaimError> {
    if repo.is_empty() || repo.len() > MAX_REPO_LEN {
        return Err(ClaimError::TemplateMismatch("bad repo"));
    }
    let mut parts = repo.split('/');
    let owner = parts.next().unwrap_or("");
    let name = parts.next().unwrap_or("");
    if parts.next().is_some() || owner.is_empty() || name.is_empty() {
        return Err(ClaimError::TemplateMismatch("bad repo"));
    }
    let ok = |s: &str| {
        s.bytes().all(|b| {
            b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_'
        })
    };
    if !ok(owner) || !ok(name) {
        return Err(ClaimError::TemplateMismatch("bad repo"));
    }
    Ok(())
}

/// Extracted claim facts after successful validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extracted {
    pub author: String,
}

/// Validate parsed parameters + context values against a bounty.
/// `params_value` must already be the canonical parse; `context_value` the
/// parse of the submitted context (any key order).
pub fn validate_template(
    params_value: &Value,
    context_value: &Value,
    repo: &str,
    pr_number: u64,
) -> Result<Extracted, ClaimError> {
    let params = params_value
        .as_object()
        .ok_or(ClaimError::TemplateMismatch("params not object"))?;

    // Method + URL pinned exactly.
    match params.get("method").and_then(Value::as_str) {
        Some("GET") => {}
        _ => return Err(ClaimError::TemplateMismatch("method must be GET")),
    }
    let url = params.get("url").and_then(Value::as_str).ok_or(
        ClaimError::TemplateMismatch("missing url"),
    )?;
    if url != expected_pr_url(repo, pr_number) {
        return Err(ClaimError::TemplateMismatch("url mismatch"));
    }

    // Matchers: non-empty, bounded, well-formed. The VALUES are attested by
    // the witness; shape checks keep the attestation meaningful.
    let matches = params
        .get("responseMatches")
        .and_then(Value::as_array)
        .ok_or(ClaimError::TemplateMismatch("missing responseMatches"))?;
    if matches.is_empty() || matches.len() > MAX_MATCHERS {
        return Err(ClaimError::TemplateMismatch("bad responseMatches"));
    }
    for m in matches {
        let obj = m
            .as_object()
            .ok_or(ClaimError::TemplateMismatch("bad matcher"))?;
        match obj.get("type").and_then(Value::as_str) {
            Some("regex") | Some("contains") => {}
            _ => return Err(ClaimError::TemplateMismatch("bad matcher type")),
        }
        match obj.get("value").and_then(Value::as_str) {
            Some(v) if !v.is_empty() && v.len() <= MAX_MATCHER_LEN => {}
            _ => return Err(ClaimError::TemplateMismatch("bad matcher value")),
        }
    }
    if let Some(redactions) = params.get("responseRedactions") {
        if !redactions.is_array() {
            return Err(ClaimError::TemplateMismatch("bad responseRedactions"));
        }
    }

    // Extracted facts: merged MUST be "true"; author/repo/number bind the PR.
    let ctx = context_value
        .as_object()
        .ok_or(ClaimError::TemplateMismatch("context not object"))?;
    let extracted = ctx
        .get("extractedParameters")
        .and_then(Value::as_object)
        .ok_or(ClaimError::TemplateMismatch("missing extractedParameters"))?;
    match extracted.get("merged").and_then(Value::as_str) {
        Some("true") => {}
        _ => return Err(ClaimError::PredicateFailed("merged != true")),
    }
    let author = extracted
        .get("author")
        .and_then(Value::as_str)
        .ok_or(ClaimError::PredicateFailed("missing author"))?;
    if author.is_empty() || author.len() > MAX_LOGIN_LEN {
        return Err(ClaimError::PredicateFailed("bad author"));
    }
    match extracted.get("repo").and_then(Value::as_str) {
        Some(r) if r == repo => {}
        _ => return Err(ClaimError::PredicateFailed("repo mismatch")),
    }
    let number = extracted.get("number").and_then(Value::as_str).ok_or(
        ClaimError::PredicateFailed("missing number"),
    )?;
    if number != pr_number.to_string() {
        return Err(ClaimError::PredicateFailed("number mismatch"));
    }

    Ok(Extracted {
        author: author.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn params(url: &str) -> Value {
        json!({
            "body": "",
            "headers": {"User-Agent": "omnibounty"},
            "method": "GET",
            "responseMatches": [
                {"type": "regex", "value": "\"merged\":(?<merged>.*?)[,}]"},
                {"type": "regex", "value": "\"login\":\"(?<author>.*?)\""},
            ],
            "responseRedactions": [],
            "url": url,
        })
    }

    fn context(merged: &str, author: &str, repo: &str, number: &str) -> Value {
        json!({
            "extractedParameters": {
                "merged": merged,
                "author": author,
                "repo": repo,
                "number": number,
            },
            "providerHash": "0x1234",
        })
    }

    #[test]
    fn accepts_compliant_claim() {
        let url = expected_pr_url("octo/demo", 42);
        let e = validate_template(
            &params(&url),
            &context("true", "octocat", "octo/demo", "42"),
            "octo/demo",
            42,
        )
        .unwrap();
        assert_eq!(e.author, "octocat");
    }

    #[test]
    fn rejects_closed_but_unmerged() {
        // THE H4 case: `state=closed` style proofs without merged=true fail.
        let url = expected_pr_url("octo/demo", 42);
        let err = validate_template(
            &params(&url),
            &context("false", "octocat", "octo/demo", "42"),
            "octo/demo",
            42,
        )
        .unwrap_err();
        assert_eq!(err, ClaimError::PredicateFailed("merged != true"));
    }

    #[test]
    fn rejects_wrong_pr_and_repo() {
        let url = expected_pr_url("octo/demo", 42);
        // Wrong URL (different PR number).
        let other = expected_pr_url("octo/demo", 43);
        assert_eq!(
            validate_template(
                &params(&other),
                &context("true", "octocat", "octo/demo", "42"),
                "octo/demo",
                42
            )
            .unwrap_err(),
            ClaimError::TemplateMismatch("url mismatch")
        );
        // Extracted repo/number must match even if URL is right.
        assert!(validate_template(
            &params(&url),
            &context("true", "octocat", "evil/fork", "42"),
            "octo/demo",
            42
        )
        .is_err());
        assert!(validate_template(
            &params(&url),
            &context("true", "octocat", "octo/demo", "43"),
            "octo/demo",
            42
        )
        .is_err());
    }

    #[test]
    fn rejects_malformed_matchers_and_repo() {
        let url = expected_pr_url("octo/demo", 42);
        let mut p = params(&url);
        p["responseMatches"] = json!([]);
        assert!(validate_template(
            &p,
            &context("true", "a", "octo/demo", "42"),
            "octo/demo",
            42
        )
        .is_err());
        assert!(validate_repo("octo/demo").is_ok());
        assert!(validate_repo("no-slash").is_err());
        assert!(validate_repo("a/b/c").is_err());
        assert!(validate_repo("a/b?c=d").is_err());
        assert!(validate_repo("").is_err());
    }
}
