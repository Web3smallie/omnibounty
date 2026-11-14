import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashCriteriaDocument } from "../lib/criteria.mjs";
import { fetchCriteriaDocument, verifyCriteriaText } from "../lib/criteriaSource.mjs";

// P0-4: criteria retrieval + hash verification. Fixtures are the repo's own
// criteria vectors; the golden hashes file is the independent oracle.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const SIMPLE_CI = read("testdata/v3/criteria-valid/simple-ci.json");
const MERGED = read("testdata/v3/criteria-valid/merged.json");
const GOLDEN = JSON.parse(read("testdata/v3/golden-hashes.json"));
const DEMO_HASH = "0x499fc4d32bc3bc91a8cab81785c6fb59e7073c3f769e2b03399b68bdcd7e95b6";

const okRes = (text) => ({ ok: true, status: 200, text: async () => text });
const statusRes = (status) => ({ ok: status >= 200 && status < 300, status, text: async () => "" });

describe("criteria text verification", () => {
  it("accepts a document hashing to the on-chain commitment (golden-anchored)", () => {
    assert.equal(hashCriteriaDocument(SIMPLE_CI), GOLDEN["simple-ci"]);
    const r = verifyCriteriaText(SIMPLE_CI, GOLDEN["simple-ci"]);
    assert.equal(r.ok, true);
    assert.equal(r.hash, GOLDEN["simple-ci"]);
    assert.equal(r.text, SIMPLE_CI);
    assert.equal(r.doc.repo, "react/react");
  });

  it("rejects a valid document committed to a different hash (wrong bounty)", () => {
    const r = verifyCriteriaText(MERGED, GOLDEN["simple-ci"]);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "mismatch");
    assert.match(r.detail, /hashes to .* bounty commits to/);
  });

  it("rejects malformed JSON", () => {
    assert.equal(verifyCriteriaText("{bad", GOLDEN["simple-ci"]).reason, "malformed");
    assert.equal(verifyCriteriaText("", GOLDEN["simple-ci"]).reason, "malformed");
    assert.equal(verifyCriteriaText(null, GOLDEN["simple-ci"]).reason, "malformed");
    assert.equal(verifyCriteriaText('{"a":1,"a":2}', GOLDEN["simple-ci"]).reason, "malformed");
  });

  it("rejects well-formed JSON that fails criteria validation", () => {
    const bad = read("testdata/v3/criteria-invalid/zero-amount.json");
    const r = verifyCriteriaText(bad, GOLDEN["simple-ci"]);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "invalid");
  });

  it("rejects malformed expected hashes without hashing", () => {
    for (const h of [undefined, null, "", "xyz", "0x1234", GOLDEN["simple-ci"].slice(2)]) {
      assert.equal(verifyCriteriaText(SIMPLE_CI, h).reason, "invalid");
    }
  });

  it("accepts uppercase hashes by normalizing case", () => {
    assert.equal(verifyCriteriaText(SIMPLE_CI, GOLDEN["simple-ci"].toUpperCase()).ok, true);
  });
});

describe("criteria artifact retrieval", () => {
  it("retrieves and verifies a served document", async () => {
    const calls = [];
    const r = await fetchCriteriaDocument(GOLDEN["simple-ci"], async (url) => {
      calls.push(url);
      assert.match(url, new RegExp(`/criteria/${GOLDEN["simple-ci"]}\\.json$`));
      return okRes(SIMPLE_CI);
    });
    assert.equal(calls.length, 1);
    assert.equal(r.ok, true);
    assert.equal(r.hash, GOLDEN["simple-ci"]);
  });

  it("rejects a served document that fails verification", async () => {
    const r = await fetchCriteriaDocument(GOLDEN["simple-ci"], async () => okRes(MERGED));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "mismatch");
  });

  it("reports missing artifacts so the UI falls back to paste", async () => {
    const calls = [];
    const r = await fetchCriteriaDocument(GOLDEN["merged"], async (url) => {
      calls.push(url);
      return statusRes(404);
    });
    assert.equal(calls.length, 1);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "missing");
  });

  it("reports storage and RPC failures distinctly from missing", async () => {
    assert.equal(
      (await fetchCriteriaDocument(GOLDEN["simple-ci"], async () => statusRes(500))).reason,
      "unavailable"
    );
    assert.equal(
      (await fetchCriteriaDocument(GOLDEN["simple-ci"], async () => {
        throw new Error("fetch failed");
      })).reason,
      "unavailable"
    );
    assert.equal(
      (
        await fetchCriteriaDocument(GOLDEN["simple-ci"], async () => ({
          ok: true,
          status: 200,
          text: async () => {
            throw new Error("body read failed");
          },
        }))
      ).reason,
      "unavailable"
    );
  });

  it("rejects malformed and invalid served documents", async () => {
    assert.equal(
      (await fetchCriteriaDocument(GOLDEN["simple-ci"], async () => okRes("{bad"))).reason,
      "malformed"
    );
    const bad = read("testdata/v3/criteria-invalid/zero-amount.json");
    assert.equal(
      (await fetchCriteriaDocument(GOLDEN["simple-ci"], async () => okRes(bad))).reason,
      "invalid"
    );
  });

  it("never fetches for a malformed hash", async () => {
    let calls = 0;
    const r = await fetchCriteriaDocument("xyz", async () => {
      calls++;
      return okRes(SIMPLE_CI);
    });
    assert.equal(calls, 0);
    assert.equal(r.reason, "invalid");
  });
});

describe("served demo criteria artifact", () => {
  const ARTIFACT = "frontend/public/criteria/0x499fc4d32bc3bc91a8cab81785c6fb59e7073c3f769e2b03399b68bdcd7e95b6.json";
  const EVIDENCE = "audit-backup-20261113/proofs/demo-criteria.json";

  it("is byte-identical to the documented RUN4 evidence (no fabrication)", () => {
    assert.equal(read(ARTIFACT), read(EVIDENCE));
    assert.equal(read(ARTIFACT).length, 517);
  });

  it("hashes to its own filename and validates", () => {
    const text = read(ARTIFACT);
    assert.equal(hashCriteriaDocument(text), DEMO_HASH);
    assert.equal(verifyCriteriaText(text, DEMO_HASH).ok, true);
  });
});
