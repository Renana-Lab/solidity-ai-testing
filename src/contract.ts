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

/** Read a .sol file, find its name and pragma, and add line numbers (spec 5, ContractLoader). */
export function loadContract(filePath: string, maxTokens: number): LoadedContract {
  const source = readFileSync(filePath, "utf8");
  const name = source.match(/^\s*(?:abstract\s+)?contract\s+(\w+)/m)?.[1];
  if (!name) throw new Error(`No "contract" declaration found in ${filePath}`);
  const pragma = source.match(/^\s*pragma\s+solidity\s+([^;]+);/m)?.[1]?.trim() ?? null;
  const lines = source.split(/\r?\n/);
  const width = String(lines.length).length;
  const numbered = lines.map((l, i) => `${String(i + 1).padStart(width, " ")}: ${l}`).join("\n");
  // Rough rule of thumb: 1 token is about 4 characters.
  const estimatedTokens = Math.ceil(source.length / 4);
  if (estimatedTokens > maxTokens) {
    throw new ContractTooLargeError(`Contract is about ${estimatedTokens} tokens; the limit is ${maxTokens} (config maxContractTokens)`);
  }
  return { path: filePath, fileName: path.basename(filePath), contractName: name, pragma, source, numbered, estimatedTokens };
}
