#!/bin/bash
# Live M4: PoC for saved M3 findings (no new audit calls), cap $0.10 per contract.
export PATH="$PATH:/c/Users/yairk/.foundry/bin"
cd /c/solidity-ai-testing
# Fail fast, before any Gemini call, if forge is missing.
forge --version > /dev/null || { echo "forge not found or not working" >&2; exit 2; }
run() { # name path findings [extra flags]
  echo "=== $1 ($3)"
  npx tsx src/cli/index.ts audit "$2" --poc --poc-from "$3" --max-cost 0.10 --out reports/m4-run --model gemini-3.6-flash ${4:-}
  echo "exit=$?"
}
for p in contracts/samples/vulnerable/*.sol contracts/samples/safe/*.sol; do
  n=$(basename "$p" .sol)
  f=$(ls reports/m3-run/*-$n-audit/audit/llm-findings.json)
  run "$n" "$p" "$f"
done
# negative controls: findings that do not belong to the contract
run "SafeVault-with-ReentrancyVault-finding" contracts/samples/safe/SafeVault.sol "$(ls reports/m3-run/*-ReentrancyVault-audit/audit/llm-findings.json)" --negative-control
run "SimpleToken-with-fabricated-claim" contracts/samples/safe/SimpleToken.sol tests/fixtures/false-claims/simpletoken-mint.json --negative-control
