import type { Pricing } from "../config.js";

/** Thrown when a run goes over --max-cost. The CLI maps it to exit code 3. */
export class BudgetExceededError extends Error {
  constructor(
    public readonly spentUsd: number,
    public readonly capUsd: number,
  ) {
    super(`Cost cap exceeded: spent $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)} allowed`);
    this.name = "BudgetExceededError";
  }
}

export class CostTracker {
  private spent = 0;
  private inTokens = 0;
  private outTokens = 0;

  constructor(
    private readonly pricing: Pricing,
    private readonly capUsd: number,
  ) {}

  get totalUsd(): number {
    return this.spent;
  }
  get totalTokens(): { input: number; output: number } {
    return { input: this.inTokens, output: this.outTokens };
  }

  /** Cost of one call. Prices are USD per 1M tokens. Unknown model = error, never a silent $0. */
  costOf(model: string, inputTokens: number, outputTokens: number): number {
    const p = this.pricing[model];
    if (!p) throw new Error(`No pricing for model "${model}" in config/pricing.yaml`);
    return (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
  }

  record(model: string, inputTokens: number, outputTokens: number): number {
    const cost = this.costOf(model, inputTokens, outputTokens);
    this.spent += cost;
    this.inTokens += inputTokens;
    this.outTokens += outputTokens;
    return cost;
  }

  /** Called before every API call, so a run stops as soon as the cap is passed. */
  assertWithinBudget(): void {
    if (this.spent >= this.capUsd) throw new BudgetExceededError(this.spent, this.capUsd);
  }
}
