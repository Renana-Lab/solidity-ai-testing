import type { PocResult } from "../audit/poc.js";
import { isMatch, matchIssues, score, type Scores } from "../audit/compare.js";
import type { Issue } from "../audit/types.js";
import type { GenTestsSummary } from "../testgen/generator.js";

/** Everything measured for one contract in a bench run. */
export interface ContractRow {
  /** Path inside the samples folder, e.g. "vulnerable/ReentrancyVault.sol". */
  file: string;
  kind: "vulnerable" | "safe" | "other";
  /** null when the contract is not in ground-truth.yaml (then it is not scored). */
  expected: Issue[] | null;
  /** Gemini issues of every repeat (the first one is the one that is scored). */
  llmRuns: Issue[][];
  /** Slither issues; null when Slither was skipped or failed. */
  slither: Issue[] | null;
  poc: PocResult[] | null;
  tests: GenTestsSummary | null;
  costUsd: number;
  tokens: number;
  seconds: number;
  calls: number;
  retries: number;
  /** Why this contract is incomplete (budget stop, API error, ...). */
  note: string | null;
}

/** The Gemini issues plus the Slither issues that Gemini did not already report. */
export function unionIssues(llm: Issue[], slither: Issue[]): Issue[] {
  const m = matchIssues(slither, llm);
  return [...llm, ...m.aOnly];
}

export interface RowScores {
  gemini: Scores;
  slither: Scores | null;
  union: Scores | null;
}

export function scoreRow(row: ContractRow): RowScores | null {
  if (!row.expected) return null;
  const llm = row.llmRuns[0] ?? [];
  return {
    gemini: score(llm, row.expected),
    slither: row.slither ? score(row.slither, row.expected) : null,
    union: row.slither ? score(unionIssues(llm, row.slither), row.expected) : null,
  };
}

/** Splits one contract's PoC results into "finding is in the ground truth" and "extra finding". */
export function pocSplit(row: ContractRow) {
  const out = { truthMediumPlus: 0, truthConfirmed: 0, extraTried: 0, extraConfirmed: 0 };
  if (!row.expected) return out;
  const isMediumPlus = (i: Issue) => i.severity !== "low" && i.severity !== "info";
  const matched = matchIssues(row.llmRuns[0] ?? [], row.expected).matched;
  const truthOf = new Map(matched.map((m) => [m.a.ref, m.b]));
  out.truthMediumPlus = row.expected.filter(isMediumPlus).length;
  for (const p of row.poc ?? []) {
    const t = truthOf.get(p.findingId);
    if (!t) {
      out.extraTried++;
      if (p.status === "confirmed") out.extraConfirmed++;
    } else if (isMediumPlus(t) && p.status === "confirmed") out.truthConfirmed++;
  }
  return out;
}

/** Add up TP/FP/FN over many contracts, then compute the ratios once (micro average). */
export function pool(list: Scores[]): Scores {
  const tp = list.reduce((a, s) => a + s.tp, 0);
  const fp = list.reduce((a, s) => a + s.fp, 0);
  const fn = list.reduce((a, s) => a + s.fn, 0);
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return { tp, fp, fn, precision, recall, f1 };
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Share of the first run's issues that every other run reports too (null with a single run). */
export function stability(runs: Issue[][]): { recurring: number; total: number } | null {
  if (runs.length < 2) return null;
  const first = runs[0]!.filter((i) => i.severity !== "info");
  const recurring = first.filter((i) => runs.slice(1).every((r) => r.some((o) => o.severity !== "info" && isMatch(i, o)))).length;
  return { recurring, total: first.length };
}

export interface Aggregate {
  contracts: number;
  scored: number;
  gemini: Scores;
  slither: Scores | null;
  union: Scores | null;
  poc: {
    /** high/critical findings on vulnerable contracts that got a PoC, and how many were confirmed. */
    vulnerableTried: number;
    vulnerableConfirmed: number;
    /** Ground-truth issues of medium severity or worse, and how many of them a passing PoC confirmed. */
    truthMediumPlus: number;
    truthConfirmed: number;
    /** PoCs on findings that are NOT in the ground truth (scored as false positives), and how many passed. */
    extraTried: number;
    extraConfirmed: number;
    /** PoCs that passed on a safe contract: must be 0. */
    safePassed: number;
    safeTried: number;
  };
  tests: {
    contracts: number;
    compiledFirstTry: number;
    meanPassRate: number | null;
    meanLineCoverage: number | null;
    meanBranchCoverage: number | null;
    meanRepairs: number | null;
  };
  costUsd: number;
  tokens: number;
  seconds: number;
  calls: number;
  retries: number;
  stability: { recurring: number; total: number } | null;
}

export function aggregate(rows: ContractRow[]): Aggregate {
  const scores = rows.map(scoreRow).filter((s): s is RowScores => s !== null);
  const sl = scores.map((s) => s.slither).filter((s): s is Scores => s !== null);
  const un = scores.map((s) => s.union).filter((s): s is Scores => s !== null);
  const tests = rows.map((r) => r.tests).filter((t): t is GenTestsSummary => t !== null);
  const num = (xs: Array<number | null>) => xs.filter((x): x is number => x !== null);

  const pocOf = (kind: ContractRow["kind"]) => rows.filter((r) => r.kind === kind).flatMap((r) => r.poc ?? []);
  const vuln = pocOf("vulnerable");
  const safe = pocOf("safe");
  const split = rows.filter((r) => r.kind === "vulnerable").map(pocSplit);
  const sum = (k: keyof ReturnType<typeof pocSplit>) => split.reduce((a, x) => a + x[k], 0);

  const stab = rows.map((r) => stability(r.llmRuns)).filter((s): s is { recurring: number; total: number } => s !== null);

  return {
    contracts: rows.length,
    scored: scores.length,
    gemini: pool(scores.map((s) => s.gemini)),
    slither: sl.length ? pool(sl) : null,
    union: un.length ? pool(un) : null,
    poc: {
      vulnerableTried: vuln.length,
      vulnerableConfirmed: vuln.filter((p) => p.status === "confirmed").length,
      truthMediumPlus: sum("truthMediumPlus"),
      truthConfirmed: sum("truthConfirmed"),
      extraTried: sum("extraTried"),
      extraConfirmed: sum("extraConfirmed"),
      safeTried: safe.length,
      safePassed: safe.filter((p) => p.status === "confirmed").length,
    },
    tests: {
      contracts: tests.length,
      compiledFirstTry: tests.filter((t) => t.compiledFirstTry).length,
      meanPassRate: mean(num(tests.map((t) => t.passRate))),
      meanLineCoverage: mean(num(tests.map((t) => t.lineCoverage))),
      meanBranchCoverage: mean(num(tests.map((t) => t.branchCoverage))),
      meanRepairs: mean(tests.map((t) => t.repairsUsed)),
    },
    costUsd: rows.reduce((a, r) => a + r.costUsd, 0),
    tokens: rows.reduce((a, r) => a + r.tokens, 0),
    seconds: rows.reduce((a, r) => a + r.seconds, 0),
    calls: rows.reduce((a, r) => a + r.calls, 0),
    retries: rows.reduce((a, r) => a + r.retries, 0),
    stability: stab.length ? { recurring: stab.reduce((a, s) => a + s.recurring, 0), total: stab.reduce((a, s) => a + s.total, 0) } : null,
  };
}
