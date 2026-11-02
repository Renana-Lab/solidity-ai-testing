import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditContract, buildAuditPrompt, findingsToIssues } from "../src/audit/auditor.js";
import { isMatch, lineOverlap, matchIssues, score } from "../src/audit/compare.js";
import type { Issue } from "../src/audit/types.js";
import { anonymize, loadContract, stripComments } from "../src/contract.js";
import { loadGroundTruth, truthFor } from "../src/eval/groundTruth.js";
import type { LlmClient } from "../src/llm/client.js";
import { AuditOutput, Finding } from "../src/llm/schemas.js";
import { parseSlitherJson, runSlither, slitherCategory } from "../src/slither/runner.js";
import { REPO_ROOT } from "../src/util.js";

const issue = (o: Partial<Issue>): Issue => ({
  origin: "llm",
  category: "reentrancy",
  severity: "high",
  function: "withdraw",
  startLine: 10,
  endLine: 20,
  title: "t",
  ...o,
});

describe("matching", () => {
  it("matches same category and function even when lines differ", () => {
    expect(isMatch(issue({}), issue({ startLine: 50, endLine: 60 }))).toBe(true);
  });
  it("matches same category with 50% line overlap and a different function name", () => {
    expect(isMatch(issue({ function: "a" }), issue({ function: "b", startLine: 15, endLine: 25 }))).toBe(true);
    expect(lineOverlap(issue({}), issue({ startLine: 20, endLine: 30 }))).toBeCloseTo(1 / 11);
  });
  it("never matches different categories, even on identical lines", () => {
    expect(isMatch(issue({}), issue({ category: "access-control" }))).toBe(false);
  });
  it("does not treat two unknown function names as the same function", () => {
    expect(isMatch(issue({ function: "", startLine: 1, endLine: 2 }), issue({ function: "", startLine: 50, endLine: 60 }))).toBe(false);
  });
  it("is one-to-one and ignores info issues", () => {
    const a = [issue({}), issue({}), issue({ severity: "info", category: "other" })];
    const b = [issue({ origin: "truth" })];
    const m = matchIssues(a, b);
    expect(m.matched).toHaveLength(1);
    expect(m.aOnly).toHaveLength(1);
    expect(m.bOnly).toHaveLength(0);
    expect(m.ignoredInfo).toBe(1);
  });
  it("computes precision, recall and f1", () => {
    const truth = [issue({ origin: "truth" }), issue({ origin: "truth", category: "dos", function: "x", startLine: 30, endLine: 40 })];
    const s = score([issue({}), issue({ category: "timestamp", function: "y", startLine: 70, endLine: 80 })], truth);
    expect(s).toMatchObject({ tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5, f1: 0.5 });
  });
  it("gives null scores when there is nothing to divide by", () => {
    expect(score([], [])).toMatchObject({ precision: null, recall: null, f1: null });
  });
});

describe("stripComments", () => {
  it("blanks comments but keeps line numbers and strings", () => {
    const src = 'a // x\n/* b\nc */ d\nstring s = "http://x"; // tail';
    const out = stripComments(src);
    expect(out.split("\n")).toHaveLength(4);
    expect(out).toContain('"http://x"');
    expect(out).not.toContain("tail");
    expect(out).not.toMatch(/[bc]\s*\*\//);
    expect(out.split("\n")[2]?.trim()).toBe("d");
  });
  it("removes the giveaway comments from the real samples", () => {
    const c = loadContract(path.join(REPO_ROOT, "contracts/samples/vulnerable/ReentrancyVault.sol"), 20000, { stripComments: true });
    expect(c.numbered).not.toMatch(/INTENTIONALLY|SWC-107/i);
    expect(c.numbered.split("\n").length).toBe(readFileSync(c.path, "utf8").split("\n").length);
  });
  it("anonymize hides the vulnerability-revealing contract and file name", () => {
    const c = anonymize(loadContract(path.join(REPO_ROOT, "contracts/samples/vulnerable/ReentrancyVault.sol"), 20000, { stripComments: true }));
    expect(c.numbered).not.toMatch(/reentrancy/i);
    expect(c.numbered).toContain("contract Target");
    expect(buildAuditPrompt(c)).not.toMatch(/reentrancy/i);
  });
});

describe("ground-truth.yaml", () => {
  const gtFile = path.join(REPO_ROOT, "contracts/samples/ground-truth.yaml");
  const gt = loadGroundTruth(gtFile);

  it("lists every sample, and every file exists", () => {
    expect(gt.contracts.filter((c) => c.file.startsWith("vulnerable/"))).toHaveLength(7);
    for (const c of gt.contracts) expect(existsSync(path.join(REPO_ROOT, "contracts/samples", c.file)), c.file).toBe(true);
  });

  it("has line ranges that start at the named function and end at its closing brace", () => {
    for (const c of gt.contracts) {
      const lines = readFileSync(path.join(REPO_ROOT, "contracts/samples", c.file), "utf8").split(/\r?\n/);
      for (const f of c.findings) {
        const [start, end] = f.lines;
        expect(lines[start - 1], `${c.file} start`).toMatch(new RegExp(`function\\s+${f.function}\\b`));
        expect(lines[end - 1]?.trim(), `${c.file} end`).toBe("}");
      }
    }
  });

  it("finds the entry for a path on any OS", () => {
    expect(truthFor(gt, "C:\\x\\contracts\\samples\\vulnerable\\TxOriginWallet.sol")?.[0]?.category).toBe("tx-origin");
    expect(truthFor(gt, "/x/safe/SafeVault.sol")).toEqual([]);
    expect(truthFor(gt, "/x/Unknown.sol")).toBeNull();
  });
});

describe("parseSlitherJson", () => {
  const raw = JSON.stringify({
    success: true,
    error: null,
    results: {
      detectors: [
        { check: "reentrancy-eth", impact: "High", description: "d", elements: [{ type: "function", name: "withdraw", source_mapping: { lines: [13, 14, 21] } }] },
        { check: "timestamp", impact: "Low", description: "d", elements: [{ type: "node", name: "x", source_mapping: { lines: [18] }, type_specific_fields: { parent: { type: "function", name: "pickWinner" } } }] },
        { check: "solc-version", impact: "Informational", description: "d", elements: [{ type: "pragma", name: "p", source_mapping: { lines: [4] } }] },
      ],
    },
  });
  it("maps detectors to categories, severities, functions and line ranges", () => {
    const [a, b, c] = parseSlitherJson(raw);
    expect(a).toMatchObject({ category: "reentrancy", severity: "high", function: "withdraw", startLine: 13, endLine: 21 });
    expect(b).toMatchObject({ category: "timestamp", severity: "low", function: "pickWinner", startLine: 18, endLine: 18 });
    expect(c).toMatchObject({ category: "other", severity: "info" });
  });
  it("throws a clear error when Slither reports failure", () => {
    expect(() => parseSlitherJson(JSON.stringify({ success: false, error: "solc missing" }))).toThrow(/solc missing/);
  });
  it("maps common detector names", () => {
    expect(slitherCategory("tx-origin")).toBe("tx-origin");
    expect(slitherCategory("unchecked-lowlevel")).toBe("unchecked-call");
    expect(slitherCategory("calls-loop")).toBe("dos");
    expect(slitherCategory("something-new")).toBe("other");
  });
});

describe("auditContract", () => {
  const contract = loadContract(path.join(REPO_ROOT, "contracts/samples/vulnerable/ReentrancyVault.sol"), 20000, { stripComments: true });
  const finding = (o: Partial<Finding>): Finding => ({
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
  const client = (findings: Finding[]): LlmClient => ({
    async generate(req) {
      return req.schema.parse({ findings }) as never;
    },
  });
  const params = { contract, system: "s", temperature: 0.2 };

  it("sorts by severity and clamps line numbers into the file", async () => {
    const out = await auditContract({
      ...params,
      client: client([finding({ id: "F-002", severity: "low" }), finding({ location: { function: "withdraw", startLine: -5, endLine: 9999 } })]),
    });
    expect(out.map((f) => f.severity)).toEqual(["high", "low"]);
    expect(out[0]?.location.startLine).toBe(1);
    expect(out[0]?.location.endLine).toBeLessThanOrEqual(contract.numbered.split("\n").length);
  });
  it("returns an empty list for a safe contract and converts findings to issues", async () => {
    expect(await auditContract({ ...params, client: client([]) })).toEqual([]);
    expect(findingsToIssues([finding({})])[0]).toMatchObject({ origin: "llm", category: "reentrancy", function: "withdraw" });
  });
  it("rejects output with a category outside the fixed list", () => {
    expect(() => AuditOutput.parse({ findings: [{ ...finding({}), category: "magic" }] })).toThrow();
  });
});

describe("Slither integration (real binary)", () => {
  it("finds reentrancy in ReentrancyVault", async () => {
    const r = await runSlither(path.join(REPO_ROOT, "contracts/samples/vulnerable/ReentrancyVault.sol"));
    expect(r.issues.some((i) => i.category === "reentrancy" && i.function === "withdraw")).toBe(true);
  }, 120_000);
});
