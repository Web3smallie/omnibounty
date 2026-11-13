// OmniBounty V3 batch finalizer: discover matured claims and finalize each.
//
// Runs `runOnce` from ./finalize.mjs once per eligible claim: unsigned +
// challenge-expired, discovered by paging list_bounties and probing each
// filled slot. Designed for scheduled runs (see
// .github/workflows/finalize-scheduler.yml); the one-shot finalize.mjs
// remains the manual fallback and shares all submission logic.
//
// Safety properties (mirroring the one-shot tool):
// - Discovery is a prefilter only; runOnce re-verifies claim, voucher
//   absence, and maturity before any transaction (TOCTOU-safe).
// - At most one submission attempt per claim per run; SlotPending /
//   AlreadyFinalized outcomes fall through to polling, never resubmit.
// - Per-claim polling is bounded (BATCH_ROUNDS); stragglers retry next tick.
// - One claim's failure never blocks the others; the exit code still
//   reports it (0 = all ok or nothing eligible, 1 = any failure).
// - No secrets are printed; evidence holds public chain data only.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runOnce, buildEvidence } from "./finalize.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC_URL = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";
const CONTRACT_ID = "omnibounty-v3.testnet";
const KEY_FILE = process.env.NEAR_KEY_FILE || join(ROOT, "secrets", "v3-operator.json");
const PAGE = 100; // == NEAR MAX_LIST_LIMIT
const BATCH_ROUNDS = 8; // <=2 min polling per claim; leftovers retry next tick

// Eligible = unsigned + challenge-expired. Malformed entries are skipped
// (fail-closed); a failed page fetch throws and fails the run loudly.
export async function discoverMatured(account, contractId, nowSec) {
  const out = [];
  let from = 0;
  for (;;) {
    const page = await account.viewFunction({
      contractId, methodName: "list_bounties", args: { from, limit: PAGE },
    });
    if (!Array.isArray(page)) {
      throw new Error(`unexpected list_bounties shape at offset ${from}`);
    }
    if (page.length === 0) break;
    for (const b of page) {
      if (!b || typeof b.id !== "number" || !Array.isArray(b.slots)) continue;
      if (b.slots_filled === 0) continue;
      const n = Math.min(b.slots.length, 64);
      for (let slot = 0; slot < n; slot++) {
        const claim = await account.viewFunction({
          contractId, methodName: "get_claim", args: { bounty_id: b.id, slot },
        });
        if (!claim) continue;
        if (claim.signed === true) continue;
        if (typeof claim.challenge_ends_at !== "number") continue;
        if (nowSec < claim.challenge_ends_at) continue;
        out.push({ bountyId: b.id, slot, claim });
      }
    }
    if (page.length < PAGE) break;
    from += page.length;
  }
  return out;
}

export async function runBatch(deps, { rounds = BATCH_ROUNDS, writeEvidence } = {}) {
  const { account, contractId, nowSec } = deps;
  const sleepFn = deps.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const results = [];
  let eligible;
  try {
    eligible = await discoverMatured(account, contractId, nowSec);
  } catch (e) {
    return { code: 1, results: [{ status: "discovery-error", detail: e.message ?? String(e) }] };
  }
  for (const item of eligible) {
    try {
      const r = await runOnce({ account, contractId, nowSec, sleepFn, rounds }, item);
      const evidence = buildEvidence({
        contractId, bountyId: item.bountyId, slot: item.slot,
        claim: item.claim, txHash: r.txHash, voucher: r.voucher, submitted: r.submitted,
      });
      if (writeEvidence) await writeEvidence(item, evidence);
      results.push({
        status: "finalized", bountyId: item.bountyId, slot: item.slot,
        submitted: r.submitted, txHash: r.txHash, digest: r.voucher.voucher.digest,
      });
    } catch (e) {
      results.push({
        status: "failed", bountyId: item.bountyId, slot: item.slot,
        detail: e.message ?? String(e),
      });
    }
  }
  return { code: results.some((r) => r.status === "failed") ? 1 : 0, results };
}

async function main(argv) {
  if (argv.length !== 0) {
    console.error("usage: node tools/finalize_batch.mjs (no arguments; discovers eligible claims itself)");
    process.exitCode = 2;
    return;
  }
  let saved;
  try {
    const { readFileSync: read } = await import("node:fs");
    saved = JSON.parse(read(KEY_FILE, "utf8"));
  } catch (e) {
    console.error(`cannot read operator key file ${KEY_FILE}: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  const { createRequire } = await import("node:module");
  const nearApi = createRequire(import.meta.url)("../frontend/node_modules/near-api-js");
  const keystore = new nearApi.keyStores.InMemoryKeyStore();
  const keyPair = nearApi.KeyPair.fromString(saved.private_key);
  await keystore.setKey("testnet", saved.account_id, keyPair);
  const near = await nearApi.connect({ networkId: "testnet", keyStore: keystore, nodeUrl: RPC_URL });
  const account = await near.account(saved.account_id);
  const nowSec = Math.floor(Date.now() / 1000);
  const dir = join(ROOT, ".link-temp");
  mkdirSync(dir, { recursive: true });
  const report = await runBatch(
    { account, contractId: CONTRACT_ID, nowSec },
    {
      writeEvidence: async (item, evidence) => {
        writeFileSync(
          join(dir, `finalize-${item.bountyId}-${item.slot}.json`),
          JSON.stringify(evidence, null, 2) + "\n"
        );
      },
    }
  );
  console.log(JSON.stringify({ contract: CONTRACT_ID, at: new Date().toISOString(), ...report }, null, 2));
  process.exitCode = report.code;
}

if (process.argv[1]?.endsWith("finalize_batch.mjs")) {
  await main(process.argv.slice(2));
}
