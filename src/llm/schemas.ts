import { z } from "zod";

// Defined once in zod. They are converted to JSON Schema for Gemini's structured
// output, and the reply is validated again with zod when it arrives.

export const GenTestsOutput = z.object({
  testFileName: z.string().describe("File name ending in .t.sol, e.g. Counter.t.sol"),
  solidity: z.string().describe("Complete Foundry test file source"),
  rationale: z.string(),
  coveredFunctions: z.array(z.string()),
});
export type GenTestsOutput = z.infer<typeof GenTestsOutput>;

export const RepairOutput = z.object({
  solidity: z.string().describe("Complete corrected Foundry test file source"),
  changes: z.array(z.string()),
  behaviorNotes: z.array(z.string()),
});
export type RepairOutput = z.infer<typeof RepairOutput>;

export const PocOutput = z.object({
  testFileName: z.string().describe("File name ending in .t.sol, e.g. Poc_F001.t.sol"),
  solidity: z.string().describe("Complete Foundry test file that exploits the finding"),
  assertionExplanation: z.string().describe("What the assertions prove about the exploit"),
});
export type PocOutput = z.infer<typeof PocOutput>;

// ---- Audit (spec 9.1) ----

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const CATEGORIES = [
  "reentrancy",
  "access-control",
  "arithmetic",
  "tx-origin",
  "front-running",
  "timestamp",
  "dos",
  "unchecked-call",
  "other",
] as const;

export type Severity = (typeof SEVERITIES)[number];
export type Category = (typeof CATEGORIES)[number];

export const Finding = z.object({
  id: z.string().describe("F-001, F-002, ..."),
  title: z.string(),
  severity: z.enum(SEVERITIES),
  swc: z.string().optional().describe("e.g. SWC-107"),
  category: z.enum(CATEGORIES),
  location: z.object({
    contract: z.string().optional(),
    function: z.string().describe("Function name without parameters; use 'constructor' or '' if none"),
    startLine: z.number().int(),
    endLine: z.number().int(),
  }),
  description: z.string(),
  exploitScenario: z.string(),
  suggestedFix: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Finding = z.infer<typeof Finding>;

export const AuditOutput = z.object({ findings: z.array(Finding) });
export type AuditOutput = z.infer<typeof AuditOutput>;
