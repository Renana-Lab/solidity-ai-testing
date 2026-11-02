// LLM-written Solidity must not be able to leave the sandbox (spec section 16).
// foundry.toml already sets ffi=false and no fs_permissions; this is a second line of defence
// that rejects the test text itself before anything runs.

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bvm\s*\.\s*ffi\b/, "vm.ffi (runs shell commands)"],
  [/\bvm\s*\.\s*(createFork|createSelectFork|selectFork|rpc|rpcUrl|rpcUrls)\b/, "fork / rpc cheatcodes"],
  [/\bvm\s*\.\s*(readFile|readFileBinary|writeFile|writeFileBinary|writeLine|removeFile|readDir|readLink|closeFile|copyFile|createDir|removeDir|fsMetadata|exists|isFile|isDir|projectRoot|getCode|getDeployedCode)\b/, "file system cheatcodes"],
  // vm.env* would let a test read process environment variables such as GEMINI_API_KEY.
  [/\bvm\s*\.\s*(env[A-Za-z]*|setEnv)\b/, "environment cheatcodes (could read secrets)"],
  [/\bvm\s*\.\s*(prompt|promptSecret|prompt[A-Za-z]*)\b/, "interactive prompt cheatcodes"],
];

// Extra rules for exploit tests: cheatcodes that could FAKE the result of an exploit.
const FORBIDDEN_POC: Array<[RegExp, string]> = [
  [/\bvm\s*\.\s*(store|etch|mockCall|mockCallRevert|mockFunction)\b/, "cheatcodes that fake state or results (store/etch/mockCall)"],
];

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** Returns a list of violations; an empty list means the test text is acceptable. */
export function findUnsafeCode(solidity: string): string[] {
  // Strip comments first so a mention in a comment does not trigger a false alarm.
  const code = stripComments(solidity);
  return FORBIDDEN.filter(([re]) => re.test(code)).map(([, why]) => why);
}

/**
 * Checks for exploit tests: the sandbox rules above, plus a few cheap sanity checks that a
 * test really exercises the target. A test that passes without touching the contract would
 * "confirm" any finding, so it is rejected before it runs.
 */
export function findPocProblems(solidity: string, contractName: string): string[] {
  const code = stripComments(solidity);
  const problems = [...findUnsafeCode(solidity), ...FORBIDDEN_POC.filter(([re]) => re.test(code)).map(([, why]) => why)];
  // Remove import lines, then require that the contract is actually used (deployed or cast).
  const body = code.replace(/^\s*import[^;]*;/gm, "");
  if (!new RegExp(`\\b${contractName}\\b`).test(body)) problems.push(`the test never uses the target contract "${contractName}"`);
  if (!/\bfunction\s+test\w*\s*\(/.test(code)) problems.push("no test function (name must start with test)");
  if (!/\bassert[A-Za-z]*\s*\(|\bvm\s*\.\s*expectRevert\b/.test(code)) problems.push("no assertion that could fail");
  if (/\bassertTrue\s*\(\s*true\s*\)|\bassertEq\s*\(\s*(\w+)\s*,\s*\1\s*\)/.test(code)) problems.push("contains a vacuous assertion (always true)");
  return problems;
}
