// SPDX-License-Identifier: MIT
// INTENTIONALLY VULNERABLE, for education only. Do not deploy.
pragma solidity ^0.8.24;

/// Sample: missing access control (SWC-105/106). Anyone can wipe every budget.
contract UnprotectedReset {
    address public owner;
    address[] public members;
    mapping(address => uint256) public budgets;

    constructor() {
        owner = msg.sender;
    }

    function setBudget(address member, uint256 amount) external {
        require(msg.sender == owner, "only owner");
        if (budgets[member] == 0) members.push(member);
        budgets[member] = amount;
    }

    function resetAll() public {
        for (uint256 i = 0; i < members.length; i++) {
            budgets[members[i]] = 0;
        }
    }

    function memberCount() external view returns (uint256) {
        return members.length;
    }
}
