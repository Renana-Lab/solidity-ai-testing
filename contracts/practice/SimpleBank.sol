// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SimpleBank
/// @notice M1 practice contract: deposit ETH, withdraw it after a lock period.
/// Written safely (checks-effects-interactions). Education only.
contract SimpleBank {
    uint256 public constant LOCK_PERIOD = 1 days;

    mapping(address => uint256) public balances;
    // Time of each user's latest deposit. Withdrawals unlock LOCK_PERIOD after it.
    mapping(address => uint256) public lastDeposit;

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    error ZeroAmount();
    error InsufficientBalance(uint256 requested, uint256 available);
    error StillLocked(uint256 unlockTime);
    error TransferFailed();

    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();
        balances[msg.sender] += msg.value;
        lastDeposit[msg.sender] = block.timestamp;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 balance = balances[msg.sender];
        if (amount > balance) revert InsufficientBalance(amount, balance);
        uint256 unlockTime = lastDeposit[msg.sender] + LOCK_PERIOD;
        if (block.timestamp < unlockTime) revert StillLocked(unlockTime);

        // Effects BEFORE interactions: update state first, send ETH last.
        // Doing it the other way round is the classic reentrancy bug (SWC-107).
        balances[msg.sender] = balance - amount;
        emit Withdrawn(msg.sender, amount);

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
