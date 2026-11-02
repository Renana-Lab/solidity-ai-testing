// SPDX-License-Identifier: MIT
// INTENTIONALLY VULNERABLE, for education only. Do not deploy.
pragma solidity ^0.8.24;

/// Sample: integer underflow inside `unchecked` (SWC-101). Solidity 0.8 normally
/// reverts on underflow, but `unchecked` turns that protection off.
contract UncheckedMath {
    mapping(address => uint256) public points;

    function earn(uint256 amount) external {
        points[msg.sender] += amount;
    }

    function spend(uint256 amount) external {
        unchecked {
            points[msg.sender] -= amount;
        }
    }

    function transferPoints(address to, uint256 amount) external {
        require(points[msg.sender] >= amount, "not enough points");
        points[msg.sender] -= amount;
        points[to] += amount;
    }
}
