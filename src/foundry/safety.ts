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

/** Returns a list of violations; an empty list means the test text is acceptable. */
export function findUnsafeCode(solidity: string): string[] {
  // Strip comments first so a mention in a comment does not trigger a false alarm.
  const code = solidity.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return FORBIDDEN.filter(([re]) => re.test(code)).map(([, why]) => why);
}
