import type { LoadedContract } from "../contract.js";
import type { LlmClient, ThinkingLevel } from "../llm/client.js";
import { AuditOutput, Finding, SEVERITIES } from "../llm/schemas.js";
import type { Issue } from "./types.js";

export interface AuditParams {
  client: LlmClient;
  contract: LoadedContract;
  system: string;
  temperature: number;
  thinking?: ThinkingLevel;
  onPrompt?: (name: string, system: string, user: string) => void;
}

export function buildAuditPrompt(c: LoadedContract): string {
  return [`File name: ${c.fileName}`, `Contract: ${c.contractName}`, `Pragma: ${c.pragma ?? "none"}`, "<contract>", c.numbered, "</contract>"].join("\n");
}

/** Direction B: ask the model for structured findings, then sort them by severity. */
export async function auditContract(p: AuditParams): Promise<Finding[]> {
  const user = buildAuditPrompt(p.contract);
  p.onPrompt?.("audit", p.system, user);
  const out = await p.client.generate({
    step: "audit",
    system: p.system,
    user,
    schema: AuditOutput,
    temperature: p.temperature,
    thinking: p.thinking,
  });
  const lineCount = p.contract.numbered.split("\n").length;
  return out.findings
    .map((f) => ({
      ...f,
      // Keep line numbers inside the file, so a bad answer cannot break later steps.
      location: {
        ...f.location,
        startLine: clamp(f.location.startLine, 1, lineCount),
        endLine: clamp(Math.max(f.location.endLine, f.location.startLine), 1, lineCount),
      },
    }))
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Findings in the common shape used by the comparator and the evaluator. */
export function findingsToIssues(findings: Finding[]): Issue[] {
  return findings.map((f) => ({
    origin: "llm" as const,
    category: f.category,
    severity: f.severity,
    function: f.location.function,
    startLine: f.location.startLine,
    endLine: f.location.endLine,
    title: f.title,
    ref: f.id,
  }));
}
