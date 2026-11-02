import { execa } from "execa";
import type { Issue } from "../audit/types.js";
import type { Category, Severity } from "../llm/schemas.js";
import { ToolMissingError } from "../foundry/runner.js";

/** Map a Slither detector name to one of our categories (spec 5, SlitherRunner). */
export function slitherCategory(check: string): Category {
  if (check.startsWith("reentrancy")) return "reentrancy";
  if (check === "tx-origin") return "tx-origin";
  if (check === "timestamp" || check === "weak-prng") return "timestamp";
  if (["unchecked-lowlevel", "unchecked-send", "unchecked-transfer", "unused-return"].includes(check)) return "unchecked-call";
  if (["calls-loop", "costly-loop", "controlled-array-length", "locked-ether"].includes(check)) return "dos";
  if (["arbitrary-send-eth", "arbitrary-send-erc20", "suicidal", "unprotected-upgrade", "protected-vars", "missing-zero-check", "controlled-delegatecall"].includes(check)) return "access-control";
  if (["divide-before-multiply", "incorrect-shift-in-assembly", "tautology", "boolean-cst"].includes(check)) return "arithmetic";
  return "other";
}

/** Slither's "impact" word -> our severity. Informational and Optimization count as info. */
export function slitherSeverity(impact: string): Severity {
  switch (impact.toLowerCase()) {
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return "info";
  }
}

interface SlitherElement {
  type: string;
  name: string;
  source_mapping?: { lines?: number[] };
  type_specific_fields?: { parent?: { type: string; name: string } };
}
interface SlitherDetector {
  check: string;
  impact: string;
  description: string;
  elements: SlitherElement[];
}

export class SlitherError extends Error {}

/** Turn `slither --json -` output into our common Issue shape. Pure, so it is easy to test. */
export function parseSlitherJson(raw: string): Issue[] {
  const start = raw.indexOf("{");
  if (start < 0) throw new SlitherError("Slither printed no JSON");
  const data = JSON.parse(raw.slice(start)) as { success: boolean; error: string | null; results?: { detectors?: SlitherDetector[] } };
  if (!data.success) throw new SlitherError(`Slither failed: ${data.error ?? "unknown error"}`);

  return (data.results?.detectors ?? []).map((d) => {
    // Use the first element that has line numbers. For a node/variable the enclosing function
    // is its parent; for a function element it is the element itself.
    const el = d.elements.find((e) => e.source_mapping?.lines?.length) ?? d.elements[0];
    const lines = el?.source_mapping?.lines ?? [];
    let fn = "";
    if (el?.type === "function") fn = el.name;
    else if (el?.type_specific_fields?.parent?.type === "function") fn = el.type_specific_fields.parent.name;
    return {
      origin: "slither" as const,
      category: slitherCategory(d.check),
      severity: slitherSeverity(d.impact),
      function: fn,
      startLine: lines.length ? Math.min(...lines) : 0,
      endLine: lines.length ? Math.max(...lines) : 0,
      title: d.check,
      ref: d.check,
    };
  });
}

export interface SlitherResult {
  raw: string;
  issues: Issue[];
}

/** Run Slither as a subprocess. It exits non-zero when it finds something, which is normal. */
export async function runSlither(contractPath: string): Promise<SlitherResult> {
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  try {
    const r = await execa("slither", [contractPath, "--json", "-"], { reject: false, env, extendEnv: false, timeout: 300_000 });
    return { raw: r.stdout, issues: parseSlitherJson(r.stdout) };
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") throw new ToolMissingError("slither");
    throw e;
  }
}
