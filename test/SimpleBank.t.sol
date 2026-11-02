// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SimpleBank} from "../contracts/practice/SimpleBank.sol";

/// A "user" contract with no receive()/fallback(): it cannot accept ETH,
/// so the bank's `call` back to it fails. Used to test the TransferFailed branch.
contract NoReceiveUser {
    function depositTo(SimpleBank bank) external payable {
        bank.deposit{value: msg.value}();
    }

    function withdrawFrom(SimpleBank bank, uint256 amount) external {
        bank.withdraw(amount);
    }
}

/// A malicious user that tries to re-enter withdraw() when it receives ETH.
/// Our bank updates state before sending, so the second call must fail.
contract ReentrantUser {
    SimpleBank bank;
    bool public reentered;

    constructor(SimpleBank _bank) {
        bank = _bank;
    }

    function attack() external payable {
        bank.deposit{value: msg.value}();
    }

    function go(uint256 amount) external {
        bank.withdraw(amount);
    }

    // receive() runs when this contract gets plain ETH. We try to withdraw again here.
    receive() external payable {
        reentered = true;
        bank.withdraw(1 ether);
    }
}

contract SimpleBankTest is Test {
    SimpleBank bank;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    function setUp() public {
        bank = new SimpleBank();
        // vm.deal sets an address's ETH balance. Test accounts start with 0 otherwise.
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    // ---------- deposit ----------

    function test_Deposit_UpdatesBalanceAndContractEth() public {
        vm.prank(alice);
        bank.deposit{value: 3 ether}(); // {value: ...} attaches ETH to the call
        assertEq(bank.balances(alice), 3 ether);
        assertEq(address(bank).balance, 3 ether);
        assertEq(alice.balance, 7 ether);
    }

    function test_Deposit_RecordsTimestamp() public {
        vm.warp(1_000_000); // vm.warp sets block.timestamp
        vm.prank(alice);
        bank.deposit{value: 1 ether}();
        assertEq(bank.lastDeposit(alice), 1_000_000);
    }

    function test_Deposit_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit Deposited(alice, 1 ether);
        vm.prank(alice);
        bank.deposit{value: 1 ether}();
    }

    function test_Deposit_RevertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(SimpleBank.ZeroAmount.selector);
        bank.deposit{value: 0}();
    }

    // ---------- withdraw ----------

    function test_Withdraw_AfterLockPeriod() public {
        vm.startPrank(alice); // startPrank: every call until stopPrank is made as alice
        bank.deposit{value: 5 ether}();
        vm.warp(block.timestamp + bank.LOCK_PERIOD());
        bank.withdraw(2 ether);
        vm.stopPrank();

        assertEq(bank.balances(alice), 3 ether);
        assertEq(alice.balance, 7 ether); // 10 - 5 + 2
        assertEq(address(bank).balance, 3 ether);
    }

    function test_Withdraw_EmitsEvent() public {
        vm.startPrank(alice);
        bank.deposit{value: 1 ether}();
        vm.warp(block.timestamp + 1 days);
        vm.expectEmit(true, false, false, true);
        emit Withdrawn(alice, 1 ether);
        bank.withdraw(1 ether);
        vm.stopPrank();
    }

    function test_Withdraw_RevertsWhileLocked() public {
        vm.startPrank(alice);
        bank.deposit{value: 1 ether}();
        uint256 unlockTime = block.timestamp + bank.LOCK_PERIOD();
        vm.warp(unlockTime - 1); // one second too early
        vm.expectRevert(abi.encodeWithSelector(SimpleBank.StillLocked.selector, unlockTime));
        bank.withdraw(1 ether);
        vm.stopPrank();
    }

    function test_Withdraw_RevertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(SimpleBank.ZeroAmount.selector);
        bank.withdraw(0);
    }

    function test_Withdraw_RevertsOnInsufficientBalance() public {
        vm.startPrank(alice);
        bank.deposit{value: 1 ether}();
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(abi.encodeWithSelector(SimpleBank.InsufficientBalance.selector, 2 ether, 1 ether));
        bank.withdraw(2 ether);
        vm.stopPrank();
    }

    // Bob cannot touch Alice's money: his own balance is 0.
    function test_Withdraw_CannotTakeOthersFunds() public {
        vm.prank(alice);
        bank.deposit{value: 5 ether}();
        vm.warp(block.timestamp + 1 days);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SimpleBank.InsufficientBalance.selector, 1 ether, 0));
        bank.withdraw(1 ether);
    }

    // A new deposit restarts the lock for that user.
    function test_SecondDeposit_ResetsLock() public {
        vm.startPrank(alice);
        bank.deposit{value: 1 ether}();
        vm.warp(block.timestamp + 1 days);
        bank.deposit{value: 1 ether}(); // lock restarts now
        uint256 unlockTime = block.timestamp + 1 days;
        vm.expectRevert(abi.encodeWithSelector(SimpleBank.StillLocked.selector, unlockTime));
        bank.withdraw(1 ether);
        vm.stopPrank();
    }

    function test_Withdraw_RevertsWhenTransferFails() public {
        NoReceiveUser user = new NoReceiveUser();
        vm.deal(address(user), 1 ether);
        user.depositTo{value: 1 ether}(bank);
        vm.warp(block.timestamp + 1 days);

        vm.expectRevert(SimpleBank.TransferFailed.selector);
        user.withdrawFrom(bank, 1 ether);
        // The whole transaction reverted, so the balance was NOT reduced.
        assertEq(bank.balances(address(user)), 1 ether);
    }

    // Security check: the reentrant second withdraw fails, which makes the
    // outer transfer fail, so everything is rolled back and nothing is stolen.
    function test_Withdraw_IsReentrancySafe() public {
        // Other users' money sits in the bank: this is what an attacker would target.
        vm.prank(bob);
        bank.deposit{value: 5 ether}();

        ReentrantUser attacker = new ReentrantUser(bank);
        vm.deal(address(attacker), 1 ether);
        attacker.attack{value: 1 ether}();
        vm.warp(block.timestamp + 1 days);

        vm.expectRevert(SimpleBank.TransferFailed.selector);
        attacker.go(1 ether);

        assertEq(address(bank).balance, 6 ether); // nothing left the bank
        assertEq(bank.balances(bob), 5 ether);
    }

    // ---------- fuzz ----------

    // For any deposit and any valid withdrawal, balances stay consistent with real ETH.
    // bound() squeezes a random number into a range (better than vm.assume for ranges:
    // assume throws inputs away, bound reshapes them).
    function testFuzz_DepositWithdraw(uint96 depositAmount, uint96 withdrawAmount) public {
        depositAmount = uint96(bound(depositAmount, 1, 10 ether));
        withdrawAmount = uint96(bound(withdrawAmount, 1, depositAmount));

        vm.startPrank(alice);
        bank.deposit{value: depositAmount}();
        vm.warp(block.timestamp + 1 days);
        bank.withdraw(withdrawAmount);
        vm.stopPrank();

        assertEq(bank.balances(alice), depositAmount - withdrawAmount);
        // Solvency: the bank always holds exactly what it owes.
        assertEq(address(bank).balance, bank.balances(alice));
    }
}
