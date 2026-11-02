import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ApiError, GoogleGenAI } from "@google/genai";
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
}) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;

/** Exit code 4: the API kept failing after all retries. */
export class LlmApiError extends Error {
  constructor(message: string) {
    super(scrub(message));
    this.name = "LlmApiError";
  }
}

/** The model returned JSON that did not match the schema, even after one retry. */
export class LlmOutputError extends Error {
  constructor(message: string) {
    super(scrub(message));
    this.name = "LlmOutputError";
  }
}

/** The real transport, using the official SDK with JSON-schema structured output. */
export function sdkTransport(apiKey: string): Transport {
  const ai = new GoogleGenAI({ apiKey });
  return async ({ model, system, user, temperature, jsonSchema }) => {
    const res = await ai.models.generateContent({
      model,
      contents: user,
      config: {
        systemInstruction: system,
        temperature,
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchema,
      },
    });
    const u = res.usageMetadata;
    return {
      text: res.text ?? "",
      inputTokens: u?.promptTokenCount ?? 0,
      // "Thinking" tokens are billed as output tokens.
      outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
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
          });
          const cost = this.opts.cost.record(this.opts.model, r.inputTokens, r.outputTokens);
          this.log({
            step: req.step,
            model: this.opts.model,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            costUsd: cost,
            latencyMs: Date.now() - started,
            retries: attempt,
          });
          return r.text;
        } catch (e) {
          const status = e instanceof ApiError ? e.status : (e as { status?: number }).status;
          // Retry rate limits (429), server errors (5xx) and network errors (no status).
          const retryable = status === undefined || status === 429 || status >= 500;
          const msg = e instanceof Error ? e.message : String(e);
          if (!retryable) throw new LlmApiError(`Gemini API error ${status}: ${msg}`);
          if (attempt >= this.maxRetries) throw new LlmApiError(`Gemini API failed after ${attempt + 1} attempts: ${msg}`);
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
