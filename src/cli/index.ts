#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { audit } from "./audit.js";
import { doctor } from "./doctor.js";
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
  .option("--keep-workspace", "do not delete the temporary Foundry workspaces")
  .option("--no-blind", "send the real contract and file name (by default they are replaced with 'Target')")
  .option("--ground-truth <file>", "ground-truth.yaml to score against (default: contracts/samples/ground-truth.yaml)")
  .option("--dry-run", "save the prompts but do not call the API")
  .option("--mock <dir>", "answer from recorded JSON fixtures instead of the API")
  .option("--verbose", "save every prompt that is sent")
  .action(async (file: string, flags) => {
    process.exitCode = await audit(file, flags);
  });

await program.parseAsync(process.argv);
