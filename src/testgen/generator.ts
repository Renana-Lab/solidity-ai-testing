import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LoadedContract } from "../contract.js";
import type { ForgeLike } from "../foundry/runner.js";
import type { TestOutcome } from "../foundry/parse.js";
import { findUnsafeCode } from "../foundry/safety.js";
import { percent } from "../foundry/parse.js";
import { GenTestsOutput, RepairOutput } from "../llm/schemas.js";
import type { LlmClient } from "../llm/client.js";
import { truncateMiddle } from "../util.js";

export interface AttemptRecord {
  attempt: number;
  status: "ok" | "compile_error" | "unsafe";
  passed: number;
  failed: number;
}

export interface GenTestsSummary {
  contract: string;
  testFile: string;
  compiledFirstTry: boolean;
  compiled: boolean;
  passRate: number | null; // percent
  passed: number;
  failed: number;
  lineCoverage: number | null; // percent
  branchCoverage: number | null; // percent
  uncoveredFunctions: string[];
  repairsUsed: number;
  attempts: AttemptRecord[];
  behaviorNotes: string[];
  coveredFunctions: string[];
  rationale: string;
}

export interface GenTestsParams {
  client: LlmClient;
  forge: ForgeLike;
  contract: LoadedContract;
  /** Directory for attempt-N.t.sol, forge-test.json, summary.json. */
  outDir: string;
  maxRepairs: number;
  temperature: number;
  genSystem: string;
  repairSystem: string;
  /** Prompts are only built (never sent) when this is set. */
  onPrompt?: (name: string, system: string, user: string) => void;
}

/** Build the user message: the contract is wrapped in tags and line-numbered. */
export function buildGenPrompt(c: LoadedContract): string {
  return [
    `File name: ${c.fileName}`,
    `Import it as: ../src/${c.fileName}`,
    `Contract: ${c.contractName}`,
    `Pragma: ${c.pragma ?? "none"}`,
    "<contract>",
    c.numbered,
    "</contract>",
  ].join("\n");
}

export function buildRepairPrompt(c: LoadedContract, testSource: string, errors: string): string {
  return [
    `File name: ${c.fileName}`,
    "<contract>",
    c.numbered,
    "</contract>",
    "<test>",
    testSource,
    "</test>",
    "<errors>",
    truncateMiddle(errors, 6000),
    "</errors>",
  ].join("\n");
}

/** The model chooses the file name, but we only accept a plain "<Name>.t.sol". */
export function safeTestFileName(proposed: string, contractName: string): string {
  const base = path.basename(proposed.replace(/\\/g, "/"));
  return /^[A-Za-z0-9_]+\.t\.sol$/.test(base) ? base : `${contractName}.t.sol`;
}

function describeFailures(outcomes: TestOutcome[]): string {
  return outcomes
    .filter((o) => !o.passed)
    .map((o) => `${o.suite} ${o.name}: ${o.reason ?? "failed"}`)
    .join("\n");
}

/**
 * Direction A: generate a Foundry test, run it, and feed compile errors / failures
 * back to the model for at most `maxRepairs` repair rounds (the RepairLoop).
 */
export async function generateTests(p: GenTestsParams): Promise<GenTestsSummary> {
  mkdirSync(p.outDir, { recursive: true });

  const genUser = buildGenPrompt(p.contract);
  p.onPrompt?.("gen-tests", p.genSystem, genUser);
  const first = await p.client.generate({
    step: "gen-tests",
    system: p.genSystem,
    user: genUser,
    schema: GenTestsOutput,
    temperature: p.temperature,
  });

  const testFile = safeTestFileName(first.testFileName, p.contract.contractName);
  let source = first.solidity;
  const attempts: AttemptRecord[] = [];
  const behaviorNotes: string[] = [];
  let outcomes: TestOutcome[];
  let compiled: boolean;
  let repairsUsed = 0;

  for (let attempt = 0; ; attempt++) {
    writeFileSync(path.join(p.outDir, `attempt-${attempt}.t.sol`), source);

    let status: AttemptRecord["status"] = "ok";
    let feedback: string;
    outcomes = [];

    const unsafe = findUnsafeCode(source);
    if (unsafe.length > 0) {
      // Never run it. Ask the model to remove the forbidden cheatcodes.
      status = "unsafe";
      compiled = false;
      feedback = `The test was rejected before running. It uses forbidden features: ${unsafe.join(", ")}. Remove them.`;
    } else {
      p.forge.writeTest(testFile, source);
      const build = await p.forge.build();
      compiled = build.ok;
      if (!build.ok) {
        status = "compile_error";
        feedback = build.output;
      } else {
        const run = await p.forge.test();
        outcomes = run.outcomes;
        if (outcomes.length === 0) {
          // Compiled but no results: show the raw output so the model can see why.
          feedback = `forge test produced no results:\n${run.output}`;
        } else {
          feedback = describeFailures(outcomes);
        }
      }
    }

    const passed = outcomes.filter((o) => o.passed).length;
    const failed = outcomes.length - passed;
    attempts.push({ attempt, status, passed, failed });

    const allGood = status === "ok" && outcomes.length > 0 && failed === 0;
    if (allGood || attempt >= p.maxRepairs) break;

    const repairUser = buildRepairPrompt(p.contract, source, feedback);
    p.onPrompt?.(`repair-${attempt + 1}`, p.repairSystem, repairUser);
    const fix = await p.client.generate({
      step: `repair-${attempt + 1}`,
      system: p.repairSystem,
      user: repairUser,
      schema: RepairOutput,
      temperature: p.temperature,
    });
    repairsUsed++;
    behaviorNotes.push(...fix.behaviorNotes);
    source = fix.solidity;
  }

  // Coverage only makes sense when the final test compiled and ran.
  const cov = compiled && outcomes.length > 0 ? await p.forge.coverage() : null;
  const passed = outcomes.filter((o) => o.passed).length;
  const summary: GenTestsSummary = {
    contract: p.contract.fileName,
    testFile,
    compiledFirstTry: attempts[0]?.status === "ok",
    compiled,
    passRate: percent(passed, outcomes.length),
    passed,
    failed: outcomes.length - passed,
    lineCoverage: cov ? percent(cov.linesHit, cov.linesFound) : null,
    branchCoverage: cov ? percent(cov.branchesHit, cov.branchesFound) : null,
    uncoveredFunctions: cov?.uncoveredFunctions ?? [],
    repairsUsed,
    attempts,
    behaviorNotes,
    coveredFunctions: first.coveredFunctions,
    rationale: first.rationale,
  };
  writeFileSync(path.join(p.outDir, "forge-test.json"), JSON.stringify(outcomes, null, 2));
  writeFileSync(path.join(p.outDir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}
