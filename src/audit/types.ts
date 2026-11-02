import type { Category, Severity } from "../llm/schemas.js";

/** One issue in a common shape, whatever produced it (Gemini, Slither or the ground truth). */
export interface Issue {
  origin: "llm" | "slither" | "truth";
  category: Category;
  severity: Severity;
  /** Function name without parameters; "" when unknown. */
  function: string;
  startLine: number;
  endLine: number;
  title: string;
  /** Detector name for Slither, finding id for the LLM. */
  ref?: string;
}

export interface MatchResult {
  matched: Array<{ a: Issue; b: Issue }>;
  aOnly: Issue[];
  bOnly: Issue[];
  /** Issues with severity "info" are not counted (spec section 12). */
  ignoredInfo: number;
}
