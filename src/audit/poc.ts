import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LoadedContract } from "../contract.js";
import { findPocProblems } from "../foundry/safety.js";
import type { ForgeLike } from "../foundry/runner.js";
import type { LlmClient, ThinkingLevel } from "../llm/client.js";
import { Finding, PocOutput, SEVERITIES, Severity } from "../llm/schemas.js";
import { safeTestFileName } from "../testgen/generator.js";
import { truncateMiddle } from "../util.js";

/**
 * confirmed             the exploit test compiled, ran, and every test in it passed
 * unconfirmed           it compiled and ran, but a test failed (or timed out): the claim is not proven
 * poc_failed_to_compile it never compiled, even after the allowed repairs
 * rejected_unsafe       it used forbidden cheatcodes or could not have proven anything
 */
export type PocStatus = "confirmed" | "unconfirmed" | "poc_failed_to_compile" | "rejected_unsafe";

export interface PocResult {
  findingId: string;
  severity: Severity;
  status: PocStatus;
  repairsUsed: number;
  testFile: string;
  explanation: string;
  /** Why it was not confirmed (compiler error, failing assertion, timeout, ...). */
  detail: string | null;
  passed: number;
  failed: number;
}

export interface PocParams {
  client: LlmClient;
  /** A fresh, isolated Foundry workspace for each finding. */
  makeForge: (findingId: string) => ForgeLike;
  /** The real (not anonymized) contract: the exploit test must import it by name. */
  contract: LoadedContract;
  findings: Finding[];
  /** Findings at this severity or worse get a PoC. */
  minSeverity: Severity;
  maxRepairs: number;
  system: string;
  repairSystem: string;
  temperature: number;
  thinking?: ThinkingLevel;
  outDir: string;
}

export function selectForPoc(findings: Finding[], minSeverity: Severity): Finding[] {
  const limit = SEVERITIES.indexOf(minSeverity);
  return findings.filter((f) => SEVERITIES.indexOf(f.severity) <= limit);
}

function findingBlock(f: Finding): string {
  return JSON.stringify(
    {
      id: f.id,
      title: f.title,
      severity: f.severity,
      category: f.category,
      function: f.location.function,
      lines: [f.location.startLine, f.location.endLine],
      description: f.description,
      exploitScenario: f.exploitScenario,
    },
    null,
    2,
  );
}

export function buildPocPrompt(c: LoadedContract, f: Finding): string {
  return [
    `File name: ${c.fileName}`,
    `Import it as: ../src/${c.fileName}`,
    `Contract: ${c.contractName}`,
    `Pragma: ${c.pragma ?? "none"}`,
    "<contract>",
    c.numbered,
    "</contract>",
    "<finding>",
    findingBlock(f),
    "</finding>",
  ].join("\n");
}

export function buildPocRepairPrompt(c: LoadedContract, f: Finding, testSource: string, errors: string): string {
  return [buildPocPrompt(c, f), "<test>", testSource, "</test>", "<errors>", truncateMiddle(errors, 6000), "</errors>"].join("\n");
}

/** Direction B, step 3: try to prove each serious finding with an exploit test that really runs. */
export async function confirmFindings(p: PocParams): Promise<PocResult[]> {
  const dir = path.join(p.outDir, "poc");
  mkdirSync(dir, { recursive: true });
  const results: PocResult[] = [];

  for (const f of selectForPoc(p.findings, p.minSeverity)) {
    const forge = p.makeForge(f.id);
    let out = await p.client.generate({
      step: `poc-${f.id}`,
      system: p.system,
      user: buildPocPrompt(p.contract, f),
      schema: PocOutput,
      temperature: p.temperature,
      thinking: p.thinking,
    });
    const testFile = safeTestFileName(out.testFileName, `Poc${f.id.replace(/\W/g, "")}`);

    let status: PocStatus;
    let detail: string | null;
    let passed: number;
    let failed: number;
    let repairsUsed = 0;

    for (let attempt = 0; ; attempt++) {
      writeFileSync(path.join(dir, `${f.id}.attempt-${attempt}.t.sol`), out.solidity);
      passed = 0;
      failed = 0;
      let feedback: string;

      const problems = findPocProblems(out.solidity, p.contract.contractName);
      if (problems.length > 0) {
        status = "rejected_unsafe";
        feedback = `The test was rejected before running: ${problems.join("; ")}.`;
      } else {
        forge.writeTest(testFile, out.solidity);
        const build = await forge.build();
        if (!build.ok) {
          status = "poc_failed_to_compile";
          feedback = build.output;
        } else {
          const run = await forge.test();
          passed = run.outcomes.filter((o) => o.passed).length;
          failed = run.outcomes.length - passed;
          if (run.timedOut) {
            status = "unconfirmed";
            detail = "timed out";
          } else if (run.outcomes.length === 0) {
            status = "unconfirmed";
            detail = `forge test produced no results: ${truncateMiddle(run.output, 400)}`;
          } else if (failed === 0) {
            status = "confirmed";
            detail = null;
          } else {
            status = "unconfirmed";
            detail = run.outcomes
              .filter((o) => !o.passed)
              .map((o) => `${o.name}: ${o.reason ?? "failed"}`)
              .join("; ");
          }
          break; // The exploit ran. Only compile problems and rejections are worth a repair.
        }
      }

      detail = feedback;
      if (attempt >= p.maxRepairs) break;
      out = await p.client.generate({
        step: `poc-${f.id}-repair-${attempt + 1}`,
        system: p.repairSystem,
        user: buildPocRepairPrompt(p.contract, f, out.solidity, feedback),
        schema: PocOutput,
        temperature: p.temperature,
        thinking: p.thinking,
      });
      repairsUsed++;
    }

    writeFileSync(path.join(dir, `${f.id}.t.sol`), out.solidity);
    const result: PocResult = {
      findingId: f.id,
      severity: f.severity,
      status,
      repairsUsed,
      testFile,
      explanation: out.assertionExplanation,
      detail: status === "confirmed" ? null : truncateMiddle(detail ?? "", 1500),
      passed,
      failed,
    };
    writeFileSync(path.join(dir, `${f.id}.result.json`), JSON.stringify(result, null, 2));
    results.push(result);
  }
  return results;
}
