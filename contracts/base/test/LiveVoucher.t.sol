// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../OmniEscrow.sol";
import { MockUSDC } from "./OmniEscrow.t.sol";

/// @notice Settles a REAL voucher: digest + secp256k1 signature produced by
/// the live NEAR Chain Signatures network (v1.signer-prod.testnet v3.18.0)
/// during `node tools/live_handshake.mjs`, exported to
/// `testdata/live_voucher.json`. This closes the NEAR -> Base loop: the
/// MPC-signed bytes that came out of the NEAR callback must pay out here.
///
/// The voucher binds token = real Sepolia USDC and escrow = the 0x1111...
/// placeholder, so the test etches the escrow + a mock token runtime at
/// those exact addresses (standard Foundry technique: bound-address checks
/// then execute against the real bytecode with empty storage) and moves to
/// chain 84532 so the domain separator commits to the voucher's chain.
contract LiveVoucherTest is Test {
    using stdJson for string;

    string constant LIVE = "../../testdata/live_voucher.json";

    function testLiveMpcVoucherSettles() public {
        string memory json = vm.readFile(LIVE);
        address mpcSigner = json.readAddress("$.mpcSigner");
        OmniEscrow.Voucher memory v = OmniEscrow.Voucher({
            bountyId: json.readUint("$.voucher.bounty_id"),
            recipient: json.readAddress("$.voucher.recipient"),
            token: json.readAddress("$.voucher.token"),
            amount: json.readUint("$.voucher.amount"),
            nonce: json.readUint("$.voucher.nonce"),
            expiry: json.readUint("$.voucher.expiry"),
            chainId: json.readUint("$.voucher.chain_id"),
            escrow: json.readAddress("$.voucher.escrow")
        });
        uint8 sigV = uint8(json.readUint("$.v"));
        bytes32 r = json.readBytes32("$.r");
        bytes32 s = json.readBytes32("$.s");
        bytes32 expectDigest = json.readBytes32("$.voucher.digest");
        assertEq(v.chainId, 84532, "live vector must target Base Sepolia");

        // Etch the real escrow bytecode at the voucher-bound address.
        // Deployed at the default chain (31337) so the later chainId move
        // exercises the fork-recompute domain separator path.
        OmniEscrow template_ = new OmniEscrow(mpcSigner);
        vm.etch(v.escrow, address(template_).code);
        OmniEscrow escrow = OmniEscrow(v.escrow);
        // The etched copy starts with empty storage: pin the MPC signer
        // (storage slot 1: owner=0, mpcSigner=1 per declaration order).
        vm.store(v.escrow, bytes32(uint256(1)), bytes32(uint256(uint160(mpcSigner))));
        assertEq(escrow.mpcSigner(), mpcSigner, "signer pin failed");

        // Move to the voucher's chain and check the digest matches the
        // NEAR-produced value bit-for-bit.
        vm.chainId(v.chainId);
        assertEq(escrow.digestOf(v), expectDigest, "digest mismatch vs NEAR");

        // Fund through the full lifecycle with a mock token etched at the
        // voucher-bound (Sepolia USDC) address.
        MockUSDC tokenImpl = new MockUSDC();
        vm.etch(v.token, address(tokenImpl).code);
        MockUSDC token = MockUSDC(v.token);
        address sponsor = makeAddr("live-sponsor");
        token.mint(sponsor, v.amount);
        vm.startPrank(sponsor);
        token.approve(v.escrow, v.amount);
        escrow.createBounty(v.bountyId, v.token, v.amount);
        escrow.fundBounty(v.bountyId);
        vm.stopPrank();

        // Settle the LIVE voucher: signature, binding, and payout.
        uint256 before = token.balanceOf(v.recipient);
        escrow.claim(v, sigV, r, s);
        assertEq(token.balanceOf(v.recipient) - before, v.amount, "payout amount");
        assertTrue(escrow.usedVoucher(expectDigest), "digest not marked used");

        // The live digest is single-use.
        vm.expectRevert(OmniEscrow.VoucherUsed.selector);
        escrow.claim(v, sigV, r, s);
    }
}
