// Offline: re-read the CURRENT ground truth into saved bench.json files and re-render evaluation.md. No LLM calls.
// Usage: npx tsx scripts/rescore-bench.ts reports/m5/bench-<date> [more bench folders]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadGroundTruth, truthFor, DEFAULT_GROUND_TRUTH } from "../src/eval/groundTruth.js";
import { renderEvaluation, type BenchResult } from "../src/report/evaluation.js";
import { REPO_ROOT } from "../src/util.js";

const gt = loadGroundTruth(path.join(REPO_ROOT, DEFAULT_GROUND_TRUTH));
for (const d of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(path.join(d, "bench.json"), "utf8")) as BenchResult;
  for (const row of r.rows) row.expected = truthFor(gt, path.join(REPO_ROOT, "contracts/samples", row.file));
  writeFileSync(path.join(d, "bench.json"), JSON.stringify(r, null, 2));
  writeFileSync(path.join(d, "evaluation.md"), renderEvaluation(r));
}
