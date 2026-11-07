/**
 * Runtime configuration for the provider.
 *
 * Two tool modes, because they answer different questions:
 *
 * `native`
 *   agy runs its **own** tools (`read_file`, `run_command`, ...) exactly as it
 *   does in a terminal, and opencode is shown what happened. This is the
 *   "seamless" experience: agy keeps its own skills, MCP servers, project rules
 *   and context handling. The cost is that opencode's permission model and
 *   sandbox do **not** apply — agy writes files itself.
 *
 * `bridged`
 *   agy is given no tools and calls opencode's over MCP instead. opencode keeps
 *   its approvals and sandbox, but agy's own skills/rules are not involved.
 *
 * Stored next to the account file, so the desktop settings page and this module
 * agree on one location.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_TURN_LIMITS, type TurnLimits } from "./turn-safety";

/** Which side executes the tools. */
export type AgentMode = "native" | "bridged";

export interface ProviderSettings {
  /** Who runs the tools. Defaults to `native`. */
  agentMode: AgentMode;
  /**
   * When `native`, whether agy's permission requests are approved
   * automatically. `false` makes agy ask, which over ACP means the turn waits
   * for a client answer we never send — so this must be true for a usable run.
   */
  autoApproveNative: boolean;
  /**
   * Context window to advertise to opencode.
   *
   * agy's binary enforces 256K unless its own gates are patched (see the
   * `agy-context-unlock` script). Advertising more makes opencode send context
   * agy then truncates, so the default is the enforced value, not the model's
   * physical 1M.
   */
  contextWindow: number;
  /** Whether `native` mode reuses one long-lived agy session per conversation. */
  reuseSessions: boolean;
  /**
   * Minutes an open ACP session may sit idle before its worker is closed.
   * The conversation itself stays on disk and is restored with `session/load`.
   */
  acpIdleMinutes: number;
  /** Maximum open ACP sessions (agy workers) at once. */
  acpMaxSessions: number;
  /** Hard per-user-turn limits; tool-result HTTP continuations share them. */
  taskBudget: TurnLimits;
  /** Only enable after the host's real shell path passed multiline regression. */
  windowsMultilineShell: boolean;
}

/** agy enforces this unless its own gates are patched. */
export const ENFORCED_CONTEXT_WINDOW = 256_000;
/** What a patched binary allows (983,040 usable of a 1M window). */
export const UNLOCKED_CONTEXT_WINDOW = 983_040;

const DEFAULTS: ProviderSettings = {
  agentMode: "native",
  autoApproveNative: true,
  contextWindow: ENFORCED_CONTEXT_WINDOW,
  reuseSessions: true,
  acpIdleMinutes: 10,
  acpMaxSessions: 3,
  taskBudget: DEFAULT_TURN_LIMITS,
  windowsMultilineShell: false,
};

/** `~/.config/opencode/agy/settings.json` — beside `accounts.json`. */
export function settingsPath(): string {
  return join(homedir(), ".config", "opencode", "agy", "settings.json");
}

/**
 * Reads the settings, falling back to defaults for anything missing.
 *
 * A malformed file yields defaults rather than throwing: the provider has to
 * start even if the user hand-edited the JSON badly.
 *
 * @param path - override for tests.
 */
export function readSettings(path = settingsPath()): ProviderSettings {
  try {
    if (!existsSync(path)) return { ...DEFAULTS };
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ProviderSettings>;
    return {
      agentMode: raw.agentMode === "bridged" ? "bridged" : "native",
      autoApproveNative: raw.autoApproveNative !== false,
      contextWindow:
        typeof raw.contextWindow === "number" && raw.contextWindow > 0
          ? raw.contextWindow
          : DEFAULTS.contextWindow,
      reuseSessions: raw.reuseSessions !== false,
      windowsMultilineShell: raw.windowsMultilineShell === true,
      taskBudget: {
        maxToolCalls: positive(raw.taskBudget?.maxToolCalls, DEFAULT_TURN_LIMITS.maxToolCalls, 10_000),
        maxTurnMs: positive(raw.taskBudget?.maxTurnMs, DEFAULT_TURN_LIMITS.maxTurnMs, 24 * 60 * 60_000),
        maxRepeatedResults: positive(raw.taskBudget?.maxRepeatedResults, DEFAULT_TURN_LIMITS.maxRepeatedResults, 10_000),
      },
      acpIdleMinutes:
        typeof raw.acpIdleMinutes === "number" && raw.acpIdleMinutes >= 1
          ? Math.min(1440, Math.round(raw.acpIdleMinutes))
          : DEFAULTS.acpIdleMinutes,
      acpMaxSessions:
        typeof raw.acpMaxSessions === "number" && raw.acpMaxSessions >= 1
          ? Math.min(16, Math.round(raw.acpMaxSessions))
          : DEFAULTS.acpMaxSessions,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Writes the settings, creating the directory when needed. */
export function writeSettings(next: Partial<ProviderSettings>, path = settingsPath()): ProviderSettings {
  const merged = { ...readSettings(path), ...next };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(merged, null, 2), "utf8");
  } catch {
    /* a read-only config dir keeps the in-memory value */
  }
  return merged;
}

/** Environment overrides, for tests and one-off runs. */
export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderSettings {
  const base = readSettings();
  const mode = env.AGY_AGENT_MODE;
  if (mode === "native" || mode === "bridged") base.agentMode = mode;
  if (env.AGY_CONTEXT_WINDOW) {
    const n = Number(env.AGY_CONTEXT_WINDOW);
    if (Number.isFinite(n) && n > 0) base.contextWindow = n;
  }
  if (env.AGY_AUTO_APPROVE === "0") base.autoApproveNative = false;
  base.taskBudget = {
    maxToolCalls: positive(env.AGY_MAX_TOOL_CALLS, base.taskBudget.maxToolCalls, 10_000),
    maxTurnMs: positive(env.AGY_MAX_TURN_MS, base.taskBudget.maxTurnMs, 24 * 60 * 60_000),
    maxRepeatedResults: positive(env.AGY_MAX_REPEATED_RESULTS, base.taskBudget.maxRepeatedResults, 10_000),
  };
  return base;
}

function positive(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= maximum ? n : fallback;
}
