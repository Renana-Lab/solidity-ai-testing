import { execa } from "execa";
import { ToolMissingError } from "./runner.js";

/** A function that runs `forge --version`. Injected so tests do not need forge. */
export type ForgeProbe = () => Promise<unknown>;

const realProbe: ForgeProbe = () => execa("forge", ["--version"], { timeout: 20_000 });

/**
 * Fail fast, before any paid Gemini call, if forge is missing or does not run.
 * Throws ToolMissingError (exit code 2).
 */
export async function checkForgeAvailable(probe: ForgeProbe = realProbe): Promise<void> {
  try {
    await probe();
  } catch {
    throw new ToolMissingError("forge (it must start with `forge --version`)");
  }
}
