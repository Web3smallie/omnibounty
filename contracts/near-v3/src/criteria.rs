//! V3 acceptance-criteria documents: strict JSON subset, canonicalization,
//! validation, and commitment hashing.
//!
//! Byte-for-byte companion of `frontend/lib/criteria.mjs`. Parity is pinned
//! by `testdata/v3/golden-hashes.json` (all 8 scenarios) plus edge-case
//! tests below. Any drift fails the suite — the vectors win over prose.
//!
//! Strict-subset rules (mirror the TS `strictParseJson` exactly):
//! - No duplicate object keys, comparing DECODED key values (so `{"a":1,
//!   "\u0061":2}` is rejected).
//! - No numeric literals, no `null` literals anywhere. Booleans allowed.
//! - Unbalanced brackets / malformed strings rejected.
//!
//! Canonical form reuses `canon::canonicalize` (canonicalize@2.1.0 order).
//! String lengths count UTF-16 code units (JS `.length` semantics), NOT
//! bytes or scalar values.

use crate::canon;
use crate::error::ClaimError;
use crate::normalize::parse_u256_decimal;
use near_sdk::env;
use serde_json::Value;
use std::collections::HashSet;

pub const MAX_CRITERIA_BYTES: usize = 32_768;
pub const MAX_EVIDENCE_AGE_SEC: u64 = 604_800;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergePolicy {
    Merged,
    CiVerified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityPolicy {
    Open,
    Commitment,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckRule {
    pub name: String,
    pub apps: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtectedFile {
    pub path: String,
    pub blob_sha: [u8; 20],
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FilesRules {
    pub allowed: Vec<String>,
    pub forbidden: Vec<String>,
    pub required_touched: Vec<String>,
    pub protected: Vec<ProtectedFile>,
    pub max_changed_files: Option<u64>,
    pub max_additions: Option<u64>,
    pub max_deletions: Option<u64>,
    pub patch_contains_all: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRule {
    pub login: String,
    pub associations: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueRule {
    pub url: String,
    pub number: u64,
    pub require_close_reference: bool,
    pub keywords: Vec<String>,
}

/// Fully validated, typed criteria. Every rule below mirrors the TS
/// `validateCriteria` field-for-field; any divergence breaks parity tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedCriteria {
    pub repo: String,
    pub base_commit: Option<[u8; 20]>,
    pub merge_policy: MergePolicy,
    pub allow_forks: bool,
    pub author_association: Vec<String>,
    pub identity: IdentityPolicy,
    pub checks: Vec<CheckRule>,
    pub check_max_age: Option<u64>,
    pub files: Option<FilesRules>,
    pub labels: Vec<String>,
    pub reviews: Vec<ReviewRule>,
    pub issue: Option<IssueRule>,
    pub single_winner: bool,
    pub slots: Vec<[u8; 32]>,
    pub deadline: u64,
    pub challenge_window: u64,
    pub evidence_max_age: u64,
}

/// UTF-16 code-unit length (JS `.length` semantics). All schema string
/// bounds use this measure — bytes and scalar counts both differ for
/// astral characters.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn is_canonical_uint(s: &str) -> bool {
    if s.is_empty() || s.len() > 20 {
        return false;
    }
    let b = s.as_bytes();
    if b[0] == b'0' {
        return s.len() == 1;
    }
    b[0].is_ascii_digit() && b[0] != b'0' && b.iter().all(|c| c.is_ascii_digit())
}

fn parse_canonical_u64(field: &'static str, s: &str) -> Result<u64, ClaimError> {
    if !is_canonical_uint(s) {
        return Err(ClaimError::InvalidCriteria(field));
    }
    s.parse::<u64>()
        .map_err(|_| ClaimError::InvalidCriteria(field))
}

fn is_repo_slug(s: &str) -> bool {
    if s.is_empty() || utf16_len(s) > 128 {
        return false;
    }
    let mut parts = s.split('/');
    let (owner, name) = match (parts.next(), parts.next(), parts.next()) {
        (Some(o), Some(n), None) => (o, n),
        _ => return false,
    };
    if owner.is_empty() || name.is_empty() {
        return false;
    }
    let ok = |p: &str| {
        p.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    };
    ok(owner) && ok(name)
}

// -- Strict JSON scanner -----------------------------------------------------
// Mirrors TS strictParseJson: rejects duplicate keys (decoded compare),
// numeric literals, and null literals. Returns the parsed value.

fn unescape_key(raw: &[u8]) -> Result<String, ClaimError> {
    // raw includes surrounding quotes.
    let mut out = String::new();
    let mut i = 1usize;
    while i + 1 < raw.len() {
        let c = raw[i];
        if c != b'\\' {
            out.push(c as char);
            i += 1;
            continue;
        }
        i += 1;
        if i >= raw.len() {
            return Err(ClaimError::InvalidCriteria("bad string escape"));
        }
        match raw[i] {
            b'"' => out.push('"'),
            b'\\' => out.push('\\'),
            b'/' => out.push('/'),
            b'b' => out.push('\u{0008}'),
            b'f' => out.push('\u{000C}'),
            b'n' => out.push('\n'),
            b'r' => out.push('\r'),
            b't' => out.push('\t'),
            b'u' => {
                if i + 4 >= raw.len() {
                    return Err(ClaimError::InvalidCriteria("bad string escape"));
                }
                let hex = std::str::from_utf8(&raw[i + 1..i + 5])
                    .map_err(|_| ClaimError::InvalidCriteria("bad string escape"))?;
                let mut cp = u32::from_str_radix(hex, 16)
                    .map_err(|_| ClaimError::InvalidCriteria("bad string escape"))?;
                i += 4;
                if (0xd800..0xdc00).contains(&cp)
                    && i + 6 < raw.len()
                    && raw[i + 1] == b'\\'
                    && raw[i + 2] == b'u'
                {
                    let lo_hex = std::str::from_utf8(&raw[i + 3..i + 7])
                        .map_err(|_| ClaimError::InvalidCriteria("bad string escape"))?;
                    if let Ok(lo) = u32::from_str_radix(lo_hex, 16) {
                        if (0xdc00..0xe000).contains(&lo) {
                            cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
                            i += 6;
                        }
                    }
                }
                out.push(
                    char::from_u32(cp).ok_or(ClaimError::InvalidCriteria("bad string escape"))?,
                );
            }
            _ => return Err(ClaimError::InvalidCriteria("bad string escape")),
        }
        i += 1;
    }
    Ok(out)
}

/// Strict-parse criteria text: subset rules first, then serde parse.
pub fn strict_parse(text: &str) -> Result<Value, ClaimError> {
    if text.len() > MAX_CRITERIA_BYTES {
        return Err(ClaimError::ProofTooLarge("criteria"));
    }
    let b = text.as_bytes();
    let n = b.len();
    let mut stack: Vec<Option<HashSet<String>>> = Vec::new(); // Some=set obj, None=array
    let mut i = 0usize;
    while i < n {
        let c = b[i];
        if c == b'"' {
            // Read full string honoring backslash escapes.
            let mut j = i + 1;
            while j < n {
                if b[j] == b'\\' {
                    j += 2;
                    continue;
                }
                if b[j] == b'"' {
                    break;
                }
                j += 1;
            }
            if j >= n {
                return Err(ClaimError::InvalidCriteria("malformed JSON"));
            }
            let raw = &b[i..j + 1];
            // Key iff next non-ws char is ':'.
            let mut k = j + 1;
            while k < n && matches!(b[k], b' ' | b'\t' | b'\n' | b'\r') {
                k += 1;
            }
            if k < n && b[k] == b':' {
                match stack.last_mut() {
                    Some(Some(keys)) => {
                        let key = unescape_key(raw)?;
                        if !keys.insert(key) {
                            return Err(ClaimError::InvalidCriteria("duplicate key"));
                        }
                    }
                    _ => return Err(ClaimError::InvalidCriteria("malformed JSON")),
                }
            }
            i = j + 1;
            continue;
        }
        match c {
            b'{' => stack.push(Some(HashSet::new())),
            b'[' => stack.push(None),
            b'}' | b']' => {
                if stack.pop().is_none() {
                    return Err(ClaimError::InvalidCriteria("malformed JSON"));
                }
            }
            b'-' | b'0'..=b'9' => {
                return Err(ClaimError::InvalidCriteria("numeric literal"));
            }
            b'n' if b[i..].starts_with(b"null")
                && b.get(i + 4)
                    .is_none_or(|d| !d.is_ascii_alphanumeric() && *d != b'_') =>
            {
                return Err(ClaimError::InvalidCriteria("null literal"));
            }
            _ => {}
        }
        i += 1;
    }
    if !stack.is_empty() {
        return Err(ClaimError::InvalidCriteria("malformed JSON"));
    }
    serde_json::from_str(text).map_err(|_| ClaimError::InvalidCriteria("malformed JSON"))
}

/// Canonical bytes + commitment hash.
pub fn canonicalize_criteria_text(text: &str) -> Result<String, ClaimError> {
    let v = strict_parse(text)?;
    canon::canonicalize(&v)
}

pub fn criteria_hash(text: &str) -> Result<[u8; 32], ClaimError> {
    let canon = canonicalize_criteria_text(text)?;
    let h = env::keccak256(canon.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(&h);
    Ok(out)
}

const ASSOCIATIONS: &[&str] = &[
    "OWNER",
    "MEMBER",
    "COLLABORATOR",
    "CONTRIBUTOR",
    "FIRST_TIMER",
    "FIRST_TIME_CONTRIBUTOR",
    "MANNEQUIN",
    "NONE",
];

fn get<'a>(obj: &'a serde_json::Map<String, Value>, key: &str) -> Result<&'a Value, ClaimError> {
    obj.get(key)
        .ok_or(ClaimError::InvalidCriteria("missing required field"))
}

fn as_str(v: &Value) -> Result<&str, ClaimError> {
    v.as_str()
        .ok_or(ClaimError::InvalidCriteria("expected string"))
}

fn check_len(s: &str, min: usize, max: usize) -> bool {
    let l = utf16_len(s);
    l >= min && l <= max
}

fn uniq_strings(
    v: &Value,
    min: usize,
    max: usize,
    smin: usize,
    smax: usize,
) -> Result<Vec<String>, ClaimError> {
    let arr = v
        .as_array()
        .ok_or(ClaimError::InvalidCriteria("expected array"))?;
    if arr.len() < min || arr.len() > max {
        return Err(ClaimError::InvalidCriteria("bad array length"));
    }
    let mut out = Vec::with_capacity(arr.len());
    let mut seen = HashSet::new();
    for item in arr {
        let s = as_str(item)?;
        if !check_len(s, smin, smax) {
            return Err(ClaimError::InvalidCriteria("bad string length"));
        }
        if !seen.insert(s.to_string()) {
            return Err(ClaimError::InvalidCriteria("duplicate entry"));
        }
        out.push(s.to_string());
    }
    Ok(out)
}

fn parse_hex40(s: &str) -> Result<[u8; 20], ClaimError> {
    if s.len() != 40
        || !s
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(ClaimError::InvalidCriteria("bad sha"));
    }
    let mut out = [0u8; 20];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        let hi = (chunk[0] as char).to_digit(16).unwrap();
        let lo = (chunk[1] as char).to_digit(16).unwrap();
        out[i] = ((hi << 4) | lo) as u8;
    }
    Ok(out)
}

/// Full shape + semantic validation. Mirrors TS `validateCriteria`
/// field-for-field; any divergence breaks parity tests.
pub fn validate_criteria(doc: &Value) -> Result<ValidatedCriteria, ClaimError> {
    let obj = doc
        .as_object()
        .ok_or(ClaimError::InvalidCriteria("must be an object"))?;
    const TOP: &[&str] = &[
        "schema",
        "version",
        "title",
        "description",
        "repo",
        "base_commit",
        "merge_policy",
        "allow_forks",
        "author_association",
        "identity_policy",
        "checks",
        "files",
        "labels",
        "reviews",
        "issue",
        "policy",
        "slots",
        "unfilled",
        "deadline",
        "challenge_window_sec",
        "evidence_max_age_sec",
    ];
    for k in obj.keys() {
        if !TOP.contains(&k.as_str()) {
            return Err(ClaimError::InvalidCriteria("unknown field"));
        }
    }
    for k in [
        "schema",
        "version",
        "title",
        "description",
        "repo",
        "merge_policy",
        "allow_forks",
        "identity_policy",
        "policy",
        "slots",
        "unfilled",
        "deadline",
        "challenge_window_sec",
        "evidence_max_age_sec",
    ] {
        if !obj.contains_key(k) {
            return Err(ClaimError::InvalidCriteria("missing required field"));
        }
    }
    if get(obj, "schema")?.as_str() != Some("omnibounty/criteria") {
        return Err(ClaimError::InvalidCriteria("bad schema id"));
    }
    if get(obj, "version")?.as_str() != Some("1") {
        return Err(ClaimError::InvalidCriteria("unsupported version"));
    }
    let title = as_str(get(obj, "title")?)?;
    if !check_len(title, 1, 120) {
        return Err(ClaimError::InvalidCriteria("bad title"));
    }
    let description = as_str(get(obj, "description")?)?;
    if !check_len(description, 1, 8000) {
        return Err(ClaimError::InvalidCriteria("bad description"));
    }
    let repo = as_str(get(obj, "repo")?)?;
    if !is_repo_slug(repo) {
        return Err(ClaimError::InvalidCriteria("bad repo"));
    }
    let base_commit = match obj.get("base_commit") {
        None => None,
        Some(v) => Some(
            parse_hex40(as_str(v).map_err(|_| ClaimError::InvalidCriteria("bad base_commit"))?)
                .map_err(|_| ClaimError::InvalidCriteria("bad base_commit"))?,
        ),
    };
    let merge_policy = match as_str(get(obj, "merge_policy")?)? {
        "merged" => MergePolicy::Merged,
        "ci_verified" => MergePolicy::CiVerified,
        _ => return Err(ClaimError::InvalidCriteria("bad merge_policy")),
    };
    let allow_forks = get(obj, "allow_forks")?
        .as_bool()
        .ok_or(ClaimError::InvalidCriteria("bad allow_forks"))?;
    let author_association = match obj.get("author_association") {
        None => Vec::new(),
        Some(v) => {
            let list = uniq_strings(v, 1, 8, 1, 64)?;
            for a in &list {
                if !ASSOCIATIONS.contains(&a.as_str()) {
                    return Err(ClaimError::InvalidCriteria("bad association"));
                }
            }
            list
        }
    };
    let identity = match as_str(get(obj, "identity_policy")?)? {
        "open" => IdentityPolicy::Open,
        "commitment" => IdentityPolicy::Commitment,
        _ => return Err(ClaimError::InvalidCriteria("bad identity_policy")),
    };

    // Checks (optional section).
    let mut checks = Vec::new();
    let mut check_max_age = None;
    if let Some(c) = obj.get("checks") {
        let co = c
            .as_object()
            .ok_or(ClaimError::InvalidCriteria("bad checks"))?;
        for k in co.keys() {
            if k != "required" && k != "max_age_sec" {
                return Err(ClaimError::InvalidCriteria("unknown field"));
            }
        }
        let req = co
            .get("required")
            .and_then(Value::as_array)
            .ok_or(ClaimError::InvalidCriteria("bad checks.required"))?;
        if req.is_empty() || req.len() > 16 {
            return Err(ClaimError::InvalidCriteria("bad checks.required"));
        }
        let mut names = HashSet::new();
        for r in req {
            let ro = r
                .as_object()
                .ok_or(ClaimError::InvalidCriteria("bad check"))?;
            for k in ro.keys() {
                if k != "name" && k != "apps" {
                    return Err(ClaimError::InvalidCriteria("unknown field"));
                }
            }
            let name = as_str(get(ro, "name")?)
                .map_err(|_| ClaimError::InvalidCriteria("bad check name"))?;
            if !check_len(name, 1, 256) {
                return Err(ClaimError::InvalidCriteria("bad check name"));
            }
            if !names.insert(name.to_string()) {
                return Err(ClaimError::InvalidCriteria("duplicate entry"));
            }
            // No per-array max (mirrors TS/schema): the 32KB document cap
            // bounds worst-case size; each entry is length-checked.
            let apps = uniq_strings(
                get(ro, "apps").map_err(|_| ClaimError::InvalidCriteria("bad check apps"))?,
                1,
                usize::MAX,
                1,
                128,
            )
            .map_err(|_| ClaimError::InvalidCriteria("bad check apps"))?;
            checks.push(CheckRule {
                name: name.to_string(),
                apps,
            });
        }
        if let Some(m) = co.get("max_age_sec") {
            let s = as_str(m).map_err(|_| ClaimError::InvalidCriteria("bad max_age_sec"))?;
            check_max_age = Some(parse_canonical_u64("max_age_sec", s)?);
        }
    }

    // Files (optional section).
    let mut files = None;
    if let Some(f) = obj.get("files") {
        let fo = f
            .as_object()
            .ok_or(ClaimError::InvalidCriteria("bad files"))?;
        for k in fo.keys() {
            if ![
                "allowed_paths",
                "forbidden_paths",
                "required_touched",
                "protected",
                "max_changed_files",
                "max_additions",
                "max_deletions",
                "patch_contains_all",
            ]
            .contains(&k.as_str())
            {
                return Err(ClaimError::InvalidCriteria("unknown field"));
            }
        }
        if fo.is_empty() {
            return Err(ClaimError::InvalidCriteria("empty files section"));
        }
        let path_list = |key: &str| -> Result<Vec<String>, ClaimError> {
            match fo.get(key) {
                None => Ok(Vec::new()),
                Some(v) => {
                    let arr = v
                        .as_array()
                        .ok_or(ClaimError::InvalidCriteria("bad path list"))?;
                    if arr.is_empty() {
                        return Err(ClaimError::InvalidCriteria("bad path list"));
                    }
                    let mut out = Vec::new();
                    let mut seen = HashSet::new();
                    for p in arr {
                        let s = as_str(p).map_err(|_| ClaimError::InvalidCriteria("bad path"))?;
                        let norm = check_path_pattern(s, true)?;
                        if !seen.insert(norm.clone()) {
                            return Err(ClaimError::InvalidCriteria("duplicate entry"));
                        }
                        out.push(norm);
                    }
                    Ok(out)
                }
            }
        };
        let mut protected = Vec::new();
        if let Some(p) = fo.get("protected") {
            let arr = p
                .as_array()
                .ok_or(ClaimError::InvalidCriteria("bad protected"))?;
            if arr.is_empty() || arr.len() > 16 {
                return Err(ClaimError::InvalidCriteria("bad protected"));
            }
            let mut seen = HashSet::new();
            for e in arr {
                let eo = e
                    .as_object()
                    .ok_or(ClaimError::InvalidCriteria("bad protected"))?;
                for k in eo.keys() {
                    if k != "path" && k != "blob_sha" {
                        return Err(ClaimError::InvalidCriteria("unknown field"));
                    }
                }
                let path = check_path_pattern(
                    as_str(get(eo, "path").map_err(|_| ClaimError::InvalidCriteria("bad path"))?)
                        .map_err(|_| ClaimError::InvalidCriteria("bad path"))?,
                    false,
                )?;
                let blob_sha = parse_hex40(
                    as_str(
                        get(eo, "blob_sha")
                            .map_err(|_| ClaimError::InvalidCriteria("bad blob_sha"))?,
                    )
                    .map_err(|_| ClaimError::InvalidCriteria("bad blob_sha"))?,
                )?;
                if !seen.insert(path.clone()) {
                    return Err(ClaimError::InvalidCriteria("duplicate entry"));
                }
                protected.push(ProtectedFile { path, blob_sha });
            }
        }
        let opt_u64 = |key: &str| -> Result<Option<u64>, ClaimError> {
            match fo.get(key) {
                None => Ok(None),
                Some(v) => {
                    let s = as_str(v).map_err(|_| ClaimError::InvalidCriteria("bad uint"))?;
                    Ok(Some(parse_canonical_u64("bad uint", s)?))
                }
            }
        };
        let patch_contains_all = match fo.get("patch_contains_all") {
            None => Vec::new(),
            Some(v) => uniq_strings(v, 1, 8, 1, 256)
                .map_err(|_| ClaimError::InvalidCriteria("bad patch_contains_all"))?,
        };
        files = Some(FilesRules {
            allowed: path_list("allowed_paths")?,
            forbidden: path_list("forbidden_paths")?,
            required_touched: path_list("required_touched")?,
            protected,
            max_changed_files: opt_u64("max_changed_files")?,
            max_additions: opt_u64("max_additions")?,
            max_deletions: opt_u64("max_deletions")?,
            patch_contains_all,
        });
    }

    // Labels (optional section).
    let mut labels = Vec::new();
    if let Some(l) = obj.get("labels") {
        let lo = l
            .as_object()
            .ok_or(ClaimError::InvalidCriteria("bad labels"))?;
        for k in lo.keys() {
            if k != "required_all" {
                return Err(ClaimError::InvalidCriteria("unknown field"));
            }
        }
        labels = uniq_strings(
            get(lo, "required_all").map_err(|_| ClaimError::InvalidCriteria("bad labels"))?,
            1,
            8,
            1,
            64,
        )
        .map_err(|_| ClaimError::InvalidCriteria("bad labels"))?;
    }

    // Reviews (optional section).
    let mut reviews = Vec::new();
    if let Some(r) = obj.get("reviews") {
        let ro = r
            .as_object()
            .ok_or(ClaimError::InvalidCriteria("bad reviews"))?;
        for k in ro.keys() {
            if k != "required_approvals" {
                return Err(ClaimError::InvalidCriteria("unknown field"));
            }
        }
        let arr = get(ro, "required_approvals")
            .map_err(|_| ClaimError::InvalidCriteria("bad reviews"))?
            .as_array()
            .ok_or(ClaimError::InvalidCriteria("bad reviews"))?;
        if arr.is_empty() || arr.len() > 8 {
            return Err(ClaimError::InvalidCriteria("bad reviews"));
        }
        let mut seen = HashSet::new();
        for a in arr {
            let ao = a
                .as_object()
                .ok_or(ClaimError::InvalidCriteria("bad review"))?;
            for k in ao.keys() {
                if k != "login" && k != "association" {
                    return Err(ClaimError::InvalidCriteria("unknown field"));
                }
            }
            let login =
                as_str(get(ao, "login").map_err(|_| ClaimError::InvalidCriteria("bad review"))?)
                    .map_err(|_| ClaimError::InvalidCriteria("bad review"))?;
            if !check_len(login, 1, 128) {
                return Err(ClaimError::InvalidCriteria("bad review"));
            }
            if !seen.insert(login.to_string()) {
                return Err(ClaimError::InvalidCriteria("duplicate entry"));
            }
            let mut associations = Vec::new();
            if let Some(av) = ao.get("association") {
                let arr2 = av
                    .as_array()
                    .ok_or(ClaimError::InvalidCriteria("bad association"))?;
                if arr2.is_empty() {
                    return Err(ClaimError::InvalidCriteria("bad association"));
                }
                let mut seen2 = HashSet::new();
                for x in arr2 {
                    let s =
                        as_str(x).map_err(|_| ClaimError::InvalidCriteria("bad association"))?;
                    if !ASSOCIATIONS.contains(&s) {
                        return Err(ClaimError::InvalidCriteria("bad association"));
                    }
                    if !seen2.insert(s.to_string()) {
                        return Err(ClaimError::InvalidCriteria("duplicate entry"));
                    }
                    associations.push(s.to_string());
                }
            }
            reviews.push(ReviewRule {
                login: login.to_string(),
                associations,
            });
        }
    }

    // Issue (optional section).
    let mut issue = None;
    if let Some(g) = obj.get("issue") {
        let go = g
            .as_object()
            .ok_or(ClaimError::InvalidCriteria("bad issue"))?;
        for k in go.keys() {
            if k != "url" && k != "require_close_reference" && k != "keywords" {
                return Err(ClaimError::InvalidCriteria("unknown field"));
            }
        }
        for k in ["url", "require_close_reference", "keywords"] {
            if !go.contains_key(k) {
                return Err(ClaimError::InvalidCriteria("missing required field"));
            }
        }
        let url = as_str(get(go, "url").map_err(|_| ClaimError::InvalidCriteria("bad issue url"))?)
            .map_err(|_| ClaimError::InvalidCriteria("bad issue url"))?;
        let number = parse_issue_url(url, repo)?;
        let require_close_reference = go["require_close_reference"]
            .as_bool()
            .ok_or(ClaimError::InvalidCriteria("bad issue flag"))?;
        let keywords = uniq_strings(
            get(go, "keywords").map_err(|_| ClaimError::InvalidCriteria("bad issue keywords"))?,
            1,
            4,
            1,
            32,
        )
        .map_err(|_| ClaimError::InvalidCriteria("bad issue keywords"))?;
        issue = Some(IssueRule {
            url: url.to_string(),
            number,
            require_close_reference,
            keywords,
        });
    }

    // Rewards + policy.
    let single_winner = match as_str(get(obj, "policy")?)? {
        "single_winner" => true,
        "ordered_slots" => false,
        _ => return Err(ClaimError::InvalidCriteria("bad policy")),
    };
    let slots_v = get(obj, "slots")?
        .as_array()
        .ok_or(ClaimError::InvalidCriteria("bad slots"))?;
    if slots_v.is_empty() || slots_v.len() > 16 {
        return Err(ClaimError::InvalidCriteria("bad slots"));
    }
    if single_winner && slots_v.len() != 1 {
        return Err(ClaimError::InvalidCriteria("policy/slots mismatch"));
    }
    let mut slots = Vec::with_capacity(slots_v.len());
    for s in slots_v {
        let so = s
            .as_object()
            .ok_or(ClaimError::InvalidCriteria("bad slot"))?;
        for k in so.keys() {
            if k != "amount" {
                return Err(ClaimError::InvalidCriteria("unknown field"));
            }
        }
        let amount =
            as_str(get(so, "amount").map_err(|_| ClaimError::InvalidCriteria("bad amount"))?)
                .map_err(|_| ClaimError::InvalidCriteria("bad amount"))?;
        if !is_canonical_decimal(amount) {
            return Err(ClaimError::InvalidCriteria("bad amount"));
        }
        let bytes =
            parse_u256_decimal(amount).map_err(|_| ClaimError::InvalidCriteria("bad amount"))?;
        if bytes == [0u8; 32] {
            return Err(ClaimError::InvalidCriteria("zero amount"));
        }
        slots.push(bytes);
    }
    if as_str(get(obj, "unfilled")?)? != "refund_sponsor" {
        return Err(ClaimError::InvalidCriteria("bad unfilled"));
    }

    // Timing.
    let deadline = parse_canonical_u64(
        "deadline",
        as_str(get(obj, "deadline")?).map_err(|_| ClaimError::InvalidCriteria("bad deadline"))?,
    )?;
    let challenge_window = parse_canonical_u64(
        "challenge_window_sec",
        as_str(get(obj, "challenge_window_sec")?)
            .map_err(|_| ClaimError::InvalidCriteria("bad challenge_window_sec"))?,
    )?;
    let evidence_max_age = parse_canonical_u64(
        "evidence_max_age_sec",
        as_str(get(obj, "evidence_max_age_sec")?)
            .map_err(|_| ClaimError::InvalidCriteria("bad evidence_max_age_sec"))?,
    )?;
    if evidence_max_age == 0 || evidence_max_age > MAX_EVIDENCE_AGE_SEC {
        return Err(ClaimError::InvalidCriteria("bad evidence_max_age_sec"));
    }

    Ok(ValidatedCriteria {
        repo: repo.to_string(),
        base_commit,
        merge_policy,
        allow_forks,
        author_association,
        identity,
        checks,
        check_max_age,
        files,
        labels,
        reviews,
        issue,
        single_winner,
        slots,
        deadline,
        challenge_window,
        evidence_max_age,
    })
}

fn is_canonical_decimal(s: &str) -> bool {
    if s.is_empty() || s.len() > 78 {
        return false;
    }
    let b = s.as_bytes();
    if b[0] == b'0' {
        return s.len() == 1;
    }
    b[0].is_ascii_digit() && b[0] != b'0' && b.iter().all(|c| c.is_ascii_digit())
}

fn check_path_pattern(p: &str, allow_trailing_slash: bool) -> Result<String, ClaimError> {
    if p.is_empty() || p.len() > 512 {
        return Err(ClaimError::InvalidCriteria("bad path"));
    }
    if p.starts_with('/') || p.contains('\\') || p.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return Err(ClaimError::InvalidCriteria("bad path"));
    }
    if p.bytes().any(|b| {
        matches!(
            b,
            b'*' | b'?' | b'[' | b']' | b'{' | b'}' | b'(' | b')' | b'|' | b'+' | b'^' | b'$'
        )
    }) {
        return Err(ClaimError::InvalidCriteria("bad path"));
    }
    let body = if allow_trailing_slash && p.ends_with('/') {
        &p[..p.len() - 1]
    } else {
        if p.ends_with('/') {
            return Err(ClaimError::InvalidCriteria("bad path"));
        }
        p
    };
    if body.is_empty() {
        return Err(ClaimError::InvalidCriteria("bad path"));
    }
    for seg in body.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(ClaimError::InvalidCriteria("bad path"));
        }
    }
    Ok(p.to_string())
}

fn parse_issue_url(url: &str, repo: &str) -> Result<u64, ClaimError> {
    let rest = url
        .strip_prefix("https://github.com/")
        .ok_or(ClaimError::InvalidCriteria("bad issue url"))?;
    let after_repo = rest
        .strip_prefix(repo)
        .filter(|r| r.starts_with('/'))
        .ok_or(ClaimError::InvalidCriteria("bad issue url"))?;
    let after_repo = &after_repo[1..];
    let num = after_repo
        .strip_prefix("issues/")
        .or_else(|| after_repo.strip_prefix("pull/"))
        .ok_or(ClaimError::InvalidCriteria("bad issue url"))?;
    if num.is_empty() || !is_canonical_decimal(num) || num == "0" {
        return Err(ClaimError::InvalidCriteria("bad issue url"));
    }
    num.parse::<u64>()
        .map_err(|_| ClaimError::InvalidCriteria("bad issue url"))
}

#[cfg(test)]
mod tests {
    use super::*;

    macro_rules! valid_case {
        ($name:ident, $file:literal) => {
            #[test]
            fn $name() {
                let text = include_str!(concat!("../../../testdata/v3/criteria-valid/", $file));
                let v = strict_parse(text).expect("valid fixture must parse");
                validate_criteria(&v).expect("valid fixture must validate");
            }
        };
    }

    valid_case!(accept_simple_ci, "simple-ci.json");
    valid_case!(accept_multi_check, "multi-check.json");
    valid_case!(accept_protected, "protected.json");
    valid_case!(accept_forbidden, "forbidden.json");
    valid_case!(accept_merged, "merged.json");
    valid_case!(accept_multi_winner, "multi-winner.json");
    valid_case!(accept_weighted, "weighted.json");
    valid_case!(accept_deadline_challenge, "deadline-challenge.json");

    macro_rules! invalid_case {
        ($name:ident, $file:literal) => {
            #[test]
            fn $name() {
                let text = include_str!(concat!("../../../testdata/v3/criteria-invalid/", $file));
                let rejected = match strict_parse(text) {
                    Err(_) => true,
                    Ok(v) => validate_criteria(&v).is_err(),
                };
                assert!(rejected, "fixture {} must be rejected", $file);
            }
        };
    }

    invalid_case!(reject_bad_slug, "bad-slug.json");
    invalid_case!(reject_leading_zero_amount, "leading-zero-amount.json");
    invalid_case!(reject_unknown_field, "unknown-field.json");
    invalid_case!(reject_policy_mismatch, "policy-mismatch.json");
    invalid_case!(reject_zero_amount, "zero-amount.json");
    invalid_case!(reject_glob_path, "glob-path.json");
    invalid_case!(reject_duplicate_keys, "duplicate-keys.json");
    invalid_case!(reject_null_value, "null-value.json");
    invalid_case!(reject_number_literal, "number-literal.json");
    invalid_case!(reject_issue_repo_mismatch, "issue-repo-mismatch.json");

    #[test]
    fn golden_hashes_match_typescript() {
        // Byte-parity gate with frontend/lib/criteria.mjs: same fixtures,
        // same hashes. Generated by experiments/phase2-criteria/scripts/
        // gen-golden-hashes.mjs (TS implementation).
        let raw = include_str!("../../../testdata/v3/golden-hashes.json");
        let goldens: serde_json::Value = serde_json::from_str(raw).unwrap();
        for name in [
            "simple-ci",
            "multi-check",
            "protected",
            "forbidden",
            "merged",
            "multi-winner",
            "weighted",
            "deadline-challenge",
        ] {
            let path = format!("../../../testdata/v3/criteria-valid/{name}.json");
            // include_str! needs a literal: dispatch explicitly.
            let text: &str = match name {
                "simple-ci" => include_str!("../../../testdata/v3/criteria-valid/simple-ci.json"),
                "multi-check" => {
                    include_str!("../../../testdata/v3/criteria-valid/multi-check.json")
                }
                "protected" => include_str!("../../../testdata/v3/criteria-valid/protected.json"),
                "forbidden" => include_str!("../../../testdata/v3/criteria-valid/forbidden.json"),
                "merged" => include_str!("../../../testdata/v3/criteria-valid/merged.json"),
                "multi-winner" => {
                    include_str!("../../../testdata/v3/criteria-valid/multi-winner.json")
                }
                "weighted" => include_str!("../../../testdata/v3/criteria-valid/weighted.json"),
                _ => include_str!("../../../testdata/v3/criteria-valid/deadline-challenge.json"),
            };
            let _ = path;
            let hash = criteria_hash(text).unwrap();
            let mut hex = String::with_capacity(66);
            hex.push_str("0x");
            for byte in hash {
                hex.push_str(&format!("{byte:02x}"));
            }
            assert_eq!(
                hex,
                goldens[name].as_str().unwrap(),
                "golden drift for {name}"
            );
        }
    }

    #[test]
    fn eyeball_case_matches_hand_verified_bytes() {
        // Same minimal case asserted in frontend/test/criteria.test.mjs.
        let canon =
            canonicalize_criteria_text(r#"{"z":"1","a":{"d":"4","c":"3"},"m":["3","2"]}"#).unwrap();
        assert_eq!(canon, r#"{"a":{"c":"3","d":"4"},"m":["3","2"],"z":"1"}"#);
    }

    #[test]
    fn non_bmp_key_order_matches_js_utf16() {
        // U+10000 sorts BEFORE U+E000 in UTF-16 code units (D800 < E000)
        // but AFTER it in byte/scalar order. TS canonicalize() puts U+10000
        // first (verified via node); Rust must agree byte-for-byte.
        let input = "{\"\u{e000}\":\"1\",\"\u{10000}\":\"2\"}";
        let canon = canonicalize_criteria_text(input).unwrap();
        // Expected bytes built from explicit escapes (no invisible literals):
        // {"<U+10000>":"2","<U+E000>":"1"} with U+10000 first (D800 < E000).
        let expected = ["{\"", "\u{10000}", "\":\"2\",\"", "\u{e000}", "\":\"1\"}"].concat();
        assert_eq!(canon, expected);
    }

    #[test]
    fn scanner_edges() {
        // Escaped-encoding duplicate.
        assert!(strict_parse("{\"a\":true,\"\\u0061\":false}").is_err());
        // Nested duplicate.
        assert!(strict_parse("{\"o\":{\"x\":true,\"x\":false}}").is_err());
        // Same key in sibling objects is fine.
        assert!(strict_parse("{\"a\":{\"x\":true},\"b\":{\"x\":false}}").is_ok());
        // Number forms rejected everywhere.
        for bad in [
            "{\"a\":1}",
            "{\"a\":-0}",
            "{\"a\":1.5}",
            "{\"a\":1e3}",
            "[1]",
            "{\"a\":[true,2]}",
        ] {
            assert!(strict_parse(bad).is_err(), "must reject {bad}");
        }
        // Null rejected everywhere; booleans fine.
        assert!(strict_parse("{\"a\":null}").is_err());
        assert!(strict_parse("[null]").is_err());
        assert!(strict_parse("{\"a\":true,\"b\":false,\"c\":\"null\"}").is_ok());
        // Unbalanced / malformed.
        assert!(strict_parse("{\"a\":true").is_err());
        assert!(strict_parse("{\"a\":true}}").is_err());
        assert!(strict_parse("{\"a\": }").is_err());
        // Deep nesting beyond canon cap fails (via canonicalize path).
        let deep = "{\"a\":".repeat(40) + "true" + &"}".repeat(40);
        assert!(canonicalize_criteria_text(&deep).is_err());
        // Oversize document rejected.
        assert!(strict_parse(&" ".repeat(MAX_CRITERIA_BYTES + 1)).is_err());
    }

    #[test]
    fn utf16_length_bounds() {
        // U+10000 counts 2 units (JS semantics), not 1 char or 4 bytes.
        assert_eq!(utf16_len("𐀀"), 2);
        assert_eq!(utf16_len("a"), 1);
        // 60 astral chars = 120 units: OK as a title; 61 = 122: rejected.
        let ok_title = "𐀀".repeat(60);
        let bad_title = "𐀀".repeat(61);
        let doc = |t: &str| {
            format!(
                "{{\"schema\":\"omnibounty/criteria\",\"version\":\"1\",\"title\":\"{t}\",\
                 \"description\":\"d\",\"repo\":\"o/r\",\"merge_policy\":\"ci_verified\",\
                 \"allow_forks\":true,\"identity_policy\":\"open\",\"policy\":\"single_winner\",\
                 \"slots\":[{{\"amount\":\"1\"}}],\"unfilled\":\"refund_sponsor\",\"deadline\":\"0\",\
                 \"challenge_window_sec\":\"0\",\"evidence_max_age_sec\":\"604800\"}}"
            )
        };
        let v_ok = strict_parse(&doc(&ok_title)).unwrap();
        assert!(validate_criteria(&v_ok).is_ok());
        let v_bad = strict_parse(&doc(&bad_title)).unwrap();
        assert!(validate_criteria(&v_bad).is_err());
    }

    #[test]
    fn uint_edges() {
        assert_eq!(parse_canonical_u64("t", "0").unwrap(), 0);
        assert_eq!(
            parse_canonical_u64("t", "18446744073709551615").unwrap(),
            u64::MAX
        );
        assert!(parse_canonical_u64("t", "007").is_err());
        assert!(parse_canonical_u64("t", "18446744073709551616").is_err());
        assert!(parse_canonical_u64("t", "").is_err());
        assert!(parse_canonical_u64("t", "-1").is_err());
        assert!(parse_canonical_u64("t", " 1").is_err());
    }
}
