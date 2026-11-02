import type { Issue, MatchResult } from "./types.js";

/** Share of the SMALLER line range that the two ranges have in common (0..1). */
export function lineOverlap(a: Issue, b: Issue): number {
  const lo = Math.max(a.startLine, b.startLine);
  const hi = Math.min(a.endLine, b.endLine);
  if (hi < lo) return 0;
  const smaller = Math.min(a.endLine - a.startLine, b.endLine - b.startLine) + 1;
  return (hi - lo + 1) / smaller;
}

/**
 * Spec section 12: the same category AND (the same function OR at least 50% line overlap).
 * The category must always match; otherwise an unrelated issue on the same lines would count.
 */
export function isMatch(a: Issue, b: Issue): boolean {
  if (a.category !== b.category) return false;
  const sameFunction = a.function !== "" && a.function.toLowerCase() === b.function.toLowerCase();
  return sameFunction || lineOverlap(a, b) >= 0.5;
}

/** One-to-one greedy matching of two lists of issues. "info" issues are left out. */
export function matchIssues(aAll: Issue[], bAll: Issue[]): MatchResult {
  const a = aAll.filter((i) => i.severity !== "info");
  const b = bAll.filter((i) => i.severity !== "info");
  const ignoredInfo = aAll.length - a.length + (bAll.length - b.length);

  const usedB = new Set<number>();
  const matched: MatchResult["matched"] = [];
  const aOnly: Issue[] = [];
  for (const x of a) {
    // Prefer the candidate with the largest line overlap.
    let best = -1;
    let bestOverlap = -1;
    b.forEach((y, j) => {
      if (usedB.has(j) || !isMatch(x, y)) return;
      const o = lineOverlap(x, y);
      if (o > bestOverlap) {
        best = j;
        bestOverlap = o;
      }
    });
    if (best >= 0) {
      usedB.add(best);
      matched.push({ a: x, b: b[best]! });
    } else {
      aOnly.push(x);
    }
  }
  const bOnly = b.filter((_, j) => !usedB.has(j));
  return { matched, aOnly, bOnly, ignoredInfo };
}

export interface Scores {
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

/** Score a list of reported issues against the ground truth. */
export function score(found: Issue[], truth: Issue[]): Scores {
  const m = matchIssues(found, truth);
  const tp = m.matched.length;
  const fp = m.aOnly.length;
  const fn = m.bOnly.length;
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return { tp, fp, fn, precision, recall, f1 };
}
