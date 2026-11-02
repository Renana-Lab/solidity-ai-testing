import { describe, expect, it } from "vitest";
import { nodeVersionOk, parseVersion, runChecks } from "../src/cli/doctor.js";

describe("doctor helpers", () => {
  it("parses versions from tool output", () => {
    expect(parseVersion("forge 1.2.3-stable (abc)")).toBe("1.2.3");
    expect(parseVersion("no version here")).toBeNull();
  });

  it("accepts node 20+ only", () => {
    expect(nodeVersionOk("v20.0.0")).toBe(true);
    expect(nodeVersionOk("v18.19.0")).toBe(false);
  });

  it("never leaks the API key in its output", async () => {
    const results = await runChecks({ GEMINI_API_KEY: "super-secret-123" });
    const key = results.find((r) => r.name === "GEMINI_API_KEY");
    expect(key?.ok).toBe(true);
    expect(JSON.stringify(results)).not.toContain("super-secret-123");
    // This test really starts forge, slither and solc-select (Python tools start slowly).
  }, 30_000);
});
