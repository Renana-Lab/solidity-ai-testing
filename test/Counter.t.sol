// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// forge-std/Test.sol gives us: the `vm` cheatcodes, assertEq/assertTrue, and `Test` base contract.
import {Test, stdError} from "forge-std/Test.sol";
import {Counter} from "../contracts/practice/Counter.sol";

contract CounterTest is Test {
    Counter counter;
    address alice = makeAddr("alice"); // makeAddr: a deterministic fake address with a label

    // Same declaration as in Counter, needed so vm.expectEmit can compare the event.
    event NumberChanged(address indexed by, uint256 oldValue, uint256 newValue);

    // setUp runs before EVERY test, so each test starts from a fresh contract.
    function setUp() public {
        counter = new Counter(); // deployed by this test contract, so it is the owner
    }

    // Test names starting with "test" are run by forge. Pattern: test_<What>_<Condition>.

    function test_InitialState() public view {
        assertEq(counter.number(), 0);
        assertEq(counter.owner(), address(this));
    }

    function test_Increment() public {
        counter.increment();
        counter.increment();
        assertEq(counter.number(), 2);
    }

    function test_Decrement() public {
        counter.setNumber(5);
        counter.decrement();
        assertEq(counter.number(), 4);
    }

    // vm.expectRevert(selector) says: the NEXT call must revert with this error.
    function test_Decrement_RevertsAtZero() public {
        vm.expectRevert(Counter.Underflow.selector);
        counter.decrement();
    }

    function test_SetNumber_ByOwner() public {
        counter.setNumber(42);
        assertEq(counter.number(), 42);
    }

    // vm.prank(alice): the next call is made as if msg.sender were alice.
    // For errors with arguments we encode the whole error with abi.encodeWithSelector.
    function test_SetNumber_RevertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Counter.NotOwner.selector, alice));
        counter.setNumber(1);
    }

    // vm.expectEmit(checkTopic1, checkTopic2, checkTopic3, checkData): then you emit the
    // event you expect, then make the real call. Topic1 here is the indexed `by`.
    function test_Increment_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit NumberChanged(alice, 0, 1);
        vm.prank(alice);
        counter.increment();
    }

    // Fuzz test: forge calls this many times (256 by default) with random `x`.
    function testFuzz_SetNumber(uint256 x) public {
        counter.setNumber(x);
        assertEq(counter.number(), x);
    }

    // Fuzz with an invariant-style property: increment then decrement is a no-op.
    // vm.assume skips inputs we cannot use (max value would overflow on increment).
    function testFuzz_IncrementThenDecrement(uint256 start) public {
        vm.assume(start < type(uint256).max);
        counter.setNumber(start);
        counter.increment();
        counter.decrement();
        assertEq(counter.number(), start);
    }

    // Edge value: incrementing the max uint256 reverts with a built-in Panic (overflow check, 0.8+).
    function test_Increment_RevertsOnOverflow() public {
        counter.setNumber(type(uint256).max);
        vm.expectRevert(stdError.arithmeticError);
        counter.increment();
    }
}
