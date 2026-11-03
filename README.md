# solidity-ai-testing (`sat`)

A command-line tool that uses Gemini to (1) write Foundry tests for a Solidity contract, (2) audit it for security problems and compare the result with Slither, and (3) try to prove each serious finding with an exploit test that really runs.

**For learning and research only.** The sample contracts in `contracts/samples/vulnerable/` are intentionally vulnerable. Do not deploy them, and do not treat this tool's output as a security audit.

## Requirements

- Node.js 20 or newer
- [Foundry](https://book.getfoundry.sh/) (`forge`)
- Python 3.10+ with [Slither](https://github.com/crytic/slither) and `solc-select` (`solc-select install 0.8.24 && solc-select use 0.8.24`)
- A Gemini API key. The free tier allows only about 20 requests per day per model, which is too little for a bench; enable billing for real runs.

```bash
npm install
forge install foundry-rs/forge-std   # only if lib/forge-std is missing
cp .env.example .env                 # then put your key in GEMINI_API_KEY
npx tsx src/cli/index.ts doctor      # checks forge, slither, solc, node and the key
```

`.env` is in `.gitignore`. The key is read only from `GEMINI_API_KEY` and is removed from error messages and logs.

## Quick start

Use `npm run sat -- <command>` (same as `sat` once built).

```bash
npm run sat -- doctor
npm run sat -- gen-tests contracts/samples/safe/SimpleToken.sol
npm run sat -- audit contracts/samples/vulnerable/ReentrancyVault.sol --poc
npm run sat -- full contracts/samples/vulnerable/ReentrancyVault.sol
npm run sat -- bench --flash
```

- `gen-tests`: Gemini writes a Foundry test, `forge test` runs it, failures are sent back for repair (at most 3 times). Reports pass rate and line/branch coverage.
- `audit`: Gemini returns structured findings; Slither runs next to it; the two are compared, and both are scored against `contracts/samples/ground-truth.yaml` when the contract is listed there. `--poc` writes an exploit test for each high/critical finding.
- `full`: `gen-tests`, then `audit --poc`.
- `bench`: runs both on every sample and writes `reports/bench-<date>/evaluation.md`. `--repeat 3` measures stability. `--only safe|vulnerable`.
- `compare <benchA> <benchB>`: side-by-side table of two bench folders (for example flash and `--pro`).

Useful flags: `--max-cost <usd>` (hard cost cap, exit code 3), `--dry-run` (save the prompts, no API call), `--mock <dir>` (answer from recorded JSON, no API call), `--verbose`, `--poc-from <llm-findings.json>` (re-run PoCs on saved findings with no new audit call), `--negative-control` (with `--poc-from`: the findings belong to another contract, so every PoC must fail).

Exit codes: `0` ok, `1` usage error, `2` tool missing (forge/slither), `3` cost cap reached, `4` API error after retries.

## What a run writes

Every run makes a folder `reports/<time>-<contract>-<command>/` with:

- `report.md`: the readable report;
- `run.json`: command, model, cost, tokens, time, flags, git commit;
- `llm-calls.jsonl`: one line per API call (tokens, thinking tokens, cost, latency, why it was retried);
- `audit/`: `llm-findings.json`, `issues.json`, `comparison.json`, `slither.json`, `poc/<id>.t.sol` and `<id>.result.json`;
- `gen-tests/`: every attempt, `forge-test.json`, `coverage.lcov`, `summary.json`.

`reports/` and `.work/` are not committed.

### How the audit is kept fair

- Comments are removed (line numbers stay) and the contract name is replaced by `Target` before the code is sent, so the model cannot read the answer from a comment or a file name (`--keep-comments`, `--no-blind` turn this off).
- A finding matches the ground truth when it has the same category and the same function, or at least 50% line overlap. `info` findings are ignored.
- A PoC is **confirmed** only if the exploit test compiles and every test in it passes on the vulnerable contract. A failing assertion is never "repaired" into a pass; only compile errors get up to 2 repairs.
- Generated Solidity runs only in a throwaway Foundry workspace on the local EVM, with `ffi = false` and no file permissions. Tests using `vm.ffi`, forks, file cheatcodes, `vm.store`, `vm.etch` or `vm.mockCall` are rejected before they run, and each run has a time limit.

## Latest benchmark

Model `gemini-3.6-flash`, 9 sample contracts (7 vulnerable, 2 safe), 3 audit runs per contract, commit `c35861e`. Full table: `evaluation.md` of the bench folder.

| | TP/FP/FN | Precision | Recall | F1 |
|---|---|---|---|---|
| Gemini | 8/1/0 | 0.89 | 1.00 | 0.94 |
| Slither | 5/3/3 | 0.63 | 0.63 | 0.63 |
| Gemini + Slither | 8/4/0 | 0.67 | 1.00 | 0.80 |

- PoC: 6 of the 7 ground-truth issues of medium severity or worse (4 high, 3 medium; the model rated all of them high, so all got a PoC) were confirmed. The seventh (ReentrancyVault) did run, but the model's expected amount in the assertion was wrong (12 ETH instead of 11), so it stays "unconfirmed". In an earlier run the same finding was confirmed.
- PoC on the safe contracts: 0 passed (and 0 findings to try). Two negative controls (a real exploit pointed at `SafeVault`, a made-up claim against `SimpleToken`) both failed, as they should.
- Generated tests: compiled on the first try 8/9, mean pass rate 100%, mean line coverage 100%, branch coverage 100%, 0.33 repairs on average.
- Stability: 7 of 9 first-run findings appeared in all 3 runs.
- Cost: $0.37 for the whole bench (130,908 tokens, 46 calls, 0 retries, about 11 minutes).

Read these numbers with care: there are only 9 tiny contracts, the ground truth is written by hand, the model's pre-training may include well-known examples such as reentrancy, and one run is one sample.

## Pro vs flash

`gemini-4-argon` (`--pro`) against `gemini-3.6-flash`, same 9 contracts, same blind audit and ground truth. Scores use the **first** audit run of each contract. Pro ran with `--repeat 1` and a cap of $0.20 per contract; flash is the 3-run bench above.

| | flash (`gemini-3.6-flash`) | pro (`gemini-4-argon`) |
|---|---|---|
| Gemini TP/FP/FN | 8/1/0 | 8/4/0 |
| Precision / recall / F1 | 0.89 / 1.00 / 0.94 | 0.67 / 1.00 / 0.80 |
| Gemini + Slither F1 | 0.80 | 0.70 |
| PoC confirmed, ground-truth issues of medium severity or worse | 6 of 7 | 6 of 7 (ReentrancyVault did not finish, see below) |
| PoC passed on extra findings (scored as false positives) | 0 of 0 | 2 of 2 (see below) |
| PoC passed on safe contracts | 0 | 0 |
| Tests: compiled first try / mean pass rate / line coverage | 8 of 9 / 100% / 100% | 8 of 9 / 100% / 100% |
| Cost, whole bench | $0.373 (3 audit runs per contract) | $0.672 (1 run per contract) |
| Cost for tests + 1 audit run per contract | about $0.20 | $0.672 (about 3.3x) |
| Time | 683 s | 1004 s |
| API calls (retries) | 46 (0) | 33 (0) |

What this shows, with care: both models found every planted vulnerability (recall 1.00). Pro reported more extra findings that are not in the ground truth (4 false positives against 1), so its precision is lower here. Both models had the same PoC result on the ground truth: 6 of 7 confirmed. Pro costs about 3x more for this work.

**The sample is small: 9 contracts, one run each for pro.** A difference of one or two findings is within the run-to-run noise (flash itself lost 2 of 9 findings between repeats). Treat every difference above as indicative only, not as a ranking of the models. Some of pro's "false positives" may be real but minor issues that the hand-written ground truth does not list.

**What the pro PoC number means.** An earlier version of this table said "8 of 8". That counted every pro finding that got a PoC: 6 are ground-truth issues, and 2 are extra findings that were scored as false positives. The ReentrancyVault finding (critical) had no finished PoC. So the right figure for the ground truth is 6 of 7, the same as flash.

**Two pro false positives have a passing PoC**, so they deserve a look before trusting the precision number:

- `TimestampLottery` F-002, "missing access control on `pickWinner`". Its PoC lets an attacker choose the timestamp so that their own ticket wins. That is the known timestamp issue (already a true positive), under a wrong label. `pickWinner()` being public is how this sample works. Probably not a new issue.
- `UncheckedMath` F-002, "unrestricted minting in `earn`". Its PoC shows that anyone can call `earn(1_000_000 ether)` and then move those points. This is true behaviour of the sample, but the contract has no owner or other notion of who may earn points, so it is a design shortcut of the teaching example rather than the planted bug. Whether the ground truth should list it is your call; `ground-truth.yaml` was not changed.

The other two pro false positives (`UnboundedRefund` and `UnprotectedReset`, both medium) were below the PoC threshold and have no PoC.

On pro's `ReentrancyVault` run, the audit found the right issue, but the PoC step stopped when the model returned cut-off JSON during its second repair. That PoC is counted neither as confirmed nor as failed, and the contract was scored offline from the saved findings. Since then `issues.json` is written before the PoC step, so a PoC failure can no longer drop a contract from the scores.

### PoC flakiness

Exploit tests come from the model, so they vary from run to run. The `ReentrancyVault` PoC was **confirmed** in the M4 run but **unconfirmed** in the M5 flash run: the attack worked, but the model wrote the wrong expected amount in its assertion (12 ETH instead of 11). By design a failing assertion is never "repaired" into a pass, so the finding stays unconfirmed. Read "unconfirmed" as "not proven by this attempt", not as "false alarm", and "confirmed" as evidence from one compiled and passing test.

## Costs

Prices are in `config/pricing.yaml` (per million tokens). Thinking tokens are billed as output. Defaults: `--max-cost 1.00` per run, `bench --max-cost 0.10` per contract and `--max-total-cost 1.00` for the whole bench; when a cap is reached the run stops and still writes a partial report.

## Repository layout

```
src/cli/        commands: doctor, gen-tests, audit, full, bench, compare
src/llm/        GeminiClient (retries, rate limit, cost cap), schemas, pricing
src/foundry/    forge runner, output parsing, safety checks, preflight
src/testgen/    test generation and repair loop
src/audit/      auditor, comparator, PoC confirmer
src/slither/    Slither runner and category mapping
src/eval/       ground truth, evaluator (precision/recall/F1, stability)
src/report/     markdown reports and evaluation.md
prompts/        every prompt, as Markdown
contracts/      practice/ (hand-written), samples/vulnerable, samples/safe, ground-truth.yaml
test/           hand-written Foundry tests for contracts/practice
tests/          vitest tests of the tool (recorded fixtures, no real API calls)
config/         default.yaml, pricing.yaml
```

## Development

```bash
npm run lint && npm run typecheck && npm test && forge test
```

Unit tests never call the real API: they use recorded fixtures in `tests/fixtures/` and a fake transport. Some tests start the real `forge` and `slither`. `sat full ... --mock tests/fixtures/reentrancy` runs the whole pipeline offline.

## Known limitations

- Only single-file contracts with a `pragma` that solc 0.8.24 accepts; no imports from other packages.
- Findings are matched by category and location; unusual but correct findings may count as false positives.
- Gemini answers vary from run to run (see "PoC flakiness"); one bench is one sample.
- Gemini model names and prices change often; check `config/pricing.yaml` before a large run.

## Credit

Prof. Renana Peres' lab, The Hebrew University of Jerusalem.
