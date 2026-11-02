import { execa } from "execa";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Pull the first "x.y.z" version number out of a tool's --version output. */
export function parseVersion(output: string): string | null {
  const m = output.match(/\d+\.\d+(\.\d+)?/);
  return m ? m[0] : null;
}

/** Node 20 LTS or newer is required (see spec section 13). */
export function nodeVersionOk(version: string): boolean {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  return Number.isFinite(major) && major >= 20;
}

/** Run `<cmd> <args>` and report whether it exists. A missing binary is a normal result, not a crash. */
async function checkCommand(name: string, cmd: string, args: string[]): Promise<CheckResult> {
  try {
    const { stdout } = await execa(cmd, args);
    return { name, ok: true, detail: parseVersion(stdout) ?? stdout.split("\n")[0] ?? "ok" };
  } catch {
    return { name, ok: false, detail: "not found on PATH" };
  }
}

export async function runChecks(env: NodeJS.ProcessEnv = process.env): Promise<CheckResult[]> {
  const nodeV = process.version;
  const results: CheckResult[] = [
    { name: "node", ok: nodeVersionOk(nodeV), detail: `${nodeV} (need >= 20)` },
    await checkCommand("forge", "forge", ["--version"]),
    await checkCommand("slither", "slither", ["--version"]),
    await checkCommand("solc-select", "solc-select", ["versions"]),
    await checkCommand("solc", "solc", ["--version"]),
    {
      name: "GEMINI_API_KEY",
      ok: Boolean(env.GEMINI_API_KEY && env.GEMINI_API_KEY !== "your-key-here"),
      // Never print the key itself.
      detail: env.GEMINI_API_KEY ? "set" : "missing (copy .env.example to .env)",
    },
  ];
  return results;
}

/** Returns the process exit code: 0 all good, 2 a required tool is missing (spec section 7). */
export async function doctor(): Promise<number> {
  const results = await runChecks();
  for (const r of results) {
    console.log(`${r.ok ? "OK     " : "MISSING"} ${r.name.padEnd(15)} ${r.detail}`);
  }
  return results.every((r) => r.ok) ? 0 : 2;
}
