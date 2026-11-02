// SPDX-License-Identifier: MIT
// INTENTIONALLY VULNERABLE, for education only. Do not deploy.
pragma solidity ^0.8.24;

/// Sample: denial of service (SWC-128 / SWC-113). The loop is unbounded, and one
/// recipient that rejects ETH makes the whole refund revert for everybody.
contract UnboundedRefund {
    address[] public contributors;
    mapping(address => uint256) public contributed;

    function contribute() external payable {
        require(msg.value > 0, "zero");
        if (contributed[msg.sender] == 0) contributors.push(msg.sender);
        contributed[msg.sender] += msg.value;
    }

    function refundAll() external {
        for (uint256 i = 0; i < contributors.length; i++) {
            address to = contributors[i];
            uint256 amount = contributed[to];
            contributed[to] = 0;
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "refund failed");
        }
    }
}
