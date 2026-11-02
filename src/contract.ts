import { readFileSync } from "node:fs";
import path from "node:path";

export interface LoadedContract {
  path: string;
  fileName: string;
  /** First contract name found in the file. */
  contractName: string;
  pragma: string | null;
  source: string;
  /** Source with "  12: " style line numbers, as sent to the model. */
  numbered: string;
  estimatedTokens: number;
}

export class ContractTooLargeError extends Error {}

/**
 * Blank out all comments but keep every newline, so line numbers stay the same.
 * Used for audits: comments such as "INTENTIONALLY VULNERABLE" would give the answer
 * away, and comments are also where prompt-injection text would hide.
 * String literals are respected, so "http://x" inside a string is not a comment.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (c === "/" && next === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
    } else if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < src.length && src[i] !== quote && src[i] !== "\n") {
        if (src[i] === "\\") {
          out += src[i]! + (src[i + 1] ?? "");
          i += 2;
        } else {
          out += src[i];
          i++;
        }
      }
      if (i < src.length && src[i] === quote) {
        out += quote;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Replace the contract's name (in the code and in the metadata) with "Target".
 * Names like "ReentrancyVault" or "TxOriginWallet" would give the answer away in a benchmark.
 * Only the copy sent to the model is changed; the report still uses the real name.
 */
export function anonymize(c: LoadedContract): LoadedContract {
  const rename = (s: string) => s.replace(new RegExp(`\\b${c.contractName}\\b`, "g"), "Target");
  return { ...c, fileName: "Target.sol", contractName: "Target", numbered: rename(c.numbered) };
}

/** Read a .sol file, find its name and pragma, and add line numbers (spec 5, ContractLoader). */
export function loadContract(filePath: string, maxTokens: number, opts: { stripComments?: boolean } = {}): LoadedContract {
  const source = readFileSync(filePath, "utf8");
  const shown = opts.stripComments ? stripComments(source) : source;
  const name = source.match(/^\s*(?:abstract\s+)?contract\s+(\w+)/m)?.[1];
  if (!name) throw new Error(`No "contract" declaration found in ${filePath}`);
  const pragma = source.match(/^\s*pragma\s+solidity\s+([^;]+);/m)?.[1]?.trim() ?? null;
  const lines = shown.split(/\r?\n/);
  const width = String(lines.length).length;
  const numbered = lines.map((l, i) => `${String(i + 1).padStart(width, " ")}: ${l}`).join("\n");
  // Rough rule of thumb: 1 token is about 4 characters.
  const estimatedTokens = Math.ceil(source.length / 4);
  if (estimatedTokens > maxTokens) {
    throw new ContractTooLargeError(`Contract is about ${estimatedTokens} tokens; the limit is ${maxTokens} (config maxContractTokens)`);
  }
  return { path: filePath, fileName: path.basename(filePath), contractName: name, pragma, source, numbered, estimatedTokens };
}
