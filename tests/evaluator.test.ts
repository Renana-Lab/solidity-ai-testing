import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverContracts } from "../src/cli/bench.js";
import type { Issue } from "../src/audit/types.js";
import { aggregate, pool, scoreRow, stability, unionIssues, type ContractRow } from "../src/eval/evaluator.js";
import { renderComparison, renderEvaluation, type BenchResult } from "../src/report/evaluation.js";
import { REPO_ROOT } from "../src/util.js";

const issue = (o: Partial<Issue>): Issue => ({ origin: "llm", category: "reentrancy", severity: "high", function: "withdraw", startLine: 10, endLine: 20, title: "t", ...o });

const row = (o: Partial<ContractRow> = {}): ContractRow => ({
  file: "vulnerable/A.sol",
  kind: "vulnerable",
  expected: [issue({ origin: "truth" })],
  llmRuns: [[issue({})]],
  slither: [],
  poc: [],
  tests: null,
  costUsd: 0.01,
  tokens: 1000,
  seconds: 10,
  calls: 2,
  retries: 0,
  note: null,
  ...o,
});

describe("scoring", () => {
  it("scores Gemini, Slither and the union separately", () => {
    const r = row({ slither: [issue({ origin: "slither", category: "access-control", function: "owner", startLine: 40, endLine: 42 })] });
    const s = scoreRow(r)!;
    expect(s.gemini).toMatchObject({ tp: 1, fp: 0, fn: 0 });
    expect(s.slither).toMatchObject({ tp: 0, fp: 1, fn: 1 });
    expect(s.union).toMatchObject({ tp: 1, fp: 1, fn: 0 }); // the Slither extra is a false positive
  });
  it("does not score a contract without ground truth", () => {
    expect(scoreRow(row({ expected: null }))).toBeNull();
  });
  it("union does not count an issue twice when both tools report it", () => {
    const g = [issue({})];
    const sl = [issue({ origin: "slither" })];
    expect(unionIssues(g, sl)).toHaveLength(1);
  });
  it("pools by adding TP/FP/FN, not by averaging ratios", () => {
    const p = pool([
      { tp: 1, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1 },
      { tp: 0, fp: 3, fn: 1, precision: 0, recall: 0, f1: null },
    ]);
    expect(p).toMatchObject({ tp: 1, fp: 3, fn: 1, precision: 0.25, recall: 0.5 });
  });
});

describe("aggregate", () => {
  it("counts PoC confirmations and false passes on safe contracts", () => {
    const confirmed = { findingId: "F-001", severity: "high", status: "confirmed", repairsUsed: 0, testFile: "", explanation: "", detail: null, passed: 1, failed: 0 } as const;
    const a = aggregate([
      row({ poc: [confirmed, { ...confirmed, findingId: "F-002", status: "unconfirmed" }] }),
      row({ file: "safe/B.sol", kind: "safe", expected: [], llmRuns: [[]], poc: [{ ...confirmed }] }),
    ]);
    expect(a.poc).toEqual({ vulnerableTried: 2, vulnerableConfirmed: 1, safeTried: 1, safePassed: 1 });
  });
  it("sums cost, calls and retries", () => {
    const a = aggregate([row({ costUsd: 0.02, retries: 1 }), row({ costUsd: 0.03, calls: 3 })]);
    expect(a.costUsd).toBeCloseTo(0.05);
    expect(a.calls).toBe(5);
    expect(a.retries).toBe(1);
  });
});

describe("stability", () => {
  it("is null with one run", () => expect(stability([[issue({})]])).toBeNull());
  it("counts findings of run 1 that every other run also reports", () => {
    const a = issue({});
    const b = issue({ category: "access-control", function: "reset", startLine: 30, endLine: 35 });
    expect(stability([[a, b], [a], [a, b]])).toEqual({ recurring: 1, total: 2 });
  });
});

describe("reports and discovery", () => {
  const bench: BenchResult = { model: "m", startedAt: "now", gitSha: null, repeat: 1, maxCostPerContract: 0.1, maxTotalCost: 1, budgetStopped: true, rows: [row()] };
  it("renders evaluation.md with the three scores and a partial-result warning", () => {
    const md = renderEvaluation(bench);
    expect(md).toMatch(/\| Gemini \| 1\/0\/0/);
    expect(md).toMatch(/\| Union \|/);
    expect(md).toMatch(/Partial result/);
    expect(md).toMatch(/vulnerable\/A\.sol/);
  });
  it("renders a comparison table", () => {
    expect(renderComparison(bench, { ...bench, model: "n" })).toMatch(/\| \| m \| n \|/);
  });
  it("finds the 9 sample contracts and filters by kind", () => {
    const dir = path.join(REPO_ROOT, "contracts/samples");
    expect(discoverContracts(dir, "all")).toHaveLength(9);
    expect(discoverContracts(dir, "safe").map((c) => c.rel)).toEqual(["safe/SafeVault.sol", "safe/SimpleToken.sol"]);
  });
});
