import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { REPO_ROOT, truncateMiddle } from "../util.js";
import { FileCoverage, TestOutcome, parseForgeTestJson, parseLcov } from "./parse.js";

/** Exit code 2: forge is not installed. */
export class ToolMissingError extends Error {
  constructor(tool: string) {
    super(`${tool} was not found on PATH. Run "sat doctor".`);
    this.name = "ToolMissingError";
  }
}

export interface BuildResult {
  ok: boolean;
  output: string;
}
export interface TestRunResult {
  outcomes: TestOutcome[];
  output: string;
  /** True when forge test was killed for running longer than the per-run timeout. */
  timedOut?: boolean;
}

export interface WorkspaceOptions {
  /** Solidity compiler version written to foundry.toml. */
  solc?: string;
  /** Kill `forge test` after this long (an exploit test with an endless loop must not hang the run). */
  testTimeoutMs?: number;
}

/** What the test generator needs from Foundry. Faked in unit tests. */
export interface ForgeLike {
  writeTest(fileName: string, content: string): void;
  build(): Promise<BuildResult>;
  test(): Promise<TestRunResult>;
  coverage(): Promise<FileCoverage | null>;
}

/**
 * A throw-away Foundry project in .work/<run-id>/ :
 *   src/<Contract>.sol   the contract under test (copied, never modified)
 *   test/<X>.t.sol       the generated test
 * forge-std is shared from the repo's lib/ folder through an absolute remapping,
 * so we do not copy it for every run.
 */
export class ForgeWorkspace implements ForgeLike {
  readonly dir: string;
  private readonly contractFile: string;
  private readonly testTimeoutMs: number;

  constructor(workDir: string, contractPath: string, opts: WorkspaceOptions = {}) {
    const solc = opts.solc ?? "0.8.24";
    this.testTimeoutMs = opts.testTimeoutMs ?? 300_000;
    this.dir = workDir;
    this.contractFile = path.basename(contractPath);
    mkdirSync(path.join(workDir, "src"), { recursive: true });
    mkdirSync(path.join(workDir, "test"), { recursive: true });
    copyFileSync(contractPath, path.join(workDir, "src", this.contractFile));
    const forgeStd = path.join(REPO_ROOT, "lib", "forge-std").replace(/\\/g, "/");
    // ffi = false and no fs_permissions: generated tests cannot run commands or touch files.
    writeFileSync(
      path.join(workDir, "foundry.toml"),
      [
        "[profile.default]",
        'src = "src"',
        'test = "test"',
        'out = "out"',
        `solc = "${solc}"`,
        `libs = ["${forgeStd}"]`,
        `remappings = ["forge-std/=${forgeStd}/src/"]`,
        "ffi = false",
        "fs_permissions = []",
        "",
      ].join("\n"),
    );
  }

  writeTest(fileName: string, content: string): void {
    // One generated test file at a time: remove older attempts from the workspace.
    rmSync(path.join(this.dir, "test"), { recursive: true, force: true });
    mkdirSync(path.join(this.dir, "test"), { recursive: true });
    writeFileSync(path.join(this.dir, "test", fileName), content);
  }

  async build(): Promise<BuildResult> {
    const r = await this.forge(["build"]);
    return { ok: r.exitCode === 0, output: truncateMiddle(r.stdout + "\n" + r.stderr) };
  }

  async test(): Promise<TestRunResult> {
    const r = await this.forge(["test", "--json"], this.testTimeoutMs);
    let outcomes: TestOutcome[] = [];
    try {
      outcomes = parseForgeTestJson(r.stdout);
    } catch {
      /* non-JSON output: leave outcomes empty, the raw output is returned for the repair prompt */
    }
    return { outcomes, output: r.stdout, timedOut: r.timedOut };
  }

  async coverage(): Promise<FileCoverage | null> {
    const report = path.join(this.dir, "coverage.lcov");
    await this.forge(["coverage", "--report", "lcov", "--report-file", report]);
    if (!existsSync(report)) return null;
    const files = parseLcov(readFileSync(report, "utf8"));
    return files.find((f) => f.file.replace(/\\/g, "/").endsWith(`src/${this.contractFile}`)) ?? null;
  }

  private async forge(args: string[], timeout = 300_000) {
    // Never pass the API key to anything that runs LLM-written code.
    const env = { ...process.env };
    delete env.GEMINI_API_KEY;
    try {
      return await execa("forge", args, { cwd: this.dir, reject: false, env, extendEnv: false, timeout });
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") throw new ToolMissingError("forge");
      throw e;
    }
  }
}
