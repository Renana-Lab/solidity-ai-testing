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
