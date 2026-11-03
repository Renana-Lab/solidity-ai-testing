import type { Scores } from "../audit/compare.js";
import { aggregate, scoreRow, type Aggregate, type ContractRow } from "../eval/evaluator.js";

/** What a bench run saves in bench.json, and what evaluation.md is built from. */
export interface BenchResult {
  model: string;
  startedAt: string;
  gitSha: string | null;
  repeat: number;
  /** Cost cap per contract and for the whole bench. */
  maxCostPerContract: number;
  maxTotalCost: number;
  budgetStopped: boolean;
  rows: ContractRow[];
}

const f2 = (n: number | null) => (n === null ? "n/a" : n.toFixed(2));
const p1 = (n: number | null) => (n === null ? "n/a" : `${n.toFixed(1)}%`);
const usd = (n: number) => `$${n.toFixed(4)}`;

export function renderEvaluation(b: BenchResult): string {
  const a = aggregate(b.rows);
  const L: string[] = [
    "# Evaluation",
    "",
    `Educational use only. Model: **${b.model}** | contracts: ${a.contracts} | repeats: ${b.repeat} | started ${b.startedAt}${b.gitSha ? ` | commit ${b.gitSha}` : ""}`,
    "",
  ];
  if (b.budgetStopped) L.push(`> **Partial result:** the bench stopped at its cost cap ($${b.maxTotalCost.toFixed(2)}). Contracts after the stop are missing.`, "");

  L.push(
    "## 1. Summary",
    "",
    "Scores are TP/FP/FN against `ground-truth.yaml`, pooled over all contracts that are listed there. \"Union\" means Gemini plus the Slither issues Gemini did not report.",
    "",
    "| | TP/FP/FN | Precision | Recall | F1 |",
    "|---|---|---|---|---|",
    ...(
      [
        ["Gemini", a.gemini],
        ["Slither", a.slither],
        ["Union", a.union],
      ] as Array<[string, Scores | null]>
    ).map(([n, s]) => `| ${n} | ${s ? `${s.tp}/${s.fp}/${s.fn}` : "n/a"} | ${f2(s?.precision ?? null)} | ${f2(s?.recall ?? null)} | ${f2(s?.f1 ?? null)} |`),
    "",
    `- PoC confirmation of the ground truth: **${a.poc.truthConfirmed} of ${a.poc.truthMediumPlus}** ground-truth issues of medium severity or worse were confirmed by a passing exploit test.`,
    `- PoC on extra findings (not in the ground truth, scored as false positives): ${a.poc.extraConfirmed} of ${a.poc.extraTried} passed. Read these PoCs: each is either a mislabelled known issue or a real issue the ground truth lacks.`,
    `- PoC on safe contracts: **${a.poc.safePassed}** passed by mistake (${a.poc.safeTried} tried; must be 0).`,
    `- Generated tests (${a.tests.contracts} contracts): compiled on the first try ${a.tests.compiledFirstTry}/${a.tests.contracts}, mean pass rate ${p1(a.tests.meanPassRate)}, mean line coverage ${p1(a.tests.meanLineCoverage)}, mean branch coverage ${p1(a.tests.meanBranchCoverage)}, mean repairs ${f2(a.tests.meanRepairs)}.`,
    ...(a.stability ? [`- Stability over ${b.repeat} runs: ${a.stability.recurring} of ${a.stability.total} findings of the first run appeared in every run.`] : []),
    `- Cost: **${usd(a.costUsd)}** total, ${a.tokens} tokens, ${a.calls} API calls (${a.retries} retries), ${a.seconds.toFixed(0)} s.`,
    "",
    "## 2. Per contract",
    "",
    "| Contract | Expected | Gemini TP/FP/FN | Slither TP/FP/FN | Union TP/FP/FN | PoC confirmed | Tests (pass / line cov / repairs) | Cost | Time |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const r of b.rows) {
    const s = scoreRow(r);
    const t = (x: Scores | null | undefined) => (x ? `${x.tp}/${x.fp}/${x.fn}` : "n/a");
    const poc = r.poc ? `${r.poc.filter((p) => p.status === "confirmed").length}/${r.poc.length}` : "-";
    const tests = r.tests ? `${p1(r.tests.passRate)} / ${p1(r.tests.lineCoverage)} / ${r.tests.repairsUsed}` : "-";
    L.push(`| ${r.file} | ${r.expected ? r.expected.length : "?"} | ${t(s?.gemini)} | ${t(s?.slither)} | ${t(s?.union)} | ${poc} | ${tests} | ${usd(r.costUsd)} | ${r.seconds.toFixed(0)} s |`);
  }
  const notes = b.rows.filter((r) => r.note);
  if (notes.length) L.push("", "## 3. Notes", ...notes.map((r) => `- ${r.file}: ${r.note}`));
  L.push(
    "",
    "## How to read this",
    "- A finding counts as a match when the category is the same and the function is the same or the line ranges overlap by at least half. `info` findings are ignored.",
    "- Ground truth was written by hand for 9 small teaching contracts. High scores here do not predict results on real projects.",
    "- A PoC \"confirmed\" means the exploit test compiled and passed on the vulnerable contract. It is evidence, not a proof of the whole finding.",
  );
  return L.join("\n") + "\n";
}

/** Side-by-side of two bench runs (for example flash and pro). */
export function renderComparison(x: BenchResult, y: BenchResult): string {
  const ax: Aggregate = aggregate(x.rows);
  const ay: Aggregate = aggregate(y.rows);
  const line = (name: string, f: (a: Aggregate) => string) => `| ${name} | ${f(ax)} | ${f(ay)} |`;
  return [
    `# ${x.model} vs ${y.model}`,
    "",
    `| | ${x.model} | ${y.model} |`,
    "|---|---|---|",
    line("Gemini precision / recall / F1", (a) => `${f2(a.gemini.precision)} / ${f2(a.gemini.recall)} / ${f2(a.gemini.f1)}`),
    line("Gemini TP/FP/FN", (a) => `${a.gemini.tp}/${a.gemini.fp}/${a.gemini.fn}`),
    line("Union F1", (a) => f2(a.union?.f1 ?? null)),
    line("PoC confirmed, ground-truth issues (medium+)", (a) => `${a.poc.truthConfirmed}/${a.poc.truthMediumPlus}`),
    line("PoC passed on extra findings (FP)", (a) => `${a.poc.extraConfirmed}/${a.poc.extraTried}`),
    line("PoC passed on safe (must be 0)", (a) => String(a.poc.safePassed)),
    line("Tests: mean pass rate", (a) => p1(a.tests.meanPassRate)),
    line("Tests: mean line coverage", (a) => p1(a.tests.meanLineCoverage)),
    line("Tests: compiled first try", (a) => `${a.tests.compiledFirstTry}/${a.tests.contracts}`),
    line("Cost", (a) => usd(a.costUsd)),
    line("Time", (a) => `${a.seconds.toFixed(0)} s`),
    line("API calls (retries)", (a) => `${a.calls} (${a.retries})`),
    "",
    `Cost ratio: ${ax.costUsd > 0 ? (ay.costUsd / ax.costUsd).toFixed(1) : "n/a"}x. Same 9 teaching contracts, one run each unless the bench says otherwise; differences of one finding are noise.`,
    "",
  ].join("\n");
}
