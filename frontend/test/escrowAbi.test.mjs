import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import {
  ESCROW_ABI,
  ESCROW_ABI_V2,
  ESCROW_VERSION_PROBES,
  VOUCHER_TYPEHASH_EXPECTED,
  VOUCHER_V2_TYPEHASH_EXPECTED,
} from "../lib/escrowAbi.mjs";
import {
  VOUCHER_CLAIMED_TOPIC,
  VOUCHER_CLAIMED_TOPIC_V2,
} from "../lib/display.mjs";

// P0-2: the exact ABI strings the UI decodes with, verified against the
// deployed contract sources (no invented signatures or field orders).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V1_SRC = readFileSync(join(ROOT, "contracts", "base", "OmniEscrow.sol"), "utf8");
const V2_SRC = readFileSync(join(ROOT, "contracts", "base-v3", "src", "OmniEscrowV2.sol"), "utf8");

const V1_IFACE = new ethers.Interface(ESCROW_ABI);
const V2_IFACE = new ethers.Interface(ESCROW_ABI_V2);

const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SPONSOR = "0x1111111111111111111111111111111111111111";
const CRITERIA_HASH = `0x${"ab".repeat(32)}`;

describe("V1 escrow ABI selection", () => {
  it("pins the V1 single-winner Bounty 5-tuple in contract order", () => {
    const out = V1_IFACE.getFunction("bounties").outputs;
    assert.deepEqual(
      out.map((p) => [p.name, p.type]),
      [
        ["token", "address"],
        ["amount", "uint256"],
        ["sponsor", "address"],
        ["funded", "bool"],
        ["claimed", "bool"],
      ]
    );
  });

  it("pins the V1 write surface used by the sponsor flow", () => {
    const create = V1_IFACE.getFunction("createBounty");
    assert.deepEqual(create.inputs.map((p) => p.type), ["uint256", "address", "uint256"]);
    assert.deepEqual(
      V1_IFACE.getFunction("fundBounty").inputs.map((p) => p.type),
      ["uint256"]
    );
    assert.equal(V1_IFACE.getFunction("claim").inputs[0].components.length, 8);
    assert.ok(V1_IFACE.getFunction("usedVoucher"));
    assert.ok(V1_IFACE.getFunction("mpcSigner"));
  });
});

describe("V2 escrow ABI selection", () => {
  it("pins bounties as one Bounty tuple with 9 components in contract order", () => {
    // The escrow declares `returns (Bounty memory)`: a SINGLE tuple
    // output, not 9 inline outputs. The 9-output form throws BAD_DATA
    // against the real escrow (P1-15).
    const out = V2_IFACE.getFunction("bounties").outputs;
    assert.equal(out.length, 1);
    assert.equal(out[0].baseType, "tuple");
    assert.deepEqual(
      out[0].components.map((p) => [p.name, p.type]),
      [
        ["token", "address"],
        ["sponsor", "address"],
        ["deadline", "uint64"],
        ["criteriaHash", "bytes32"],
        ["funded", "bool"],
        ["totalFunded", "uint256"],
        ["amounts", "uint256[]"],
        ["claimedBitmap", "uint256"],
        ["refundedBitmap", "uint256"],
      ]
    );
  });

  it("matches the compiled artifact ABI for bounties", () => {
    const artifact = JSON.parse(
      readFileSync(join(ROOT, "contracts", "base-v3", "out", "OmniEscrowV2.sol", "OmniEscrowV2.json"), "utf8")
    );
    const abiBounties = artifact.abi.find((e) => e.type === "function" && e.name === "bounties");
    assert.equal(abiBounties.outputs.length, 1);
    assert.equal(abiBounties.outputs[0].type, "tuple");
    assert.deepEqual(
      abiBounties.outputs[0].components.map((c) => [c.name, c.type]),
      V2_IFACE.getFunction("bounties").outputs[0].components.map((p) => [p.name, p.type])
    );
  });

  it("pins the V2 sponsor writes used by the V3 form", () => {
    assert.deepEqual(
      V2_IFACE.getFunction("createBounty").inputs.map((p) => [p.name, p.type]),
      [
        ["bountyId", "uint256"],
        ["token", "address"],
        ["amounts", "uint256[]"],
        ["deadline", "uint64"],
        ["criteriaHash", "bytes32"],
      ]
    );
    assert.deepEqual(
      V2_IFACE.getFunction("fundBounty").inputs.map((p) => [p.name, p.type]),
      [["bountyId", "uint256"]]
    );
  });

  it("decodes true chain-shaped bytes through a Contract like production reads", async () => {
    // The escrow returns ONE offset-prefixed tuple (Bounty memory with a
    // dynamic amounts array). This drives the exact readEscrowV2 path —
    // JsonRpcProvider + Contract + stubbed transport (no network) — and
    // asserts every named field the UI decodes.
    const tupleType =
      "tuple(address,address,uint64,bytes32,bool,uint256,uint256[],uint256,uint256)";
    const chainBytes = ethers.AbiCoder.defaultAbiCoder().encode([tupleType], [
      [TOKEN, SPONSOR, 1794129386, CRITERIA_HASH, true, 3000000, [1000000, 2000000], 1, 0],
    ]);
    const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
    provider.call = async () => chainBytes;
    const escrow = new ethers.Contract(
      "0x63391c272A49c30f79eb6c3d8E10F0652Bb0F767",
      ESCROW_ABI_V2,
      provider
    );
    const d = await escrow.bounties(7);
    assert.equal(d.token, TOKEN);
    assert.equal(d.sponsor, SPONSOR);
    assert.equal(d.deadline, 1794129386n);
    assert.equal(d.criteriaHash, CRITERIA_HASH);
    assert.equal(d.funded, true);
    assert.equal(d.totalFunded, 3000000n);
    assert.deepEqual(Array.from(d.amounts).map(String), ["1000000", "2000000"]);
    assert.equal(d.claimedBitmap, 1n);
    assert.equal(d.refundedBitmap, 0n);
  });
});

describe("escrow version probes", () => {
  it("are zero-arg bytes32 constant getters with distinct selectors", () => {
    for (const [key, fragment] of Object.entries(ESCROW_VERSION_PROBES)) {
      const fn = new ethers.Interface([fragment]).getFunction(
        key === "v2" ? "VOUCHER_V2_TYPEHASH" : "VOUCHER_TYPEHASH"
      );
      assert.equal(fn.inputs.length, 0);
      assert.equal(fn.outputs[0].type, "bytes32");
    }
    const sels = Object.values(ESCROW_VERSION_PROBES).map(
      (f) => new ethers.Interface([f]).getFunction(f.match(/function (\w+)/)[1]).selector
    );
    assert.notEqual(sels[0], sels[1]);
  });

  it("pins probe values to the Solidity constants and frozen type strings", () => {
    assert.ok(V1_SRC.includes(VOUCHER_TYPEHASH_EXPECTED), "V1 source must contain the pinned typehash");
    assert.ok(V2_SRC.includes(VOUCHER_V2_TYPEHASH_EXPECTED), "V2 source must contain the pinned typehash");
    assert.equal(
      ethers.id(
        "Voucher(uint256 bountyId,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow)"
      ),
      VOUCHER_TYPEHASH_EXPECTED
    );
    assert.equal(
      ethers.id(
        "VoucherV2(uint256 bountyId,uint8 slotIndex,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow,bytes32 criteriaHash)"
      ),
      VOUCHER_V2_TYPEHASH_EXPECTED
    );
  });
});

describe("VoucherClaimed event topics (P0-3)", () => {
  it("pins the V1 topic to the V1 event declaration", () => {
    assert.ok(
      V1_SRC.includes(
        "event VoucherClaimed(uint256 indexed bountyId, address indexed recipient, uint256 amount, uint256 nonce, bytes32 digest)"
      )
    );
    assert.equal(
      ethers.id("VoucherClaimed(uint256,address,uint256,uint256,bytes32)"),
      VOUCHER_CLAIMED_TOPIC
    );
  });

  it("pins the V2 topic to the V2 event declaration with non-indexed slotIndex", () => {
    assert.ok(V2_SRC.includes("event VoucherClaimed("));
    assert.ok(V2_SRC.includes("uint8 slotIndex,"), "slotIndex must precede the amount in data");
    assert.equal(
      ethers.id("VoucherClaimed(uint256,uint8,address,uint256,uint256,bytes32,bytes32)"),
      VOUCHER_CLAIMED_TOPIC_V2
    );
    assert.notEqual(VOUCHER_CLAIMED_TOPIC_V2, VOUCHER_CLAIMED_TOPIC);
  });
});

describe("cross-version decoding", () => {
  // True V2 wire bytes: one offset-prefixed tuple (unfunded fixture, so
  // any `funded === true` below is pure mis-decode).
  const TUPLE = "tuple(address,address,uint64,bytes32,bool,uint256,uint256[],uint256,uint256)";
  const v2bytes = () =>
    ethers.AbiCoder.defaultAbiCoder().encode([TUPLE], [
      [TOKEN, SPONSOR, 1794129386, CRITERIA_HASH, false, 3000000, [1000000, 2000000], 1, 0],
    ]);
  const v1bytes = () =>
    V1_IFACE.encodeFunctionResult("bounties", [
      TOKEN,
      1000000,
      "0x2222222222222222222222222222222222222222",
      true,
      false,
    ]);

  it("V2-decoding V1 bytes fails loud (first word misread as tuple offset)", () => {
    assert.throws(() => V2_IFACE.decodeFunctionResult("bounties", v1bytes()), /BAD_DATA|BUFFER_OVERRUN/);
  });

  it("V1-decoding V2 bytes silently garbles (why reads are version-gated)", () => {
    // The 0x20 offset word decodes as an address, every field shifts one
    // word, and funded/claimed read nonzero words as true even though the
    // bounty is unfunded.
    const d = V1_IFACE.decodeFunctionResult("bounties", v2bytes());
    assert.equal(BigInt(d.token), 0x20n);
    assert.equal(d.amount, BigInt(TOKEN));
    assert.equal(d.funded, true);
    assert.equal(d.claimed, true);
  });
});
