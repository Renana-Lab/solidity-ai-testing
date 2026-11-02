import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Walk up from this file until we find package.json. Works from src/ and from dist/. */
function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Could not locate repo root (package.json)");
    dir = parent;
  }
  return dir;
}

export const REPO_ROOT = findRepoRoot();

/**
 * Remove anything that looks like an API key from text before it is logged or printed.
 * The spec requires that the key never appears in logs or error messages.
 */
export function scrub(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]");
  const key = env.GEMINI_API_KEY;
  if (key && key.length >= 8) out = out.split(key).join("[REDACTED]");
  return out;
}

/** Keep the first and last part of long tool output so prompts stay small. */
export function truncateMiddle(text: string, max = 6000): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n...[truncated ${text.length - max} chars]...\n${text.slice(-half)}`;
}
