import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { REPO_ROOT } from "./util.js";

const ConfigSchema = z.object({
  model: z.string(),
  flashModel: z.string(),
  proModel: z.string(),
  temperature: z.object({ audit: z.number(), genTests: z.number() }),
  thinking: z.object({
    genTests: z.enum(["minimal", "low", "medium", "high"]),
    audit: z.enum(["minimal", "low", "medium", "high"]),
  }),
  callTimeoutMs: z.number().int().positive(),
  maxCostUsd: z.number().positive(),
  concurrency: z.number().int().positive(),
  maxRpm: z.number().positive(),
  maxRetries: z.number().int().min(0),
  maxRepairs: z.number().int().min(0),
  maxContractTokens: z.number().int().positive(),
});
export type Config = z.infer<typeof ConfigSchema>;

const PricingSchema = z.object({
  models: z.record(z.string(), z.object({ input: z.number(), output: z.number() })),
});
export type Pricing = z.infer<typeof PricingSchema>["models"];

function readYaml(rel: string): unknown {
  return parse(readFileSync(path.join(REPO_ROOT, rel), "utf8"));
}

/** config/default.yaml, with env vars (see .env.example) overriding it. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = ConfigSchema.parse(readYaml("config/default.yaml"));
  if (env.GEMINI_MODEL) cfg.model = env.GEMINI_MODEL;
  if (env.SAT_MAX_COST_USD) cfg.maxCostUsd = Number(env.SAT_MAX_COST_USD);
  if (env.SAT_CONCURRENCY) cfg.concurrency = Number(env.SAT_CONCURRENCY);
  return ConfigSchema.parse(cfg);
}

/** Prices live in config/pricing.yaml, never in code. */
export function loadPricing(): Pricing {
  return PricingSchema.parse(readYaml("config/pricing.yaml")).models;
}

/** Prompts are Markdown files in prompts/, not strings inside the code. */
export function loadPrompt(name: string): string {
  return readFileSync(path.join(REPO_ROOT, "prompts", name), "utf8");
}
