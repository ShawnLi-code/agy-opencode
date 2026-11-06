/**
 * Runs one turn through `agy` for the OpenAI-compatible provider.
 *
 * Uses the same account routing, tier mapping and timeouts as the `agy` tool,
 * so a provider call and a delegated call behave identically.
 */

import { runAgy, AgyError } from "../agy-runner";
import { loadAccounts, pickAccount, accountEnv, recordResult } from "../accounts";

export interface RunOptions {
  /** Per-turn timeout; agy can sit in a capacity queue for minutes. */
  timeout?: string | number;
}

export async function runTier(tier: string, prompt: string, options: RunOptions = {}): Promise<string> {
  const store = loadAccounts();
  const account = pickAccount(store);
  const startedAt = Date.now();

  try {
    const result = await runAgy({
      prompt,
      tier: tier as any,
      timeout: options.timeout ?? "10m",
      accountEnv: accountEnv(account),
    });
    recordResult(account.id, {
      ok: result.exitCode === 0,
      ms: Date.now() - startedAt,
      code: result.exitCode === 0 ? undefined : "AGY_FAILED",
    });
    return result.stdout;
  } catch (err) {
    recordResult(account.id, {
      ok: false,
      ms: Date.now() - startedAt,
      code: err instanceof AgyError ? err.code : "UNEXPECTED",
    });
    throw err;
  }
}
