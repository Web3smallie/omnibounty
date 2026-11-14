import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  VOUCHER_CLAIMED_TOPIC,
  VOUCHER_CLAIMED_TOPIC_V2,
  aggregateV3Paid,
  baseAddressUrl,
  baseBlockUrl,
  baseTxUrl,
  bountyCardAmountText,
  bountyCardPrUrl,
  bountyCardSlotsText,
  bountyCriteria,
  bountyMatchesQuery,
  bountyTitle,
  claimedAmountsTotal,
  claimedBitmapTotal,
  extractNearTxHash,
  findVoucherClaimedTx,
  findVoucherClaimedTxV2,
  formatDateTime,
  formatExpiry,
  formatUsdc,
  githubPrUrl,
  interpretNearTxOutcome,
  isBountyExpired,
  isBountyV3,
  isSuccessfulReceipt,
  nearAccountUrl,
  nearTxUrl,
  chunkRanges,
  describeFetchFailure,
  parseAmountValue,
  payoutScanSpec,
  shortenAddress,
  thrownTxHash,
  timeAgo,
  v3EscrowCardState,
} from "../lib/display.mjs";

// Real VoucherClaimed log from the $1 V2 payout on Base Sepolia
// (tx 0xead24060…, block 57109940, bounty #2). Public on-chain data,
// used here as an independent-oracle vector for the settlement parser.
const REAL_PAYOUT_LOG = {
  address: "0xee5c8f3154fed8b9b2f5d820ac687fdfa8cf2c99",
  topics: [
    "0x4d6e87a106811ec1860b64b16b64e3bb1d328b4eddf3cfa1779e7340dd5e74a5",
    "0x0000000000000000000000000000000000000000000000000000000000000002",
    "0x000000000000000000000000aa77daf4a174b3d05d6046462a7cb0e8eb9fa426",
  ],
  data: "0x00000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000000000000044034055de723155c051e9f33cf70aa286d8b4e0cc46e6db1849fe5db238f72d",
  blockNumber: "0x3676db4",
  transactionHash: "0xead24060467e605e610a66d2e8331c9860991a219e49c77a25a137a40ae30b05",
};

const REAL_TRANSFER_LOG = {
  address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  topics: [
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    "0x000000000000000000000000ee5c8f3154fed8b9b2f5d820ac687fdfa8cf2c99",
    "0x000000000000000000000000aa77daf4a174b3d05d6046462a7cb0e8eb9fa426",
  ],
  data: "0x00000000000000000000000000000000000000000000000000000000000f4240",
  blockNumber: "0x3676db4",
  transactionHash: "0xead24060467e605e610a66d2e8331c9860991a219e49c77a25a137a40ae30b05",
};

describe("money formatting", () => {
  it("formats USDC base units with 6 decimals", () => {
    assert.equal(formatUsdc("1000000"), "1.00");
    assert.equal(formatUsdc("0"), "0.00");
    assert.equal(formatUsdc("1"), "0.000001");
    assert.equal(formatUsdc("1000001"), "1.000001");
    assert.equal(formatUsdc("2500000000"), "2,500.00");
    assert.equal(formatUsdc("25500000"), "25.50");
    assert.equal(formatUsdc(1000000), "1.00");
    assert.equal(formatUsdc(1000000n), "1.00");
  });

  it("rejects negative and malformed amounts", () => {
    assert.throws(() => formatUsdc("-1"), /negative/);
    assert.throws(() => formatUsdc("abc"), /Cannot convert/);
  });
});

describe("addresses and time", () => {
  it("shortens addresses", () => {
    assert.equal(shortenAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"), "0x036C…CF7e");
    assert.equal(shortenAddress("short"), "short");
  });

  it("formats timestamps and expiries", () => {
    assert.equal(formatDateTime(1794129386), "2026-11-08 09:16 UTC");
    assert.equal(formatExpiry(0), "No deadline");
    assert.equal(formatExpiry(1794129386), "2026-11-08 09:16 UTC");
  });

  it("computes relative age deterministically", () => {
    assert.equal(timeAgo(1000, 1005), "just now");
    assert.equal(timeAgo(1000, 1300), "5m ago");
    assert.equal(timeAgo(1000, 1000 + 3 * 3600), "3h ago");
    assert.equal(timeAgo(1000, 1000 + 2 * 86400), "2d ago");
    assert.equal(timeAgo(2000, 1000), "just now"); // future clamps
  });
});

describe("explorer links", () => {
  it("builds NEAR links per network", () => {
    assert.equal(nearTxUrl("testnet", "ABC"), "https://testnet.nearblocks.io/txns/ABC");
    assert.equal(nearTxUrl("mainnet", "ABC"), "https://nearblocks.io/txns/ABC");
    assert.equal(
      nearAccountUrl("testnet", "v2.omnibounty.testnet"),
      "https://testnet.nearblocks.io/address/v2.omnibounty.testnet"
    );
  });

  it("builds Base Sepolia links", () => {
    assert.equal(baseTxUrl("0xabc"), "https://sepolia.basescan.org/tx/0xabc");
    assert.equal(baseAddressUrl("0xabc"), "https://sepolia.basescan.org/address/0xabc");
    assert.equal(baseBlockUrl(12), "https://sepolia.basescan.org/block/12");
  });

  it("builds GitHub PR links", () => {
    assert.equal(githubPrUrl("react/react", 38132), "https://github.com/react/react/pull/38132");
  });
});

describe("bounty presentation", () => {
  const bounty = { id: 2, repo: "react/react", pr_number: 38132, expiry: 0 };

  it("derives title and criteria from the on-chain template", () => {
    assert.equal(bountyTitle(bounty), "react/react#38132");
    assert.ok(bountyCriteria(bounty).includes("react/react#38132"));
    assert.ok(bountyCriteria(bounty).includes("Reclaim"));
  });

  it("detects expiry", () => {
    assert.equal(isBountyExpired({ expiry: 0 }, 9999999999), false);
    assert.equal(isBountyExpired({ expiry: 1000 }, 2000), true);
    assert.equal(isBountyExpired({ expiry: 3000 }, 2000), false);
  });
});

describe("NEAR outcome parsing", () => {
  it("extracts tx hashes from wallet-selector outcome shapes", () => {
    assert.equal(extractNearTxHash({ transaction: { hash: "H1" } }), "H1");
    assert.equal(extractNearTxHash({ transaction_outcome: { id: "H2" } }), "H2");
    assert.equal(extractNearTxHash("H3"), "H3");
  });

  it("returns null instead of fabricating a hash", () => {
    assert.equal(extractNearTxHash(null), null);
    assert.equal(extractNearTxHash(undefined), null);
    assert.equal(extractNearTxHash({}), null);
    assert.equal(extractNearTxHash({ transaction: {} }), null);
  });
});

describe("NEAR final execution status (P1-8)", () => {
  const okOutcome = (over = {}) => ({
    final_execution_status: "FINAL",
    status: { SuccessValue: "e30=" },
    transaction: { hash: "H1" },
    transaction_outcome: { id: "H1" },
    receipts_outcome: [],
    ...over,
  });

  it("accepts SuccessValue, including empty bodies, with the hash preserved", () => {
    assert.deepEqual(interpretNearTxOutcome(okOutcome()), { ok: true, txHash: "H1" });
    const r = interpretNearTxOutcome(okOutcome({ status: { SuccessValue: "" } }));
    assert.equal(r.ok, true);
    assert.equal(r.txHash, "H1");
  });

  it("fails explicit execution failures with the contract message and hash", () => {
    const r = interpretNearTxOutcome(
      okOutcome({
        status: {
          Failure: {
            error_message: "Smart contract panicked: BountyNotFunded(7)",
            error_type: { ActionError: { kind: "FunctionCallError" } },
          },
        },
      })
    );
    assert.equal(r.ok, false);
    assert.equal(r.txHash, "H1");
    assert.match(r.error, /NEAR transaction failed/);
    assert.match(r.error, /BountyNotFunded\(7\)/);
  });

  it("flattens nested failure detail when no message is present", () => {
    const r = interpretNearTxOutcome(okOutcome({ status: { Failure: { error_type: { ActionError: "x" } } } }));
    assert.equal(r.ok, false);
    assert.match(r.error, /ActionError/);
    const s = interpretNearTxOutcome(okOutcome({ status: { Failure: "boom" } }));
    assert.match(s.error, /boom/);
  });

  it("fails closed on pending, basic, and unrecognized statuses", () => {
    for (const status of ["Started", "NotStarted", "EXECUTED", { SuccessReceiptId: "r" }, { SuccessValue: 5 }, [], 5]) {
      const r = interpretNearTxOutcome(okOutcome({ status }));
      assert.equal(r.ok, false, JSON.stringify(status));
      assert.equal(r.txHash, "H1");
    }
    assert.match(interpretNearTxOutcome(okOutcome({ status: "Failure" })).error, /failed/);
  });

  it("fails closed on missing status and malformed results, keeping any hash", () => {
    const missing = interpretNearTxOutcome({ transaction: { hash: "H9" } });
    assert.equal(missing.ok, false);
    assert.equal(missing.txHash, "H9");
    assert.match(missing.error, /missing execution status/);
    for (const bad of [null, undefined, 42, [], { status: null }]) {
      assert.equal(interpretNearTxOutcome(bad).ok, false);
    }
    // A bare hash string carries no status: unverifiable, hash echoed back.
    assert.deepEqual(interpretNearTxOutcome("abc"), {
      ok: false,
      txHash: "abc",
      error: "NEAR transaction could not be verified (unreadable result).",
    });
  });
});

describe("thrownTxHash", () => {
  it("reads hashes carried by thrown NEAR failures", () => {
    assert.equal(thrownTxHash(Object.assign(new Error("x"), { txHash: "H1" })), "H1");
    assert.equal(thrownTxHash(new Error("x")), null);
    assert.equal(thrownTxHash(null), null);
    assert.equal(thrownTxHash({ txHash: 5 }), null);
    assert.equal(thrownTxHash({ txHash: "" }), null);
  });
});

describe("RPC failure diagnosis", () => {
  const URL = "https://rpc.testnet.near.org";

  it("keeps the endpoint and the undici cause chain", () => {
    const cause = new Error("getaddrinfo ENOTFOUND rpc.testnet.near.org");
    cause.code = "ENOTFOUND";
    const err = new Error("fetch failed");
    err.cause = cause;
    assert.equal(
      describeFetchFailure(URL, err),
      "fetch failed (https://rpc.testnet.near.org): fetch failed [cause: ENOTFOUND: getaddrinfo ENOTFOUND rpc.testnet.near.org]"
    );
  });

  it("handles causeless errors and non-Error inputs without crashing", () => {
    assert.equal(
      describeFetchFailure(URL, new Error("fetch failed")),
      "fetch failed (https://rpc.testnet.near.org): fetch failed"
    );
    assert.equal(
      describeFetchFailure(URL, "boom"),
      "fetch failed (https://rpc.testnet.near.org): boom"
    );
    const err = new Error("fetch failed");
    err.cause = "socket hang up";
    assert.ok(describeFetchFailure(URL, err).includes("[cause: socket hang up]"));
  });
});

describe("settlement parsing", () => {
  it("pins the VoucherClaimed topic (cross-checked with ethers)", () => {
    assert.equal(VOUCHER_CLAIMED_TOPIC, ethers.id("VoucherClaimed(uint256,address,uint256,uint256,bytes32)"));
  });

  it("finds the real $1 payout in the receipt logs", () => {
    const found = findVoucherClaimedTx([REAL_TRANSFER_LOG, REAL_PAYOUT_LOG], 2);
    assert.deepEqual(found, {
      txHash: "0xead24060467e605e610a66d2e8331c9860991a219e49c77a25a137a40ae30b05",
      blockNumber: 57109940,
      amount: "1000000",
    });
  });

  it("ignores other bounties, other events, and malformed logs", () => {
    assert.equal(findVoucherClaimedTx([REAL_TRANSFER_LOG, REAL_PAYOUT_LOG], 7), null);
    assert.equal(findVoucherClaimedTx([REAL_TRANSFER_LOG], 2), null);
    assert.equal(findVoucherClaimedTx([], 2), null);
    assert.equal(findVoucherClaimedTx(null, 2), null);
    assert.equal(findVoucherClaimedTx([{ topics: [] }], 2), null);
    assert.equal(
      findVoucherClaimedTx([{ ...REAL_PAYOUT_LOG, data: "0x1234" }], 2),
      null
    );
  });

  it("chunks scan windows into RPC-safe ascending ranges", () => {
    const ranges = chunkRanges(57109000, 57109940 + 500);
    assert.ok(ranges.length > 1);
    for (const [s, e] of ranges) assert.ok(e - s + 1 <= 190, "chunk exceeds RPC range cap");
    assert.equal(ranges[0][0], 57109000);
    assert.equal(ranges[ranges.length - 1][1], 57109940 + 500);
    for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i][0], ranges[i - 1][1] + 1);
    const covering = ranges.find(([s, e]) => s <= 57109940 && 57109940 <= e);
    assert.ok(covering, "real payout block must fall inside the chunked window");
  });

  it("caps chunk counts and handles empty windows", () => {
    assert.equal(chunkRanges(1, 100000, 3).length, 3);
    assert.deepEqual(chunkRanges(100, 50), []);
    assert.deepEqual(chunkRanges(7, 7), [[7, 7]]);
  });

  it("ignores reorged (removed) logs instead of linking dead payouts", () => {
    assert.equal(findVoucherClaimedTx([{ ...REAL_PAYOUT_LOG, removed: true }], 2), null);
    // Canonical logs are unaffected by the removed check.
    assert.ok(findVoucherClaimedTx([{ ...REAL_PAYOUT_LOG, removed: false }], 2));
  });
});

// P0-3: V2 VoucherClaimed layout from OmniEscrowV2.sol —
// (bountyId indexed, slotIndex, recipient indexed, amount, nonce,
// criteriaHash, digest). topics[1] is the bounty id; data word 0 is the
// slot index and word 1 the amount.
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const V2_PAYOUT_LOG = {
  address: "0x63391c272a49c30f79eb6c3d8e10f0652bb0f767",
  topics: [
    "0xf40a6b7a2d537a1623a4a0ca6eb6eb08f1070280c99383201a00bf8b3905b5df",
    `0x${word(7)}`,
    "0x000000000000000000000000aa77daf4a174b3d05d6046462a7cb0e8eb9fa426",
  ],
  data: `0x${word(2)}${word(1000000)}${word(9)}${"cc".repeat(32)}${"dd".repeat(32)}`,
  blockNumber: "0x3676db4",
  transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

describe("V2 payout log decoding", () => {
  it("pins the V2 topic (cross-checked with ethers + Solidity in escrowAbi tests)", () => {
    assert.equal(
      VOUCHER_CLAIMED_TOPIC_V2,
      "0xf40a6b7a2d537a1623a4a0ca6eb6eb08f1070280c99383201a00bf8b3905b5df"
    );
    assert.notEqual(VOUCHER_CLAIMED_TOPIC_V2, VOUCHER_CLAIMED_TOPIC);
  });

  it("decodes amount from data word 1 and slot from word 0", () => {
    assert.deepEqual(findVoucherClaimedTxV2([V2_PAYOUT_LOG], 7), {
      txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      blockNumber: 57109940,
      amount: "1000000",
      slotIndex: 2,
    });
    // Distinctive values prove the words are not confused.
    const swapped = { ...V2_PAYOUT_LOG, data: `0x${word(5)}${word(42)}${word(9)}${"cc".repeat(32)}${"dd".repeat(32)}` };
    const found = findVoucherClaimedTxV2([swapped], 7);
    assert.equal(found.amount, "42");
    assert.equal(found.slotIndex, 5);
  });

  it("ignores other bounties, other events, and malformed logs", () => {
    assert.equal(findVoucherClaimedTxV2([V2_PAYOUT_LOG], 8), null);
    assert.equal(findVoucherClaimedTxV2([REAL_TRANSFER_LOG], 7), null);
    assert.equal(findVoucherClaimedTxV2([], 7), null);
    assert.equal(findVoucherClaimedTxV2(null, 7), null);
    assert.equal(findVoucherClaimedTxV2([{ topics: [] }], 7), null);
    assert.equal(findVoucherClaimedTxV2([{ ...V2_PAYOUT_LOG, data: "0x1234" }], 7), null);
    assert.equal(findVoucherClaimedTxV2([{ ...V2_PAYOUT_LOG, data: `0x${word(1)}${word(2)}` }], 7), null);
    assert.equal(findVoucherClaimedTxV2([{ ...V2_PAYOUT_LOG, data: "0xzzzz" }], 7), null);
    assert.equal(findVoucherClaimedTxV2([{ ...V2_PAYOUT_LOG, transactionHash: undefined }], 7), null);
    assert.equal(findVoucherClaimedTxV2([{ ...V2_PAYOUT_LOG, blockNumber: "nope" }], 7), null);
  });

  it("rejects out-of-range slot indexes instead of decoding garbage", () => {
    const bad = { ...V2_PAYOUT_LOG, data: `0x${word(256)}${word(1000000)}${word(9)}${"cc".repeat(32)}${"dd".repeat(32)}` };
    assert.equal(findVoucherClaimedTxV2([bad], 7), null);
  });

  it("isolates V1 and V2 layouts in both directions", () => {
    assert.equal(findVoucherClaimedTxV2([REAL_PAYOUT_LOG], 2), null);
    assert.equal(findVoucherClaimedTx([V2_PAYOUT_LOG], 7), null);
  });

  it("ignores reorged (removed) logs", () => {
    assert.equal(findVoucherClaimedTxV2([{ ...V2_PAYOUT_LOG, removed: true }], 7), null);
  });
});

describe("payout scan routing", () => {
  it("pairs each detected version with its topic and decoder", () => {
    const v1 = payoutScanSpec("v1");
    assert.equal(v1.topic, VOUCHER_CLAIMED_TOPIC);
    assert.equal(v1.decode, findVoucherClaimedTx);
    const v2 = payoutScanSpec("v2");
    assert.equal(v2.topic, VOUCHER_CLAIMED_TOPIC_V2);
    assert.equal(v2.decode, findVoucherClaimedTxV2);
  });

  it("refuses unverified and unknown versions instead of guessing a layout", () => {
    assert.throws(() => payoutScanSpec("unknown"), /unsupported escrow version/);
    assert.throws(() => payoutScanSpec(undefined), /unsupported escrow version/);
    assert.throws(() => payoutScanSpec("v3"), /unsupported escrow version/);
  });
});

describe("receipt success", () => {
  it("accepts only mined successful receipts", () => {
    assert.equal(isSuccessfulReceipt({ status: "0x1" }), true);
    assert.equal(isSuccessfulReceipt({ status: "0x0" }), false);
    assert.equal(isSuccessfulReceipt({ status: 1 }), false);
    assert.equal(isSuccessfulReceipt({}), false);
    assert.equal(isSuccessfulReceipt(null), false);
    assert.equal(isSuccessfulReceipt(undefined), false);
  });
});

// P0-1: homepage + marketplace must survive V3 list shapes. Fixtures mirror
// the on-chain views: V1 (repo/pr_number/amount) and V3
// (contracts/near-v3 BountyView: criteria_hash/slots/total_amount).
const V1_OPEN = {
  id: 1,
  repo: "octo/repo",
  pr_number: 42,
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "1000000",
  sponsor: "sponsor.testnet",
  expiry: 0,
  status: "open",
  created_at: 1794129386,
};
const V1_CLAIMED = { ...V1_OPEN, id: 2, status: "claimed", amount: "2500000" };
const V3_OPEN = {
  id: 7,
  sponsor: "sponsor.testnet",
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  criteria_hash: "0xdeadbeef00112233445566778899aabbccddeeff00112233445566778899aabb",
  slots: ["1000000", "2000000"],
  slots_filled: 1,
  total_amount: "3000000",
  funded: true,
  deadline: 0,
  challenge_window: 0,
  created_at: 1794129386,
  seq: 3,
  status: "funded",
};

describe("V1/V3 list guards", () => {
  it("detects V3 records by criteria_hash only", () => {
    assert.equal(isBountyV3(V3_OPEN), true);
    assert.equal(isBountyV3(V1_OPEN), false);
    assert.equal(isBountyV3({ ...V1_OPEN, criteria_hash: undefined }), false);
  });

  it("never throws on nullish or malformed records", () => {
    assert.equal(isBountyV3(null), false);
    assert.equal(isBountyV3(undefined), false);
    assert.equal(isBountyV3({}), false);
    assert.equal(isBountyV3("bounty"), false);
  });
});

describe("safe amount parsing", () => {
  it("accepts decimal strings, numbers, and bigints", () => {
    assert.equal(parseAmountValue("1000000"), 1000000n);
    assert.equal(parseAmountValue(1000000), 1000000n);
    assert.equal(parseAmountValue(1000000n), 1000000n);
    assert.equal(parseAmountValue("0"), 0n);
  });

  it("returns null instead of throwing on absent or invalid amounts", () => {
    assert.equal(parseAmountValue(undefined), null);
    assert.equal(parseAmountValue(null), null);
    assert.equal(parseAmountValue("abc"), null);
    assert.equal(parseAmountValue(""), null);
    assert.equal(parseAmountValue("   "), null);
    assert.equal(parseAmountValue("-1"), null);
    assert.equal(parseAmountValue(true), null);
    assert.equal(parseAmountValue({}), null);
  });
});

describe("claimed totals (homepage stat)", () => {
  it("sums V1 claimed amounts exactly like the old inline reduce", () => {
    assert.equal(claimedAmountsTotal([V1_OPEN, V1_CLAIMED]), 2500000n);
    assert.equal(claimedAmountsTotal([V1_CLAIMED, { ...V1_CLAIMED, id: 3, amount: "500000" }]), 3000000n);
    assert.equal(claimedAmountsTotal([V1_OPEN]), 0n);
  });

  it("skips V3 records: total_amount is the whole bounty, not the claimed part", () => {
    assert.equal(claimedAmountsTotal([V3_OPEN]), 0n);
    assert.equal(claimedAmountsTotal([{ ...V3_OPEN, status: "claimed" }]), 0n);
  });

  it("handles mixed-version lists without crashing", () => {
    assert.equal(claimedAmountsTotal([V1_CLAIMED, V3_OPEN, V1_OPEN]), 2500000n);
  });

  it("skips missing or malformed amounts instead of throwing", () => {
    assert.equal(claimedAmountsTotal([{ id: 9, status: "claimed" }]), 0n);
    assert.equal(claimedAmountsTotal([{ id: 9, status: "claimed", amount: "abc" }]), 0n);
    assert.equal(claimedAmountsTotal([{ id: 9, status: "claimed", amount: "-5" }]), 0n);
    assert.equal(claimedAmountsTotal([V1_CLAIMED, { id: 9, status: "claimed" }]), 2500000n);
  });

  it("returns zero for empty and non-list inputs", () => {
    assert.equal(claimedAmountsTotal([]), 0n);
    assert.equal(claimedAmountsTotal(null), 0n);
    assert.equal(claimedAmountsTotal(undefined), 0n);
  });
});

describe("V1/V3 card derivation", () => {
  it("renders V1 amounts exactly as before", () => {
    assert.equal(bountyCardAmountText(V1_OPEN), "1.00");
    assert.equal(bountyCardAmountText(V1_CLAIMED), "2.50");
  });

  it("renders V3 totals from total_amount", () => {
    assert.equal(bountyCardAmountText(V3_OPEN), "3.00");
  });

  it("returns null for missing or malformed card amounts", () => {
    assert.equal(bountyCardAmountText({ ...V1_OPEN, amount: undefined }), null);
    assert.equal(bountyCardAmountText({ ...V1_OPEN, amount: "abc" }), null);
    assert.equal(bountyCardAmountText({ ...V3_OPEN, total_amount: undefined }), null);
    assert.equal(bountyCardAmountText({ ...V3_OPEN, total_amount: "nope" }), null);
    assert.equal(bountyCardAmountText(null), null);
  });

  it("keeps V1 PR links and omits them for V3", () => {
    assert.equal(bountyCardPrUrl(V1_OPEN), "https://github.com/octo/repo/pull/42");
    assert.equal(bountyCardPrUrl(V3_OPEN), null);
    assert.equal(bountyCardPrUrl({ ...V1_OPEN, repo: undefined }), null);
    assert.equal(bountyCardPrUrl({ ...V1_OPEN, pr_number: undefined }), null);
    assert.equal(bountyCardPrUrl(null), null);
  });

  it("derives V3 slots lines and null for V1", () => {
    assert.equal(bountyCardSlotsText(V3_OPEN), "2 slots (1 claimed)");
    assert.equal(bountyCardSlotsText({ ...V3_OPEN, slots: ["1000000"], slots_filled: 0 }), "1 slot (0 claimed)");
    assert.equal(bountyCardSlotsText(V1_OPEN), null);
    assert.equal(bountyCardSlotsText({ ...V3_OPEN, slots: undefined }), null);
  });
});

describe("V1/V3 list search", () => {
  it("matches everything on an empty query", () => {
    assert.equal(bountyMatchesQuery(V1_OPEN, ""), true);
    assert.equal(bountyMatchesQuery(V3_OPEN, ""), true);
  });

  it("keeps V1 matching: repo substring and exact #id", () => {
    assert.equal(bountyMatchesQuery(V1_OPEN, "octo"), true);
    assert.equal(bountyMatchesQuery(V1_OPEN, "OCTO".toLowerCase()), true);
    assert.equal(bountyMatchesQuery(V1_OPEN, "1"), true);
    assert.equal(bountyMatchesQuery(V1_OPEN, "#1"), true);
    assert.equal(bountyMatchesQuery(V1_OPEN, "other"), false);
    assert.equal(bountyMatchesQuery(V1_OPEN, "2"), false);
  });

  it("matches V3 records by #id and criteria hash without throwing", () => {
    assert.equal(bountyMatchesQuery(V3_OPEN, "7"), true);
    assert.equal(bountyMatchesQuery(V3_OPEN, "#7"), true);
    assert.equal(bountyMatchesQuery(V3_OPEN, "deadbeef"), true);
    assert.equal(bountyMatchesQuery(V3_OPEN, "octo"), false);
    assert.equal(bountyMatchesQuery({ id: 7, status: "open" }, "x"), false);
    assert.equal(bountyMatchesQuery(null, "x"), false);
  });
});

describe("V3 settled-slot totals (escrow bitmap)", () => {
  it("sums multiple settled slots, string or bigint shapes", () => {
    assert.equal(claimedBitmapTotal(["1000000", "2000000", "500000"], 0b111), 3500000n);
    assert.equal(claimedBitmapTotal([1000000n, 2000000n], 3n), 3000000n);
    assert.equal(claimedBitmapTotal(["1000000", "2000000"], "0x3"), 3000000n);
  });

  it("counts only set bits (partial settlement)", () => {
    assert.equal(claimedBitmapTotal(["1000000", "2000000"], 0b01), 1000000n);
    assert.equal(claimedBitmapTotal(["1000000", "2000000"], 0b10), 2000000n);
  });

  it("returns zero for an empty bitmap: pending, rejected, and signed-but-unrelayed vouchers leave bits unset", () => {
    assert.equal(claimedBitmapTotal(["1000000", "2000000"], 0n), 0n);
    assert.equal(claimedBitmapTotal(["1000000", "2000000"], 0), 0n);
    assert.equal(claimedBitmapTotal(["1000000", "2000000"], "0x0"), 0n);
  });

  it("ignores out-of-range bits instead of inventing slots", () => {
    assert.equal(claimedBitmapTotal(["1000000"], 0b110), 0n);
    assert.equal(claimedBitmapTotal(["1000000"], 0b11), 1000000n);
    assert.equal(claimedBitmapTotal([], 0b111), 0n);
  });

  it("skips malformed and negative amounts without throwing", () => {
    assert.equal(claimedBitmapTotal(["abc", "2000000"], 0b11), 2000000n);
    assert.equal(claimedBitmapTotal(["-5", "2000000"], 0b11), 2000000n);
    assert.equal(claimedBitmapTotal([undefined, "2000000"], 0b11), 2000000n);
    assert.equal(claimedBitmapTotal(null, 0b11), 0n);
    assert.equal(claimedBitmapTotal("1000000", 0b1), 0n);
  });

  it("returns zero for malformed bitmaps without throwing", () => {
    assert.equal(claimedBitmapTotal(["1000000"], "zz"), 0n);
    assert.equal(claimedBitmapTotal(["1000000"], ""), 0n);
    assert.equal(claimedBitmapTotal(["1000000"], -1n), 0n);
    assert.equal(claimedBitmapTotal(["1000000"], null), 0n);
    assert.equal(claimedBitmapTotal(["1000000"], {}), 0n);
    assert.equal(claimedBitmapTotal(["1000000"], true), 0n);
  });
});

describe("V3 payout aggregation (stubbed escrow reads)", () => {
  const FILLED_A = { ...V3_OPEN, id: 7, slots_filled: 2 };
  const FILLED_B = { ...V3_OPEN, id: 8, slots_filled: 1 };
  const UNFILLED = { ...V3_OPEN, id: 9, slots_filled: 0 };

  it("sums verified V3 payouts and skips unfilled bounties without a read", async () => {
    const calls = [];
    const readPaid = async (id) => {
      calls.push(id);
      return { paid: 3000000n, ok: true };
    };
    const r = await aggregateV3Paid([FILLED_A, UNFILLED, FILLED_B], readPaid);
    assert.deepEqual(r, { total: 6000000n, incomplete: false });
    assert.deepEqual(calls.sort(), [7, 8]);
  });

  it("never routes V1 records through the V3 read path", async () => {
    const calls = [];
    const r = await aggregateV3Paid([V1_OPEN, V1_CLAIMED, FILLED_A], async (id) => {
      calls.push(id);
      return { paid: 1000000n, ok: true };
    });
    assert.deepEqual(calls, [7]);
    assert.deepEqual(r, { total: 1000000n, incomplete: false });
  });

  it("counts unsettled fills (pending/unsigned/unrelayed) as 0 without flagging incomplete", async () => {
    // Zero-sponsor/unknown bounties report the same shape: nothing settled, read fine.
    const r = await aggregateV3Paid([FILLED_A], async () => ({ paid: 0n, ok: true }));
    assert.deepEqual(r, { total: 0n, incomplete: false });
  });

  it("flags incomplete on failed, thrown, or malformed reads while keeping successes", async () => {
    const r = await aggregateV3Paid([FILLED_A, FILLED_B, UNFILLED], async (id) => {
      if (id === 7) return { paid: 1000000n, ok: true };
      return { paid: 0n, ok: false };
    });
    assert.deepEqual(r, { total: 1000000n, incomplete: true });

    const thrown = await aggregateV3Paid([FILLED_A], async () => {
      throw new Error("RPC down");
    });
    assert.deepEqual(thrown, { total: 0n, incomplete: true });

    const malformed = await aggregateV3Paid([FILLED_A], async () => ({ paid: "1000000", ok: true }));
    assert.deepEqual(malformed, { total: 0n, incomplete: true });

    const negative = await aggregateV3Paid([FILLED_A], async () => ({ paid: -1n, ok: true }));
    assert.deepEqual(negative, { total: 0n, incomplete: true });
  });

  it("flags incomplete for V3 records it cannot address, and zero for empty input", async () => {
    const r = await aggregateV3Paid([{ ...V3_OPEN, id: undefined, slots_filled: 1 }], async () => ({ paid: 1n, ok: true }));
    assert.deepEqual(r, { total: 0n, incomplete: true });
    assert.deepEqual(await aggregateV3Paid([], async () => ({ paid: 1n, ok: true })), {
      total: 0n,
      incomplete: false,
    });
    assert.deepEqual(await aggregateV3Paid(null, async () => ({ paid: 1n, ok: true })), {
      total: 0n,
      incomplete: false,
    });
  });

  it("caps concurrent reads at 8 by default and honors overrides", async () => {
    const track = async (n, opts) => {
      let active = 0;
      let peak = 0;
      const list = Array.from({ length: n }, (_, i) => ({ ...V3_OPEN, id: 100 + i, slots_filled: 1 }));
      const r = await aggregateV3Paid(
        list,
        async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          return { paid: 1n, ok: true };
        },
        opts
      );
      return { r, peak };
    };
    const d = await track(20, undefined);
    assert.deepEqual(d.r, { total: 20n, incomplete: false });
    assert.ok(d.peak <= 8, `default peak ${d.peak} exceeds cap 8`);
    const one = await track(4, { maxParallel: 1 });
    assert.deepEqual(one.r, { total: 4n, incomplete: false });
    assert.equal(one.peak, 1);
  });

  it("combines with the unchanged V1 total for mixed lists", async () => {
    const list = [V1_CLAIMED, V1_OPEN, FILLED_A];
    const v1 = claimedAmountsTotal(list);
    const v3 = await aggregateV3Paid(list, async () => ({ paid: 3000000n, ok: true }));
    assert.equal(v1, 2500000n);
    assert.equal(v1 + v3.total, 5500000n);
    assert.equal(v3.incomplete, false);
  });
});

describe("V2 escrow card state (P0-2)", () => {
  const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const SPONSOR = "0x1111111111111111111111111111111111111111";
  const v2 = (over = {}) => ({
    token: TOKEN,
    sponsor: SPONSOR,
    funded: true,
    totalFunded: "3000000",
    amounts: ["1000000", "2000000"],
    claimedBitmap: "3",
    refundedBitmap: "0",
    ...over,
  });

  it("maps real V2 fields through the shared funding pill", () => {
    assert.deepEqual(v3EscrowCardState(v2()), {
      token: TOKEN,
      amount: "3000000",
      sponsor: SPONSOR,
      funded: true,
      claimed: true,
    });
  });

  it("reports claimed only when every slot settled", () => {
    assert.equal(v3EscrowCardState(v2({ claimedBitmap: "1" })).claimed, false);
    assert.equal(v3EscrowCardState(v2({ claimedBitmap: "1" })).funded, true);
    assert.equal(v3EscrowCardState(v2({ claimedBitmap: "0" })).claimed, false);
    assert.equal(v3EscrowCardState(v2({ funded: false, claimedBitmap: "0" })).funded, false);
  });

  it("treats unknown (zero-sponsor) bounties as unfunded, like the V1 path", () => {
    const zero = "0x0000000000000000000000000000000000000000";
    assert.deepEqual(
      v3EscrowCardState({
        token: zero,
        sponsor: zero,
        funded: false,
        totalFunded: "0",
        amounts: [],
        claimedBitmap: "0",
        refundedBitmap: "0",
      }),
      { token: zero, amount: "0", sponsor: zero, funded: false, claimed: false }
    );
  });

  it("returns null for malformed structs so callers show the error pill", () => {
    assert.equal(v3EscrowCardState(null), null);
    assert.equal(v3EscrowCardState({}), null);
    assert.equal(v3EscrowCardState(v2({ amounts: undefined })), null);
    assert.equal(v3EscrowCardState(v2({ amounts: "1000000" })), null);
    assert.equal(v3EscrowCardState(v2({ totalFunded: "abc" })), null);
    assert.equal(v3EscrowCardState(v2({ totalFunded: "-1" })), null);
    assert.equal(v3EscrowCardState(v2({ claimedBitmap: "zz" })), null);
    assert.equal(v3EscrowCardState(v2({ claimedBitmap: "" })), null);
    assert.equal(v3EscrowCardState(v2({ claimedBitmap: -1n })), null);
    assert.equal(v3EscrowCardState(v2({ funded: "yes" })), null);
    assert.equal(v3EscrowCardState(v2({ token: 42 })), null);
    assert.equal(v3EscrowCardState(v2({ sponsor: null })), null);
  });
});
