import type { Issue, MatchResult } from "../audit/types.js";
import type { Scores } from "../audit/compare.js";
import type { Finding } from "../llm/schemas.js";
import type { GenTestsSummary } from "../testgen/generator.js";

export interface RunInfo {
  command: string;
  model: string;
  costUsd: number;
  tokens: { input: number; output: number };
  seconds: number;
  budgetStopped?: boolean;
}

export interface AuditSummary {
  contract: string;
  findings: Finding[];
  slither: { issues: Issue[]; skipped: boolean; error?: string };
  comparison: MatchResult | null;
  /** Present when the contract is in ground-truth.yaml. */
  truth: { issues: Issue[]; llm: Scores; slither: Scores | null; llmMatch: MatchResult } | null;
}

const pct = (n: number | null) => (n === null ? "n/a" : `${n}%`);
const frac = (n: number | null) => (n === null ? "n/a" : n.toFixed(2));
const loc = (i: Issue) => `${i.function || "?"} (${i.startLine}-${i.endLine})`;

/** report.md (spec section 10). Sections appear only for the parts that ran. */
export function renderReport(run: RunInfo, tests: GenTestsSummary | null, audit: AuditSummary | null = null): string {
  const lines: string[] = [
    `# Report: ${tests?.contract ?? audit?.contract ?? "run"}`,
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
  if (audit) {
    lines.push("", "## 3. Findings (Gemini)");
    if (audit.findings.length === 0) lines.push("No findings.");
    else {
      lines.push("| ID | Severity | Category | Function | Lines | Confidence | Title |", "|---|---|---|---|---|---|---|");
      for (const f of audit.findings) {
        lines.push(`| ${f.id} | ${f.severity} | ${f.category} | ${f.location.function} | ${f.location.startLine}-${f.location.endLine} | ${f.confidence} | ${f.title} |`);
      }
    }
    lines.push("", "## 4. Comparison with Slither");
    if (audit.slither.skipped) lines.push("Slither was skipped (--no-slither).");
    else if (audit.slither.error) lines.push(`Slither failed: ${audit.slither.error}`);
    else if (audit.comparison) {
      const c = audit.comparison;
      lines.push(
        `- Found by both: ${c.matched.length}`,
        `- Gemini only: ${c.aOnly.length}${c.aOnly.length ? " (" + c.aOnly.map((i) => `${i.category} in ${loc(i)}`).join("; ") + ")" : ""}`,
        `- Slither only: ${c.bOnly.length}${c.bOnly.length ? " (" + c.bOnly.map((i) => `${i.ref}: ${i.category} in ${loc(i)}`).join("; ") + ")" : ""}`,
        `- Informational items ignored: ${c.ignoredInfo}`,
      );
    }
    if (audit.truth) {
      const t = audit.truth;
      lines.push(
        "",
        "## Ground truth",
        `- Expected: ${t.issues.length ? t.issues.map((i) => `${i.category} in ${loc(i)}`).join("; ") : "no vulnerabilities"}`,
        `- Gemini: TP ${t.llm.tp}, FP ${t.llm.fp}, FN ${t.llm.fn} (precision ${frac(t.llm.precision)}, recall ${frac(t.llm.recall)})`,
      );
      if (t.slither) lines.push(`- Slither: TP ${t.slither.tp}, FP ${t.slither.fp}, FN ${t.slither.fn} (precision ${frac(t.slither.precision)}, recall ${frac(t.slither.recall)})`);
    }
  }
  return lines.join("\n") + "\n";
}
