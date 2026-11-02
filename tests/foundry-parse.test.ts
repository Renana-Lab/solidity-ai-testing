import { describe, expect, it } from "vitest";
import { findUnsafeCode } from "../src/foundry/safety.js";
import { parseForgeTestJson, parseLcov, percent } from "../src/foundry/parse.js";

describe("parseForgeTestJson", () => {
  it("reads passes and failures and skips noise before the JSON", () => {
    const raw =
      "Warning: something\n" +
      JSON.stringify({
        "test/A.t.sol:ATest": {
          test_results: {
            "test_ok()": { status: "Success", reason: null },
            "test_bad()": { status: "Failure", reason: "revert: nope" },
            "test_skip()": { status: "Skipped", reason: null },
          },
        },
      });
    expect(parseForgeTestJson(raw)).toEqual([
      { suite: "test/A.t.sol:ATest", name: "test_ok()", passed: true, reason: null },
      { suite: "test/A.t.sol:ATest", name: "test_bad()", passed: false, reason: "revert: nope" },
    ]);
  });
  it("returns nothing for non-JSON output", () => {
    expect(parseForgeTestJson("Error: compile failed")).toEqual([]);
  });
});

describe("parseLcov", () => {
  const lcov = [
    "TN:",
    "SF:src/Counter.sol",
    "FN:5,Counter.inc",
    "FNDA:3,Counter.inc",
    "FN:9,Counter.dec",
    "FNDA:0,Counter.dec",
    "DA:5,3",
    "DA:6,3",
    "DA:9,0",
    "DA:10,0",
    "BRDA:6,0,0,1",
    "BRDA:6,0,1,-",
    "BRDA:9,0,0,0",
    "end_of_record",
  ].join("\n");

  it("counts lines, branches and uncovered functions", () => {
    const [f] = parseLcov(lcov);
    expect(f).toMatchObject({ file: "src/Counter.sol", linesFound: 4, linesHit: 2, branchesFound: 3, branchesHit: 1 });
    expect(f?.uncoveredFunctions).toEqual(["Counter.dec"]);
  });
  it("percent handles zero", () => {
    expect(percent(0, 0)).toBeNull();
    expect(percent(1, 3)).toBe(33.33);
  });
});

describe("findUnsafeCode", () => {
  it("rejects ffi, fork, fs and env cheatcodes", () => {
    expect(findUnsafeCode('vm.ffi(cmds);')).not.toHaveLength(0);
    expect(findUnsafeCode('vm.createSelectFork("http://x");')).not.toHaveLength(0);
    expect(findUnsafeCode('vm.readFile("a");')).not.toHaveLength(0);
    expect(findUnsafeCode('vm.envString("GEMINI_API_KEY");')).not.toHaveLength(0);
  });
  it("accepts normal cheatcodes and ignores comments", () => {
    expect(findUnsafeCode("vm.prank(a); vm.warp(1); vm.deal(a, 1); vm.expectRevert();")).toEqual([]);
    expect(findUnsafeCode("// never use vm.ffi here\nuint x;")).toEqual([]);
  });
});
