import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { Issue } from "../audit/types.js";
import { CATEGORIES, SEVERITIES } from "../llm/schemas.js";

const GroundTruthSchema = z.object({
  contracts: z.array(
    z.object({
      file: z.string(),
      findings: z.array(
        z.object({
          category: z.enum(CATEGORIES),
          swc: z.string().optional(),
          function: z.string(),
          lines: z.tuple([z.number().int(), z.number().int()]),
          severity: z.enum(SEVERITIES),
        }),
      ),
    }),
  ),
});
export type GroundTruth = z.infer<typeof GroundTruthSchema>;

export function loadGroundTruth(file: string): GroundTruth {
  return GroundTruthSchema.parse(parse(readFileSync(file, "utf8")));
}

/**
 * Find the entry for a contract by the END of its path, e.g. ".../samples/vulnerable/X.sol"
 * matches "vulnerable/X.sol". Returns null when the contract is not in the file.
 */
export function truthFor(gt: GroundTruth, contractPath: string): Issue[] | null {
  const norm = contractPath.replace(/\\/g, "/");
  const entry = gt.contracts.find((c) => norm.endsWith(`/${c.file}`) || norm === c.file);
  if (!entry) return null;
  return entry.findings.map((f) => ({
    origin: "truth" as const,
    category: f.category,
    severity: f.severity,
    function: f.function,
    startLine: f.lines[0],
    endLine: f.lines[1],
    title: f.swc ?? f.category,
  }));
}

export const DEFAULT_GROUND_TRUTH = path.join("contracts", "samples", "ground-truth.yaml");
