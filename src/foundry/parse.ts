// Pure parsers for forge output. No process spawning here, so they are easy to unit test.

export interface TestOutcome {
  suite: string;
  name: string;
  passed: boolean;
  /** Revert reason / failure message, when the test failed. */
  reason: string | null;
}

/** Parse `forge test --json`: { "<file>:<Contract>": { test_results: { "<test>": {status, reason} } } } */
export function parseForgeTestJson(raw: string): TestOutcome[] {
  // forge may print warnings before the JSON; start at the first "{".
  const start = raw.indexOf("{");
  if (start < 0) return [];
  const data = JSON.parse(raw.slice(start)) as Record<
    string,
    { test_results: Record<string, { status: string; reason: string | null }> }
  >;
  const out: TestOutcome[] = [];
  for (const [suite, s] of Object.entries(data)) {
    for (const [name, r] of Object.entries(s.test_results)) {
      if (r.status === "Skipped") continue;
      out.push({ suite, name, passed: r.status === "Success", reason: r.reason });
    }
  }
  return out;
}

export interface FileCoverage {
  file: string;
  linesFound: number;
  linesHit: number;
  branchesFound: number;
  branchesHit: number;
  /** Functions that no test executed. Handy for the "uncovered functions" report section. */
  uncoveredFunctions: string[];
}

/** Parse lcov: SF=file, DA=line,hits, BRDA=line,block,branch,taken, FN/FNDA = functions. */
export function parseLcov(lcov: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let cur: FileCoverage | null = null;
  for (const line of lcov.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      cur = { file: line.slice(3), linesFound: 0, linesHit: 0, branchesFound: 0, branchesHit: 0, uncoveredFunctions: [] };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("DA:")) {
      const hits = Number(line.slice(3).split(",")[1]);
      cur.linesFound++;
      if (hits > 0) cur.linesHit++;
    } else if (line.startsWith("BRDA:")) {
      const taken = line.slice(5).split(",")[3];
      cur.branchesFound++;
      if (taken !== "-" && Number(taken) > 0) cur.branchesHit++;
    } else if (line.startsWith("FNDA:")) {
      const [hits, ...nameParts] = line.slice(5).split(",");
      if (Number(hits) === 0) cur.uncoveredFunctions.push(nameParts.join(","));
    } else if (line === "end_of_record") {
      files.push(cur);
      cur = null;
    }
  }
  return files;
}

export function percent(hit: number, found: number): number | null {
  return found === 0 ? null : Math.round((hit / found) * 10000) / 100;
}
