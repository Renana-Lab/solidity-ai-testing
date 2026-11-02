import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import type { PocResult } from "../audit/poc.js";
import type { Issue } from "../audit/types.js";
import { loadConfig } from "../config.js";
import type { ContractRow } from "../eval/evaluator.js";
import { checkForgeAvailable } from "../foundry/preflight.js";
import type { GenTestsSummary } from "../testgen/generator.js";
import { renderComparison, renderEvaluation, type BenchResult } from "../report/evaluation.js";
import { REPO_ROOT } from "../util.js";
import { audit } from "./audit.js";
import { genTests } from "./genTests.js";

export interface BenchFlags {
  dir: string;
  only: "vulnerable" | "safe" | "all";
  repeat: number;
  model?: string;
  flash?: boolean;
  pro?: boolean;
  out: string;
  /** Cap for ONE contract (tests + audit + PoC + repeats). */
  maxCost?: number;
  /** Cap for the whole bench. */
  maxTotalCost?: number;
  skipTests?: boolean;
}

export interface Discovered {
  abs: string;
  /** Path inside the samples folder, e.g. "vulnerable/ReentrancyVault.sol". */
  rel: string;
  kind: ContractRow["kind"];
}

/** All .sol files under the folder, sorted, filtered by --only. Other folders count as kind "other". */
export function discoverContracts(dir: string, only: BenchFlags["only"]): Discovered[] {
  const found: Discovered[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const abs = path.join(d, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith(".sol")) {
        const rel = path.relative(dir, abs).replace(/\\/g, "/");
        const kind = rel.startsWith("vulnerable/") ? "vulnerable" : rel.startsWith("safe/") ? "safe" : "other";
        found.push({ abs, rel, kind });
      }
    }
  };
  walk(dir);
  return found.filter((c) => only === "all" || c.kind === only);
}

const readJson = <T>(file: string): T | null => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null);

/** Each step writes into its own empty folder, so its single run folder is the only entry. */
function runDirOf(stepDir: string): string | null {
  if (!existsSync(stepDir)) return null;
  const first = readdirSync(stepDir).sort()[0];
  return first ? path.join(stepDir, first) : null;
}

interface RunFiles {
  costUsd: number;
  tokens: number;
  seconds: number;
  error: string | null;
  calls: number;
  retries: number;
}

function readRun(runDir: string | null): RunFiles | null {
  if (!runDir) return null;
  const r = readJson<{ costUsd: number; tokens: { input: number; output: number }; seconds: number; error: string | null }>(path.join(runDir, "run.json"));
  if (!r) return null;
  const log = path.join(runDir, "llm-calls.jsonl");
  const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { retries?: number }) : [];
  return {
    costUsd: r.costUsd,
    tokens: r.tokens.input + r.tokens.output,
    seconds: r.seconds,
    error: r.error,
    calls: lines.length,
    retries: lines.reduce((a, l) => a + (l.retries ?? 0), 0),
  };
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** `sat bench`. Returns the process exit code (spec section 7). */
export async function bench(flags: BenchFlags): Promise<number> {
  const cfg = loadConfig();
  if (flags.flash && flags.pro) {
    console.error("Use either --flash or --pro, not both.");
    return 1;
  }
  const model = flags.model ?? (flags.pro ? cfg.proModel : flags.flash ? cfg.flashModel : cfg.model);
  const perContract = flags.maxCost ?? 0.1;
  const maxTotal = flags.maxTotalCost ?? 1;
  const dir = path.resolve(flags.dir);
  if (!existsSync(dir)) {
    console.error(`Folder not found: ${dir}`);
    return 1;
  }
  const contracts = discoverContracts(dir, flags.only);
  if (contracts.length === 0) {
    console.error(`No .sol files found in ${dir} for --only ${flags.only}.`);
    return 1;
  }
  try {
    await checkForgeAvailable();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }

  const benchDir = path.resolve(flags.out, `bench-${stamp()}`);
  mkdirSync(benchDir, { recursive: true });
  let sha: string | null = null;
  try {
    sha = (await execa("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT })).stdout.trim();
  } catch {
    // not a git checkout: leave it out of the report
  }
  const result: BenchResult = {
    model,
    startedAt: new Date().toISOString(),
    gitSha: sha,
    repeat: flags.repeat,
    maxCostPerContract: perContract,
    maxTotalCost: maxTotal,
    budgetStopped: false,
    rows: [],
  };
  // Saved after every contract, so a crash or a cost stop still leaves a partial report.
  const save = () => {
    writeFileSync(path.join(benchDir, "bench.json"), JSON.stringify(result, null, 2));
    writeFileSync(path.join(benchDir, "evaluation.md"), renderEvaluation(result));
  };
  console.log(`Bench: ${contracts.length} contracts | model ${model} | cap $${perContract.toFixed(2)} per contract, $${maxTotal.toFixed(2)} total | output ${benchDir}`);

  const modelFlags = { model: flags.model, flash: flags.flash, pro: flags.pro };
  let total = 0;
  let exitCode = 0;

  for (const [n, c] of contracts.entries()) {
    if (total >= maxTotal) {
      result.budgetStopped = true;
      exitCode = 3;
      break;
    }
    console.log(`\n[${n + 1}/${contracts.length}] ${c.rel}`);
    const cdir = path.join(benchDir, path.basename(c.abs, ".sol"));
    const row: ContractRow = { file: c.rel, kind: c.kind, expected: null, llmRuns: [], slither: null, poc: null, tests: null, costUsd: 0, tokens: 0, seconds: 0, calls: 0, retries: 0, note: null };
    const notes: string[] = [];
    const remaining = () => Math.max(perContract - row.costUsd, 0);
    /** Add the cost of a finished step and note anything that went wrong. */
    const account = (what: string, r: RunFiles | null, code: number) => {
      if (r) {
        row.costUsd += r.costUsd;
        row.tokens += r.tokens;
        row.seconds += r.seconds;
        row.calls += r.calls;
        row.retries += r.retries;
        total += r.costUsd;
      }
      if (code === 3) notes.push(`${what} hit the cost cap`);
      else if (code !== 0) notes.push(`${what} failed (exit ${code}${r?.error ? `: ${r.error.slice(0, 120)}` : ""})`);
      if (code === 2) exitCode = 2;
    };

    if (!flags.skipTests) {
      const out = path.join(cdir, "tests");
      const code = await genTests(c.abs, { out, minCoverage: 80, maxCost: remaining(), ...modelFlags });
      const runDir = runDirOf(out);
      account("gen-tests", readRun(runDir), code);
      row.tests = readJson<GenTestsSummary>(path.join(runDir ?? "", "gen-tests", "summary.json"));
    }

    for (let i = 1; i <= flags.repeat && exitCode !== 2; i++) {
      if (remaining() < 0.005) {
        notes.push(`audit run ${i} skipped: per-contract cap used up`);
        break;
      }
      const out = path.join(cdir, `audit-${i}`);
      // Exploit tests only on the first run: the repeats are about how stable the findings are.
      const code = await audit(c.abs, { out, slither: true, blind: true, poc: i === 1, maxCost: remaining(), ...modelFlags });
      const runDir = runDirOf(out);
      account(`audit run ${i}`, readRun(runDir), code);
      const files = path.join(runDir ?? "", "audit");
      const issues = readJson<{ llm: Issue[]; slither: Issue[] | null; truth: Issue[] | null }>(path.join(files, "issues.json"));
      if (!issues) continue;
      row.llmRuns.push(issues.llm);
      if (i === 1) {
        row.slither = issues.slither;
        row.expected = issues.truth;
        const pocDir = path.join(files, "poc");
        row.poc = existsSync(pocDir)
          ? readdirSync(pocDir)
              .filter((f) => f.endsWith(".result.json"))
              .map((f) => readJson<PocResult>(path.join(pocDir, f))!)
          : [];
      }
    }
    row.note = notes.length ? notes.join("; ") : null;
    result.rows.push(row);
    save();
    if (exitCode === 2) break;
  }

  save();
  console.log(`\nBench done: total cost $${total.toFixed(4)}${result.budgetStopped ? " (stopped at the total cap, partial result)" : ""}`);
  console.log(`Evaluation: ${path.join(benchDir, "evaluation.md")}`);
  return exitCode;
}

/** `sat compare <benchA> <benchB>`: side-by-side of two bench folders. */
export function compare(a: string, b: string, out: string): number {
  const read = (d: string) => readJson<BenchResult>(path.join(path.resolve(d), "bench.json"));
  const x = read(a);
  const y = read(b);
  if (!x || !y) {
    console.error("Both folders must contain a bench.json (made by `sat bench`).");
    return 1;
  }
  mkdirSync(path.resolve(out), { recursive: true });
  const file = path.join(path.resolve(out), `compare-${stamp()}.md`);
  writeFileSync(file, renderComparison(x, y));
  console.log(`Comparison: ${file}`);
  return 0;
}
