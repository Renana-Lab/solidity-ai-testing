import type { GenTestsSummary } from "../testgen/generator.js";

export interface RunInfo {
  command: string;
  model: string;
  costUsd: number;
  tokens: { input: number; output: number };
  seconds: number;
  budgetStopped?: boolean;
}

const pct = (n: number | null) => (n === null ? "n/a" : `${n}%`);

/** report.md (spec section 10). Only the test section exists until the audit milestone. */
export function renderReport(run: RunInfo, tests: GenTestsSummary | null): string {
  const lines: string[] = [
    `# Report: ${tests?.contract ?? "run"}`,
    "",
    "## 1. Summary",
    `- Command: \`${run.command}\``,
    `- Model: ${run.model}`,
    `- Cost: $${run.costUsd.toFixed(4)} (${run.tokens.input} in / ${run.tokens.output} out tokens)`,
    `- Time: ${run.seconds.toFixed(1)}s`,
  ];
  if (run.budgetStopped) lines.push("- **Stopped early: cost cap reached. This report is partial.**");
  if (tests) {
    lines.push(
      "",
      "## 2. Tests",
      `- Test file: \`${tests.testFile}\``,
      `- Compiled on first try: ${tests.compiledFirstTry ? "yes" : "no"}`,
      `- Final: ${tests.passed} passed, ${tests.failed} failed (pass rate ${pct(tests.passRate)})`,
      `- Line coverage: ${pct(tests.lineCoverage)}, branch coverage: ${pct(tests.branchCoverage)}`,
      `- Repairs used: ${tests.repairsUsed}`,
      `- Uncovered functions: ${tests.uncoveredFunctions.length ? tests.uncoveredFunctions.join(", ") : "none"}`,
      "",
      "| Attempt | Status | Passed | Failed |",
      "|---|---|---|---|",
      ...tests.attempts.map((a) => `| ${a.attempt} | ${a.status} | ${a.passed} | ${a.failed} |`),
      "",
      "## 5. Behavior notes from the repair loop",
      ...(tests.behaviorNotes.length ? tests.behaviorNotes.map((n) => `- ${n}`) : ["- none"]),
    );
  }
  return lines.join("\n") + "\n";
}
