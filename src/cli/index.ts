#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { audit } from "./audit.js";
import { bench, compare } from "./bench.js";
import { doctor } from "./doctor.js";
import { full } from "./full.js";
import { genTests } from "./genTests.js";

const program = new Command();
program.name("sat").description("AI-assisted Solidity testing and auditing (educational)");

program
  .command("doctor")
  .description("check that forge, slither, solc, node and the API key are available")
  .action(async () => {
    process.exitCode = await doctor();
  });

program
  .command("gen-tests")
  .description("generate Foundry tests for a contract with Gemini, run them, and repair failures")
  .argument("<file>", "path to a .sol file")
  .option("--model <name>", "Gemini model (default from config)")
  .option("--flash", "use the flash model (the default)")
  .option("--pro", "use the strong, more expensive model (gemini-4-argon)")
  .option("--out <dir>", "output directory", "reports")
  .option("--max-cost <usd>", "stop when the run costs more than this", Number)
  .option("--max-repairs <n>", "maximum repair rounds", Number)
  .option("--min-coverage <pct>", "warn if line coverage is below this", Number, 80)
  .option("--keep-workspace", "do not delete the temporary Foundry workspace")
  .option("--dry-run", "save the prompts but do not call the API")
  .option("--mock <dir>", "answer from recorded JSON fixtures instead of the API")
  .option("--verbose", "save every prompt that is sent")
  .action(async (file: string, flags) => {
    process.exitCode = await genTests(file, flags);
  });

program
  .command("audit")
  .description("ask Gemini for security findings, compare with Slither and the ground truth")
  .argument("<file>", "path to a .sol file")
  .option("--model <name>", "Gemini model (default from config)")
  .option("--flash", "use the flash model (the default)")
  .option("--pro", "use the strong, more expensive model (gemini-4-argon)")
  .option("--out <dir>", "output directory", "reports")
  .option("--max-cost <usd>", "stop when the run costs more than this", Number)
  .option("--no-slither", "skip the Slither run")
  .option("--keep-comments", "send comments to the model (by default they are removed)")
  .option("--poc", "write and run an exploit test for each serious finding")
  .option("--poc-severity <level>", "minimum severity that gets a PoC (default from config: high)")
  .option("--max-poc-repairs <n>", "repair rounds for PoCs that fail to compile", Number)
  .option("--poc-from <file>", "use findings from a saved llm-findings.json instead of asking the model")
  .option("--negative-control", "with --poc-from: the findings belong to another contract, so every PoC must fail")
  .option("--keep-workspace", "do not delete the temporary Foundry workspaces")
  .option("--no-blind", "send the real contract and file name (by default they are replaced with 'Target')")
  .option("--ground-truth <file>", "ground-truth.yaml to score against (default: contracts/samples/ground-truth.yaml)")
  .option("--dry-run", "save the prompts but do not call the API")
  .option("--mock <dir>", "answer from recorded JSON fixtures instead of the API")
  .option("--verbose", "save every prompt that is sent")
  .action(async (file: string, flags) => {
    process.exitCode = await audit(file, flags);
  });

program
  .command("full")
  .description("gen-tests, then audit with exploit tests (PoC) for the serious findings")
  .argument("<file>", "path to a .sol file")
  .option("--model <name>", "Gemini model (default from config)")
  .option("--flash", "use the flash model (the default)")
  .option("--pro", "use the strong, more expensive model (gemini-4-argon)")
  .option("--out <dir>", "output directory", "reports")
  .option("--max-cost <usd>", "stop when each step costs more than this", Number)
  .option("--min-coverage <pct>", "warn if line coverage is below this", Number, 80)
  .option("--no-slither", "skip the Slither run")
  .option("--no-blind", "send the real contract and file name")
  .option("--keep-workspace", "do not delete the temporary Foundry workspaces")
  .option("--dry-run", "save the prompts but do not call the API")
  .option("--mock <dir>", "answer from recorded JSON fixtures instead of the API")
  .option("--verbose", "save every prompt that is sent")
  .action(async (file: string, flags) => {
    process.exitCode = await full(file, flags);
  });

program
  .command("bench")
  .description("run gen-tests and audit (with PoC) on every sample and write evaluation.md")
  .option("--dir <dir>", "folder with the sample contracts", "contracts/samples")
  .option("--only <kind>", "vulnerable, safe or all", "all")
  .option("--repeat <n>", "audit runs per contract (to measure stability)", Number, 1)
  .option("--model <name>", "Gemini model (default from config)")
  .option("--flash", "use the flash model (the default)")
  .option("--pro", "use the strong, more expensive model (gemini-4-argon)")
  .option("--out <dir>", "output directory", "reports")
  .option("--max-cost <usd>", "cost cap for ONE contract (default 0.10)", Number)
  .option("--max-total-cost <usd>", "cost cap for the whole bench (default 1.00)", Number)
  .option("--skip-tests", "only audit, do not generate tests")
  .action(async (flags) => {
    process.exitCode = await bench(flags);
  });

program
  .command("compare")
  .description("side-by-side table of two bench folders (for example flash and pro)")
  .argument("<benchA>", "folder made by sat bench")
  .argument("<benchB>", "folder made by sat bench")
  .option("--out <dir>", "output directory", "reports")
  .action((a: string, b: string, flags: { out: string }) => {
    process.exitCode = compare(a, b, flags.out);
  });

await program.parseAsync(process.argv);
