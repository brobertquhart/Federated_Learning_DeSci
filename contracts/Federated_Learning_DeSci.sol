pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract FederatedLearningDeSciFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidBatchState();
    error InvalidParameters();
    error ReplayDetected();
    error StateMismatch();
    error DecryptionFailed();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;

    struct Batch {
        uint256 id;
        bool isOpen;
        uint256 totalEncryptedGradientSum;
        uint32 totalSamples;
    }

    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PausedSet(bool paused);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event EncryptedGradientSubmitted(address indexed provider, uint256 indexed batchId, euint32 encryptedGradientSum, uint32 samples);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint32 decryptedGradientSum, uint32 totalSamples);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; 
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidParameters();
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidParameters();
        delete isProvider[provider];
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        if (_cooldownSeconds == 0) revert InvalidParameters();
        emit CooldownSecondsSet(cooldownSeconds, _cooldownSeconds);
        cooldownSeconds = _cooldownSeconds;
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batches[currentBatchId].isOpen) revert InvalidBatchState();
        currentBatchId++;
        batches[currentBatchId] = Batch(currentBatchId, true, 0, 0);
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        Batch storage batch = batches[currentBatchId];
        if (!batch.isOpen) revert InvalidBatchState();
        batch.isOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitEncryptedGradient(
        euint32 encryptedGradientSum,
        uint32 samples
    ) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        Batch storage batch = batches[currentBatchId];
        if (!batch.isOpen) revert InvalidBatchState();

        _initIfNeeded(encryptedGradientSum);

        batch.totalEncryptedGradientSum = FHE.add(batch.totalEncryptedGradientSum, encryptedGradientSum);
        batch.totalSamples += samples;

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit EncryptedGradientSubmitted(msg.sender, currentBatchId, encryptedGradientSum, samples);
    }

    function requestBatchDecryption(uint256 batchId) external onlyOwner whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        Batch storage batch = batches[batchId];
        if (batch.id == 0 || batch.isOpen) revert InvalidBatchState(); 

        euint32 encryptedGradientSum = FHE.asEuint32(batch.totalEncryptedGradientSum);
        _initIfNeeded(encryptedGradientSum);

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(encryptedGradientSum);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext(batchId, stateHash, false);
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        DecryptionContext storage ctx = decryptionContexts[requestId];
        if (ctx.processed) revert ReplayDetected();

        Batch storage batch = batches[ctx.batchId];
        if (batch.id == 0) revert InvalidBatchState();

        euint32 encryptedGradientSum = FHE.asEuint32(batch.totalEncryptedGradientSum);
        _initIfNeeded(encryptedGradientSum);

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(encryptedGradientSum);
        bytes32 currentHash = _hashCiphertexts(cts);

        if (currentHash != ctx.stateHash) revert StateMismatch();
        FHE.checkSignatures(requestId, cleartexts, proof);

        (uint32 decryptedGradientSum) = abi.decode(cleartexts, (uint32));
        ctx.processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, decryptedGradientSum, batch.totalSamples);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 x) internal view {
        if (!FHE.isInitialized(x)) revert DecryptionFailed();
    }

    function _requireInitialized(euint32 x) internal view {
        if (!FHE.isInitialized(x)) revert DecryptionFailed();
    }
}