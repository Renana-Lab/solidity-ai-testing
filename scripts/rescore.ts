// Offline re-score of saved `sat audit` runs against the CURRENT ground truth. No LLM calls.
// Usage: npx tsx scripts/rescore.ts reports/m3-run
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { findingsToIssues } from "../src/audit/auditor.js";
import { score } from "../src/audit/compare.js";
import { loadGroundTruth, truthFor } from "../src/eval/groundTruth.js";
import { parseSlitherJson } from "../src/slither/runner.js";
import { REPO_ROOT } from "../src/util.js";

const runs = path.resolve(process.argv[2] ?? "reports/m3-run");
const gt = loadGroundTruth(path.join(REPO_ROOT, "contracts/samples/ground-truth.yaml"));
const tot = { gemini: { tp: 0, fp: 0, fn: 0 }, slither: { tp: 0, fp: 0, fn: 0 } };

for (const dir of readdirSync(runs).sort()) {
  const name = dir.replace(/^\d+-\d+-/, "").replace(/-audit$/, "");
  const file = ["vulnerable", "safe"].map((s) => path.join(REPO_ROOT, "contracts/samples", s, `${name}.sol`)).find(existsSync);
  const truth = file ? truthFor(gt, file) : null;
  if (!truth) continue;
  const llm = findingsToIssues(JSON.parse(readFileSync(path.join(runs, dir, "audit/llm-findings.json"), "utf8")).findings);
  const slPath = path.join(runs, dir, "audit/slither.json");
  const sl = existsSync(slPath) ? parseSlitherJson(readFileSync(slPath, "utf8")) : [];
  const a = score(llm, truth);
  const b = score(sl, truth);
  for (const k of ["tp", "fp", "fn"] as const) {
    tot.gemini[k] += a[k];
    tot.slither[k] += b[k];
  }
  console.log(`${name.padEnd(18)} gemini TP${a.tp}/FP${a.fp}/FN${a.fn}   slither TP${b.tp}/FP${b.fp}/FN${b.fn}`);
}
const fmt = (t: { tp: number; fp: number; fn: number }) =>
  `TP ${t.tp} FP ${t.fp} FN ${t.fn} | precision ${(t.tp / (t.tp + t.fp)).toFixed(2)} recall ${(t.tp / (t.tp + t.fn)).toFixed(2)}`;
console.log("GEMINI  ", fmt(tot.gemini));
console.log("SLITHER ", fmt(tot.slither));
