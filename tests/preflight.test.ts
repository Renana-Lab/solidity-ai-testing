import { describe, expect, it } from "vitest";
import { geminiPart } from "../src/cli/audit.js";
import { checkForgeAvailable } from "../src/foundry/preflight.js";
import { ToolMissingError } from "../src/foundry/runner.js";
import { injectedBanner } from "../src/report/markdown.js";

describe("checkForgeAvailable", () => {
  it("passes when forge --version runs", async () => {
    await expect(checkForgeAvailable(async () => ({ stdout: "forge 1.8.7" }))).resolves.toBeUndefined();
  });
  it("throws ToolMissingError (exit code 2) when forge cannot start", async () => {
    const missing = async () => {
      throw Object.assign(new Error("spawn forge ENOENT"), { code: "ENOENT" });
    };
    await expect(checkForgeAvailable(missing)).rejects.toThrow(ToolMissingError);
  });
  it("throws also when forge starts but exits with an error", async () => {
    await expect(checkForgeAvailable(async () => Promise.reject(new Error("exit 1")))).rejects.toThrow(/forge/);
  });
});

describe("--poc-from wording", () => {
  it("says where the findings came from and that no audit call was made", () => {
    expect(geminiPart(2)).toBe("Gemini: 2 findings");
    expect(geminiPart(1, "/x/y/llm-findings.json")).toBe("Gemini: 1 findings (loaded from llm-findings.json, no new audit calls)");
  });
  it("calls it a negative control only when it is one", () => {
    const plain = injectedBanner({ file: "f.json", negativeControl: false });
    expect(plain).not.toMatch(/negative control/i);
    expect(plain).toMatch(/loaded from a file/i);
    expect(injectedBanner({ file: "f.json", negativeControl: true })).toMatch(/Negative control/);
  });
});
