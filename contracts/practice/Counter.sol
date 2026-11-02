// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Counter
/// @notice M1 practice contract: a number that only its owner can set directly.
contract Counter {
    // `public` makes Solidity generate a free getter function: counter.number()
    uint256 public number;
    address public immutable owner;

    // Events are logs written to the blockchain. Tests can check them with vm.expectEmit.
    // `indexed` fields can be filtered by off-chain tools.
    event NumberChanged(address indexed by, uint256 oldValue, uint256 newValue);

    // Custom errors are cheaper than revert strings and can carry data.
    error NotOwner(address caller);
    error Underflow();

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _; // the body of the modified function runs here
    }

    function increment() external {
        _set(number + 1);
    }

    function decrement() external {
        // Since 0.8, `number - 1` would already revert at 0 (with a generic panic).
        // We check explicitly so the error is readable.
        if (number == 0) revert Underflow();
        _set(number - 1);
    }

    function setNumber(uint256 newNumber) external onlyOwner {
        _set(newNumber);
    }

    function _set(uint256 newNumber) private {
        emit NumberChanged(msg.sender, number, newNumber);
        number = newNumber;
    }
}
