import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadContract } from "../src/contract.js";
import type { ForgeLike } from "../src/foundry/runner.js";
import type { LlmClient } from "../src/llm/client.js";
import { generateTests, safeTestFileName } from "../src/testgen/generator.js";
import { REPO_ROOT } from "../src/util.js";

const contract = loadContract(path.join(REPO_ROOT, "contracts/practice/Counter.sol"), 20000);

/** A scripted LLM: returns the next canned answer, keyed by call order. */
function scriptedClient(answers: unknown[]): LlmClient & { steps: string[] } {
  const steps: string[] = [];
  return {
    steps,
    async generate<T>(req: { step: string; schema: { parse(x: unknown): T } }) {
      steps.push(req.step);
      return req.schema.parse(answers.shift());
    },
  };
}

/** A scripted Foundry: each element is the result of one build+test round. */
function fakeForge(rounds: Array<{ build: boolean; outcomes?: boolean[] }>): ForgeLike {
  let i = -1;
  return {
    writeTest: () => {
      i++;
    },
    build: async () => ({ ok: rounds[i]!.build, output: "Error (1234): boom" }),
    test: async () => ({
      outcomes: (rounds[i]!.outcomes ?? []).map((passed, n) => ({ suite: "S", name: `t${n}`, passed, reason: passed ? null : "assert failed" })),
      output: "",
    }),
    coverage: async () => ({ file: "src/Counter.sol", linesFound: 10, linesHit: 9, branchesFound: 2, branchesHit: 2, uncoveredFunctions: [] }),
  };
}

const gen = { testFileName: "Counter.t.sol", solidity: "contract T {}", rationale: "r", coveredFunctions: ["increment"] };
const fix = (note: string[] = []) => ({ solidity: "contract T2 {}", changes: ["c"], behaviorNotes: note });

function run(client: LlmClient, forge: ForgeLike, maxRepairs = 3) {
  return generateTests({
    client,
    forge,
    contract,
    outDir: mkdtempSync(path.join(os.tmpdir(), "sat-gen-")),
    maxRepairs,
    temperature: 0.4,
    genSystem: "g",
    repairSystem: "r",
  });
}

describe("generateTests (RepairLoop)", () => {
  it("passes first try with no repairs", async () => {
    const client = scriptedClient([gen]);
    const s = await run(client, fakeForge([{ build: true, outcomes: [true, true] }]));
    expect(s).toMatchObject({ compiledFirstTry: true, repairsUsed: 0, passRate: 100, lineCoverage: 90, branchCoverage: 100 });
    expect(client.steps).toEqual(["gen-tests"]);
  });

  it("repairs a compile error, then a failing test", async () => {
    const client = scriptedClient([gen, fix(), fix(["Contract reverts at 0, test assumed wrap"])]);
    const s = await run(
      client,
      fakeForge([{ build: false }, { build: true, outcomes: [true, false] }, { build: true, outcomes: [true, true] }]),
    );
    expect(s.compiledFirstTry).toBe(false);
    expect(s.repairsUsed).toBe(2);
    expect(s.passRate).toBe(100);
    expect(s.behaviorNotes).toEqual(["Contract reverts at 0, test assumed wrap"]);
    expect(client.steps).toEqual(["gen-tests", "repair-1", "repair-2"]);
  });

  it("stops after maxRepairs and reports the failures", async () => {
    const client = scriptedClient([gen, fix(), fix()]);
    const forge = fakeForge([{ build: true, outcomes: [false] }, { build: true, outcomes: [false] }, { build: true, outcomes: [false] }]);
    const s = await run(client, forge, 2);
    expect(s.repairsUsed).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.passRate).toBe(0);
  });

  it("never runs a test that uses vm.ffi and asks for a repair instead", async () => {
    const unsafe = { ...gen, solidity: "contract T { function f() public { vm.ffi(x); } }" };
    let built = 0;
    const forge = fakeForge([{ build: true, outcomes: [true] }]);
    const countingForge: ForgeLike = { ...forge, build: async () => (built++, forge.build()) };
    const s = await run(scriptedClient([unsafe, fix()]), countingForge);
    expect(s.attempts[0]?.status).toBe("unsafe");
    expect(s.attempts[1]?.status).toBe("ok");
    expect(built).toBe(1); // only the repaired version was built
  });

  it("writes attempt files and summary.json", async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), "sat-gen-"));
    await generateTests({
      client: scriptedClient([gen]),
      forge: fakeForge([{ build: true, outcomes: [true] }]),
      contract,
      outDir,
      maxRepairs: 3,
      temperature: 0.4,
      genSystem: "g",
      repairSystem: "r",
    });
    expect(readFileSync(path.join(outDir, "attempt-0.t.sol"), "utf8")).toBe("contract T {}");
    expect(JSON.parse(readFileSync(path.join(outDir, "summary.json"), "utf8")).passed).toBe(1);
  });
});

describe("safeTestFileName", () => {
  it("accepts plain names and rejects paths and odd names", () => {
    expect(safeTestFileName("Counter.t.sol", "Counter")).toBe("Counter.t.sol");
    expect(safeTestFileName("../../evil.t.sol", "Counter")).toBe("evil.t.sol");
    expect(safeTestFileName("weird name.sol", "Counter")).toBe("Counter.t.sol");
  });
});
