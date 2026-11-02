import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GeminiClient, LlmApiError, LlmOutputError, Transport, thinkingConfigFor } from "../src/llm/client.js";
import { BudgetExceededError, CostTracker } from "../src/llm/cost.js";

const pricing = { m: { input: 1, output: 10 } }; // $ per 1M tokens
const schema = z.object({ ok: z.boolean() });
const req = { step: "t", system: "s", user: "u", schema, temperature: 0 };
const noSleep = async () => {};

function client(transport: Transport, cap = 1, extra: object = {}) {
  const cost = new CostTracker(pricing, cap);
  return { cost, c: new GeminiClient({ transport, model: "m", cost, sleep: noSleep, maxRetries: 3, ...extra }) };
}
const reply = (text: string, i = 1000, o = 1000) => ({ text, inputTokens: i, outputTokens: o });

describe("CostTracker", () => {
  it("computes cost from per-million prices", () => {
    const t = new CostTracker(pricing, 1);
    expect(t.record("m", 1_000_000, 100_000)).toBeCloseTo(2); // 1*1 + 0.1*10
  });
  it("fails loudly on a model without pricing", () => {
    expect(() => new CostTracker(pricing, 1).record("nope", 1, 1)).toThrow(/No pricing/);
  });
  it("throws once the cap is reached", () => {
    const t = new CostTracker(pricing, 0.001);
    t.record("m", 1_000_000, 0);
    expect(() => t.assertWithinBudget()).toThrow(BudgetExceededError);
  });
});

describe("thinkingConfigFor", () => {
  it("uses a token budget for 2.5 and a level for newer models", () => {
    expect(thinkingConfigFor("gemini-2.5-pro", "low")).toEqual({ thinkingBudget: 1024 });
    expect(thinkingConfigFor("gemini-3.8-flash", "low")).toEqual({ thinkingLevel: "LOW" });
    expect(thinkingConfigFor("gemini-4-argon", undefined)).toBeUndefined();
  });
});

describe("GeminiClient", () => {
  it("returns validated JSON and logs tokens and cost", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sat-"));
    const logPath = path.join(dir, "llm-calls.jsonl");
    const { c, cost } = client(async () => reply('{"ok":true}'), 1, { logPath });
    expect(await c.generate(req)).toEqual({ ok: true });
    const line = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(line).toMatchObject({ step: "t", model: "m", inputTokens: 1000, outputTokens: 1000, retries: 0 });
    expect(cost.totalUsd).toBeGreaterThan(0);
  });

  it("retries on 429 then succeeds", async () => {
    let calls = 0;
    const { c } = client(async () => {
      if (++calls < 3) throw Object.assign(new Error("rate limited"), { status: 429 });
      return reply('{"ok":true}');
    });
    expect(await c.generate(req)).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("records why each retry happened in the log", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sat-"));
    const logPath = path.join(dir, "llm-calls.jsonl");
    let calls = 0;
    const { c } = client(
      async () => {
        if (++calls < 2) throw Object.assign(new Error("overloaded"), { status: 503 });
        return reply('{"ok":true}');
      },
      1,
      { logPath },
    );
    await c.generate(req);
    const line = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(line.retries).toBe(1);
    expect(line.retryReasons[0]).toMatch(/503 after \d+ms: overloaded/);
  });

  it("does not retry other 4xx errors", async () => {
    let calls = 0;
    const { c } = client(async () => {
      calls++;
      throw Object.assign(new Error("bad request"), { status: 400 });
    });
    await expect(c.generate(req)).rejects.toThrow(LlmApiError);
    expect(calls).toBe(1);
  });

  it("gives up after maxRetries", async () => {
    let calls = 0;
    const { c } = client(async () => {
      calls++;
      throw Object.assign(new Error("down"), { status: 503 });
    });
    await expect(c.generate(req)).rejects.toThrow(LlmApiError);
    expect(calls).toBe(4); // first try + 3 retries
  });

  it("retries once with the error message when the JSON is invalid", async () => {
    const users: string[] = [];
    let n = 0;
    const { c } = client(async (p) => {
      users.push(p.user);
      return reply(n++ === 0 ? '{"ok":"yes"}' : '{"ok":true}');
    });
    expect(await c.generate(req)).toEqual({ ok: true });
    expect(users[1]).toContain("previous reply was invalid");
  });

  it("throws LlmOutputError if the retry is invalid too", async () => {
    const { c } = client(async () => reply("not json"));
    await expect(c.generate(req)).rejects.toThrow(LlmOutputError);
  });

  it("stops at the cost cap and makes no further calls", async () => {
    let calls = 0;
    // each call costs $1+$10 per 1M tokens -> 1M in + 1M out = $11, cap is $1
    const { c } = client(async () => {
      calls++;
      return reply('{"ok":true}', 1_000_000, 1_000_000);
    });
    await c.generate(req);
    await expect(c.generate(req)).rejects.toThrow(BudgetExceededError);
    expect(calls).toBe(1);
  });

  it("retries a timeout once, then gives up", async () => {
    let calls = 0;
    const { c } = client(async () => {
      calls++;
      throw Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    });
    await expect(c.generate(req)).rejects.toThrow(/timed out twice/);
    expect(calls).toBe(2);
  });

  it("passes the thinking level through to the transport", async () => {
    let seen: string | undefined;
    const { c } = client(async (p) => {
      seen = p.thinking;
      return reply('{"ok":true}');
    });
    await c.generate({ ...req, thinking: "low" });
    expect(seen).toBe("low");
  });

  it("never leaks the API key in error messages", async () => {
    process.env.GEMINI_API_KEY = "AIzaSyFAKEFAKEFAKEFAKEFAKEFAKE123456";
    const { c } = client(async () => {
      throw Object.assign(new Error(`bad key ${process.env.GEMINI_API_KEY}`), { status: 400 });
    });
    await expect(c.generate(req)).rejects.toThrow(/REDACTED/);
    delete process.env.GEMINI_API_KEY;
  });
});
