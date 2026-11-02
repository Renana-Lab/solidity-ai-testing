// SPDX-License-Identifier: MIT
// INTENTIONALLY VULNERABLE, for education only. Do not deploy.
pragma solidity ^0.8.24;

/// Sample: authorization with tx.origin (SWC-115). A malicious contract the owner
/// calls can forward the call here, and tx.origin is still the owner.
contract TxOriginWallet {
    address public owner;

    constructor() payable {
        owner = msg.sender;
    }

    function transferTo(address payable to, uint256 amount) external {
        require(tx.origin == owner, "not owner");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "transfer failed");
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }

    receive() external payable {}
}
