import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseClaimBundle,
  prProofOf,
  proofsOf,
  toContractProofs,
  planClaimSubmission,
  buildQualifyArgs,
  interpretDryOutcome,
  submitWithPreflight,
  selectOwnClaim,
  derivePhase,
  bountyTitleV3,
  bountyCriteriaV3,
} from "../lib/settlement.mjs";

const OWNER = "0x1111111111111111111111111111111111111111";
const SIG = "0x" + "ab".repeat(65);
const ID32 = "0x" + "cd".repeat(32);
const PR_EX = {
  merged: "true", author: "octocat", repo: "o/r", number: "7",
  head_sha: "a".repeat(40), author_id: "10001", pr_created: "2026-10-26T19:00:00Z",
};
const ID_EX = { id_login: "octocat", id_num: "10001" };

// Raw zkFetch output shape ({claimData, signatures}), as prove.mjs writes it.
const rawProof = (extracted, owner = OWNER) => ({
  claimData: {
    provider: "http", parameters: "{\"url\":\"https://api.github.com\"}",
    context: JSON.stringify({ extractedParameters: extracted }),
    identifier: ID32, owner, epoch: 1, timestampS: 100,
  },
  signatures: [SIG],
});
// Already-normalized on-chain shape ({claimInfo, signedClaim}).
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
const BUNDLE = (pr = rawProof(PR_EX), id = onchainProof(ID_EX)) => ({
  criteria_json: '{"repo":"o/r"}',
  proofs: [
    { evidence_type: 1, proof: pr },
    { evidence_type: 7, proof: id },
  ],
});

describe("parseClaimBundle", () => {
  it("accepts criteria as an object and proofs as evidence_type entries", async () => {
    const r = parseClaimBundle(JSON.stringify({
      criteria_json: { repo: "o/r" },
      proofs: [{ evidence_type: 1, proof: rawProof(PR_EX) }],
    }));
    assert.equal(r.ok, true);
    assert.equal(r.bundle.criteria_json, JSON.stringify({ repo: "o/r" }));
    assert.equal(r.bundle.proofs.length, 1);
  });

  it("accepts criteria as a raw string", async () => {
    const r = parseClaimBundle(JSON.stringify({ criteria_json: '{"repo":"o/r"}', proofs: [{ evidence_type: 7, proof: onchainProof(ID_EX) }] }));
    assert.equal(r.ok, true);
    assert.equal(r.bundle.criteria_json, '{"repo":"o/r"}');
  });

  it("rejects non-JSON, missing fields, and malformed proofs", async () => {
    assert.equal(parseClaimBundle("nope").ok, false);
    assert.equal(parseClaimBundle("[]").ok, false);
    assert.equal(parseClaimBundle(JSON.stringify({ proofs: [] })).ok, false);
    assert.equal(parseClaimBundle(JSON.stringify({ criteria_json: "{}", proofs: [] })).ok, false);
    const r = parseClaimBundle(JSON.stringify({
      criteria_json: "{}",
      proofs: [{ evidence_type: 0, proof: {} }, { evidence_type: "pr", proof: {} }, { evidence_type: 9, proof: {} }, { evidence_type: 1 }],
    }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 4);
  });

  it("prProofOf finds the single evidence_type-1 entry", async () => {
    const ok = { proofs: [{ evidence_type: 7, proof: {} }, { evidence_type: 1, proof: rawProof(PR_EX) }] };
    assert.deepEqual(prProofOf(ok), rawProof(PR_EX));
    assert.equal(prProofOf({ proofs: [{ evidence_type: 7, proof: {} }] }), null);
    assert.equal(prProofOf({ proofs: [{ evidence_type: 1, proof: {} }, { evidence_type: 1, proof: {} }] }), null);
  });

  it("proofsOf filters by evidence kind", async () => {
    assert.equal(proofsOf(BUNDLE(), 7).length, 1);
    assert.equal(proofsOf(BUNDLE(), 2).length, 0);
  });
});

describe("toContractProofs", () => {
  it("normalizes raw proofs and binds PR + identity to the recipient", async () => {
    const r = toContractProofs(BUNDLE(), OWNER);
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
    assert.equal(r.contractProofs.length, 2);
    // Exact TaggedProofArg shape: { evidence_type: u8, proof: {claimInfo, signedClaim} }.
    for (const [i, t] of [0, 1].map((i) => [i, [1, 7][i]])) {
      assert.equal(r.contractProofs[i].evidence_type, t);
      assert.deepEqual(Object.keys(r.contractProofs[i].proof).sort(), ["claimInfo", "signedClaim"]);
      assert.deepEqual(Object.keys(r.contractProofs[i].proof.signedClaim.claim).sort(), ["epoch", "identifier", "owner", "timestampS"]);
    }
    // The raw PR proof was normalized (claimData gone), not passed through.
    assert.equal("claimData" in r.contractProofs[0].proof, false);
    assert.equal(r.contractProofs[0].proof.claimInfo.provider, "http");
  });

  it("accepts an already-normalized bundle unchanged", async () => {
    const r = toContractProofs(BUNDLE(onchainProof(PR_EX), onchainProof(ID_EX)), OWNER);
    assert.equal(r.ok, true);
  });

  it("rejects a missing identity proof", async () => {
    const b = BUNDLE();
    b.proofs = b.proofs.slice(0, 1);
    const r = toContractProofs(b, OWNER);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(";"), /identity/);
  });

  it("rejects two PR proofs", async () => {
    const b = BUNDLE();
    b.proofs.push({ evidence_type: 1, proof: rawProof(PR_EX) });
    assert.equal(toContractProofs(b, OWNER).ok, false);
  });

  it("rejects mixed-prover bundles", async () => {
    const other = "0x2222222222222222222222222222222222222222";
    const r = toContractProofs(BUNDLE(rawProof(PR_EX, OWNER), onchainProof(ID_EX, other)), OWNER);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(";"), /one owner/);
  });

  it("rejects identity/PR author mismatch (login and numeric id)", async () => {
    const badLogin = toContractProofs(BUNDLE(rawProof(PR_EX), onchainProof({ ...ID_EX, id_login: "mallory" })), OWNER);
    assert.equal(badLogin.ok, false);
    assert.match(badLogin.errors.join(";"), /not the PR author/);
    const badId = toContractProofs(BUNDLE(rawProof(PR_EX), onchainProof({ ...ID_EX, id_num: "99999" })), OWNER);
    assert.equal(badId.ok, false);
    assert.match(badId.errors.join(";"), /not the PR author/);
  });

  it("rejects a recipient that is not the proof owner", async () => {
    const r = toContractProofs(BUNDLE(), "0x3333333333333333333333333333333333333333");
    assert.equal(r.ok, false);
    assert.match(r.errors.join(";"), /does not match recipient/);
  });

  it("reports malformed proofs with their index", async () => {
    const bad = rawProof(PR_EX);
    delete bad.claimData;
    const r = toContractProofs(BUNDLE(bad, onchainProof(ID_EX)), OWNER);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(";"), /proofs\[0\]/);
  });
});

describe("planClaimSubmission (M1)", () => {
  const TEXT = JSON.stringify({ criteria_json: { repo: "o/r" }, proofs: BUNDLE().proofs });

  it("plans a merged claim with facts and contract proofs", async () => {
    const r = planClaimSubmission(TEXT, OWNER);
    assert.equal(r.ok, true);
    assert.equal(r.facts.merged, "true");
    assert.equal(r.facts.owner, OWNER);
    assert.equal(r.bundle.proofs.length, 2);
    assert.equal(r.bundle.proofs[0].evidence_type, 1);
  });

  it("blocks unmerged PRs: no bundle, no facts", async () => {
    const bad = { criteria_json: { repo: "o/r" }, proofs: BUNDLE(rawProof({ ...PR_EX, merged: "false" })).proofs };
    const r = planClaimSubmission(JSON.stringify(bad), OWNER);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(";"), /NOT merged/);
    assert.equal(r.bundle, undefined);
    assert.equal(r.facts, undefined);
  });

  it("rejects invalid bundles without planning", async () => {
    assert.equal(planClaimSubmission("nope").ok, false);
    assert.equal(planClaimSubmission(JSON.stringify({ criteria_json: "{}", proofs: [] })).ok, false);
  });
});

describe("buildQualifyArgs + interpretDryOutcome (M2)", () => {
  it("builds identical args for dry_qualify and qualify_claim", async () => {
    const plan = planClaimSubmission(JSON.stringify({ criteria_json: { repo: "o/r" }, proofs: BUNDLE().proofs }), OWNER);
    assert.equal(plan.ok, true);
    const args = buildQualifyArgs(7, plan.bundle, OWNER);
    assert.deepEqual(Object.keys(args).sort(), ["bounty_id", "criteria_json", "proofs", "recipient"]);
    assert.equal(args.bounty_id, 7);
    assert.equal(args.criteria_json, JSON.stringify({ repo: "o/r" }));
    assert.equal(args.proofs, plan.bundle.proofs);
    assert.equal(args.recipient, OWNER);
  });

  it("passes a clean dry outcome through", async () => {
    const r = interpretDryOutcome({ ok: true, bounty_id: 7, pr_number: 7, head_sha: "a", verdicts: [], errors: [] });
    assert.deepEqual(r, { ok: true, errors: [] });
  });

  it("surfaces contract rejections with failing verdicts", async () => {
    const r = interpretDryOutcome({
      ok: false, bounty_id: 7, pr_number: null, head_sha: null,
      verdicts: [
        { id: "pr.matchers", status: "Pass", detail: "" },
        { id: "identity.login", status: "Fail", detail: "identity is not the PR author" },
      ],
      errors: ["ClaimError::PredicateFailed"],
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(";"), /PredicateFailed/);
    assert.match(r.errors.join(";"), /identity\.login: identity is not the PR author/);
    assert.doesNotMatch(r.errors.join(";"), /pr\.matchers/);
  });

  it("fails closed on malformed outcomes", async () => {
    for (const bad of [null, undefined, "ok", 42, [], {}, { ok: "yes", errors: [] }, { errors: [] }]) {
      assert.equal(interpretDryOutcome(bad).ok, false, JSON.stringify(bad));
    }
    // ok:true must still carry an empty error list.
    assert.equal(interpretDryOutcome({ ok: true, errors: ["stray"] }).ok, false);
  });
});

describe("submitWithPreflight (M2)", () => {
  const ARGS = { bounty_id: 7, criteria_json: "{}", proofs: [], recipient: OWNER };
  const DRY_OK = { ok: true, bounty_id: 7, pr_number: 7, head_sha: "a", verdicts: [], errors: [] };

  it("signs with the identical args object after a passing preflight", async () => {
    const seen = [];
    const r = await submitWithPreflight({
      args: ARGS,
      dryCall: async (a) => { seen.push(["dry", a]); return DRY_OK; },
      signCall: async (a) => { seen.push(["sign", a]); return { txHash: "0xhash" }; },
    });
    assert.equal(r.ok, true);
    assert.equal(r.receipt.txHash, "0xhash");
    assert.deepEqual(seen.map(([k]) => k), ["dry", "sign"]);
    assert.equal(seen[0][1], ARGS);
    assert.equal(seen[1][1], ARGS);
    assert.equal(seen[0][1], seen[1][1]);
  });

  it("never signs after a contract rejection", async () => {
    let signed = 0;
    const r = await submitWithPreflight({
      args: ARGS,
      dryCall: async () => ({ ...DRY_OK, ok: false, errors: ["BountyNotFunded(7)"] }),
      signCall: async () => { signed++; return { txHash: "0xno" }; },
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(";"), /BountyNotFunded/);
    assert.equal(signed, 0);
  });

  it("never signs when preflight RPC throws or responds malformed", async () => {
    let signed = 0;
    const signCall = async () => { signed++; return { txHash: "0xno" }; };
    const down = await submitWithPreflight({ args: ARGS, dryCall: async () => { throw new Error("RPC down"); }, signCall });
    assert.equal(down.ok, false);
    assert.match(down.errors.join(";"), /Preflight check failed/);
    const garbled = await submitWithPreflight({ args: ARGS, dryCall: async () => null, signCall });
    assert.equal(garbled.ok, false);
    assert.match(garbled.errors.join(";"), /unreadable/);
    assert.equal(signed, 0);
  });

  it("reports wallet errors without masking", async () => {
    const r = await submitWithPreflight({
      args: ARGS,
      dryCall: async () => DRY_OK,
      signCall: async () => { throw new Error("user rejected"); },
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(";"), /user rejected/);
  });
});

describe("selectOwnClaim", () => {
  const C = (slot, recipient, seq) => ({ slot, claim: { recipient, claim_seq: seq } });

  it("matches case-insensitively and prefers the latest claim_seq", async () => {
    const entries = [
      C(0, "0xAAA", 0),
      { slot: 1, claim: null },
      C(1, "0xaaa", 3),
      C(2, "0xbbb", 9),
    ];
    assert.deepEqual(selectOwnClaim(entries, "0xaaa"), C(1, "0xaaa", 3));
    assert.equal(selectOwnClaim(entries, "0xzzz"), null);
    assert.equal(selectOwnClaim([], "0xaaa"), null);
  });
});

describe("derivePhase", () => {
  const NOW = 1000;
  const V = { voucher: { digest: "0xd" }, v: 27, r: "0xr", s: "0xs" };

  it("walks qualifying -> qualified -> finalizing -> signing -> settling -> paid", async () => {
    assert.deepEqual(derivePhase({ claim: null, voucher: null, used: null, nowSec: NOW }), { phase: "qualifying" });
    assert.deepEqual(
      derivePhase({ claim: { signed: false, pending_digest: null, challenge_ends_at: NOW + 60 }, voucher: null, used: null, nowSec: NOW }),
      { phase: "qualified", waitSec: 60 }
    );
    assert.deepEqual(
      derivePhase({ claim: { signed: false, pending_digest: null, challenge_ends_at: NOW }, voucher: null, used: null, nowSec: NOW }),
      { phase: "finalizing" }
    );
    assert.deepEqual(
      derivePhase({ claim: { signed: false, pending_digest: "0xd", challenge_ends_at: 0 }, voucher: null, used: null, nowSec: NOW }),
      { phase: "signing" }
    );
    assert.deepEqual(derivePhase({ claim: { signed: true }, voucher: V, used: false, nowSec: NOW }), { phase: "settling" });
    assert.deepEqual(derivePhase({ claim: { signed: true }, voucher: V, used: null, nowSec: NOW }), { phase: "settling" });
    assert.deepEqual(derivePhase({ claim: { signed: true }, voucher: V, used: true, nowSec: NOW }), { phase: "paid" });
  });

  it("treats signed-without-voucher as settling (view lag)", async () => {
    assert.deepEqual(
      derivePhase({ claim: { signed: true, pending_digest: null }, voucher: null, used: null, nowSec: NOW }),
      { phase: "settling" }
    );
  });
});

describe("v3 bounty lines", () => {
  it("renders title and criteria without V1 fields", async () => {
    const b = { id: 7, slots: ["1000000", "1000000"], slots_filled: 1, total_amount: "2000000", challenge_window: 0 };
    assert.equal(bountyTitleV3(b), "Bounty #7");
    const line = bountyCriteriaV3(b);
    assert.match(line, /2 slots \(1 claimed\)/);
    assert.match(line, /no challenge delay/);
    assert.match(line, /2\.00 USDC/);
  });

  it("names a nonzero challenge window", async () => {
    const b = { id: 8, slots: ["1000000"], slots_filled: 0, total_amount: "1000000", challenge_window: 3600 };
    assert.match(bountyCriteriaV3(b), /challenge window 3600s/);
  });
});
