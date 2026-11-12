// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title OmniBounty Base Escrow V2 — multi-winner USDC settlement for NEAR V3.
/// @notice Non-custodial (sponsor-refundable) escrow. NEAR V3 verifies
/// qualification and authorizes payment via MPC-signed `VoucherV2`
/// authorizations; this contract verifies the voucher signature plus its
/// own funding state, then pays USDC. It never reinterprets GitHub
/// evidence or acceptance criteria.
/// @dev Fresh V3 implementation. `contracts/base/OmniEscrow.sol` (V2,
/// single-winner) is untouched. Proven V2 shapes retained: EIP-712
/// fork-aware domain, low-level ERC-20 call tolerance, reentrancy guard,
/// custom errors, effects-before-interactions.
contract OmniEscrowV2 {
    // -- Types ------------------------------------------------------------

    struct Bounty {
        address token;
        address sponsor;
        /// Refund horizon. 0 disables refunds permanently (funds remain
        /// claimable forever). Sponsor-declared; UIs/relayers cross-check
        /// it against the criteria document (mechanical, by hash).
        uint64 deadline;
        /// Sponsor-declared criteria commitment; every claim must match it
        /// exactly (cross-checked off-chain like the slot schedule).
        bytes32 criteriaHash;
        bool funded;
        /// Checked sum(amounts) at creation; the sole fund/pull/claim total.
        uint256 totalFunded;
        /// Immutable per-slot schedule, 1..16 entries, each > 0.
        uint256[] amounts;
        /// Bit i set => slot i claimed. Disjoint from refundedBitmap.
        uint256 claimedBitmap;
        /// Bit i set => slot i refunded. Disjoint from claimedBitmap.
        uint256 refundedBitmap;
    }

    /// Frozen NEAR VoucherV2 authorization. Field order and types are
    /// normative (`docs/v3/NEAR_V3_DESIGN.md` §9) — do not reorder.
    struct VoucherV2 {
        uint256 bountyId;
        uint8 slotIndex;
        address recipient;
        address token;
        uint256 amount;
        uint256 nonce;
        uint256 expiry;
        uint256 chainId;
        address escrow;
        bytes32 criteriaHash;
    }

    // -- Constants --------------------------------------------------------

    /// NEAR V3 maximum: contract enforces slotIndex < len(amounts) <= 16.
    uint256 internal constant MAX_SLOTS = 16;

    /// keccak256("VoucherV2(uint256 bountyId,uint8 slotIndex,address
    /// recipient,address token,uint256 amount,uint256 nonce,uint256
    /// expiry,uint256 chainId,address escrow,bytes32 criteriaHash)")
    /// Pinned by `test_typehash_matches_frozen_string` and cross-checked
    /// against testdata/v3/eip712-voucher2.json.
    bytes32 public constant VOUCHER_V2_TYPEHASH = 0x1455b35cc7864127c56d1e0d2f4e6172e7170aa94cb677c301415aac89954bfb;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("OmniBounty");
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256("1");

    // -- Storage ----------------------------------------------------------

    mapping(uint256 bountyId => Bounty) private _bounties;
    mapping(bytes32 digest => bool) public usedVoucher;
    bool private _locked;
    uint256 private immutable _deploymentChainId;
    bytes32 private immutable _deploymentDomainSeparator;

    address public owner;
    address public pendingOwner;
    address public mpcSigner;

    // -- Events / errors --------------------------------------------------

    event BountyCreated(
        uint256 indexed bountyId,
        address indexed token,
        uint256 total,
        address indexed sponsor,
        uint64 deadline,
        bytes32 criteriaHash
    );
    event BountyFunded(uint256 indexed bountyId, address indexed sponsor, uint256 amount);
    event VoucherClaimed(
        uint256 indexed bountyId,
        uint8 slotIndex,
        address indexed recipient,
        uint256 amount,
        uint256 nonce,
        bytes32 criteriaHash,
        bytes32 digest
    );
    event SlotRefunded(uint256 indexed bountyId, uint8 slotIndex, address indexed sponsor, uint256 amount);
    event MpcSignerUpdated(address indexed oldSigner, address indexed newSigner);
    event OwnershipTransferProposed(address indexed oldOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    error NotOwner();
    error NotProposedOwner();
    error ZeroAddress();
    error ZeroAmount();
    error BountyExists();
    error BountyNotFound();
    error AlreadyFunded();
    error NotFunded();
    error NotSponsor();
    error InvalidSchedule();
    error InvalidSlot();
    error SlotClaimed();
    error AlreadyRefunded();
    error RefundUnavailable();
    error DeadlineNotPassed();
    error VoucherUsed();
    error VoucherExpired();
    error WrongChain();
    error WrongEscrow();
    error AmountMismatch();
    error TokenMismatch();
    error CriteriaMismatch();
    error BadSignature();
    error TransferFailed();
    error Reentrant();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrant();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(address mpcSigner_) {
        if (mpcSigner_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        mpcSigner = mpcSigner_;
        _deploymentChainId = block.chainid;
        _deploymentDomainSeparator = _buildDomainSeparator();
    }

    // -- EIP-712 ----------------------------------------------------------

    function _buildDomainSeparator() internal view returns (bytes32) {
        return
            keccak256(abi.encode(DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice Recomputes on chain forks; stable otherwise.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        if (block.chainid == _deploymentChainId) return _deploymentDomainSeparator;
        return _buildDomainSeparator();
    }

    function structHashOf(VoucherV2 calldata v) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                VOUCHER_V2_TYPEHASH,
                v.bountyId,
                v.slotIndex,
                v.recipient,
                v.token,
                v.amount,
                v.nonce,
                v.expiry,
                v.chainId,
                v.escrow,
                v.criteriaHash
            )
        );
    }

    function digestOf(VoucherV2 calldata v) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHashOf(v)));
    }

    // -- Bounty lifecycle -------------------------------------------------

    function bounties(uint256 bountyId) external view returns (Bounty memory) {
        return _bounties[bountyId];
    }

    /// @notice Claim/refund flags for one slot (UIs + relayer pre-checks).
    function slotStatus(uint256 bountyId, uint8 slotIndex) external view returns (bool claimed, bool refunded) {
        Bounty storage b = _bounties[bountyId];
        if (b.sponsor == address(0)) revert BountyNotFound();
        if (slotIndex >= b.amounts.length) revert InvalidSlot();
        uint256 bit = uint256(1) << slotIndex;
        return (b.claimedBitmap & bit != 0, b.refundedBitmap & bit != 0);
    }

    /// @notice Declare an immutable reward schedule. The caller becomes the
    /// sponsor. Amounts/deadline/criteriaHash SHOULD match the NEAR
    /// criteria document (UIs cross-check mechanically); a mismatch only
    /// bricks this sponsor's own bounty — claims fail closed.
    function createBounty(
        uint256 bountyId,
        address token,
        uint256[] calldata amounts,
        uint64 deadline,
        bytes32 criteriaHash
    ) external {
        if (token == address(0)) revert ZeroAddress();
        if (amounts.length == 0 || amounts.length > MAX_SLOTS) revert InvalidSchedule();
        if (_bounties[bountyId].sponsor != address(0)) revert BountyExists();
        uint256 total = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            if (amounts[i] == 0) revert ZeroAmount();
            total += amounts[i]; // 0.8 checked math: overflow reverts.
        }
        Bounty storage b = _bounties[bountyId];
        b.token = token;
        b.sponsor = msg.sender;
        b.deadline = deadline;
        b.criteriaHash = criteriaHash;
        b.totalFunded = total;
        b.amounts = amounts;
        emit BountyCreated(bountyId, token, total, msg.sender, deadline, criteriaHash);
    }

    /// @notice Pulls exactly `totalFunded` from the sponsor (approve first).
    /// Under/over-funding is impossible: the amount is the stored total.
    function fundBounty(uint256 bountyId) external nonReentrant {
        Bounty storage b = _bounties[bountyId];
        if (b.sponsor == address(0)) revert BountyNotFound();
        if (msg.sender != b.sponsor) revert NotSponsor();
        if (b.funded) revert AlreadyFunded();
        b.funded = true;
        _safeTransferFrom(b.token, msg.sender, address(this), b.totalFunded);
        emit BountyFunded(bountyId, msg.sender, b.totalFunded);
    }

    /// @notice Settles one slot against a VoucherV2 authorization. Every
    /// bound field is re-checked; effects precede the transfer.
    function claim(VoucherV2 calldata v, uint8 sigV, bytes32 r, bytes32 s) external nonReentrant {
        bytes32 digest = digestOf(v);
        if (usedVoucher[digest]) revert VoucherUsed();
        // Voucher expiries are day-scale; L2 block-timestamp granularity is immaterial.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > v.expiry) revert VoucherExpired();
        if (v.chainId != block.chainid) revert WrongChain();
        if (v.escrow != address(this)) revert WrongEscrow();
        if (v.recipient == address(0)) revert ZeroAddress();
        if (v.amount == 0) revert ZeroAmount();
        if (sigV != 27 && sigV != 28) revert BadSignature();

        Bounty storage b = _bounties[v.bountyId];
        if (b.sponsor == address(0)) revert BountyNotFound();
        if (!b.funded) revert NotFunded();
        if (v.slotIndex >= b.amounts.length) revert InvalidSlot();
        uint256 bit = uint256(1) << v.slotIndex;
        if (b.claimedBitmap & bit != 0) revert SlotClaimed();
        if (b.refundedBitmap & bit != 0) revert AlreadyRefunded();
        if (v.token != b.token) revert TokenMismatch();
        if (v.amount != b.amounts[v.slotIndex]) revert AmountMismatch();
        if (v.criteriaHash != b.criteriaHash) revert CriteriaMismatch();

        // No low-S (EIP-2) enforcement by design: MPC legitimately produces
        // high-S signatures, and malleation is harmless here — the nullifier
        // keys on the digest (not the signature) and payout fields are
        // digest-bound, so a malleated variant pays the same recipient or
        // reverts as used. See adversarial tests.
        address signer = ecrecover(digest, sigV, r, s);
        if (signer == address(0) || signer != mpcSigner) revert BadSignature();

        // Effects before interactions.
        usedVoucher[digest] = true;
        b.claimedBitmap |= bit;
        _safeTransfer(v.token, v.recipient, v.amount);
        emit VoucherClaimed(v.bountyId, v.slotIndex, v.recipient, v.amount, v.nonce, v.criteriaHash, digest);
    }

    /// @notice Sponsor reclaims one unclaimed slot after the deadline. The
    /// claim/refund race resolves atomically on the bitmaps: exactly one
    /// of claim/refund can win per slot. Deadline-0 bounties are never
    /// refundable (funds remain claimable forever).
    function refundSlot(uint256 bountyId, uint8 slotIndex) external nonReentrant {
        Bounty storage b = _bounties[bountyId];
        if (b.sponsor == address(0)) revert BountyNotFound();
        if (msg.sender != b.sponsor) revert NotSponsor();
        if (!b.funded) revert NotFunded();
        if (b.deadline == 0) revert RefundUnavailable();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= b.deadline) revert DeadlineNotPassed();
        if (slotIndex >= b.amounts.length) revert InvalidSlot();
        uint256 bit = uint256(1) << slotIndex;
        if (b.claimedBitmap & bit != 0) revert SlotClaimed();
        if (b.refundedBitmap & bit != 0) revert AlreadyRefunded();
        b.refundedBitmap |= bit;
        uint256 amount = b.amounts[slotIndex];
        _safeTransfer(b.token, b.sponsor, amount);
        emit SlotRefunded(bountyId, slotIndex, b.sponsor, amount);
    }

    // -- Admin ------------------------------------------------------------

    function setMpcSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        address old = mpcSigner;
        mpcSigner = newSigner;
        emit MpcSignerUpdated(old, newSigner);
    }

    /// @notice Two-step ownership (V2 used one step): propose, then the
    /// successor accepts. Re-proposing overwrites a mistaken proposal.
    function proposeOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferProposed(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || pendingOwner == address(0)) {
            revert NotProposedOwner();
        }
        address old = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(old, owner);
    }

    // -- Token helpers (tolerate non-standard ERC20 without return data) --

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
