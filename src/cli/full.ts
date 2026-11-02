import { audit, type AuditFlags } from "./audit.js";
import { genTests } from "./genTests.js";

export interface FullFlags extends Omit<AuditFlags, "poc" | "pocFrom" | "negativeControl" | "groundTruth"> {
  maxRepairs?: number;
  minCoverage: number;
}

/** `sat full <file.sol>`: gen-tests, then audit with PoC confirmation. Returns the first non-zero exit code. */
export async function full(file: string, flags: FullFlags): Promise<number> {
  const testsCode = await genTests(file, { ...flags, minCoverage: flags.minCoverage });
  // A cost-cap stop (3) or API error (4) in the first step would repeat in the second; stop there.
  if (testsCode !== 0) return testsCode;
  return audit(file, { ...flags, poc: true });
}
