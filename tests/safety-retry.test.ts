import { describe, expect, test } from "bun:test";
import { registerTurnIdentity } from "../src/provider/turn-identity";
import { DEFAULT_TURN_LIMITS, formatTurnDuration, TurnSafety } from "../src/provider/turn-safety";

describe("agy task-budget retry policy", () => {
  test("stops only terminal agy budget errors, not transient or other-provider failures", async () => {
    const hooks = new Map<string, (event: any) => void>();
    const scopes = new Map<string, unknown>();
    await registerTurnIdentity({ session: { hook: async (name: string, fn: (event: any) => void, scope: unknown) => { hooks.set(name, fn); scopes.set(name, scope); } } });
    const retry = hooks.get("retry")!;
    expect(scopes.get("retry")).toEqual({ providerID: "agy-cli" });
    for (const code of ["AGY_TURN_TIME_LIMIT", "AGY_TOOL_CALL_LIMIT", "AGY_NO_PROGRESS", "AGY_TOOL_FAILURE_LIMIT"]) {
      const event = { model: { providerID: "agy-cli" }, error: { message: `agy stopped: ${code}: stop` }, decision: { retry: true, delay: 1000 } };
      retry(event);
      expect(event.decision).toEqual({ retry: false });
    }
    for (const event of [
      { model: { providerID: "other" }, error: { message: "AGY_TURN_TIME_LIMIT" }, decision: { retry: true, delay: 1000 } },
      { model: { providerID: "agy-cli" }, error: { message: "503 temporarily unavailable" }, decision: { retry: true, delay: 1000 } },
    ]) {
      retry(event);
      expect(event.decision).toEqual({ retry: true, delay: 1000 });
    }
  });

  test("default budget is four hours and a short timer still trips once", async () => {
    expect(DEFAULT_TURN_LIMITS).toEqual({ maxToolCalls: 200, maxTurnMs: 4 * 60 * 60_000, maxRepeatedResults: 8 });
    expect(formatTurnDuration(DEFAULT_TURN_LIMITS.maxTurnMs)).toBe("4 小时");
    let stops = 0;
    const safety = new TurnSafety({ maxToolCalls: 200, maxTurnMs: 20, maxRepeatedResults: 8 }, () => { stops++; });
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(stops).toBe(1);
    expect(safety.getReason()?.code).toBe("AGY_TURN_TIME_LIMIT");
    expect(safety.reserve("after-stop")).toBe(false);
  });
});
