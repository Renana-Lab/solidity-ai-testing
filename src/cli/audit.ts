import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { auditContract, buildAuditPrompt, findingsToIssues } from "../audit/auditor.js";
import { matchIssues, score } from "../audit/compare.js";
import type { Issue } from "../audit/types.js";
import { loadConfig, loadPricing, loadPrompt } from "../config.js";
import { anonymize, loadContract } from "../contract.js";
import { DEFAULT_GROUND_TRUTH, loadGroundTruth, truthFor } from "../eval/groundTruth.js";
import { ToolMissingError } from "../foundry/runner.js";
import { FixtureClient, GeminiClient, LlmApiError, LlmClient, LlmOutputError, sdkTransport } from "../llm/client.js";
import { BudgetExceededError, CostTracker } from "../llm/cost.js";
import type { Finding } from "../llm/schemas.js";
import { AuditSummary, renderReport } from "../report/markdown.js";
import { runSlither } from "../slither/runner.js";
import { REPO_ROOT, scrub } from "../util.js";

export interface AuditFlags {
  model?: string;
  flash?: boolean;
  pro?: boolean;
  out: string;
  maxCost?: number;
  slither: boolean; // commander turns --no-slither into slither=false
  keepComments?: boolean;
  /** commander turns --no-blind into blind=false. Default true: the contract name is hidden. */
  blind: boolean;
  groundTruth?: string;
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

/** `sat audit <file.sol>`. Returns the process exit code (spec section 7). */
export async function audit(file: string, flags: AuditFlags): Promise<number> {
  const cfg = loadConfig();
  if (flags.flash && flags.pro) {
    console.error("Use either --flash or --pro, not both.");
    return 1;
  }
  const model = flags.model ?? (flags.pro ? cfg.proModel : flags.flash ? cfg.flashModel : cfg.model);
  const maxCost = flags.maxCost ?? cfg.maxCostUsd;

  const contractPath = path.resolve(file);
  if (!existsSync(contractPath)) {
    console.error(`File not found: ${contractPath}`);
    return 1;
  }
  let contract;
  try {
    // Comments are removed (line numbers kept) so they cannot reveal or fake the answer.
    contract = loadContract(contractPath, cfg.maxContractTokens, { stripComments: !flags.keepComments });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  const runId = `${stamp()}-${contract.contractName}-audit`;
  const runDir = path.resolve(flags.out, runId);
  const outDir = path.join(runDir, "audit");
  mkdirSync(outDir, { recursive: true });
  const system = loadPrompt("audit.system.md");

  if (flags.dryRun) {
    const dir = path.join(runDir, "prompts-sent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "audit.system.md"), system);
    writeFileSync(path.join(dir, "audit.user.txt"), buildAuditPrompt(flags.blind ? anonymize(contract) : contract));
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

  const started = Date.now();
  console.log(`Model: ${model} | cost cap: $${maxCost.toFixed(2)} | thinking: ${cfg.thinking.audit}`);
  let exitCode = 0;
  let budgetStopped = false;
  let errorMessage: string | null = null;
  let summary: AuditSummary | null = null;

  try {
    // Run Gemini and Slither side by side: they do not depend on each other.
    const slitherPromise: Promise<{ issues: Issue[]; skipped: boolean; error?: string; raw?: string }> = flags.slither
      ? runSlither(contractPath).then(
          (r) => ({ issues: r.issues, skipped: false, raw: r.raw }),
          (e) => {
            if (e instanceof ToolMissingError) throw e;
            return { issues: [], skipped: false, error: scrub(e instanceof Error ? e.message : String(e)) };
          },
        )
      : Promise.resolve({ issues: [], skipped: true });

    const [findings, sl]: [Finding[], Awaited<typeof slitherPromise>] = await Promise.all([
      auditContract({
        client,
        contract: flags.blind ? anonymize(contract) : contract,
        system,
        temperature: cfg.temperature.audit,
        thinking: cfg.thinking.audit,
        onPrompt: (name, sys, user) => {
          if (!flags.verbose) return;
          const dir = path.join(runDir, "prompts-sent");
          mkdirSync(dir, { recursive: true });
          writeFileSync(path.join(dir, `${name}.txt`), `${sys}\n\n----\n\n${user}`);
        },
      }),
      slitherPromise,
    ]);

    const llmIssues = findingsToIssues(findings);
    const comparison = flags.slither && !sl.error ? matchIssues(llmIssues, sl.issues) : null;

    // Ground truth is optional: used when this contract is listed in the file.
    let truth: AuditSummary["truth"] = null;
    const gtPath = path.resolve(flags.groundTruth ?? path.join(REPO_ROOT, DEFAULT_GROUND_TRUTH));
    if (existsSync(gtPath)) {
      const expected = truthFor(loadGroundTruth(gtPath), contractPath);
      if (expected) {
        truth = {
          issues: expected,
          llm: score(llmIssues, expected),
          slither: flags.slither && !sl.error ? score(sl.issues, expected) : null,
          llmMatch: matchIssues(llmIssues, expected),
        };
      }
    }

    summary = { contract: contract.fileName, findings, slither: { issues: sl.issues, skipped: sl.skipped, error: sl.error }, comparison, truth };
    writeFileSync(path.join(outDir, "llm-findings.json"), JSON.stringify({ findings }, null, 2));
    if (sl.raw) writeFileSync(path.join(outDir, "slither.json"), sl.raw);
    writeFileSync(path.join(outDir, "comparison.json"), JSON.stringify({ comparison, truth }, null, 2));
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
  }

  const run = {
    command: `sat audit ${file}`,
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
  writeFileSync(path.join(runDir, "report.md"), renderReport(run, null, summary));

  if (summary) {
    const s = summary;
    const slitherPart = s.slither.skipped ? "skipped" : s.slither.error ? "failed" : `${s.slither.issues.filter((i) => i.severity !== "info").length} issues`;
    console.log(`Gemini: ${s.findings.length} findings | Slither: ${slitherPart} | cost: $${cost.totalUsd.toFixed(4)}`);
    if (s.truth) console.log(`Ground truth: Gemini TP ${s.truth.llm.tp} / FP ${s.truth.llm.fp} / FN ${s.truth.llm.fn}`);
  }
  console.log(`Report: ${path.join(runDir, "report.md")}`);
  return exitCode;
}
