# OmniBounty V3 — Canonicalization

Normative byte-level rules for criteria documents. The same document MUST
produce byte-identical canonical form in TypeScript and Rust; Solidity never
canonicalizes (it compares opaque `bytes32` hashes only).

## 1. Input: strict JSON subset

A criteria document is UTF-8 text that MUST satisfy, in order:

1. Parse as exactly one JSON value that is an object.
2. Contain **no numeric literals** (`1`, `-0`, `1.5`, `1e3` all rejected).
   All integers are canonical decimal strings validated separately.
3. Contain **no `null` literal** anywhere. Missing means absent; there is no
   null-valued field in the schema.
4. Contain **no duplicate object keys**, comparing keys by *decoded* value:
   `{"a":1,"a":2}` and `{"a":1,"\u0061":2}` are both rejected, at any depth.
5. Booleans, strings, objects and arrays are allowed.

Rationale: duplicates + numbers + null are the three classic sources of
cross-implementation hash divergence. Forbidding them removes the ambiguity
instead of specifying it.

## 2. Canonical form algorithm

1. Strict-parse per §1 (reject on any violation).
2. Validate shape + semantics per `CRITERIA_SCHEMA.json` and the TS
   enforcer (`frontend/lib/criteria.mjs`). Only valid documents hash.
3. Re-emit with **keys sorted recursively by UTF-16 code-unit order**,
   arrays in original order, minimal separators (`,` and `:`), no
   whitespace, `JSON.stringify` string escaping. This is exactly
   `canonicalize@2.1.0` semantics.

## 3. Field ordering, arrays, strings

- Object key order is insignificant pre-canonical, sorted post-canonical.
- Array order is **significant** and preserved (slot order, check order).
- Strings are exact code points: no Unicode normalization, no case folding,
  no trimming. Lowercase-only rules (hex SHAs) are enforced by the schema,
  not by silent normalization — a non-lowercase hash is REJECTED, never fixed.
- Missing vs null: missing optional sections are simply absent from the
  hashed bytes. There are **no implicit defaults** in canonical form:
  authoring tooling shows the sponsor the exact bytes that will be hashed,
  and funding commits to those bytes. What you preview is what gets hashed.

## 4. Duplicate-key detection algorithm (portable spec)

Single pass over the raw text with an explicit stack (objects hold a key
set, arrays hold nothing). On `"` outside a string, read the full string
honoring backslash escapes; if the next non-whitespace character is `:`,
it is a key: unescape it (JSON escapes incl. `\uXXXX` with surrogate-pair
composition) and reject on repeat within the current object depth. On
`{`/`[` push, on `}`/`]` pop (reject unbalanced). A `-` or digit outside
a string rejects (numeric literal). A bare `null` token rejects.
Reference implementation: `strictParseJson` in `frontend/lib/criteria.mjs`;
the Rust port MUST implement these exact rules (acceptance gate below).

## 5. Hash algorithm

```
criteria_hash = keccak256(UTF-8(canonical_bytes)), rendered 0x + lowercase hex
```

keccak256 (Ethereum variant, NOT NIST SHA3-256). TS uses `ethers.keccak256`;
Rust MUST use `env::keccak256`; Solidity compares `bytes32` equality only.

## 6. Golden vectors

`testdata/v3/golden-hashes.json` maps the 8 scenario fixtures to their
criteria hashes. Regenerate deterministically with
`experiments/phase2-criteria/scripts/gen-golden-hashes.mjs`; any drift fails
`frontend/test/criteria.test.mjs`. The nullifier-key golden vector lives in
the same suite (`buildNullifierKey` over e2e-fixture values).

Hand-verified minimal example (also asserted byte-for-byte in tests):

```
input:  {"z":"1","a":{"d":"4","c":"3"},"m":["3","2"]}
canon:  {"a":{"c":"3","d":"4"},"m":["3","2"],"z":"1"}
```

## 7. Cross-language compatibility contract

| Language | Role | Rule | Status |
|---|---|---|---|
| TypeScript | Authoring, preview, hashing, tests | `criteria.mjs` + `canonicalize@2.1.0` pinned exact + `ethers` keccak | IMPLEMENTED + TESTED |
| Rust (contract) | Re-hash claim-supplied doc, compare to committed hash | MUST reuse `canon::canonicalize_str` (already canonicalize@2.1.0-compatible, proven by live identifier MATCH) + `env::keccak256` + a port of §4 | SPECIFIED — acceptance gate: golden vectors byte-equal |
| Solidity (escrow) | Bind voucher to criteria | Compares `bytes32 criteriaHash` only; never parses JSON | SPECIFIED |

No other canonicalization behavior is conforming. If an implementation
cannot reproduce the golden vectors byte-for-byte, it is non-compliant —
the vectors win over prose.
