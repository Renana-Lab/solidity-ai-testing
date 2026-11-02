// SPDX-License-Identifier: MIT
// INTENTIONALLY VULNERABLE, for education only. Do not deploy.
pragma solidity ^0.8.24;

/// Sample: unchecked return value of a low-level call (SWC-104). If the payment
/// fails, the balance is still cleared and the money is lost.
contract UncheckedCall {
    mapping(address => uint256) public owed;

    function fund(address who) external payable {
        owed[who] += msg.value;
    }

    function claim() external {
        uint256 amount = owed[msg.sender];
        owed[msg.sender] = 0;
        msg.sender.call{value: amount}("");
    }
}
