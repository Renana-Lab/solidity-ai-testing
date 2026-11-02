// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Fixed version of ReentrancyVault: checks-effects-interactions, and the
/// result of the ETH transfer is checked. Benchmark sample with no vulnerabilities.
contract SafeVault {
    mapping(address => uint256) public balances;

    error NothingToWithdraw();
    error TransferFailed();

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        // Effects first: reset state BEFORE sending ETH.
        balances[msg.sender] = 0;

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function totalHeld() external view returns (uint256) {
        return address(this).balance;
    }
}
