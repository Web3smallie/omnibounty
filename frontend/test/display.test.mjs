import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  VOUCHER_CLAIMED_TOPIC,
  baseAddressUrl,
  baseBlockUrl,
  baseTxUrl,
  bountyCriteria,
  bountyTitle,
  extractNearTxHash,
  findVoucherClaimedTx,
  formatDateTime,
  formatExpiry,
  formatUsdc,
  githubPrUrl,
  isBountyExpired,
  nearAccountUrl,
  nearTxUrl,
  chunkRanges,
  shortenAddress,
  timeAgo,
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
});
