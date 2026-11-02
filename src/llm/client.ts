import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ApiError, GoogleGenAI, type ThinkingLevel as SdkThinkingLevel } from "@google/genai";
import { z } from "zod";
import { scrub } from "../util.js";
import { CostTracker } from "./cost.js";

export interface GenerateRequest<T> {
  /** Name of the pipeline step, used in logs and to pick mock fixtures, e.g. "gen-tests". */
  step: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  temperature: number;
  /** How much the model may "think" before answering. Thinking tokens cost output prices. */
  thinking?: ThinkingLevel;
}

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

/** Gemini 2.5 takes a token budget; Gemini 3+ takes a named level. */
export function thinkingConfigFor(model: string, level: ThinkingLevel | undefined) {
  if (!level) return undefined;
  if (/^gemini-2\.5/.test(model)) {
    const budget = { minimal: 0, low: 1024, medium: 4096, high: 16384 }[level];
    return { thinkingBudget: budget };
  }
  return { thinkingLevel: level.toUpperCase() as SdkThinkingLevel };
}

/** Everything the rest of the code knows about an LLM. Swap in a mock for tests. */
export interface LlmClient {
  generate<T>(req: GenerateRequest<T>): Promise<T>;
}

/** The raw network call. Injected so unit tests never touch the real API. */
export type Transport = (p: {
  model: string;
  system: string;
  user: string;
  temperature: number;
  jsonSchema: unknown;
  thinking?: ThinkingLevel;
}) => Promise<{
  text: string;
  inputTokens: number;
  /** Includes thinking tokens, because they are billed as output. */
  outputTokens: number;
  /** The part of outputTokens that was thinking (for diagnosing slow calls). */
  thinkingTokens?: number;
}>;

/** True for errors caused by our per-call timeout (they are retried at most once). */
export function isTimeout(e: unknown): boolean {
  const s = `${(e as Error)?.name ?? ""} ${(e as Error)?.message ?? ""}`;
  return /timeout|timed out|AbortError/i.test(s);
}

/** Exit code 4: the API kept failing after all retries. */
export class LlmApiError extends Error {
  constructor(message: string) {
    super(scrub(message));
    this.name = "LlmApiError";
  }
}

/**
 * A 429 that will not clear by waiting a few seconds: a per-day quota (free tier) or a very long
 * retry delay. Retrying only wastes time, so this fails at once with a clear message.
 */
export function isDailyQuota(msg: string): boolean {
  if (/PerDay|per day/i.test(msg)) return true;
  const delay = msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)?.[1];
  return delay !== undefined && Number(delay) > 300;
}

/** The model returned JSON that did not match the schema, even after one retry. */
export class LlmOutputError extends Error {
  constructor(message: string) {
    super(scrub(message));
    this.name = "LlmOutputError";
  }
}

/** The real transport, using the official SDK with JSON-schema structured output. */
export function sdkTransport(apiKey: string, timeoutMs = 300_000): Transport {
  // attempts: 1 turns off the SDK's own retries; GeminiClient does all retrying,
  // so the number of attempts (and the cost) stays predictable.
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: timeoutMs, retryOptions: { attempts: 1 } } });
  return async ({ model, system, user, temperature, jsonSchema, thinking }) => {
    const res = await ai.models.generateContent({
      model,
      contents: user,
      config: {
        systemInstruction: system,
        temperature,
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchema,
        thinkingConfig: thinkingConfigFor(model, thinking),
      },
    });
    const u = res.usageMetadata;
    return {
      text: res.text ?? "",
      inputTokens: u?.promptTokenCount ?? 0,
      // "Thinking" tokens are billed as output tokens.
      outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
      thinkingTokens: u?.thoughtsTokenCount ?? 0,
    };
  };
}

export interface GeminiClientOptions {
  transport: Transport;
  model: string;
  cost: CostTracker;
  /** Path of llm-calls.jsonl; one line is appended per call. */
  logPath?: string;
  maxRetries?: number;
  maxRpm?: number;
  concurrency?: number;
  /** Injected so tests do not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GeminiClient implements LlmClient {
  private readonly maxRetries: number;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextSlot = 0;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly opts: GeminiClientOptions) {
    this.maxRetries = opts.maxRetries ?? 5;
    this.minIntervalMs = opts.maxRpm ? 60_000 / opts.maxRpm : 0;
    this.sleep = opts.sleep ?? realSleep;
    if (opts.logPath) mkdirSync(path.dirname(opts.logPath), { recursive: true });
  }

  async generate<T>(req: GenerateRequest<T>): Promise<T> {
    // zod -> JSON Schema for Gemini. "$schema" is not accepted by the API, so drop it.
    const jsonSchema = z.toJSONSchema(req.schema) as Record<string, unknown>;
    delete jsonSchema.$schema;

    let user = req.user;
    for (let validationTry = 0; validationTry < 2; validationTry++) {
      const text = await this.callWithRetries(req, user, jsonSchema);
      try {
        return req.schema.parse(JSON.parse(text));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (validationTry === 1) throw new LlmOutputError(`Invalid model output for "${req.step}": ${msg}`);
        // Spec 9.1: one retry, telling the model what was wrong.
        user = `${req.user}\n\nYour previous reply was invalid: ${msg.slice(0, 800)}\nReturn valid JSON matching the schema.`;
      }
    }
    throw new LlmOutputError("unreachable");
  }

  /** One API call with budget check, rate limit, exponential backoff + jitter, and logging. */
  private async callWithRetries(req: GenerateRequest<unknown>, user: string, jsonSchema: unknown): Promise<string> {
    this.opts.cost.assertWithinBudget();
    await this.acquire();
    try {
      let timeouts = 0;
      // Why each retry happened (status + start of the message), saved in llm-calls.jsonl.
      const retryReasons: string[] = [];
      for (let attempt = 0; ; attempt++) {
        const started = Date.now();
        try {
          await this.throttle();
          const r = await this.opts.transport({
            model: this.opts.model,
            system: req.system,
            user,
            temperature: req.temperature,
            jsonSchema,
            thinking: req.thinking,
          });
          const cost = this.opts.cost.record(this.opts.model, r.inputTokens, r.outputTokens);
          this.log({
            step: req.step,
            model: this.opts.model,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            thinkingTokens: r.thinkingTokens ?? 0,
            costUsd: cost,
            latencyMs: Date.now() - started,
            retries: attempt,
            ...(retryReasons.length ? { retryReasons } : {}),
          });
          return r.text;
        } catch (e) {
          const status = e instanceof ApiError ? e.status : (e as { status?: number }).status;
          // Retry rate limits (429), server errors (5xx) and network errors (no status).
          const retryable = status === undefined || status === 429 || status >= 500;
          const msg = e instanceof Error ? e.message : String(e);
          if (!retryable) throw new LlmApiError(`Gemini API error ${status}: ${msg}`);
          if (status === 429 && isDailyQuota(msg)) {
            const resets = msg.match(/retry in ([0-9hms.]+)/i)?.[1];
            throw new LlmApiError(
              `Gemini daily quota exhausted for model "${this.opts.model}"${resets ? ` (resets in about ${resets.replace(/\.$/, "").replace(/\.\d+s$/, "s")})` : ""}. ` +
                "This is usually the free tier (about 20 requests per day per model): use another model with --model, enable billing, or wait.",
            );
          }
          // A timeout can mean a 5-minute wait: retry it once, not maxRetries times.
          if (isTimeout(e) && ++timeouts > 1) throw new LlmApiError(`Gemini API timed out twice: ${msg}`);
          if (attempt >= this.maxRetries) throw new LlmApiError(`Gemini API failed after ${attempt + 1} attempts: ${msg}`);
          retryReasons.push(`${status ?? "no-status"} after ${Date.now() - started}ms: ${scrub(msg).slice(0, 160)}`);
          await this.sleep(1000 * 2 ** attempt + Math.random() * 500);
        }
      }
    } finally {
      this.release();
    }
  }

  /** Space calls out so we never exceed maxRpm. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    if (slot > now) await this.sleep(slot - now);
  }

  // Tiny semaphore: at most `concurrency` calls in flight (default 1).
  private async acquire(): Promise<void> {
    const limit = this.opts.concurrency ?? 1;
    if (this.active < limit) {
      this.active++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  private log(entry: Record<string, unknown>): void {
    if (!this.opts.logPath) return;
    appendFileSync(this.opts.logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }
}

/**
 * --mock <dir>: answers from recorded JSON files instead of the API.
 * Looks for "<step>.json" (e.g. gen-tests.json, repair-1.json); the last
 * available repair file is reused if more repairs are requested.
 */
export class FixtureClient implements LlmClient {
  private counts = new Map<string, number>();
  constructor(private readonly dir: string) {}

  async generate<T>(req: GenerateRequest<T>): Promise<T> {
    const n = (this.counts.get(req.step) ?? 0) + 1;
    this.counts.set(req.step, n);
    const candidates = [`${req.step}-${n}.json`, `${req.step}.json`];
    const file = candidates.map((c) => path.join(this.dir, c)).find((p) => existsSync(p));
    if (!file) throw new Error(`No mock fixture for step "${req.step}" in ${this.dir}`);
    return req.schema.parse(JSON.parse(readFileSync(file, "utf8")));
  }
}
