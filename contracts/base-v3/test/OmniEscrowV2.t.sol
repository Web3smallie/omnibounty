// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../src/OmniEscrowV2.sol";

// -- Mocks ---------------------------------------------------------------

contract MockUSDC {
    string public name = "Mock USD Coin";
    string public symbol = "mUSDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        return transferFrom(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        if (from != msg.sender) {
            uint256 a = allowance[from][msg.sender];
            require(a >= amount, "allowance");
            allowance[from][msg.sender] = a - amount;
        }
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Non-standard token: no return values (must still work).
contract NoReturnToken is MockUSDC {
    function transfer(address to, uint256 amount) external override returns (bool) {
        super.transferFrom(msg.sender, to, amount);
        assembly {
            return(0, 0)
        }
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        MockUSDC.transferFrom(from, to, amount);
        assembly {
            return(0, 0)
        }
    }
}

contract RevertingToken {
    function transfer(address, uint256) external pure returns (bool) {
        revert("nope");
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert("nope");
    }
}

/// Lying token: returns false instead of reverting (must be rejected).
contract FalseToken is MockUSDC {
    function transfer(address, uint256) external override returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) public override returns (bool) {
        return false;
    }
}

/// Reenters escrow.claim from inside transfer (must hit the guard).
contract ReentrantClaimToken is MockUSDC {
    OmniEscrowV2 public target;
    bytes public payload;

    function arm(address escrow, bytes calldata callPayload) external {
        target = OmniEscrowV2(escrow);
        payload = callPayload;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        if (payload.length > 0) {
            bytes memory p = payload;
            payload = "";
            (bool ok,) = address(target).call(p);
            ok; // swallowed: the test asserts the OUTER call reverted instead
        }
        return super.transferFrom(msg.sender, to, amount);
    }
}

// -- Suite ---------------------------------------------------------------

contract OmniEscrowV2Test is Test {
    using stdJson for string;

    OmniEscrowV2 escrow;
    MockUSDC usdc;
    address sponsor = makeAddr("sponsor");
    address recipient = 0xcB234c6Fc8aBe3EB38E31EEc6288b431E313D9b9;
    address recipient2 = 0x1111111111111111111111111111111111111111;
    uint256 mpcKey = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
    address mpcSigner;
    bytes32 criteria = 0x499dcdccb8acfafe8d71e42ac91ab86cacbac30bf2b33c521b1bd47a31641d10; // simple-ci

    string constant FIXTURE = "../../testdata/v3/eip712-voucher2.json";

    function setUp() public {
        mpcSigner = vm.addr(mpcKey);
        escrow = new OmniEscrowV2(mpcSigner);
        usdc = new MockUSDC();
        usdc.mint(sponsor, 1_000_000_000_000);
        vm.prank(sponsor);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function schedule3() internal pure returns (uint256[] memory s) {
        s = new uint256[](3);
        s[0] = 600_000;
        s[1] = 400_000;
        s[2] = 300_000;
    }

    function fundBounty(uint256 id, uint256[] memory amounts, uint64 deadline) internal {
        vm.prank(sponsor);
        escrow.createBounty(id, address(usdc), amounts, deadline, criteria);
        vm.prank(sponsor);
        escrow.fundBounty(id);
    }

    function makeVoucher(uint256 id, uint8 slot, uint256 nonce, uint256 expiry)
        internal
        view
        returns (OmniEscrowV2.VoucherV2 memory v)
    {
        OmniEscrowV2.Bounty memory b = escrow.bounties(id);
        v = OmniEscrowV2.VoucherV2({
            bountyId: id,
            slotIndex: slot,
            recipient: recipient,
            token: address(usdc),
            amount: b.amounts[slot],
            nonce: nonce,
            expiry: expiry,
            chainId: block.chainid,
            escrow: address(escrow),
            criteriaHash: criteria
        });
    }

    function signVoucher(OmniEscrowV2.VoucherV2 memory v) internal view returns (uint8 sigV, bytes32 r, bytes32 s) {
        return vm.sign(mpcKey, escrow.digestOf(v));
    }

    function claimSlot(uint256 id, uint8 slot, uint256 nonce) internal {
        OmniEscrowV2.VoucherV2 memory v = makeVoucher(id, slot, nonce, block.timestamp + 1 days);
        (uint8 sigV, bytes32 r, bytes32 s) = signVoucher(v);
        escrow.claim(v, sigV, r, s);
    }

    // -- Oracle compatibility (NEAR §9 / ethers vectors) --------------------

    function test_typehash_matches_frozen_string() public view {
        assertEq(
            escrow.VOUCHER_V2_TYPEHASH(),
            keccak256(
                "VoucherV2(uint256 bountyId,uint8 slotIndex,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow,bytes32 criteriaHash)"
            )
        );
        string memory json = vm.readFile(FIXTURE);
        assertEq(escrow.VOUCHER_V2_TYPEHASH(), json.readBytes32("$.typeHash"));
    }

    function fixtureVoucher(uint256 i) internal returns (OmniEscrowV2.VoucherV2 memory v) {
        string memory json = vm.readFile(FIXTURE);
        string memory base = string.concat("$.vectors[", vm.toString(i), "]");
        v = OmniEscrowV2.VoucherV2({
            bountyId: json.readUint(string.concat(base, ".bountyId")),
            slotIndex: uint8(json.readUint(string.concat(base, ".slotIndex"))),
            recipient: json.readAddress(string.concat(base, ".recipient")),
            token: json.readAddress(string.concat(base, ".token")),
            amount: vm.parseUint(json.readString(string.concat(base, ".amount"))),
            nonce: json.readUint(string.concat(base, ".nonce")),
            expiry: json.readUint(string.concat(base, ".expiry")),
            chainId: json.readUint(string.concat(base, ".chainId")),
            escrow: json.readAddress(string.concat(base, ".escrow")),
            criteriaHash: json.readBytes32(string.concat(base, ".criteriaHash"))
        });
    }

    function test_oracle_struct_hashes_match_ethers() public {
        for (uint256 i = 0; i < 2; i++) {
            OmniEscrowV2.VoucherV2 memory v = fixtureVoucher(i);
            string memory json = vm.readFile(FIXTURE);
            string memory key = string.concat("$.vectors[", vm.toString(i), "].structHash");
            assertEq(escrow.structHashOf(v), json.readBytes32(key), "structHash vector");
        }
    }

    function test_oracle_full_digests_match_ethers() public {
        // Fixture vectors target escrow 0x1111..1111 on chain 84532. Etch
        // the runtime code there (constructor immutables stay zero, so the
        // fork-recompute branch of DOMAIN_SEPARATOR() engages — which is
        // itself covered by this check).
        address fxEscrow = 0x1111111111111111111111111111111111111111;
        deployCodeTo("OmniEscrowV2.sol:OmniEscrowV2", abi.encode(mpcSigner), fxEscrow);
        vm.chainId(84532);
        OmniEscrowV2 oracle = OmniEscrowV2(fxEscrow);
        string memory json = vm.readFile(FIXTURE);
        assertEq(oracle.DOMAIN_SEPARATOR(), json.readBytes32("$.vectors[0].domainSeparator"), "domainSeparator");
        for (uint256 i = 0; i < 2; i++) {
            OmniEscrowV2.VoucherV2 memory v = fixtureVoucher(i);
            string memory key = string.concat("$.vectors[", vm.toString(i), "].digest");
            assertEq(oracle.digestOf(v), json.readBytes32(key), "digest vector");
        }
    }

    // -- Funding ---------------------------------------------------------

    function test_funding_valid_3slot_schedule() public {
        vm.prank(sponsor);
        escrow.createBounty(7, address(usdc), schedule3(), 1893456000, criteria);
        OmniEscrowV2.Bounty memory b = escrow.bounties(7);
        assertEq(b.totalFunded, 1_300_000);
        assertFalse(b.funded);
        assertEq(b.deadline, 1893456000);
        assertEq(b.criteriaHash, criteria);
        vm.prank(sponsor);
        escrow.fundBounty(7);
        assertTrue(escrow.bounties(7).funded);
        assertEq(usdc.balanceOf(address(escrow)), 1_300_000);
    }

    function test_funding_rejects_bad_schedules() public {
        // Empty schedule.
        vm.expectRevert(OmniEscrowV2.InvalidSchedule.selector);
        escrow.createBounty(1, address(usdc), new uint256[](0), 0, criteria);
        // 17 slots (> 16).
        uint256[] memory many = new uint256[](17);
        for (uint256 i = 0; i < 17; i++) {
            many[i] = 1;
        }
        vm.expectRevert(OmniEscrowV2.InvalidSchedule.selector);
        escrow.createBounty(1, address(usdc), many, 0, criteria);
        // Zero slot.
        uint256[] memory zero = new uint256[](1);
        zero[0] = 0;
        vm.expectRevert(OmniEscrowV2.ZeroAmount.selector);
        escrow.createBounty(1, address(usdc), zero, 0, criteria);
        // Zero token.
        vm.expectRevert(OmniEscrowV2.ZeroAddress.selector);
        escrow.createBounty(1, address(0), schedule3(), 0, criteria);
        // Overflow total (16 x max) panics via checked math — fail-closed.
        uint256[] memory huge = new uint256[](2);
        huge[0] = type(uint256).max;
        huge[1] = 1;
        vm.expectRevert(stdError.arithmeticError);
        escrow.createBounty(1, address(usdc), huge, 0, criteria);
        // Duplicate id.
        fundBounty(7, schedule3(), 0);
        vm.expectRevert(OmniEscrowV2.BountyExists.selector);
        escrow.createBounty(7, address(usdc), schedule3(), 0, criteria);
    }

    function test_funding_guards_and_griefing() public {
        fundBounty(7, schedule3(), 0);
        // Double fund.
        vm.prank(sponsor);
        vm.expectRevert(OmniEscrowV2.AlreadyFunded.selector);
        escrow.fundBounty(7);
        // Non-sponsor fund.
        vm.prank(recipient);
        vm.expectRevert(OmniEscrowV2.NotSponsor.selector);
        escrow.fundBounty(7);
        // Fund nonexistent.
        vm.expectRevert(OmniEscrowV2.BountyNotFound.selector);
        escrow.fundBounty(404);
        // Insufficient allowance / balance surfaces as TransferFailed.
        address poor = makeAddr("poor");
        uint256[] memory one = new uint256[](1);
        one[0] = 100;
        vm.prank(poor);
        escrow.createBounty(8, address(usdc), one, 0, criteria);
        vm.prank(poor);
        vm.expectRevert(OmniEscrowV2.TransferFailed.selector);
        escrow.fundBounty(8);
    }

    // -- Claims ----------------------------------------------------------

    function test_claim_valid_single_slot() public {
        fundBounty(7, schedule3(), 0);
        OmniEscrowV2.VoucherV2 memory v = makeVoucher(7, 1, 0, block.timestamp + 1 days);
        bytes32 digest = escrow.digestOf(v);
        (uint8 sigV, bytes32 r, bytes32 s) = signVoucher(v);
        assertFalse(escrow.usedVoucher(digest));
        vm.expectEmit(true, true, false, true);
        emit OmniEscrowV2.VoucherClaimed(7, 1, recipient, 400_000, 0, criteria, digest);
        escrow.claim(v, sigV, r, s);
        assertTrue(escrow.usedVoucher(digest));
        assertEq(usdc.balanceOf(recipient), 400_000);
        (bool claimed, bool refunded) = escrow.slotStatus(7, 1);
        assertTrue(claimed);
        assertFalse(refunded);
    }

    function test_claim_multi_slot_independent() public {
        fundBounty(7, schedule3(), 0);
        // Slot 0 -> recipient, slot 1 -> recipient2, slot 2 -> recipient.
        claimSlot(7, 0, 0);
        OmniEscrowV2.VoucherV2 memory v = makeVoucher(7, 1, 1, block.timestamp + 1 days);
        v.recipient = recipient2;
        (uint8 sigV, bytes32 r, bytes32 s) = signVoucher(v);
        escrow.claim(v, sigV, r, s);
        claimSlot(7, 2, 2);
        assertEq(usdc.balanceOf(recipient), 600_000 + 300_000);
        assertEq(usdc.balanceOf(recipient2), 400_000);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    /// Mutate one field, re-sign with the MPC key: isolates FIELD checks
    /// from signature checks (a stale signature would fail as BadSignature).
    function test_claim_field_mismatches() public {
        fundBounty(7, schedule3(), 0);
        // Wrong recipient.
        OmniEscrowV2.VoucherV2 memory v = makeVoucher(7, 0, 0, block.timestamp + 1 days);
        v.recipient = recipient2;
        (uint8 sigV, bytes32 r, bytes32 s) = signVoucher(v);
        escrow.claim(v, sigV, r, s); // different recipient is FINE (fresh digest)
        assertEq(usdc.balanceOf(recipient2), 600_000);
        // Wrong token.
        v = makeVoucher(7, 1, 1, block.timestamp + 1 days);
        v.token = address(0xdead);
        (sigV, r, s) = signVoucher(v);
        vm.expectRevert(OmniEscrowV2.TokenMismatch.selector);
        escrow.claim(v, sigV, r, s);
        // Wrong criteria hash.
        v = makeVoucher(7, 1, 2, block.timestamp + 1 days);
        v.criteriaHash = bytes32(uint256(1));
        (sigV, r, s) = signVoucher(v);
        vm.expectRevert(OmniEscrowV2.CriteriaMismatch.selector);
        escrow.claim(v, sigV, r, s);
        // Wrong amount (exact slot amount enforced).
        v = makeVoucher(7, 1, 3, block.timestamp + 1 days);
        v.amount = 400_001;
        (sigV, r, s) = signVoucher(v);
        vm.expectRevert(OmniEscrowV2.AmountMismatch.selector);
        escrow.claim(v, sigV, r, s);
        // Wrong chain.
        v = makeVoucher(7, 1, 4, block.timestamp + 1 days);
        v.chainId = 1;
        (sigV, r, s) = signVoucher(v);
        vm.expectRevert(OmniEscrowV2.WrongChain.selector);
        escrow.claim(v, sigV, r, s);
        // Wrong escrow.
        v = makeVoucher(7, 1, 5, block.timestamp + 1 days);
        v.escrow = address(0xdead);
        (sigV, r, s) = signVoucher(v);
        vm.expectRevert(OmniEscrowV2.WrongEscrow.selector);
        escrow.claim(v, sigV, r, s);
        // Nonexistent bounty (built manually: no stored schedule to read).
        OmniEscrowV2.VoucherV2 memory v404 = OmniEscrowV2.VoucherV2({
            bountyId: 404,
            slotIndex: 0,
            recipient: recipient,
            token: address(usdc),
            amount: 1,
            nonce: 6,
            expiry: block.timestamp + 1 days,
            chainId: block.chainid,
            escrow: address(escrow),
            criteriaHash: criteria
        });
        (sigV, r, s) = signVoucher(v404);
        vm.expectRevert(OmniEscrowV2.BountyNotFound.selector);
        escrow.claim(v404, sigV, r, s);
        // Unfunded bounty.
        uint256[] memory one = new uint256[](1);
        one[0] = 100;
        vm.prank(sponsor);
        escrow.createBounty(9, address(usdc), one, 0, criteria);
        v = makeVoucher(9, 0, 7, block.timestamp + 1 days);
        (sigV, r, s) = signVoucher(v);
        vm.expectRevert(OmniEscrowV2.NotFunded.selector);
        escrow.claim(v, sigV, r, s);
        // Zero recipient / zero amount (NEAR never emits these; escrow still rejects).
        v = makeVoucher(7, 1, 7, block.timestamp + 1 days);
        v.recipient = address(0);
        (sigV, r, s) = signVoucher(v);
        vm.expectRevert(OmniEscrowV2.ZeroAddress.selector);
        escrow.claim(v, sigV, r, s);
        v = makeVoucher(7, 1, 8, block.timestamp + 1 days);
        v.amount = 0;
        (sigV, r, s) = signVoucher(v);
        vm.expectRevert(OmniEscrowV2.ZeroAmount.selector);
        escrow.claim(v, sigV, r, s);
        // Slot state untouched by all rejections.
        (bool claimed,) = escrow.slotStatus(7, 1);
        assertFalse(claimed);
    }

    function test_claim_expiry_boundaries() public {
        fundBounty(7, schedule3(), 0);
        // Expired voucher rejected.
        OmniEscrowV2.VoucherV2 memory v = makeVoucher(7, 0, 0, block.timestamp - 1);
        (uint8 sigV, bytes32 r, bytes32 s) = signVoucher(v);
        vm.expectRevert(OmniEscrowV2.VoucherExpired.selector);
        escrow.claim(v, sigV, r, s);
        // Valid during the expiry second (matches V2 semantics).
        v = makeVoucher(7, 0, 1, block.timestamp);
        (sigV, r, s) = signVoucher(v);
        escrow.claim(v, sigV, r, s);
        assertEq(usdc.balanceOf(recipient), 600_000);
    }

    function test_claim_invalid_slots() public {
        fundBounty(7, schedule3(), 0);
        // Slot 3 of a 3-slot schedule.
        OmniEscrowV2.VoucherV2 memory v = makeVoucher(7, 0, 0, block.timestamp + 1 days);
        v.slotIndex = 3;
        (uint8 sigV, bytes32 r, bytes32 s) = signVoucher(v);
        vm.expectRevert(OmniEscrowV2.InvalidSlot.selector);
        escrow.claim(v, sigV, r, s);
        // Slot 255.
        v.slotIndex = 255;
        (sigV, r, s) = signVoucher(v);
        vm.expectRevert(OmniEscrowV2.InvalidSlot.selector);
        escrow.claim(v, sigV, r, s);
        // slotStatus agrees.
        vm.expectRevert(OmniEscrowV2.InvalidSlot.selector);
        escrow.slotStatus(7, 3);
        vm.expectRevert(OmniEscrowV2.BountyNotFound.selector);
        escrow.slotStatus(404, 0);
    }

    function test_claim_replay_and_double_claim() public {
        fundBounty(7, schedule3(), 0);
        OmniEscrowV2.VoucherV2 memory v = makeVoucher(7, 0, 0, block.timestamp + 1 days);
        (uint8 sigV, bytes32 r, bytes32 s) = signVoucher(v);
        escrow.claim(v, sigV, r, s);
        // Identical resubmission: digest nullifier fires.
        vm.expectRevert(OmniEscrowV2.VoucherUsed.selector);
        escrow.claim(v, sigV, r, s);
        // Fresh digest (new nonce) for the SAME slot: bitmap fires instead.
        OmniEscrowV2.VoucherV2 memory v2 = makeVoucher(7, 0, 1, block.timestamp + 1 days);
        (uint8 sv2, bytes32 r2, bytes32 s2) = signVoucher(v2);
        vm.expectRevert(OmniEscrowV2.SlotClaimed.selector);
        escrow.claim(v2, sv2, r2, s2);
        // Other slots unaffected.
        claimSlot(7, 1, 2);
        assertEq(usdc.balanceOf(recipient), 600_000 + 400_000);
    }

    function test_claim_wrong_signer_and_malformed_sigs() public {
        fundBounty(7, schedule3(), 0);
        OmniEscrowV2.VoucherV2 memory v = makeVoucher(7, 0, 0, block.timestamp + 1 days);
        bytes32 digest = escrow.digestOf(v);
        // Attacker key.
        (uint8 sv, bytes32 rr, bytes32 ss) = vm.sign(0xBEEF, digest);
        vm.expectRevert(OmniEscrowV2.BadSignature.selector);
        escrow.claim(v, sv, rr, ss);
        // Bad v values.
        (sv, rr, ss) = signVoucher(v);
        vm.expectRevert(OmniEscrowV2.BadSignature.selector);
        escrow.claim(v, 0, rr, ss);
        vm.expectRevert(OmniEscrowV2.BadSignature.selector);
        escrow.claim(v, 29, rr, ss);
        // Zero / garbage components recover to 0x0 or the wrong signer.
        vm.expectRevert(OmniEscrowV2.BadSignature.selector);
        escrow.claim(v, sv, bytes32(0), ss);
        vm.expectRevert(OmniEscrowV2.BadSignature.selector);
        escrow.claim(v, sv, rr, bytes32(0));
        vm.expectRevert(OmniEscrowV2.BadSignature.selector);
        escrow.claim(v, sv, bytes32(uint256(1)), bytes32(uint256(2)));
        // Honest claim still works afterwards.
        escrow.claim(v, sv, rr, ss);
        assertEq(usdc.balanceOf(recipient), 600_000);
    }

    function test_malleated_signature_pays_same_recipient_or_reverts_used() public {
        fundBounty(7, schedule3(), 0);
        // secp256k1 group order.
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        OmniEscrowV2.VoucherV2 memory v = makeVoucher(7, 0, 0, block.timestamp + 1 days);
        (uint8 sigV, bytes32 r, bytes32 s) = signVoucher(v);
        // Malleate: s -> n - s, v flipped. Recovers to the SAME signer, so
        // the escrow accepts it — paying the SAME digest-bound recipient.
        // (No theft possible: changing any payout field invalidates the digest.)
        uint8 mv = sigV == 27 ? 28 : 27;
        bytes32 ms = bytes32(n - uint256(s));
        escrow.claim(v, mv, r, ms);
        assertEq(usdc.balanceOf(recipient), 600_000);
        // Either form resubmitted afterwards hits the digest nullifier.
        vm.expectRevert(OmniEscrowV2.VoucherUsed.selector);
        escrow.claim(v, sigV, r, s);
        vm.expectRevert(OmniEscrowV2.VoucherUsed.selector);
        escrow.claim(v, mv, r, ms);
    }

    // -- Refunds ---------------------------------------------------------

    function test_refund_valid_post_deadline() public {
        fundBounty(7, schedule3(), 1000);
        // Before and AT the deadline: locked.
        vm.expectRevert(OmniEscrowV2.DeadlineNotPassed.selector);
        vm.prank(sponsor);
        escrow.refundSlot(7, 0);
        vm.warp(1000);
        vm.expectRevert(OmniEscrowV2.DeadlineNotPassed.selector);
        vm.prank(sponsor);
        escrow.refundSlot(7, 0);
        // After: sponsor reclaims exactly the slot amount.
        vm.warp(1001);
        uint256 before = usdc.balanceOf(sponsor);
        vm.expectEmit(true, false, true, true);
        emit OmniEscrowV2.SlotRefunded(7, 0, sponsor, 600_000);
        vm.prank(sponsor);
        escrow.refundSlot(7, 0);
        assertEq(usdc.balanceOf(sponsor) - before, 600_000);
        (, bool refunded) = escrow.slotStatus(7, 0);
        assertTrue(refunded);
        // Double refund reverts; other slots independent.
        vm.prank(sponsor);
        vm.expectRevert(OmniEscrowV2.AlreadyRefunded.selector);
        escrow.refundSlot(7, 0);
        vm.prank(sponsor);
        escrow.refundSlot(7, 2);
        assertEq(usdc.balanceOf(address(escrow)), 400_000);
    }

    function test_refund_guards() public {
        // Deadline-0 bounty: never refundable (even at max time).
        fundBounty(7, schedule3(), 0);
        vm.warp(type(uint64).max);
        vm.prank(sponsor);
        vm.expectRevert(OmniEscrowV2.RefundUnavailable.selector);
        escrow.refundSlot(7, 0);
        // Still claimable (no horizon).
        claimSlot(7, 0, 0);
        // Non-sponsor, unknown bounty/slot, unfunded.
        vm.prank(recipient);
        vm.expectRevert(OmniEscrowV2.NotSponsor.selector);
        escrow.refundSlot(7, 1);
        vm.expectRevert(OmniEscrowV2.BountyNotFound.selector);
        escrow.refundSlot(404, 0);
        // Invalid slot (on a deadlined bounty, so the slot check is reached).
        fundBounty(8, schedule3(), 1000);
        vm.expectRevert(OmniEscrowV2.InvalidSlot.selector);
        vm.prank(sponsor);
        escrow.refundSlot(8, 9);
    }

    function test_claim_refund_race_both_orders() public {
        fundBounty(7, schedule3(), 1000);
        // Order 1: claim wins, refund loses.
        claimSlot(7, 0, 0);
        vm.warp(1001);
        vm.prank(sponsor);
        vm.expectRevert(OmniEscrowV2.SlotClaimed.selector);
        escrow.refundSlot(7, 0);
        // Order 2: refund wins, claim loses (fresh digest, valid sig).
        vm.prank(sponsor);
        escrow.refundSlot(7, 1);
        OmniEscrowV2.VoucherV2 memory v = makeVoucher(7, 1, 1, block.timestamp + 1 days);
        (uint8 sigV, bytes32 r, bytes32 s) = signVoucher(v);
        vm.expectRevert(OmniEscrowV2.AlreadyRefunded.selector);
        escrow.claim(v, sigV, r, s);
        // No funds created or destroyed: 600k paid + 400k refunded.
        assertEq(usdc.balanceOf(recipient), 600_000);
        assertEq(usdc.balanceOf(address(escrow)), 300_000);
    }

    // -- Admin -----------------------------------------------------------

    function test_two_step_ownership() public {
        address next = makeAddr("next");
        escrow.proposeOwnership(next);
        assertEq(escrow.pendingOwner(), next);
        // Wrong account cannot accept; owner unchanged.
        vm.prank(recipient);
        vm.expectRevert(OmniEscrowV2.NotProposedOwner.selector);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), address(this));
        // Non-owner cannot propose.
        vm.prank(recipient);
        vm.expectRevert(OmniEscrowV2.NotOwner.selector);
        escrow.proposeOwnership(recipient);
        // Successor accepts.
        vm.prank(next);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), next);
        assertEq(escrow.pendingOwner(), address(0));
        // Old owner locked out.
        vm.expectRevert(OmniEscrowV2.NotOwner.selector);
        escrow.setMpcSigner(makeAddr("x"));
    }

    function test_set_mpc_signer_guards() public {
        address other = makeAddr("mpc2");
        escrow.setMpcSigner(other);
        assertEq(escrow.mpcSigner(), other);
        vm.expectRevert(OmniEscrowV2.ZeroAddress.selector);
        escrow.setMpcSigner(address(0));
        vm.prank(recipient);
        vm.expectRevert(OmniEscrowV2.NotOwner.selector);
        escrow.setMpcSigner(other);
    }

    // -- Adversarial tokens ----------------------------------------------

    function test_no_return_token_works() public {
        NoReturnToken t = new NoReturnToken();
        t.mint(sponsor, 1_000_000);
        vm.prank(sponsor);
        t.approve(address(escrow), type(uint256).max);
        uint256[] memory one = new uint256[](1);
        one[0] = 500_000;
        vm.prank(sponsor);
        escrow.createBounty(7, address(t), one, 0, criteria);
        vm.prank(sponsor);
        escrow.fundBounty(7);
        OmniEscrowV2.VoucherV2 memory v = OmniEscrowV2.VoucherV2({
            bountyId: 7,
            slotIndex: 0,
            recipient: recipient,
            token: address(t),
            amount: 500_000,
            nonce: 0,
            expiry: block.timestamp + 1 days,
            chainId: block.chainid,
            escrow: address(escrow),
            criteriaHash: criteria
        });
        (uint8 sigV, bytes32 r, bytes32 s) = signVoucher(v);
        escrow.claim(v, sigV, r, s);
        assertEq(t.balanceOf(recipient), 500_000);
    }

    function test_reverting_and_false_tokens_fail_closed() public {
        // Reverting token: funding pulls revert as TransferFailed.
        RevertingToken rt = new RevertingToken();
        uint256[] memory one = new uint256[](1);
        one[0] = 100;
        vm.prank(sponsor);
        escrow.createBounty(7, address(rt), one, 0, criteria);
        vm.prank(sponsor);
        vm.expectRevert(OmniEscrowV2.TransferFailed.selector);
        escrow.fundBounty(7);
        // False-returning token: same (returndata contains `false`).
        FalseToken ft = new FalseToken();
        ft.mint(sponsor, 1_000_000);
        vm.prank(sponsor);
        ft.approve(address(escrow), type(uint256).max);
        vm.prank(sponsor);
        escrow.createBounty(8, address(ft), one, 0, criteria);
        vm.prank(sponsor);
        vm.expectRevert(OmniEscrowV2.TransferFailed.selector);
        escrow.fundBounty(8);
    }

    function test_reentrant_token_blocked_by_guard() public {
        ReentrantClaimToken t = new ReentrantClaimToken();
        t.mint(sponsor, 1_000_000);
        vm.prank(sponsor);
        t.approve(address(escrow), type(uint256).max);
        uint256[] memory one = new uint256[](1);
        one[0] = 500_000;
        vm.prank(sponsor);
        escrow.createBounty(7, address(t), one, 0, criteria);
        vm.prank(sponsor);
        escrow.fundBounty(7);
        OmniEscrowV2.VoucherV2 memory v = OmniEscrowV2.VoucherV2({
            bountyId: 7,
            slotIndex: 0,
            recipient: recipient,
            token: address(t),
            amount: 500_000,
            nonce: 0,
            expiry: block.timestamp + 1 days,
            chainId: block.chainid,
            escrow: address(escrow),
            criteriaHash: criteria
        });
        (uint8 sigV, bytes32 r, bytes32 s) = signVoucher(v);
        // Arm the token to reenter claim() during the payout transfer. The
        // inner call hits the nonReentrant guard (its revert is swallowed
        // by the token); the OUTER call then completes exactly once.
        t.arm(address(escrow), abi.encodeCall(OmniEscrowV2.claim, (v, sigV, r, s)));
        escrow.claim(v, sigV, r, s);
        assertEq(t.balanceOf(recipient), 500_000);
        assertEq(t.balanceOf(address(escrow)), 0); // single slot fully drained
        // A direct second claim still reverts (state, not just the guard).
        vm.expectRevert(OmniEscrowV2.VoucherUsed.selector);
        escrow.claim(v, sigV, r, s);
    }

    // -- Fuzz ------------------------------------------------------------

    function testFuzz_funding_totals_match_schedule(uint8 nRaw, uint256 seed) public {
        uint256 n = bound(nRaw, 1, 16);
        uint256[] memory amounts = new uint256[](n);
        uint256 total = 0;
        for (uint256 i = 0; i < n; i++) {
            uint256 a = bound(uint256(keccak256(abi.encode(seed, i))), 1, 1e12);
            amounts[i] = a;
            total += a;
        }
        vm.prank(sponsor);
        escrow.createBounty(7, address(usdc), amounts, 0, criteria);
        assertEq(escrow.bounties(7).totalFunded, total);
    }

    function testFuzz_claim_any_slot_pays_exact(uint256 slotSeed, uint256 expSeed) public {
        fundBounty(7, schedule3(), 0);
        uint8 slot = uint8(bound(slotSeed, 0, 2));
        uint256 expiry = block.timestamp + bound(expSeed, 1, 365 days);
        OmniEscrowV2.VoucherV2 memory v = makeVoucher(7, slot, 0, expiry);
        (uint8 sigV, bytes32 r, bytes32 s) = signVoucher(v);
        escrow.claim(v, sigV, r, s);
        assertEq(usdc.balanceOf(recipient), schedule3()[slot]);
    }

    function testFuzz_replay_never_pays_twice(uint256 slotSeed, uint256 nonceSeed) public {
        fundBounty(7, schedule3(), 0);
        uint8 slot = uint8(bound(slotSeed, 0, 2));
        uint256 nonce = bound(nonceSeed, 0, type(uint128).max);
        OmniEscrowV2.VoucherV2 memory v = makeVoucher(7, slot, nonce, block.timestamp + 1 days);
        (uint8 sigV, bytes32 r, bytes32 s) = signVoucher(v);
        escrow.claim(v, sigV, r, s);
        uint256 paidOnce = usdc.balanceOf(recipient);
        vm.expectRevert(OmniEscrowV2.VoucherUsed.selector);
        escrow.claim(v, sigV, r, s);
        assertEq(usdc.balanceOf(recipient), paidOnce);
    }
}

// -- Invariant harness -----------------------------------------------------

/// Random claim/refund driver over one 3-slot bounty. Successful operations
/// are recorded as ghost state; reverts are swallowed (both outcomes are
/// legal inputs to the accounting invariant).
contract EscrowInvariantHandler is Test {
    OmniEscrowV2 public escrow;
    MockUSDC public usdc;
    address public sponsor;
    address public recipient;
    uint256 public mpcKey;
    bytes32 public criteriaHash;
    uint256 public nonce;
    uint256 public paidSum;
    uint256 public refundedSum;
    bytes32[] public usedDigests;

    /// Number of recorded digests (the invariant loops over them).
    function usedDigestCount() external view returns (uint256) {
        return usedDigests.length;
    }

    constructor(
        OmniEscrowV2 escrow_,
        MockUSDC usdc_,
        address sponsor_,
        address recipient_,
        uint256 mpcKey_,
        bytes32 criteriaHash_
    ) {
        escrow = escrow_;
        usdc = usdc_;
        sponsor = sponsor_;
        recipient = recipient_;
        mpcKey = mpcKey_;
        criteriaHash = criteriaHash_;
    }

    function claimSlot(uint8 slotRaw) external {
        uint8 slot = uint8(bound(slotRaw, 0, 2));
        OmniEscrowV2.Bounty memory b = escrow.bounties(7);
        OmniEscrowV2.VoucherV2 memory v = OmniEscrowV2.VoucherV2({
            bountyId: 7,
            slotIndex: slot,
            recipient: recipient,
            token: address(usdc),
            amount: b.amounts[slot],
            nonce: nonce++,
            expiry: block.timestamp + 30 days,
            chainId: block.chainid,
            escrow: address(escrow),
            criteriaHash: criteriaHash
        });
        bytes32 digest = escrow.digestOf(v);
        (uint8 sigV, bytes32 r, bytes32 s) = vm.sign(mpcKey, digest);
        try escrow.claim(v, sigV, r, s) {
            paidSum += v.amount;
            usedDigests.push(digest);
        } catch {}
    }

    function refundSlot(uint8 slotRaw) external {
        uint8 slot = uint8(bound(slotRaw, 0, 2));
        vm.prank(sponsor);
        try escrow.refundSlot(7, slot) {
            refundedSum += escrow.bounties(7).amounts[slot];
        } catch {}
    }

    function warpPastDeadline() external {
        OmniEscrowV2.Bounty memory b = escrow.bounties(7);
        vm.warp(b.deadline + 1);
    }
}

contract OmniEscrowV2InvariantTest is Test {
    OmniEscrowV2 escrow;
    MockUSDC usdc;
    EscrowInvariantHandler handler;
    address sponsor = makeAddr("sponsor");
    address recipient = 0xcB234c6Fc8aBe3EB38E31EEc6288b431E313D9b9;
    uint256 mpcKey = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
    bytes32 criteriaHash = 0x499dcdccb8acfafe8d71e42ac91ab86cacbac30bf2b33c521b1bd47a31641d10;

    function setUp() public {
        address mpcSigner = vm.addr(mpcKey);
        escrow = new OmniEscrowV2(mpcSigner);
        usdc = new MockUSDC();
        usdc.mint(sponsor, 1_000_000_000_000);
        vm.prank(sponsor);
        usdc.approve(address(escrow), type(uint256).max);
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 600_000;
        amounts[1] = 400_000;
        amounts[2] = 300_000;
        vm.prank(sponsor);
        escrow.createBounty(7, address(usdc), amounts, uint64(block.timestamp + 7 days), criteriaHash);
        vm.prank(sponsor);
        escrow.fundBounty(7);
        handler = new EscrowInvariantHandler(escrow, usdc, sponsor, recipient, mpcKey, criteriaHash);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = handler.claimSlot.selector;
        selectors[1] = handler.refundSlot.selector;
        selectors[2] = handler.warpPastDeadline.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Conservation: claimed + refunded + escrowed == funded, always.
    function invariant_accounting_conserved() public view {
        uint256 total = escrow.bounties(7).totalFunded;
        assertEq(handler.paidSum() + handler.refundedSum() + usdc.balanceOf(address(escrow)), total);
    }

    /// Claimed and refunded slot sets are disjoint; every recorded digest
    /// is nullified on-chain.
    function invariant_no_double_spend() public view {
        OmniEscrowV2.Bounty memory b = escrow.bounties(7);
        assertEq(b.claimedBitmap & b.refundedBitmap, 0);
        // At most one terminal state per slot.
        for (uint8 i = 0; i < 3; i++) {
            uint256 bit = uint256(1) << i;
            uint256 states = ((b.claimedBitmap & bit != 0) ? 1 : 0) + ((b.refundedBitmap & bit != 0) ? 1 : 0);
            assertLe(states, 1);
        }
        // Every recorded payout digest is nullified on-chain.
        for (uint256 i = 0; i < handler.usedDigestCount(); i++) {
            assertTrue(escrow.usedVoucher(handler.usedDigests(i)));
        }
    }
}
