// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title OmniEscrow — USDC bounty escrow settled by MPC-signed EIP-712 vouchers.
/// @notice Vouchers are authorized by the NEAR Chain Signatures (MPC) signer
/// after on-chain Reclaim proof verification. The escrow checks every bound
/// field: bountyId, recipient, token, amount, nonce, expiry, chainId and the
/// escrow address itself, plus single-use digests and bounty state.
contract OmniEscrow {
    // -- Types ------------------------------------------------------------

    struct Bounty {
        address token;
        uint256 amount;
        address sponsor;
        bool funded;
        bool claimed;
    }

    struct Voucher {
        uint256 bountyId;
        address recipient;
        address token;
        uint256 amount;
        uint256 nonce;
        uint256 expiry;
        uint256 chainId;
        address escrow;
    }

    // -- Constants --------------------------------------------------------

    /// keccak256("Voucher(uint256 bountyId,address recipient,address token,
    /// uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow)")
    /// Cross-checked against testdata/eip712.json and the NEAR contract.
    bytes32 public constant VOUCHER_TYPEHASH =
        0xd6e33bde1cad655a2f5764a35e2642eb0cfeb06ea06b05e3019f8e798c14ffc4;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("OmniBounty");
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256("1");

    // -- Storage ----------------------------------------------------------

    address public owner;
    address public mpcSigner;
    mapping(uint256 => Bounty) internal _bounties;
    mapping(bytes32 => bool) public usedVoucher;
    bool private _locked;
    uint256 private immutable _deploymentChainId;
    bytes32 private immutable _deploymentDomainSeparator;

    // -- Events / errors --------------------------------------------------

    event BountyCreated(uint256 indexed bountyId, address indexed token, uint256 amount, address indexed sponsor);
    event BountyFunded(uint256 indexed bountyId, address indexed sponsor, uint256 amount);
    event VoucherClaimed(uint256 indexed bountyId, address indexed recipient, uint256 amount, uint256 nonce, bytes32 digest);
    event BountyCancelled(uint256 indexed bountyId, address indexed sponsor, bool refunded);
    event MpcSignerUpdated(address indexed oldSigner, address indexed newSigner);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();
    error ZeroAmount();
    error BountyExists();
    error BountyNotFound();
    error AlreadyFunded();
    error NotFunded();
    error AlreadyClaimed();
    error NotSponsor();
    error VoucherUsed();
    error VoucherExpired();
    error WrongChain();
    error WrongEscrow();
    error AmountMismatch();
    error TokenMismatch();
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
            keccak256(
                abi.encode(
                    DOMAIN_TYPEHASH,
                    DOMAIN_NAME_HASH,
                    DOMAIN_VERSION_HASH,
                    block.chainid,
                    address(this)
                )
            );
    }

    /// @notice Recomputes on chain forks; stable otherwise.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        if (block.chainid == _deploymentChainId) return _deploymentDomainSeparator;
        return _buildDomainSeparator();
    }

    function structHashOf(Voucher calldata v) public pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    VOUCHER_TYPEHASH,
                    v.bountyId,
                    v.recipient,
                    v.token,
                    v.amount,
                    v.nonce,
                    v.expiry,
                    v.chainId,
                    v.escrow
                )
            );
    }

    function digestOf(Voucher calldata v) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHashOf(v)));
    }

    // -- Bounty lifecycle -------------------------------------------------

    function bounties(uint256 bountyId) external view returns (Bounty memory) {
        return _bounties[bountyId];
    }

    function createBounty(uint256 bountyId, address token, uint256 amount) external {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (_bounties[bountyId].sponsor != address(0)) revert BountyExists();
        _bounties[bountyId] = Bounty({
            token: token,
            amount: amount,
            sponsor: msg.sender,
            funded: false,
            claimed: false
        });
        emit BountyCreated(bountyId, token, amount, msg.sender);
    }

    /// @notice Pulls `amount` USDC from the sponsor (requires approval first).
    function fundBounty(uint256 bountyId) external nonReentrant {
        Bounty storage b = _bounties[bountyId];
        if (b.sponsor == address(0)) revert BountyNotFound();
        if (msg.sender != b.sponsor) revert NotSponsor();
        if (b.claimed) revert AlreadyClaimed();
        if (b.funded) revert AlreadyFunded();
        b.funded = true;
        _safeTransferFrom(b.token, msg.sender, address(this), b.amount);
        emit BountyFunded(bountyId, msg.sender, b.amount);
    }

    /// @notice Settles a voucher. Every bound field is re-checked on-chain.
    function claim(Voucher calldata v, uint8 sigV, bytes32 r, bytes32 s) external nonReentrant {
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
        if (b.claimed) revert AlreadyClaimed();
        if (!b.funded) revert NotFunded();
        if (v.token != b.token) revert TokenMismatch();
        if (v.amount != b.amount) revert AmountMismatch();

        address signer = ecrecover(digest, sigV, r, s);
        if (signer == address(0) || signer != mpcSigner) revert BadSignature();

        // Effects before interactions.
        usedVoucher[digest] = true;
        b.claimed = true;
        _safeTransfer(v.token, v.recipient, v.amount);
        emit VoucherClaimed(v.bountyId, v.recipient, v.amount, v.nonce, digest);
    }

    /// @notice Sponsor reclaim before any payout. Deletes the bounty so no
    /// voucher for it can ever settle afterwards.
    function cancelBounty(uint256 bountyId) external nonReentrant {
        Bounty storage b = _bounties[bountyId];
        if (b.sponsor == address(0)) revert BountyNotFound();
        if (msg.sender != b.sponsor) revert NotSponsor();
        if (b.claimed) revert AlreadyClaimed();
        bool refunded = b.funded;
        address token = b.token;
        uint256 amount = b.amount;
        address sponsor = b.sponsor;
        delete _bounties[bountyId];
        if (refunded) _safeTransfer(token, sponsor, amount);
        emit BountyCancelled(bountyId, sponsor, refunded);
    }

    // -- Admin ------------------------------------------------------------

    function setMpcSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        address old = mpcSigner;
        mpcSigner = newSigner;
        emit MpcSignerUpdated(old, newSigner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    // -- Token helpers (tolerate non-standard ERC20 without return data) --

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSelector(0xa9059cbb, to, amount)
        );
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSelector(0x23b872dd, from, to, amount)
        );
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
