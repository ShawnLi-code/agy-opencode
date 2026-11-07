import { createHash } from "node:crypto";

export interface TurnLimits {
  maxToolCalls: number;
  maxTurnMs: number;
  maxRepeatedResults: number;
}
export const DEFAULT_TURN_LIMITS: TurnLimits = {
  maxToolCalls: 200,
  maxTurnMs: 20 * 60_000,
  maxRepeatedResults: 8,
};
export interface SafetyStop { code: string; message: string }

/** One user turn, not one HTTP span. All limits are finite and fail closed. */
export class TurnSafety {
  private timer?: ReturnType<typeof setTimeout>;
  private reserved = new Set<string>();
  private completed = new Set<string>();
  private previous = "";
  private repeats = 0;
  private ended = false;
  reason?: SafetyStop;

  constructor(readonly limits: TurnLimits, private readonly onStop: (reason: SafetyStop) => void = () => {}) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Turn safety limits must be positive finite integers");
    }
    this.timer = setTimeout(() => this.stop("AGY_TURN_TIME_LIMIT", `本轮已达到总时长上限 ${limits.maxTurnMs}ms`), limits.maxTurnMs);
    this.timer.unref?.();
  }

  get active(): boolean { return !this.ended; }
  get toolCalls(): number { return this.reserved.size; }
  getReason(): SafetyStop | undefined { return this.reason; }

  reserve(id: string): boolean {
    if (this.reason || this.ended) return false;
    if (this.reserved.has(id)) return true;
    if (this.reserved.size >= this.limits.maxToolCalls) {
      this.stop("AGY_TOOL_CALL_LIMIT", `本轮已达到 ${this.limits.maxToolCalls} 次工具调用上限`);
      return false;
    }
    this.reserved.add(id);
    return true;
  }

  complete(id: string, tool: string, args: unknown, output: unknown): void {
    if (this.reason || this.ended || this.completed.has(id)) return;
    if (!this.reserve(id)) return;
    this.completed.add(id);
    const fingerprint = createHash("sha256").update(stable({ tool, args, output })).digest("hex");
    this.repeats = fingerprint === this.previous ? this.repeats + 1 : 1;
    this.previous = fingerprint;
    if (this.repeats >= this.limits.maxRepeatedResults) {
      this.stop("AGY_NO_PROGRESS", `连续 ${this.repeats} 次工具名称、参数和结果完全相同，疑似空转`);
    }
  }

  stop(code: string, detail: string): void {
    if (this.reason || this.ended) return;
    this.reason = { code, message: `${code}: ${detail}。已暂停本轮，避免继续消耗；请发送新消息继续，或先提高 taskBudget 对应上限。` };
    this.finish();
    this.onStop(this.reason);
  }

  finish(): void {
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item) ?? "null";
}
