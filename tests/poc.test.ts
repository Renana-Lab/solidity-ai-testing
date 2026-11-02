import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { confirmFindings, selectForPoc } from "../src/audit/poc.js";
import { loadContract } from "../src/contract.js";
import { ForgeWorkspace, type ForgeLike } from "../src/foundry/runner.js";
import { findPocProblems } from "../src/foundry/safety.js";
import { FixtureClient, type LlmClient } from "../src/llm/client.js";
import type { Finding } from "../src/llm/schemas.js";
import { REPO_ROOT } from "../src/util.js";

const contract = loadContract(path.join(REPO_ROOT, "contracts/samples/vulnerable/ReentrancyVault.sol"), 20000, { stripComments: true });

const finding = (o: Partial<Finding> = {}): Finding => ({
  id: "F-001",
  title: "t",
  severity: "high",
  category: "reentrancy",
  location: { function: "withdraw", startLine: 13, endLine: 21 },
  description: "d",
  exploitScenario: "e",
  suggestedFix: "f",
  confidence: 0.9,
  ...o,
});

// A PoC text that passes the static checks for the ReentrancyVault.
const GOOD = `import {ReentrancyVault} from "../src/ReentrancyVault.sol";
contract P is Test { function test_X() public { ReentrancyVault v = new ReentrancyVault(); assertEq(address(v).balance, 0); } }`;
const poc = (solidity: string) => ({ testFileName: "PocF001.t.sol", solidity, assertionExplanation: "expl" });

function scripted(answers: unknown[]): LlmClient & { steps: string[] } {
  const steps: string[] = [];
  return {
    steps,
    async generate<T>(req: { step: string; schema: { parse(x: unknown): T } }) {
      steps.push(req.step);
      return req.schema.parse(answers.shift());
    },
  };
}

type Round = { build: boolean; outcomes?: boolean[]; timedOut?: boolean };
function fakeForge(rounds: Round[]): ForgeLike {
  let i = -1;
  return {
    writeTest: () => {
      i++;
    },
    build: async () => ({ ok: rounds[i]!.build, output: "Error (7576): Undeclared identifier." }),
    test: async () => ({
      outcomes: (rounds[i]!.outcomes ?? []).map((passed, n) => ({ suite: "S", name: `t${n}`, passed, reason: passed ? null : "assertion failed" })),
      output: "",
      timedOut: rounds[i]!.timedOut,
    }),
    coverage: async () => null,
  };
}

function run(client: LlmClient, rounds: Round[], findings = [finding()], maxRepairs = 2) {
  return confirmFindings({
    client,
    makeForge: () => fakeForge(rounds),
    contract,
    findings,
    minSeverity: "high",
    maxRepairs,
    system: "s",
    repairSystem: "r",
    temperature: 0.2,
    outDir: mkdtempSync(path.join(os.tmpdir(), "sat-poc-")),
  });
}

describe("selectForPoc", () => {
  it("keeps findings at or above the minimum severity", () => {
    const all = [finding({ id: "a", severity: "critical" }), finding({ id: "b" }), finding({ id: "c", severity: "medium" }), finding({ id: "d", severity: "info" })];
    expect(selectForPoc(all, "high").map((f) => f.id)).toEqual(["a", "b"]);
    expect(selectForPoc(all, "medium").map((f) => f.id)).toEqual(["a", "b", "c"]);
  });
});

describe("findPocProblems", () => {
  it("accepts a real exploit test", () => {
    expect(findPocProblems(GOOD, "ReentrancyVault")).toEqual([]);
  });
  it("rejects fake-state cheatcodes and sandbox escapes", () => {
    expect(findPocProblems(GOOD + "\nvm.store(a, b, c);", "ReentrancyVault")).not.toEqual([]);
    expect(findPocProblems(GOOD + "\nvm.etch(a, b);", "ReentrancyVault")).not.toEqual([]);
    expect(findPocProblems(GOOD + "\nvm.ffi(x);", "ReentrancyVault")).not.toEqual([]);
  });
  it("rejects a test that never uses the target contract", () => {
    const only = `import {ReentrancyVault} from "../src/ReentrancyVault.sol";\ncontract P is Test { function test_X() public { assertTrue(1 == 1); } }`;
    expect(findPocProblems(only, "ReentrancyVault").join()).toMatch(/never uses the target/);
  });
  it("rejects tests with no assertion or only vacuous ones", () => {
    const none = `contract P is Test { function test_X() public { new ReentrancyVault(); } }`;
    expect(findPocProblems(none, "ReentrancyVault").join()).toMatch(/no assertion/);
    const vacuous = `contract P is Test { function test_X() public { new ReentrancyVault(); assertTrue(true); } }`;
    expect(findPocProblems(vacuous, "ReentrancyVault").join()).toMatch(/vacuous/);
  });
  it("ignores forbidden names that only appear in comments", () => {
    expect(findPocProblems(GOOD + "\n// we do not use vm.store here", "ReentrancyVault")).toEqual([]);
  });
});

describe("confirmFindings", () => {
  it("confirms when the exploit test passes", async () => {
    const [r] = await run(scripted([poc(GOOD)]), [{ build: true, outcomes: [true] }]);
    expect(r).toMatchObject({ status: "confirmed", repairsUsed: 0, passed: 1, failed: 0, detail: null });
  });

  it("leaves it unconfirmed when the exploit test fails, and does NOT repair it", async () => {
    const client = scripted([poc(GOOD)]);
    const [r] = await run(client, [{ build: true, outcomes: [false] }]);
    expect(r?.status).toBe("unconfirmed");
    expect(r?.detail).toMatch(/assertion failed/);
    expect(client.steps).toEqual(["poc-F-001"]);
  });

  it("marks a timeout as unconfirmed", async () => {
    const [r] = await run(scripted([poc(GOOD)]), [{ build: true, outcomes: [], timedOut: true }]);
    expect(r).toMatchObject({ status: "unconfirmed", detail: "timed out" });
  });

  it("repairs a compile error, then confirms", async () => {
    const client = scripted([poc(GOOD), poc(GOOD)]);
    const [r] = await run(client, [{ build: false }, { build: true, outcomes: [true] }]);
    expect(r).toMatchObject({ status: "confirmed", repairsUsed: 1 });
    expect(client.steps).toEqual(["poc-F-001", "poc-F-001-repair-1"]);
  });

  it("gives up after maxRepairs compile failures", async () => {
    const client = scripted([poc(GOOD), poc(GOOD), poc(GOOD)]);
    const [r] = await run(client, [{ build: false }, { build: false }, { build: false }]);
    expect(r).toMatchObject({ status: "poc_failed_to_compile", repairsUsed: 2 });
    expect(r?.detail).toMatch(/Undeclared identifier/);
  });

  it("never builds or runs a rejected test, and rejects it for good if repairs do not help", async () => {
    let built = 0;
    const forge = fakeForge([]);
    const counting: ForgeLike = { ...forge, build: async () => (built++, { ok: true, output: "" }) };
    const bad = poc(GOOD + "\nvm.ffi(x);");
    const [r] = await confirmFindings({
      client: scripted([bad, bad, bad]),
      makeForge: () => counting,
      contract,
      findings: [finding()],
      minSeverity: "high",
      maxRepairs: 2,
      system: "s",
      repairSystem: "r",
      temperature: 0.2,
      outDir: mkdtempSync(path.join(os.tmpdir(), "sat-poc-")),
    });
    expect(r?.status).toBe("rejected_unsafe");
    expect(built).toBe(0);
  });

  it("only attempts findings above the threshold", async () => {
    const client = scripted([]);
    expect(await run(client, [], [finding({ severity: "low" })])).toEqual([]);
    expect(client.steps).toEqual([]);
  });
});

describe("sandbox (real forge)", () => {
  // These tests skip our own text check on purpose: they prove the forge CONFIG blocks the cheatcodes.
  function workspace(timeout = 60_000) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sat-sandbox-"));
    return new ForgeWorkspace(dir, path.join(REPO_ROOT, "contracts/samples/vulnerable/ReentrancyVault.sol"), { testTimeoutMs: timeout });
  }
  const wrap = (body: string) => `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
contract T is Test { function test_X() public { ${body} } }`;

  it("blocks vm.ffi (ffi = false)", async () => {
    const w = workspace();
    w.writeTest("T.t.sol", wrap('string[] memory c = new string[](1); c[0] = "echo"; vm.ffi(c);'));
    expect((await w.build()).ok).toBe(true);
    const r = await w.test();
    expect(r.outcomes[0]?.passed).toBe(false);
    expect(r.output).toMatch(/ffi/i);
  }, 120_000);

  it("blocks file writes (no fs_permissions)", async () => {
    const w = workspace();
    w.writeTest("T.t.sol", wrap('vm.writeFile("pwned.txt", "x");'));
    expect((await w.build()).ok).toBe(true);
    const r = await w.test();
    expect(r.outcomes[0]?.passed).toBe(false);
    expect(r.output).toMatch(/permission|not allowed|denied/i);
  }, 120_000);

  it("kills an endless loop at the timeout", async () => {
    const w = workspace(1_500);
    w.writeTest("T.t.sol", wrap("uint256 i; while (true) { i++; }"));
    expect((await w.build()).ok).toBe(true);
    const r = await w.test();
    expect(r.timedOut).toBe(true);
  }, 120_000);

  it("runs the recorded ReentrancyVault PoC fixture and confirms it", async () => {
    const results = await confirmFindings({
      client: new FixtureClient(path.join(REPO_ROOT, "tests/fixtures/reentrancy")),
      makeForge: () => workspace(),
      contract,
      findings: [finding()],
      minSeverity: "high",
      maxRepairs: 2,
      system: "s",
      repairSystem: "r",
      temperature: 0.2,
      outDir: mkdtempSync(path.join(os.tmpdir(), "sat-poc-")),
    });
    expect(results[0]).toMatchObject({ status: "confirmed", passed: 1, failed: 0 });
  }, 180_000);

  it("the SAME exploit fails on the fixed SafeVault (negative control)", async () => {
    const safe = loadContract(path.join(REPO_ROOT, "contracts/samples/safe/SafeVault.sol"), 20000, { stripComments: true });
    const dir = mkdtempSync(path.join(os.tmpdir(), "sat-safe-"));
    const w = new ForgeWorkspace(dir, path.join(REPO_ROOT, "contracts/samples/safe/SafeVault.sol"), { testTimeoutMs: 60_000 });
    const fixture = JSON.parse(readFileSync(path.join(REPO_ROOT, "tests/fixtures/reentrancy/poc-F-001.json"), "utf8")) as { solidity: string };
    // Same exploit, pointed at the fixed contract. Its error names differ, but withdraw() has the same shape.
    w.writeTest("PocF001.t.sol", fixture.solidity.replaceAll("ReentrancyVault", "SafeVault"));
    expect((await w.build()).ok).toBe(true);
    const r = await w.test();
    expect(r.outcomes.length).toBeGreaterThan(0);
    expect(r.outcomes.every((o) => !o.passed)).toBe(true);
    expect(safe.contractName).toBe("SafeVault");
  }, 180_000);
});

describe("sat full (mock end to end, real forge and Slither)", () => {
  it("generates tests, audits and confirms the reentrancy PoC", async () => {
    const { full } = await import("../src/cli/full.js");
    const out = mkdtempSync(path.join(os.tmpdir(), "sat-full-"));
    const code = await full(path.join(REPO_ROOT, "contracts/samples/vulnerable/ReentrancyVault.sol"), {
      out,
      slither: true,
      blind: true,
      minCoverage: 80,
      mock: path.join(REPO_ROOT, "tests/fixtures/reentrancy"),
    });
    expect(code).toBe(0);
    // The PoC result is saved inside the audit run folder.
    const auditRun = readdirSync(out).find((d) => d.endsWith("-audit"))!;
    const result = JSON.parse(readFileSync(path.join(out, auditRun, "audit", "poc", "F-001.result.json"), "utf8")) as { status: string };
    expect(result.status).toBe("confirmed");
  }, 300_000);
});
