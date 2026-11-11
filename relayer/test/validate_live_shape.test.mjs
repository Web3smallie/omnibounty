// Regression: the live NEAR contract returns snake_case voucher views
// (bounty_id, chain_id); the relayer must accept them. Fixture is the
// real v2 bounty #2 voucher (chain data, public), pinned with its live
// digest and MPC signature for end-to-end validation.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeVoucherShape, validateSignedVoucher } from "../src/validate.mjs";

const LIVE = {
  voucher: {
    bounty_id: 2,
    recipient: "0xaa77daf4a174b3d05d6046462a7cb0e8eb9fa426",
    token: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    amount: "1000000",
    nonce: 0,
    expiry: 1794424969,
    chain_id: 84532,
    escrow: "0xee5c8f3154fed8b9b2f5d820ac687fdfa8cf2c99",
    digest: "0x44034055de723155c051e9f33cf70aa286d8b4e0cc46e6db1849fe5db238f72d",
  },
  v: 27,
  r: "0x683bbe1f0647d5165c635c4d888b12e023729b53ee2cf8555e67377ea0777975",
  s: "0x65be4b4d019941d093c10a20c6eee25255baaca85b59579d4a152e85da3d2ec8",
};
const OPTS = {
  expectedChainId: 84532,
  escrowAddress: "0xee5C8F3154fed8B9B2f5D820AC687fDfa8CF2C99",
  mpcSigner: "0x73dfe93ac7024492b21c5ca8d6f301ea978abb82",
  nowSec: 1794338400, // pinned pre-expiry so this test never rots
};

describe("live voucher shape", () => {
  it("normalizes snake_case to camelCase without mutating", () => {
    const n = normalizeVoucherShape(LIVE.voucher);
    assert.equal(n.bountyId, 2);
    assert.equal(n.chainId, 84532);
    assert.equal(n.recipient, LIVE.voucher.recipient);
    assert.equal(LIVE.voucher.bountyId, undefined);
  });
  it("keeps falsy-but-valid ids (no || footgun)", () => {
    assert.equal(normalizeVoucherShape({ bounty_id: 0, chain_id: 1 }).bountyId, 0);
  });
  it("validates the real live voucher end to end", () => {
    const r = validateSignedVoucher(LIVE, OPTS);
    assert.equal(r.ok, true);
    assert.equal(r.digest.toLowerCase(), LIVE.voucher.digest.toLowerCase());
  });
});
