// Sums calls, cost and retries over the saved runs in a folder: node scripts/m4-summary.cjs reports/m4-run
const fs = require("fs"), p = require("path");
const root = process.argv[2];
let calls = 0, cost = 0, retries = 0, r503 = 0, lat = 0;
for (const d of fs.readdirSync(root)) {
  const f = p.join(root, d, "llm-calls.jsonl");
  const L = fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const c = L.reduce((a, l) => a + l.costUsd, 0);
  calls += L.length; cost += c;
  for (const l of L) { retries += l.retries; lat += l.latencyMs; for (const x of l.retryReasons ?? []) if (/^503/.test(x)) r503++; }
  console.log(d.slice(16), L.length + " calls", "$" + c.toFixed(4));
}
console.log({ calls, cost: cost.toFixed(4), retries, retries503: r503, apiSecs: Math.round(lat / 1000) });
