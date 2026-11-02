// SPDX-License-Identifier: MIT
// INTENTIONALLY VULNERABLE, for education only. Do not deploy.
pragma solidity ^0.8.24;

/// Sample: the winner depends on block.timestamp (SWC-116). A validator can nudge
/// the timestamp, and anyone can compute the result before sending their entry.
contract TimestampLottery {
    uint256 public constant TICKET_PRICE = 0.1 ether;
    address[] public players;

    function enter() external payable {
        require(msg.value == TICKET_PRICE, "wrong price");
        players.push(msg.sender);
    }

    function pickWinner() external {
        require(players.length > 0, "no players");
        uint256 index = block.timestamp % players.length;
        address winner = players[index];
        delete players;
        (bool ok, ) = winner.call{value: address(this).balance}("");
        require(ok, "payout failed");
    }

    function playerCount() external view returns (uint256) {
        return players.length;
    }
}
