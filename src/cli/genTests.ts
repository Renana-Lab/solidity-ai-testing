import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { loadConfig, loadPricing, loadPrompt } from "../config.js";
import { ContractTooLargeError, loadContract } from "../contract.js";
import { ForgeWorkspace, ToolMissingError } from "../foundry/runner.js";
import { FixtureClient, GeminiClient, LlmApiError, LlmClient, LlmOutputError, sdkTransport } from "../llm/client.js";
import { BudgetExceededError, CostTracker } from "../llm/cost.js";
import { renderReport } from "../report/markdown.js";
import { GenTestsSummary, buildGenPrompt, generateTests } from "../testgen/generator.js";
import { REPO_ROOT, scrub } from "../util.js";

export interface GenTestsFlags {
  model?: string;
  flash?: boolean;
  pro?: boolean;
  out: string;
  maxCost?: number;
  maxRepairs?: number;
  minCoverage: number;
  keepWorkspace?: boolean;
  dryRun?: boolean;
  mock?: string;
  verbose?: boolean;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

async function gitSha(): Promise<string | null> {
  try {
    return (await execa("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT })).stdout.trim();
  } catch {
    return null;
  }
}

/** `sat gen-tests <file.sol>`. Returns the process exit code (spec section 7). */
export async function genTests(file: string, flags: GenTestsFlags): Promise<number> {
  const cfg = loadConfig();
  if (flags.flash && flags.pro) {
    console.error("Use either --flash or --pro, not both.");
    return 1;
  }
  const model = flags.model ?? (flags.pro ? cfg.proModel : flags.flash ? cfg.flashModel : cfg.model);
  const maxCost = flags.maxCost ?? cfg.maxCostUsd;
  const maxRepairs = flags.maxRepairs ?? cfg.maxRepairs;

  const contractPath = path.resolve(file);
  if (!existsSync(contractPath)) {
    console.error(`File not found: ${contractPath}`);
    return 1;
  }
  let contract;
  try {
    contract = loadContract(contractPath, cfg.maxContractTokens);
  } catch (e) {
    console.error(e instanceof ContractTooLargeError || e instanceof Error ? e.message : String(e));
    return 1;
  }

  const runId = `${stamp()}-${contract.contractName}-gen-tests`;
  const runDir = path.resolve(flags.out, runId);
  const outDir = path.join(runDir, "gen-tests");
  mkdirSync(outDir, { recursive: true });

  const genSystem = loadPrompt("gen-tests.system.md");
  const repairSystem = loadPrompt("repair.system.md");

  // --dry-run: build the prompt, save it, never call the API.
  if (flags.dryRun) {
    const dir = path.join(runDir, "prompts-sent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "gen-tests.system.md"), genSystem);
    writeFileSync(path.join(dir, "gen-tests.user.txt"), buildGenPrompt(contract));
    console.log(`Dry run: prompts saved in ${dir}`);
    return 0;
  }

  const cost = new CostTracker(loadPricing(), maxCost);
  let client: LlmClient;
  if (flags.mock) {
    client = new FixtureClient(path.resolve(flags.mock));
  } else {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key === "your-key-here") {
      console.error("GEMINI_API_KEY is not set. Copy .env.example to .env and fill it in.");
      return 1;
    }
    client = new GeminiClient({
      transport: sdkTransport(key, cfg.callTimeoutMs),
      model,
      cost,
      logPath: path.join(runDir, "llm-calls.jsonl"),
      maxRetries: cfg.maxRetries,
      maxRpm: cfg.maxRpm,
      concurrency: cfg.concurrency,
    });
  }

  const workDir = path.join(REPO_ROOT, ".work", runId);
  const started = Date.now();
  let summary: GenTestsSummary | null = null;
  let exitCode = 0;
  let budgetStopped = false;
  let errorMessage: string | null = null;

  try {
    const workspace = new ForgeWorkspace(workDir, contractPath);
    console.log(`Model: ${model} | cost cap: $${maxCost.toFixed(2)} | max repairs: ${maxRepairs}`);
    summary = await generateTests({
      client,
      forge: workspace,
      contract,
      outDir,
      maxRepairs,
      temperature: cfg.temperature.genTests,
      thinking: cfg.thinking.genTests,
      genSystem,
      repairSystem,
      onPrompt: (name, system, user) => {
        if (!flags.verbose) return;
        const dir = path.join(runDir, "prompts-sent");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, `${name}.txt`), `${system}\n\n----\n\n${user}`);
      },
    });
    const lcov = path.join(workDir, "coverage.lcov");
    if (existsSync(lcov)) copyFileSync(lcov, path.join(outDir, "coverage.lcov"));
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      budgetStopped = true;
      exitCode = 3;
    } else if (e instanceof LlmApiError || e instanceof LlmOutputError) {
      exitCode = 4;
    } else if (e instanceof ToolMissingError) {
      exitCode = 2;
    } else {
      exitCode = 1;
    }
    errorMessage = scrub(e instanceof Error ? e.message : String(e));
    console.error(errorMessage);
  } finally {
    if (!flags.keepWorkspace) rmSync(workDir, { recursive: true, force: true });
  }

  const run = {
    command: `sat gen-tests ${file}`,
    model: flags.mock ? "mock" : model,
    costUsd: cost.totalUsd,
    tokens: cost.totalTokens,
    seconds: (Date.now() - started) / 1000,
    budgetStopped,
  };
  writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify({ ...run, exitCode, error: errorMessage, gitSha: await gitSha(), flags, nodeVersion: process.version, startedAt: new Date(started).toISOString() }, null, 2),
  );
  writeFileSync(path.join(runDir, "report.md"), renderReport(run, summary));

  if (summary) {
    console.log(
      `Tests: ${summary.passed} passed, ${summary.failed} failed | line coverage: ${summary.lineCoverage ?? "n/a"}% | repairs: ${summary.repairsUsed} | cost: $${cost.totalUsd.toFixed(4)}`,
    );
    if ((summary.lineCoverage ?? 0) < flags.minCoverage) {
      console.warn(`Warning: line coverage is below the target of ${flags.minCoverage}%.`);
    }
  }
  console.log(`Report: ${path.join(runDir, "report.md")}`);
  return exitCode;
}
