import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { ESCROW_ABI_V1, ESCROW_ABI_V2 } from "../src/index.mjs";

// P1-15: the V2 escrow declares `bounties` as `returns (Bounty memory)`
// (ONE offset-prefixed tuple). The single-paren 9-output form — correct
// for V1's static struct — throws BAD_DATA here, and every mock in the
// relayer suite bypasses real decoding, so this file pins true
// chain-shaped decoding plus selector parity with the compiled artifact.
const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = JSON.parse(
  readFileSync(join(HERE, "..", "..", "contracts", "base-v3", "out", "OmniEscrowV2.sol", "OmniEscrowV2.json"), "utf8")
);
const TUPLE = "tuple(address,address,uint64,bytes32,bool,uint256,uint256[],uint256,uint256)";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SPONSOR = "0x1111111111111111111111111111111111111111";
const CRITERIA = `0x${"ab".repeat(32)}`;

function chainBountiesBytes() {
  return ethers.AbiCoder.defaultAbiCoder().encode([TUPLE], [
    [TOKEN, SPONSOR, 1794129386, CRITERIA, true, 3000000, [1000000, 2000000], 1, 0],
  ]);
}

describe("relayer V2 escrow fragments", () => {
  it("decodes true tuple bytes with named fields (schedule-check path)", async () => {
    const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
    provider.call = async () => chainBountiesBytes();
    const escrow = new ethers.Contract(
      "0x63391c272A49c30f79eb6c3d8E10F0652Bb0F767",
      ESCROW_ABI_V2,
      provider
    );
    const b = await escrow.bounties(223339065907692n);
    assert.equal(b.token, TOKEN);
    assert.equal(b.sponsor, SPONSOR);
    assert.equal(b.deadline, 1794129386n);
    assert.equal(b.criteriaHash, CRITERIA);
    assert.equal(b.funded, true);
    assert.equal(b.totalFunded, 3000000n);
    assert.deepEqual(Array.from(b.amounts).map(String), ["1000000", "2000000"]);
    assert.equal(b.claimedBitmap, 1n);
    assert.equal(b.refundedBitmap, 0n);
  });

  it("matches the compiled artifact selectors", () => {
    const byName = (n) => ARTIFACT.abi.find((e) => e.type === "function" && e.name === n);
    const ours = new ethers.Interface(ESCROW_ABI_V2);
    for (const name of ["claim", "usedVoucher", "slotStatus", "bounties"]) {
      const artifactFn = new ethers.Interface([byName(name)]).getFunction(name);
      assert.equal(ours.getFunction(name).selector, artifactFn.selector, `${name} selector`);
    }
    assert.equal(ours.getFunction("claim").selector, "0x5b274d7c");
  });

  it("shares the usedVoucher getter with V1 (same selector)", () => {
    assert.equal(
      new ethers.Interface(ESCROW_ABI_V2).getFunction("usedVoucher").selector,
      new ethers.Interface(ESCROW_ABI_V1).getFunction("usedVoucher").selector
    );
  });
});
