// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../OmniEscrow.sol";

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

// -- Suite ---------------------------------------------------------------

contract OmniEscrowTest is Test {
    using stdJson for string;

    OmniEscrow escrow;
    MockUSDC usdc;
    address sponsor = makeAddr("sponsor");
    address recipient = 0xcB234c6Fc8aBe3EB38E31EEc6288b431E313D9b9;
    uint256 mpcKey = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
    address mpcSigner;

    string constant FIXTURE = "../../testdata/eip712.json";

    function setUp() public {
        mpcSigner = vm.addr(mpcKey);
        escrow = new OmniEscrow(mpcSigner);
        usdc = new MockUSDC();
        usdc.mint(sponsor, 1_000_000_000_000);
        vm.prank(sponsor);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function fixtureVoucher(string memory name) internal returns (OmniEscrow.Voucher memory v) {
        string memory json = vm.readFile(FIXTURE);
        OmniEscrow.Voucher[] memory found = new OmniEscrow.Voucher[](1);
        // Linear scan over the three committed vectors.
        string[] memory names = new string[](3);
        names[0] = "standard";
        names[1] = "second_nonce";
        names[2] = "max_amount";
        for (uint256 i = 0; i < 3; i++) {
            if (keccak256(bytes(names[i])) == keccak256(bytes(name))) {
                string memory base = string.concat("$.vouchers[", vm.toString(i), "].value");
                v = OmniEscrow.Voucher({
                    bountyId: json.readUint(string.concat(base, ".bountyId")),
                    recipient: json.readAddress(string.concat(base, ".recipient")),
                    token: json.readAddress(string.concat(base, ".token")),
                    amount: json.readUint(string.concat(base, ".amount")),
                    nonce: json.readUint(string.concat(base, ".nonce")),
                    expiry: json.readUint(string.concat(base, ".expiry")),
                    chainId: json.readUint(string.concat(base, ".chainId")),
                    escrow: json.readAddress(string.concat(base, ".escrow"))
                });
                found[0] = v;
                return found[0];
            }
        }
        revert("fixture not found");
    }

    function fixtureStructHash(string memory name) internal returns (bytes32) {
        string memory json = vm.readFile(FIXTURE);
        if (keccak256(bytes(name)) == keccak256(bytes("standard"))) return json.readBytes32("$.vouchers[0].structHash");
        if (keccak256(bytes(name)) == keccak256(bytes("second_nonce")))
            return json.readBytes32("$.vouchers[1].structHash");
        return json.readBytes32("$.vouchers[2].structHash");
    }

    // -- Oracle cross-checks --------------------------------------------

    function testTypehashMatchesOracle() public {
        string memory json = vm.readFile(FIXTURE);
        assertEq(escrow.VOUCHER_TYPEHASH(), json.readBytes32("$.voucherTypehash"));
    }

    function testStructHashMatchesOracle() public {
        assertEq(escrow.structHashOf(fixtureVoucher("standard")), fixtureStructHash("standard"));
        assertEq(escrow.structHashOf(fixtureVoucher("second_nonce")), fixtureStructHash("second_nonce"));
        assertEq(escrow.structHashOf(fixtureVoucher("max_amount")), fixtureStructHash("max_amount"));
    }

    function testE2EStructHashMatchesOracle() public {
        // The same voucher the NEAR contract derives in its end-to-end claim
        // test (testdata/e2e_claim.json): Solidity independently agrees on
        // the struct hash, closing the Rust<->Solidity<->ethers triangle.
        string memory json = vm.readFile("../../testdata/e2e_claim.json");
        OmniEscrow.Voucher memory v = OmniEscrow.Voucher({
            bountyId: json.readUint("$.voucher.bountyId"),
            recipient: json.readAddress("$.voucher.recipient"),
            token: json.readAddress("$.voucher.token"),
            amount: json.readUint("$.voucher.amount"),
            nonce: json.readUint("$.voucher.nonce"),
            expiry: json.readUint("$.voucher.expiry"),
            chainId: json.readUint("$.voucher.chainId"),
            escrow: json.readAddress("$.voucher.escrow")
        });
        assertEq(escrow.structHashOf(v), json.readBytes32("$.structHash"));
    }

    function testDomainSeparatorEncoding() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("OmniBounty"),
                keccak256("1"),
                block.chainid,
                address(escrow)
            )
        );
        assertEq(escrow.DOMAIN_SEPARATOR(), expected);
    }

    function testDigestAssemblyMatchesEIP712() public {
        OmniEscrow.Voucher memory v = fixtureVoucher("standard");
        bytes32 expected = keccak256(
            abi.encodePacked("\x19\x01", escrow.DOMAIN_SEPARATOR(), fixtureStructHash("standard"))
        );
        assertEq(escrow.digestOf(v), expected);
    }

    // -- Happy path ------------------------------------------------------

    function liveVoucher(uint256 bountyId, uint256 nonce, uint256 expiry)
        internal
        view
        returns (OmniEscrow.Voucher memory)
    {
        return
            OmniEscrow.Voucher({
                bountyId: bountyId,
                recipient: recipient,
                token: address(usdc),
                amount: 2_500_000_000,
                nonce: nonce,
                expiry: expiry,
                chainId: block.chainid,
                escrow: address(escrow)
            });
    }

    function testClaimEndToEnd() public {
        vm.prank(sponsor);
        escrow.createBounty(7, address(usdc), 2_500_000_000);
        vm.prank(sponsor);
        escrow.fundBounty(7);

        OmniEscrow.Voucher memory v = liveVoucher(7, 0, block.timestamp + 1 days);
        bytes32 digest = escrow.digestOf(v);
        (uint8 sigV, bytes32 r, bytes32 s) = vm.sign(mpcKey, digest);

        assertFalse(escrow.usedVoucher(digest));
        vm.expectEmit(true, true, false, true);
        emit OmniEscrow.VoucherClaimed(7, recipient, 2_500_000_000, 0, digest);
        escrow.claim(v, sigV, r, s);

        assertTrue(escrow.usedVoucher(digest));
        assertEq(usdc.balanceOf(recipient), 2_500_000_000);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        OmniEscrow.Bounty memory b = escrow.bounties(7);
        assertTrue(b.claimed);
    }

    // -- Replay / tamper / authorization ---------------------------------

    function fundedBounty() internal returns (OmniEscrow.Voucher memory v, bytes32 digest, uint8 sigV, bytes32 r, bytes32 s) {
        vm.prank(sponsor);
        escrow.createBounty(7, address(usdc), 2_500_000_000);
        vm.prank(sponsor);
        escrow.fundBounty(7);
        v = liveVoucher(7, 0, block.timestamp + 1 days);
        digest = escrow.digestOf(v);
        (sigV, r, s) = vm.sign(mpcKey, digest);
    }

    function testReplayRejected() public {
        (OmniEscrow.Voucher memory v, , uint8 sigV, bytes32 r, bytes32 s) = fundedBounty();
        escrow.claim(v, sigV, r, s);
        vm.expectRevert(OmniEscrow.VoucherUsed.selector);
        escrow.claim(v, sigV, r, s);
    }

    function testTamperedRecipientRejected() public {
        (OmniEscrow.Voucher memory v, , uint8 sigV, bytes32 r, bytes32 s) = fundedBounty();
        v.recipient = address(0xdead);
        vm.expectRevert(OmniEscrow.BadSignature.selector);
        escrow.claim(v, sigV, r, s);
    }

    function testTamperedAmountRejected() public {
        (OmniEscrow.Voucher memory v, , uint8 sigV, bytes32 r, bytes32 s) = fundedBounty();
        v.amount = 1;
        // Amount check precedes signature recovery.
        vm.expectRevert(OmniEscrow.AmountMismatch.selector);
        escrow.claim(v, sigV, r, s);
    }

    function testTamperedTokenRejected() public {
        (OmniEscrow.Voucher memory v, , uint8 sigV, bytes32 r, bytes32 s) = fundedBounty();
        v.token = address(0x1234);
        vm.expectRevert(OmniEscrow.TokenMismatch.selector);
        escrow.claim(v, sigV, r, s);
    }

    function testTamperedNonceRejected() public {
        (OmniEscrow.Voucher memory v, , uint8 sigV, bytes32 r, bytes32 s) = fundedBounty();
        v.nonce = 999;
        vm.expectRevert(OmniEscrow.BadSignature.selector);
        escrow.claim(v, sigV, r, s);
    }

    function testTamperedBountyIdRejected() public {
        (OmniEscrow.Voucher memory v, , uint8 sigV, bytes32 r, bytes32 s) = fundedBounty();
        v.bountyId = 4242;
        vm.expectRevert(OmniEscrow.BountyNotFound.selector);
        escrow.claim(v, sigV, r, s);
    }

    function testTamperedChainIdRejected() public {
        (OmniEscrow.Voucher memory v, , uint8 sigV, bytes32 r, bytes32 s) = fundedBounty();
        v.chainId = 1;
        vm.expectRevert(OmniEscrow.WrongChain.selector);
        escrow.claim(v, sigV, r, s);
    }

    function testTamperedEscrowRejected() public {
        (OmniEscrow.Voucher memory v, , uint8 sigV, bytes32 r, bytes32 s) = fundedBounty();
        v.escrow = address(0xbeef);
        vm.expectRevert(OmniEscrow.WrongEscrow.selector);
        escrow.claim(v, sigV, r, s);
    }

    function testZeroRecipientRejected() public {
        (OmniEscrow.Voucher memory v, , uint8 sigV, bytes32 r, bytes32 s) = fundedBounty();
        v.recipient = address(0);
        vm.expectRevert(OmniEscrow.ZeroAddress.selector);
        escrow.claim(v, sigV, r, s);
    }

    function testWrongSignerRejected() public {
        (OmniEscrow.Voucher memory v, bytes32 digest, , , ) = fundedBounty();
        (uint8 sigV, bytes32 r, bytes32 s) = vm.sign(0xBEEF, digest);
        vm.expectRevert(OmniEscrow.BadSignature.selector);
        escrow.claim(v, sigV, r, s);
    }

    function testBadVRejected() public {
        (OmniEscrow.Voucher memory v, , , bytes32 r, bytes32 s) = fundedBounty();
        vm.expectRevert(OmniEscrow.BadSignature.selector);
        escrow.claim(v, 26, r, s);
        vm.expectRevert(OmniEscrow.BadSignature.selector);
        escrow.claim(v, 0, r, s);
    }

    function testExpiredRejected() public {
        (OmniEscrow.Voucher memory v, , uint8 sigV, bytes32 r, bytes32 s) = fundedBounty();
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(OmniEscrow.VoucherExpired.selector);
        escrow.claim(v, sigV, r, s);
    }

    function testUnfundedRejected() public {
        vm.prank(sponsor);
        escrow.createBounty(7, address(usdc), 2_500_000_000);
        OmniEscrow.Voucher memory v = liveVoucher(7, 0, block.timestamp + 1 days);
        (uint8 sigV, bytes32 r, bytes32 s) = vm.sign(mpcKey, escrow.digestOf(v));
        vm.expectRevert(OmniEscrow.NotFunded.selector);
        escrow.claim(v, sigV, r, s);
    }

    function testForkInvalidatesVouchers() public {
        (OmniEscrow.Voucher memory v, , uint8 sigV, bytes32 r, bytes32 s) = fundedBounty();
        bytes32 before = escrow.DOMAIN_SEPARATOR();
        vm.chainId(1);
        assertTrue(escrow.DOMAIN_SEPARATOR() != before);
        vm.expectRevert(OmniEscrow.WrongChain.selector);
        escrow.claim(v, sigV, r, s);
    }

    // -- Lifecycle / admin ------------------------------------------------

    function testCancelRefundsAndKillsBounty() public {
        vm.prank(sponsor);
        escrow.createBounty(7, address(usdc), 2_500_000_000);
        vm.prank(sponsor);
        escrow.fundBounty(7);
        uint256 before = usdc.balanceOf(sponsor);
        vm.prank(sponsor);
        escrow.cancelBounty(7);
        assertEq(usdc.balanceOf(sponsor), before + 2_500_000_000);

        OmniEscrow.Voucher memory v = liveVoucher(7, 0, block.timestamp + 1 days);
        (uint8 sigV, bytes32 r, bytes32 s) = vm.sign(mpcKey, escrow.digestOf(v));
        vm.expectRevert(OmniEscrow.BountyNotFound.selector);
        escrow.claim(v, sigV, r, s);
    }

    function testCancelGuards() public {
        vm.prank(sponsor);
        escrow.createBounty(7, address(usdc), 2_500_000_000);
        vm.expectRevert(OmniEscrow.NotSponsor.selector);
        escrow.cancelBounty(7);
        vm.expectRevert(OmniEscrow.BountyNotFound.selector);
        vm.prank(sponsor);
        escrow.cancelBounty(404);
    }

    function testDoubleFundRejected() public {
        vm.prank(sponsor);
        escrow.createBounty(7, address(usdc), 2_500_000_000);
        vm.prank(sponsor);
        escrow.fundBounty(7);
        vm.prank(sponsor);
        vm.expectRevert(OmniEscrow.AlreadyFunded.selector);
        escrow.fundBounty(7);
    }

    function testAdminGuards() public {
        vm.expectRevert(OmniEscrow.NotOwner.selector);
        vm.prank(sponsor);
        escrow.setMpcSigner(address(1));
        vm.expectRevert(OmniEscrow.ZeroAddress.selector);
        escrow.setMpcSigner(address(0));

        address next = makeAddr("next");
        escrow.transferOwnership(next);
        assertEq(escrow.owner(), next);
        vm.expectRevert(OmniEscrow.NotOwner.selector);
        escrow.setMpcSigner(next);
    }

    function testSignerRotation() public {
        (OmniEscrow.Voucher memory v, , uint8 sigV, bytes32 r, bytes32 s) = fundedBounty();
        address next = makeAddr("mpc2");
        escrow.setMpcSigner(next);
        vm.expectRevert(OmniEscrow.BadSignature.selector);
        escrow.claim(v, sigV, r, s);
    }

    // -- Token oddities ----------------------------------------------------

    function testNoReturnTokenWorks() public {
        NoReturnToken t = new NoReturnToken();
        t.mint(sponsor, 100);
        vm.prank(sponsor);
        t.approve(address(escrow), 100);
        vm.prank(sponsor);
        escrow.createBounty(9, address(t), 100);
        vm.prank(sponsor);
        escrow.fundBounty(9);
        OmniEscrow.Voucher memory v = OmniEscrow.Voucher({
            bountyId: 9,
            recipient: recipient,
            token: address(t),
            amount: 100,
            nonce: 0,
            expiry: block.timestamp + 1 days,
            chainId: block.chainid,
            escrow: address(escrow)
        });
        (uint8 sigV, bytes32 r, bytes32 s) = vm.sign(mpcKey, escrow.digestOf(v));
        escrow.claim(v, sigV, r, s);
        assertEq(t.balanceOf(recipient), 100);
    }

    function testRevertingTokenFailsClosed() public {
        RevertingToken t = new RevertingToken();
        vm.prank(sponsor);
        escrow.createBounty(9, address(t), 100);
        vm.prank(sponsor);
        vm.expectRevert(OmniEscrow.TransferFailed.selector);
        escrow.fundBounty(9);
    }

    // -- Fuzz ---------------------------------------------------------------

    function testFuzz_ClaimRoundtrip(uint256 amount, uint256 nonce, uint256 ttl) public {
        vm.assume(amount > 0 && amount <= 1_000_000_000_000);
        vm.assume(nonce < type(uint64).max);
        vm.assume(ttl > 0 && ttl < 365 days);
        vm.prank(sponsor);
        escrow.createBounty(11, address(usdc), amount);
        vm.prank(sponsor);
        escrow.fundBounty(11);
        OmniEscrow.Voucher memory v = OmniEscrow.Voucher({
            bountyId: 11,
            recipient: recipient,
            token: address(usdc),
            amount: amount,
            nonce: nonce,
            expiry: block.timestamp + ttl,
            chainId: block.chainid,
            escrow: address(escrow)
        });
        (uint8 sigV, bytes32 r, bytes32 s) = vm.sign(mpcKey, escrow.digestOf(v));
        escrow.claim(v, sigV, r, s);
        assertEq(usdc.balanceOf(recipient), amount);
    }

    function testFuzz_StructHashAvalanche(uint256 a, uint256 b) public {
        vm.assume(a != b);
        OmniEscrow.Voucher memory v1 = liveVoucher(7, 0, block.timestamp + 1 days);
        OmniEscrow.Voucher memory v2 = liveVoucher(7, 0, block.timestamp + 1 days);
        v1.nonce = a % 1000;
        v2.nonce = b % 1000;
        vm.assume(v1.nonce != v2.nonce);
        assertTrue(escrow.structHashOf(v1) != escrow.structHashOf(v2));
    }
}
