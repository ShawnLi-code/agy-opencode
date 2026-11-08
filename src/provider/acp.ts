/**
 * Persistent ACP transport for `agy`.
 *
 * `agy --print` is one-shot: every turn spawns a process and re-sends the whole
 * conversation. ACP (`agy acp`) keeps a session server-side, streams tokens as
 * they arrive, and accepts only the new input each turn.
 *
 * Verified against agy 1.5.1: initialize → session/new → session/prompt, with
 * `session/update` notifications carrying `agent_message_chunk` text. The model
 * still honours the JSON tool envelope, so tool calling stays with opencode.
 */

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountEnv, type Account } from "../accounts";
import { allowOption, renderToolEvent, type AcpToolCallEvent } from "./native-tools";
import { recordNativeReplay } from "./replay";
import {
  catalogueFromSession,
  probeEfforts,
  readCatalogueCache,
  resolveSelection,
  writeCatalogueCache,
  type CatalogueModel,
} from "./catalogue";
import { readSettings } from "./settings";
import { CONSECUTIVE_TOOL_FAILURE_LIMIT, hasFailedToolOutput, isCommandTool, toolFailureMessage } from "./tool-failures";
import { TurnSafety } from "./turn-safety";

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

/** Usage reported by agy on `session/prompt`, in ACP naming. */
export interface AcpUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}

export interface AcpToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AcpTurnResult {
  text: string;
  parked: boolean;
  /** Native tool steps OpenCode should render and replay. */
  calls?: AcpToolCall[];
  usage?: AcpUsage;
  stopReason?: string;
  /** No activity for the whole idle budget; the prompt is still running. */
  idleTimedOut?: boolean;
  /** The prompt ended with an error after some text was already streamed. */
  error?: string;
}

interface TurnHandlers {
  onChunk: ChunkHandler;
  onThought?: (text: string) => void;
  onToolEvent?: (text: string) => void;
  nativeReplay?: boolean;
  /** How the caller reaches the replay tool: directly or through Code Mode. */
  toolWrapper?: "direct" | "code";
}

interface SessionState {
  sessionId: string;
  /** Account this session was opened on, so it can be closed on the right client. */
  accountId: string;
  /** How many user/tool inputs have already been sent to this session. */
  seenInputs: number;
  /** Exact input prefix, so edits/retries are not mistaken for tool resumes. */
  inputs?: string[];
  cancelled?: boolean;
  unsubscribe?: () => void;
  observedToolIds?: Set<string>;
  toolFailures?: number;
  safety?: TurnSafety;
  lastUsed: number;
  /**
   * The ACP session was closed to release its worker process. It can be
   * restored with `session/load`; until then no process is held for it.
   */
  closed?: boolean;
  /** Set when a turn failed mid-request, so the session must not be reused. */
  wedged?: boolean;
  /** Model family currently selected on this ACP session, if any. */
  model?: string;
  /** Thinking level currently selected on this ACP session, if any. */
  effort?: string;
  /**
   * True while an ACP prompt is running but not finished: agy is blocked on a
   * tool call, so the next OpenAI request continues the same prompt instead of
   * starting a new one.
   */
  inFlight?: boolean;
  /** Text produced since the last time the caller drained it. */
  buffer?: string;
  /** Resolves when the running prompt settles. */
  finished?: Promise<void>;
  /** Set once the running prompt has resolved. */
  done?: boolean;
  /** Text this prompt has produced in total, across drains. */
  textTotal?: string;
  /** Prompt failure, recorded so a retry can inspect it without rethrowing. */
  error?: string;
  /** True when the session was opened for native (agy-owned) tools. */
  native?: boolean;
  /** agy's reason for ending the last prompt. */
  stopReason?: string;
  /** Continuations already issued for the current turn. */
  continuations?: number;
  /** Last time agy produced any text, thought, or tool event. */
  lastActivity?: number;
  /** Tools currently executing inside agy. */
  activeTools?: number;
  /** Tool call ids counted as active, so repeated updates do not inflate it. */
  activeToolIds?: Set<string>;
  /** Completed native steps not yet returned to OpenCode. */
  pendingReplays?: AcpToolCall[];
  /** Tool call ids already mirrored for the current prompt. */
  replayed?: Set<string>;
  /** Usage from the last completed prompt. */
  usage?: AcpUsage;
  /** Wakes the waiting turn when activity arrives. */
  wake?: (() => void) | null;
}

/** Extra attempts for a turn that failed before emitting anything. */
const ACP_TURN_RETRIES = 1;
const ACP_RETRY_DELAY_MS = 1500;

/**
 * Idle budget for a turn with no open tool step.
 *
 * This is an ACTIVITY watchdog, not a deadline: every text, thought, or tool
 * event resets it. The old fixed 85-second cutoff handed a half-finished turn
 * to OpenCode as a normal `stop`, which made the session look successful while
 * agy was still working.
 */
const ACP_IDLE_MS = 10 * 60 * 1000;

/**
 * Idle budget while agy is executing a tool. A build or test run can take a
 * long time without producing assistant text, so the silence must not end the
 * turn.
 */
const ACP_LONG_TOOL_IDLE_MS = 4 * 60 * 60 * 1000;

/** The activity budget for a turn, in milliseconds. */
export function idleBudgetMs(activeTools: number | undefined): number {
  return (activeTools ?? 0) > 0 ? ACP_LONG_TOOL_IDLE_MS : ACP_IDLE_MS;
}

/**
 * Prompt sent when agy stopped because it hit its output cap.
 *
 * Deliberately narrow: it forbids repeating anything, because the model sees
 * the partial answer as its own previous turn and would otherwise restart.
 */
const CONTINUE_PROMPT = "Continue exactly where your previous output stopped. Do not repeat any earlier text.";

/** How many times one turn may be continued before giving up. */
const MAX_CONTINUATIONS = 2;

/** Resolves true when the prompt finishes inside the deadline. */
async function waitRace(prompt: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([prompt.then(() => true, () => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Keeps only the finite counters ACP reported; never invents zeros. */
export function normalizeUsage(raw: Record<string, unknown> | undefined | null): AcpUsage {
  const out: AcpUsage = {};
  if (!raw || typeof raw !== "object") return out;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const input = num(raw.inputTokens) ?? num(raw.input_tokens) ?? num(raw.prompt_tokens);
  const output = num(raw.outputTokens) ?? num(raw.output_tokens) ?? num(raw.completion_tokens);
  const read = num(raw.cachedReadTokens) ?? num(raw.cached_read_tokens) ?? num(raw.cache_read_tokens);
  const write = num(raw.cachedWriteTokens) ?? num(raw.cached_write_tokens) ?? num(raw.cache_write_tokens);
  const thought = num(raw.thoughtTokens) ?? num(raw.thinking_tokens) ?? num(raw.reasoning_tokens);
  const total = num(raw.totalTokens) ?? num(raw.total_tokens);
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (read !== undefined) out.cachedReadTokens = read;
  if (write !== undefined) out.cachedWriteTokens = write;
  if (thought !== undefined) out.thoughtTokens = thought;
  if (total !== undefined) out.totalTokens = total;
  return out;
}

/** Flattens the tool output ACP reports (`rawOutput` or `content`). */
export function toolOutputOf(event: AcpToolCallEvent): {
  output: string;
  exitCode?: number;
  error?: string;
} {
  const raw = (event as unknown as { rawOutput?: unknown }).rawOutput;
  let output = "";
  let exitCode: number | undefined;
  let error: string | undefined;
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (typeof r.output === "string") output = r.output;
    else if (typeof r["output_text"] === "string") output = r["output_text"] as string;
    if (typeof r.exit_code === "number") exitCode = r.exit_code;
    if (typeof r.exitCode === "number") exitCode = r.exitCode;
    if (typeof r.error === "string") error = r.error;
  }
  if (!output && Array.isArray(event.content)) {
    const parts: string[] = [];
    const walk = (blocks: unknown): void => {
      if (!Array.isArray(blocks)) return;
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") parts.push(b.text);
        else if (b.content) walk(Array.isArray(b.content) ? b.content : [b.content]);
      }
    };
    walk(event.content);
    output = parts.join("\n");
  }
  if (event.status === "failed" && !error) error = output.trim() || "tool failed";
  return { output, ...(exitCode !== undefined ? { exitCode } : {}), ...(error !== undefined ? { error } : {}) };
}

/**
 * Upstream transport failures worth retrying. agy surfaces a dropped connection
 * as `Post \"https://.../streamGenerateContent?alt=sse\": EOF`, sometimes wrapped
 * in \"agy acp failed: ...\". These are transient proxy/edge resets, not quota or
 * auth problems, so a single retry usually clears them.
 */
function isRetryable(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err);
  return /\bEOF\b|ECONNRESET|socket hang up|connection reset|network error|stream (?:closed|ended)|fetch failed/i.test(msg);
}

export type ChunkHandler = (text: string) => void;

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * How long an OPEN session may sit idle before its worker is released.
 *
 * A worker costs roughly 180 MB and agy runs one per session. Closing is cheap:
 * the session is stored on disk, and the next message in that conversation is
 * restored with `session/load`, history included.
 */
const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000;

/** Open workers kept at once; older idle ones are closed and reloaded on demand. */
const DEFAULT_MAX_OPEN_SESSIONS = 3;

/** Closed session records remembered for `session/load`. They hold no process. */
const DEFAULT_KEEP_SESSIONS = 64;

/** Reaper cadence, so idle workers leave even when no new turn arrives. */
const DEFAULT_SWEEP_MS = 60 * 1000;

export interface AcpPoolOptions {
  /** Idle budget for an open session before its worker is closed. */
  idleMs?: number;
  /** Maximum open ACP sessions (workers) at once. */
  maxOpen?: number;
  /** Closed session records kept for resume. */
  keep?: number;
  /** How often idle sessions are checked. */
  sweepMs?: number;
}

/**
 * A tool-free agent preset, installed by the plugin. Without it agy tries to
 * run its own tools, which we must deny — and a denial aborts the whole turn.
 */
const AGENT = process.env.AGY_ACP_AGENT ?? "agy-opencode-toolfree";

/**
 * Preset text, installed as the agent component of a local agy plugin.
 *
 * Location matters: agy 1.5.2 discovers agents only from installed plugins
 * (`agy plugin install <dir>` -> `<geminiDir>/config/plugins/<name>/agents/`).
 * The earlier target, `~/.gemini/antigravity-cli/gemini-root-config/agents`, is
 * no longer read: `agy agent` never listed the file, so `agy acp --agent` fell
 * back to the default agent, which then asked for tool permission, which this
 * transport must deny — and the denial aborted the whole turn.
 *
 * `tools: []` plus `commandExecutionPolicy: off` leaves the agent no way to act
 * on its own, so it can only answer — or emit a tool call for the caller.
 *
 * Files are written without a BOM: agy's plugin loader rejects a `plugin.json`
 * that starts with one and silently skips the entire plugin.
 */
const AGENT_PRESET = `---
name: ${AGENT}
description: Tool-free text backend for agy-opencode. opencode owns the tools.
tools: []
mainAgent: true
subagent: false
model: inherit
commandExecutionPolicy: off
mcpServers: []
skills: []
plugins: []
---

You are a text backend behind an API. Reason over the supplied conversation and
return the best response.

Do not use agy's built-in shell, file, browser, or subagent tools, and do not
delegate. The caller owns the outer conversation and tool policy. When the
session provides MCP tools, call them directly; when it does not, answer in
plain text. Never print a JSON tool-call envelope.
`;

/** Name of the local agy plugin that carries the tool-free agent. */
const AGENT_PLUGIN = "agy-opencode";

/** Manifest of the local plugin. agy refuses a manifest that starts with a BOM. */
const AGENT_PLUGIN_MANIFEST = `{
  "name": "${AGENT_PLUGIN}",
  "displayName": "agy-opencode",
  "version": "1.0.0",
  "description": "Tool-free agent used by the agy-opencode OpenCode provider."
}
`;

/**
 * Installs the tool-free agent as an agy plugin, and verifies agy actually
 * lists it.
 *
 * Two things can silently disable the agent, and both end the same way — agy
 * falls back to its default agent, asks for tool permission, we deny it, and
 * the turn dies. So this does not assume the write worked:
 *
 * 1. Wrong location. agy 1.5.2 only reads agents from installed plugins.
 * 2. Wrong encoding. A BOM in `plugin.json` makes the loader skip the plugin.
 *
 * Returns a short diagnostic instead of throwing: a missing preset degrades the
 * transport, it should not stop the provider from starting.
 */
function ensureAgentPreset(accountHome: string, env: Record<string, string>): string | null {
  const root = accountHome || homedir();
  const geminiDir = join(root, ".gemini");
  const pluginDir = join(geminiDir, "config", "plugins", AGENT_PLUGIN);
  const agentDir = join(pluginDir, "agents");
  const agentFile = join(agentDir, `${AGENT}.md`);
  const manifestFile = join(pluginDir, "plugin.json");

  try {
    mkdirSync(agentDir, { recursive: true });
    // Rewrite whenever the content differs: an older release wrote the preset to
    // a path agy no longer reads, so existence alone proves nothing.
    const manifest = readFileSync(manifestFile, "utf8");
    if (manifest !== AGENT_PLUGIN_MANIFEST) writeFileSync(manifestFile, AGENT_PLUGIN_MANIFEST, "utf8");
  } catch {
    try {
      writeFileSync(manifestFile, AGENT_PLUGIN_MANIFEST, "utf8");
    } catch {
      /* read-only home; the verification below reports it */
    }
  }

  try {
    const preset = readFileSync(agentFile, "utf8");
    if (preset !== AGENT_PRESET) writeFileSync(agentFile, AGENT_PRESET, "utf8");
  } catch {
    try {
      writeFileSync(agentFile, AGENT_PRESET, "utf8");
    } catch {
      return "cannot write agent preset";
    }
  }

  // agy only resolves agents from its plugin registry, so the file alone is not
  // enough — ask agy. This is the check that would have caught the regression.
  const listed = listAgents(env);
  if (listed === null) return "cannot run agy";
  if (!listed.includes(AGENT)) return `agy does not list ${AGENT}`;
  return null;
}

/**
 * Runs `agy agent` with the same environment agy will run under, and returns
 * the agent names it reports; null when agy cannot be run at all.
 *
 * The environment matters more than the arguments: `agy agent` has no
 * `--gemini-dir` flag, and it ignores a `GEMINI_DIR` variable. It resolves its
 * data directory from HOME/USERPROFILE, which is exactly what `accountEnv`
 * rewrites for an isolated account — so passing that env is both the correct
 * and the only way to ask about the right directory.
 */
function listAgents(env: Record<string, string>): string[] | null {
  try {
    const out = execFileSync("agy", ["agent"], {
      env,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      shell: true,
    });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** One MCP server descriptor accepted by `session/new`. */
export interface AcpMcpServer {
  type: "http";
  name: string;
  url: string;
  headers: { name: string; value: string }[];
}

class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready: Promise<void> | null = null;
  private closed = false;
  private listeners = new Set<(sessionId: string, text: string) => void>();
  /** agy's thinking stream (`agent_thought_chunk`). */
  private thoughtListeners = new Set<(sessionId: string, text: string) => void>();
  /** Observers of agy's OWN tool calls (native mode), raw so the caller can record them. */
  private toolListeners = new Set<(sessionId: string, event: AcpToolCallEvent) => void>();
  /** Non-null when the tool-free agent preset could not be installed. */
  presetError: string | null = null;
  /** True once a session was opened with an MCP bridge attached. */
  bridgeAttached = false;
  /** Native mode: agy runs its own tools, so its permission requests are real. */
  nativeTools = false;
  /** Native mode: approve agy's own permission requests automatically. */
  autoApprove = true;
  /** Agent id to spawn with; empty means agy's default (native mode). */
  agentId = AGENT;

  constructor(private readonly account: Account) {}

  private env(): Record<string, string> {
    return { ...process.env, ...accountEnv(this.account) } as Record<string, string>;
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = new Promise<void>((resolve, reject) => {
      const env = this.env();
      // The preset only exists for the bridged mode. Native mode wants agy's
      // default agent, so installing (and verifying) it would be wasted work
      // and its failure would be a false alarm.
      this.presetError = this.agentId ? ensureAgentPreset(this.account.home, env) : null;
      const argv = ["acp"];
      // Native mode must NOT pass --agent: the tool-free preset is exactly
      // what removes agy's own tools, which is the opposite of the goal.
      if (this.agentId) argv.push("--agent", this.agentId);
      // One worker per ACP session: without it, two conversations share one
      // agent loop and a subagent can stall the main chat.
      argv.push("--process-per-session");
      argv.push("--disable-telemetry");
      // An absolute --gemini-dir avoids agy's own warning and keeps the
      // account isolation the HOME rewrite is doing.
      if (this.account.home) argv.push("--gemini-dir", join(this.account.home, ".gemini"));
      const child = spawn("agy", argv, {
        env,
        cwd: process.cwd(),
        shell: true,
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;

      this.child = child;

      child.stdout.on("data", (b: Buffer) => { if (this.child === child) this.onData(b.toString("utf8")); });
      // Never forward raw stderr to an API client: CLI diagnostics can contain
      // paths, account information, or credentials.
      child.stderr.on("data", () => {});
      // Cancelling/closing a worker can close its pipe before a queued write
      // completes. Observe the stream error instead of crashing the host with
      // an unhandled EPIPE; unexpected pipe failures still reject RPC waiters.
      child.stdin.on("error", (error) => {
        if (this.child !== child || this.closed) return;
        this.closed = true;
        // Allow the next turn to spawn a replacement worker.
        this.ready = null;
        for (const [, pending] of this.pending) pending.reject(error);
        this.pending.clear();
      });
      child.on("exit", (code, signal) => {
        // A previous process can exit after a replacement has started. Its
        // exit must not close the new connection or reject its requests.
        if (this.child !== child) return;
        this.child = null;
        this.closed = true;
        // An externally killed agy must not leave this client permanently
        // dead: the next turn respawns, and the pool reloads or rebuilds its
        // sessions from the caller's transcript.
        this.ready = null;
        for (const [, p] of this.pending) p.reject(new Error(`agy acp exited (code ${code}, signal ${signal})`));
        this.pending.clear();
      });
      child.on("error", reject);

      this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
        .then(() => resolve())
        .catch(reject);
    });

    return this.ready;
  }

  private onData(text: string): void {
    this.buffer += text;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;

      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      // Reply to one of our requests.
      if (msg.id !== undefined && msg.method === undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? "acp error"));
          else p.resolve(msg.result);
        }
        continue;
      }

      // Notification.
      if (msg.method === "session/update") {
        const update = msg.params?.update;
        if (update?.sessionUpdate === "agent_message_chunk") {
          const t = update?.content?.text;
          if (typeof t === "string" && t) {
            for (const l of this.listeners) l(msg.params.sessionId, t);
          }
        } else if (update?.sessionUpdate === "agent_thought_chunk") {
          const t = update?.content?.text;
          if (typeof t === "string" && t) {
            for (const l of this.thoughtListeners) l(msg.params.sessionId, t);
          }
        } else if (
          update?.sessionUpdate === "tool_call" ||
          update?.sessionUpdate === "tool_call_update"
        ) {
          // agy ran one of its own tools. The caller decides whether to render
          // it as text or mirror it as a real tool call.
          for (const l of this.toolListeners) l(msg.params.sessionId, update as AcpToolCallEvent);
        }
        continue;
      }

      // The agent asking to run a tool.
      //
      // Two modes, two answers:
      //
      // `native`  — the tool is agy's own and agy executes it, so approving
      //             is what a terminal run does. A refusal would end the
      //             prompt (ACP has no deny-and-continue), so this must be an
      //             explicit user choice, not a default.
      // `bridged` — the tool is opencode's and arrives over MCP instead, so
      //             any request here is agy trying to act on its own: refuse.
      if (msg.method === "session/request_permission" && msg.id !== undefined) {
        const approved =
          this.autoApprove && this.nativeTools
            ? allowOption({ sessionId: String(msg.params?.sessionId ?? ""), toolCall: msg.params?.toolCall, options: msg.params?.options ?? [] })
            : null;
        this.write({
          jsonrpc: "2.0",
          id: msg.id,
          result: approved
            ? { outcome: { outcome: "selected", optionId: approved } }
            : { outcome: { outcome: "cancelled" } },
        });
      }
    }
  }

  /**
   * The option id that approves a permission request.
   *
   * agy offers several outcomes per request (`allow_once`, `allow_always`,
   * `reject_once`, ...) and the ids are not fixed, so pick the first
   * allow-shaped one instead of hardcoding a name.
   */
  private allowOptionId(params: any): string {
    const options: any[] = params?.options ?? [];
    const allow = options.find((o) => /allow|approve|accept/i.test(String(o?.kind ?? "")));
    return String(allow?.optionId ?? options[0]?.optionId ?? "allow_once");
  }

  private write(obj: unknown): void {
    if (!this.child || this.closed) throw new Error("agy acp is not running");
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  onChunk(handler: (sessionId: string, text: string) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** Observes agy's thinking stream. */
  onThought(handler: (sessionId: string, text: string) => void): () => void {
    this.thoughtListeners.add(handler);
    return () => this.thoughtListeners.delete(handler);
  }

  /** Observes agy's own tool activity (native mode). */
  onTool(handler: (sessionId: string, event: AcpToolCallEvent) => void): () => void {
    this.toolListeners.add(handler);
    return () => this.toolListeners.delete(handler);
  }

  async newSession(): Promise<string> {
    const res = await this.openSession();
    return res.sessionId;
  }

  /**
   * Closes one ACP session.
   *
   * agy runs one worker per session, so closing is what actually releases the
   * ~180 MB worker process. The session itself stays on disk and
   * `session/load` can restore it later with its conversation intact.
   *
   * A client that is not running has no worker left to close, so this is a
   * no-op instead of spawning a process just to close it.
   */
  async closeSession(sessionId: string): Promise<void> {
    if (!this.child || this.closed) return;
    // A stuck close must not block the reaper (and therefore every turn).
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.request("session/close", { sessionId }),
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error("session/close timed out")), 3_000);
          (timer as any).unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** ACP cancellation is a notification, not a request awaiting a reply. */
  cancelSession(sessionId: string): void {
    this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  /**
   * Reopens a previously closed session, history included.
   *
   * The mode (native vs. tool-free) is fixed at process spawn time, so a
   * session can only be loaded by a client already running the same agent.
   */
  async loadSession(
    sessionId: string,
    options: {
      mcpServers?: AcpMcpServer[];
      systemPromptAppend?: string;
      nativeTools?: boolean;
      autoApprove?: boolean;
    } = {},
  ): Promise<{ sessionId: string; reply: any }> {
    const native = options.nativeTools === true;
    const wanted = native ? "" : AGENT;
    if (this.agentId !== wanted) {
      this.kill();
      this.closed = false;
      this.ready = null;
      this.agentId = wanted;
    }
    this.nativeTools = native;
    this.autoApprove = options.autoApprove !== false;
    await this.start();
    const params: Record<string, unknown> = {
      sessionId,
      cwd: process.cwd(),
      mcpServers: options.mcpServers ?? [],
    };
    if (options.systemPromptAppend) {
      params._meta = { antigravity: { systemPrompt: { append: options.systemPromptAppend } } };
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const reply = await Promise.race([
        this.request("session/load", params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("session/load timed out")), 60_000);
          (timer as any).unref?.();
        }),
      ]);
      return {
        sessionId: typeof reply?.sessionId === "string" ? reply.sessionId : sessionId,
        reply,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Opens one ACP session and returns everything agy reported about it.
   *
   * The reply is where the model catalogue lives, so it is kept rather than
   * discarded: without it the provider has no way to know which model ids this
   * account actually offers.
   */
  async openSession(options: {
    /** MCP servers agy may call; the bridge is passed here. */
    mcpServers?: AcpMcpServer[];
    /** Text appended to agy's own system prompt for this session. */
    systemPromptAppend?: string;
    /** Native: let agy use its own tools and approve them. */
    nativeTools?: boolean;
    /** Native: approve agy's permission requests automatically. */
    autoApprove?: boolean;
  } = {}): Promise<{ sessionId: string; reply: any }> {
    // The two modes conflict: native needs agy's own tools, bridged needs
    // them gone so opencode's arrive over MCP instead.
    const native = options.nativeTools === true;
    const wanted = native ? "" : AGENT;
    // Switching modes means a different agy process, because --agent is fixed
    // at spawn time.
    if (this.agentId !== wanted) {
      this.kill();
      this.closed = false;
      this.ready = null;
      this.agentId = wanted;
    }
    this.nativeTools = native;
    this.autoApprove = options.autoApprove !== false;
    await this.start();
    const params: Record<string, unknown> = {
      cwd: process.cwd(),
      mcpServers: options.mcpServers ?? [],
    };
    if (options.systemPromptAppend) {
      // agy reads the appended prompt from session metadata; this is how the
      // caller's system prompt reaches the model without being re-sent.
      params._meta = { antigravity: { systemPrompt: { append: options.systemPromptAppend } } };
    }
    const reply = await this.request("session/new", params);
    return { sessionId: reply.sessionId as string, reply };
  }

  /**
   * Sends one prompt and resolves with agy's stop reason and usage.
   *
   * `session/prompt` reports the same usage object the OpenAI response needs
   * (input/output/cache/thought tokens); dropping it was why every reply showed
   * a zero token count.
   */
  async promptWithReason(
    sessionId: string,
    text: string,
  ): Promise<{ stopReason: string; usage?: AcpUsage }> {
    await this.start();
    const reply = await this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    return {
      stopReason: typeof reply?.stopReason === "string" ? reply.stopReason : "end_turn",
      ...(reply?.usage && typeof reply.usage === "object" ? { usage: normalizeUsage(reply.usage) } : {}),
    };
  }

  /**
   * Applies one session configuration option and returns agy's new state.
   *
   * `set_config_option` is the only way to select a model: agy rejects an
   * unknown value with -32602, which is why callers get the raw rejection
   * instead of a swallowed error.
   */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<any> {
    await this.start();
    return this.request("session/set_config_option", { sessionId, configId, value });
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    await this.start();
    await this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  kill(): void {
    this.closed = true;
    const child = this.child;
    this.child = null;
    for (const [, pending] of this.pending) pending.reject(new Error("agy acp stopped"));
    this.pending.clear();
    if (!child) return;

    // On Windows `shell: true` makes the direct child a cmd.exe wrapper.
    // Killing only that wrapper orphans `agy` and its per-session workers, so
    // every reload or test run left another ~100-250 MB tree behind. `/T`
    // terminates the whole tree; `child.kill()` is the fallback elsewhere.
    const pid = child.pid;
    if (process.platform === "win32" && pid) {
      try {
        execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        return;
      } catch {
        /* wrapper already gone; try the direct handle */
      }
    }
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}

export class AcpPool {
  private clients = new Map<string, AcpClient>();
  private sessions = new Map<string, SessionState>();
  private stopping = new Set<Promise<void>>();
  /** Model families this account offers; seeded from the last good run. */
  private catalogue: CatalogueModel[] = readCatalogueCache();
  /** Discovery ran (successfully or not) at least once in this process. */
  private discovered = false;
  /** In-flight discovery, so concurrent callers share one probe. */
  private discovering: Promise<CatalogueModel[]> | null = null;

  private readonly idleOverride?: number;
  private readonly maxOverride?: number;
  private readonly keep: number;
  private readonly sweepMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** One reap at a time: closing is async and must not overlap itself. */
  private reaping: Promise<void> | null = null;

  constructor(options: AcpPoolOptions = {}) {
    this.idleOverride = options.idleMs;
    this.maxOverride = options.maxOpen;
    this.keep = options.keep ?? envInt("AGY_ACP_KEEP_SESSIONS", DEFAULT_KEEP_SESSIONS);
    this.sweepMs = options.sweepMs ?? envInt("AGY_ACP_SWEEP_MS", DEFAULT_SWEEP_MS);
    this.timer = setInterval(() => {
      void this.reap();
    }, this.sweepMs);
    // A cleanup timer must never keep the host process alive on its own.
    (this.timer as any).unref?.();
  }

  /**
   * Reads the current lifecycle limits.
   *
   * The Settings page writes them to settings.json, so reading on each reap
   * makes a change take effect within a minute without a restart. Explicit
   * constructor options (tests) and env vars still win, in that order.
   */
  private limits(): { idleMs: number; maxOpen: number } {
    const settings = readSettings();
    return {
      idleMs: this.idleOverride ?? envInt("AGY_ACP_IDLE_MS", settings.acpIdleMinutes * 60_000),
      maxOpen: this.maxOverride ?? envInt("AGY_ACP_MAX_SESSIONS", settings.acpMaxSessions),
    };
  }

  /**
   * The observed model catalogue, for /v1/models and provider registration.
   *
   * Empty only when nothing was ever observed and the cache is cold. Callers
   * then fall back to the account default instead of inventing ids — the
   * failure mode this replaced.
   */
  models(): CatalogueModel[] {
    return this.catalogue;
  }

  /**
   * Observes the account's real catalogue, once per process.
   *
   * Opens a throwaway session to read what agy advertised, asks agy which
   * efforts each family accepts (its rejection is the only honest answer),
   * then caches the result. A failed probe keeps the previous catalogue: a
   * dead probe must never empty the picker.
   */
  async discover(account: Account, force = false): Promise<CatalogueModel[]> {
    if (this.discovered && !force) return this.catalogue;
    if (this.discovering) return this.discovering;

    this.discovering = (async () => {
      const client = this.clientFor(account);
      let probeId: string | undefined;
      try {
        const opened = await client.openSession();
        probeId = opened.sessionId;
        const parsed = catalogueFromSession(opened.reply);
        const configs: any[] = opened.reply?.configOptions ?? [];
        const order: string[] =
          (configs.find((o) => o?.id === "thought_level")?.options ?? [])
            .map((o: any) => o?.value)
            .filter((v: any): v is string => typeof v === "string" && v.length > 0);
        const current = configs.find((o) => o?.id === "model")?.currentValue;

        let probed = parsed;
        if (parsed.length > 0 && order.length > 0) {
          try {
            probed = await probeEfforts(
              parsed,
              order,
              (configId, value) => client.setConfigOption(opened.sessionId, configId, value),
              typeof current === "string" ? current : undefined,
            );
          } catch {
            // Probing is an optimisation; families without levels still work.
            probed = parsed;
          }
        }

        if (probed.length > 0) {
          this.catalogue = probed;
          writeCatalogueCache(probed);
        }
        return this.catalogue;
      } catch {
        return this.catalogue;
      } finally {
        // The probe is not a conversation: leaving its worker resident was a
        // permanent ~180 MB leak per account.
        if (probeId) await client.closeSession(probeId).catch(() => {});
        this.discovered = true;
        this.discovering = null;
      }
    })();

    return this.discovering;
  }

  /**
   * Applies a model selection to one ACP session, and proves it took.
   *
   * agy answers an unusable id with -32602. The old code never sent the
   * request at all, so every turn silently ran the account default; here the
   * reply is checked against the requested family instead of being trusted.
   *
   * @returns a short diagnostic when the selection could not be applied.
   */
  private async applySelection(
    client: AcpClient,
    state: SessionState,
    selection: { model: string; effort?: string } | null,
  ): Promise<string | null> {
    if (!selection) return null;
    if (state.model === selection.model && state.effort === selection.effort) return null;

    try {
      const applied = await client.setConfigOption(state.sessionId, "model", selection.model);
      const configs: any[] = applied?.configOptions ?? [];
      const now = configs.find((o) => o?.id === "model")?.currentValue;
      if (typeof now === "string" && now !== selection.model) {
        return `agy kept model ${now} instead of ${selection.model}`;
      }
      state.model = selection.model;
    } catch (err) {
      return `model rejected: ${String((err as any)?.message ?? err).slice(0, 160)}`;
    }

    if (selection.effort) {
      try {
        await client.setConfigOption(state.sessionId, "thought_level", selection.effort);
        state.effort = selection.effort;
      } catch {
        // A family that takes no level is not an error: agy already said so
        // during discovery, and the turn still runs at the family default.
        state.effort = undefined;
      }
    }

    return null;
  }

  private clientFor(account: Account): AcpClient {
    let c = this.clients.get(account.id);
    if (!c) {
      c = new AcpClient(account);
      this.clients.set(account.id, c);
    }
    return c;
  }

  /**
   * True when a session can be closed without losing anything.
   *
   * A prompt that is still running, a parked replay, or undrained text all
   * mean the caller is mid-turn; those stay open.
   */
  private closable(state: SessionState): boolean {
    return (
      state.closed !== true &&
      state.inFlight !== true &&
      (state.pendingReplays?.length ?? 0) === 0 &&
      (state.buffer ?? "").length === 0
    );
  }

  /**
   * Releases one session's worker and keeps a small record for `session/load`.
   *
   * Deleting the map entry alone was not enough: the ACP session lived on in
   * agy, so every conversation left a worker behind for the life of the host.
   */
  private async closeState(state: SessionState): Promise<void> {
    if (state.closed) return;
    state.closed = true;
    const client = this.clients.get(state.accountId);
    if (!client) return;
    try {
      await client.closeSession(state.sessionId);
    } catch {
      // The worker may already be gone (host restart, agy crash). The session
      // file is still on disk, so a later `session/load` can try again.
    }
  }

  /** Stop only this conversation; never terminate another account's worker. */
  async cancel(key: string, reason = "The user interrupted this task.", preserveSafety = false): Promise<void> {
    const state = this.sessions.get(key);
    if (!state) return;
    this.sessions.delete(key);
    state.cancelled = true;
    if (!preserveSafety) state.safety?.finish();
    state.error = reason;
    state.done = true;
    state.inFlight = false;
    state.pendingReplays = [];
    state.buffer = "";
    state.unsubscribe?.();
    state.wake?.();
    try { this.clients.get(state.accountId)?.cancelSession(state.sessionId); } catch { /* already exited */ }
    const stopped = this.closeState(state);
    this.stopping.add(stopped);
    try { await stopped; } finally { this.stopping.delete(stopped); }
  }

  /** Let queued session/close writes settle before terminating the supervisor. */
  async settleStops(): Promise<void> {
    await Promise.all([...this.stopping]);
  }

  /**
   * Waits for running turns before a reload closes the bridge.
   *
   * Closing the MCP bridge or killing the ACP workers mid-turn makes every
   * in-flight tool call fail, and agy then narrates those failures as text.
   * A reload should wait for the current turn to finish instead.
   */
  async waitForIdle(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const busy = [...this.sessions.values()].some((state) => state.inFlight === true || (state.pendingReplays?.length ?? 0) > 0);
      if (!busy) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  /**
   * Closes idle sessions and enforces the open-worker cap.
   *
   * Runs on every turn and on a timer, because the old sweep only ran when a
   * new turn arrived: a user who stopped chatting kept every worker forever.
   */
  async reap(options: { force?: boolean } = {}): Promise<void> {
    if (this.reaping) return this.reaping;
    this.reaping = (async () => {
      const now = Date.now();
      const { idleMs, maxOpen } = this.limits();

      for (const [, state] of this.sessions) {
        if (!this.closable(state)) continue;
        if (options.force || now - state.lastUsed > idleMs) {
          await this.closeState(state);
        }
      }

      if (!options.force) {
        const open = [...this.sessions.entries()]
          .filter(([, state]) => state.closed !== true)
          .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
        let excess = open.length - maxOpen;
        for (const [, state] of open) {
          if (excess <= 0) break;
          if (!this.closable(state)) continue;
          // Never evict a session that was touched just now: a turn may be
          // between creating its prompt and marking itself in flight.
          if (now - state.lastUsed < Math.min(idleMs, 30_000)) continue;
          await this.closeState(state);
          excess -= 1;
        }
      }

      // Records of closed sessions carry no process; keep the most recent
      // few so a returning conversation can be restored instead of rebuilt.
      const closed = [...this.sessions.entries()]
        .filter(([, state]) => state.closed === true)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      while (closed.length > this.keep) {
        const oldest = closed.shift();
        if (oldest) this.sessions.delete(oldest[0]);
      }
    })();
    try {
      await this.reaping;
    } finally {
      this.reaping = null;
    }
  }

  /**
   * Sends only the inputs this conversation has not sent yet and streams the
   * reply. `inputs` are the user/tool messages in order; assistant turns are
   * already known to the session and are not re-sent.
   */
  /**
   * Runs or continues one turn, and stops as soon as agy parks a tool call.
   *
   * A single agy prompt can span several OpenAI requests: when the agent calls
   * a tool it blocks inside the prompt until the result arrives, and the result
   * can only come from a later HTTP request. So this returns as soon as either
   *
   *   - agy parked a tool call (`parked`), meaning the caller must reply with
   *     `finish_reason: "tool_calls"` and send the results next time, or
   *   - the prompt finished (`done`), with everything it produced.
   *
   * The prompt itself is never awaited to completion here; that is what keeps
   * one logical turn alive across requests.
   */
  async turn(options: {
    conversationKey: string;
    account: Account;
    inputs: string[];
    /** Sent ahead of the new input on every turn (tool catalogue + contract). */
    instruction?: string;
    /** Model id the caller asked for, as the OpenAI `model` field carried it. */
    model?: string;
    /** Receives a diagnostic when the requested model could not be applied. */
    onModelWarning?: (message: string) => void;
    onChunk: ChunkHandler;
    /** MCP servers agy may call; the tool bridge is passed here. */
    mcpServers?: AcpMcpServer[];
    /** Text appended to agy's system prompt for a new session. */
    systemPromptAppend?: string;
    /**
     * Assistant replies from the caller's transcript. Used only when a closed
     * session can no longer be loaded and the conversation must be rebuilt.
     */
    replayDigest?: string;
    /** Ordered history including the current request, used only on bootstrap. */
    historyPrompt?: string;
    /** Drop outstanding MCP calls before starting an interrupted/new task. */
    onSupersede?: () => void;
    /** Shared by native, bridged and all HTTP spans of this user turn. */
    safety?: TurnSafety;
    /** Resolves true once a tool call is parked and waiting for the caller. */
    hasParkedCall?: () => boolean;
    /**
     * Bridged mode: the MCP calls agy is blocked on, in order.
     *
     * Their presence is what ends this OpenAI response with
     * `finish_reason: "tool_calls"`. Without it the prompt waits until agy's
     * own MCP client times out, which surfaced as "工具执行失败".
     */
    parkedCalls?: () => AcpToolCall[];
    /** Waits for a park; resolves true when one arrived. */
    waitForPark?: (isDone: () => boolean, timeoutMs: number) => Promise<boolean>;
    /** Longest wait for a park before returning partial text, in milliseconds. */
    parkTimeoutMs?: number;
    /** Native mode: agy runs its own tools; opencode only displays them. */
    nativeTools?: boolean;
    /** Return completed native steps as real tool calls for OpenCode to render. */
    nativeReplay?: boolean;
    /** The tool the caller can actually execute: `agy_tool` or the Code Mode `execute`. */
    toolWrapper?: "direct" | "code";
    /** Native mode: approve agy's permission requests automatically. */
    autoApprove?: boolean;
    /** Observes agy's own tool activity, already rendered for display. */
    onToolEvent?: (text: string) => void;
    /** Observes agy's thinking stream. */
    onThought?: (text: string) => void;
  }): Promise<AcpTurnResult> {
    // Reap before reading session state: a fire-and-forget close could race a
    // load of the same conversation.
    await this.reap();
    const client = this.clientFor(options.account);
    const key = options.conversationKey;

    // A turn is retried only when nothing has been emitted yet: once text has
    // streamed, a retry would duplicate it on the client.
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < ACP_TURN_RETRIES;
      let state = this.sessions.get(key);

      // The conversation belongs to another account now; its session cannot be
      // reused, and the record is stale.
      if (state && state.accountId !== options.account.id) {
        options.onSupersede?.();
        await this.cancel(key, "The account changed.", state.safety === options.safety && !!options.safety);
        state = undefined;
      }

      if (state) {
        const changedPrefix = state.inputs?.some((text, i) => options.inputs[i] !== text) ??
          state.seenInputs > options.inputs.length;
        const newUser = options.inputs.length > state.seenInputs || changedPrefix;
        const modeChanged = state.native !== (options.nativeTools === true);
        // A new question cannot drain an old task's output. Tool-result-only
        // requests retain the exact same inputs and continue normally.
        if (changedPrefix || modeChanged || (newUser && (state.inFlight || (state.pendingReplays?.length ?? 0) > 0))) {
          options.onSupersede?.();
          await this.cancel(key, "The task context was replaced.", state.safety === options.safety && !!options.safety);
          state = undefined;
        }
      }

      // The worker was released while this conversation was idle. Reload the
      // same ACP session: agy restores its history, so only the new input is
      // sent and the user continues exactly where they stopped.
      if (state?.closed && state.native === (options.nativeTools === true)) {
        try {
          const loaded = await client.loadSession(state.sessionId, {
            mcpServers: options.mcpServers,
            systemPromptAppend: options.systemPromptAppend,
            nativeTools: options.nativeTools,
            autoApprove: options.autoApprove,
          });
          state.sessionId = loaded.sessionId;
          state.closed = false;
          state.lastUsed = Date.now();
          // The load may have restored agy's defaults; force the selection to
          // be applied again instead of trusting the stale record.
          state.model = undefined;
          state.effort = undefined;
        } catch {
          // The session file is gone (agy cleanup/upgrade). Fall through to a
          // fresh session; the caller's digest below restores what it can.
          this.sessions.delete(key);
          state = undefined;
        }
      }

      // A completed native step must reach OpenCode as a tool call before any
      // final text. OpenCode runs the mirror, then asks us to continue.
      if (state && (state.pendingReplays?.length ?? 0) > 0) {
        return this.park(state);
      }

      // Bridged mode: agy is blocked inside the MCP `tools/call`. Hand it to
      // OpenCode now; waiting for the prompt to finish makes agy time out and
      // report a tool failure.
      if (state && (options.parkedCalls?.().length ?? 0) > 0) {
        return this.parkFor(state, options);
      }

      // The prompt finished while OpenCode was away (a tool replay, or a
      // reconnect). Hand back what is left and the usage agy reported.
      if (state?.done && options.inputs.length <= state.seenInputs) {
        const completed = await this.completeTurn(client, state, key, options, canRetry, this.drain(state));
        if (completed === "retry") {
          await new Promise((r) => setTimeout(r, ACP_RETRY_DELAY_MS));
          continue;
        }
        return completed;
      }

      // A prompt is already running: wait for the next tool step or for the
      // prompt to finish. The wait is activity-based, never a fixed deadline.
      if (state?.inFlight) {
        const why = await this.waitForProgress(state, options);
        if (why === "call") return this.parkFor(state, options);
        if (why === "idle") return { text: this.drain(state), parked: false, idleTimedOut: true };
        const completed = await this.completeTurn(client, state, key, options, canRetry, this.drain(state));
        if (completed === "retry") {
          await new Promise((r) => setTimeout(r, ACP_RETRY_DELAY_MS));
          continue;
        }
        return completed;
      }

      // Start a new prompt: either a fresh session, or a new user turn on an
      // existing one.
      let rebuilt = false;
      let replay: string | undefined;
      if (
        !state ||
        state.seenInputs > options.inputs.length ||
        (attempt > 0 && state.wedged) ||
        state.native !== (options.nativeTools === true)
      ) {
        // A conversation that lost its session is rebuilt from the caller's
        // transcript: user turns are replayed in full, assistant replies as a
        // digest, so the model does not answer as if the chat just started.
        if (state && state.seenInputs > 0) replay = options.replayDigest;
        // Release the old worker before dropping the record; a wedged or
        // mode-switched session must not stay resident.
        if (state) await this.closeState(state);
        this.sessions.delete(key);
        const opened = await client.openSession({
          mcpServers: options.mcpServers,
          systemPromptAppend: options.systemPromptAppend,
          nativeTools: options.nativeTools,
          autoApprove: options.autoApprove,
        });
        state = {
          sessionId: opened.sessionId,
          accountId: options.account.id,
          seenInputs: 0,
          lastUsed: Date.now(),
          native: options.nativeTools === true,
        };
        rebuilt = true;
        this.sessions.set(key, state);
      }

      state.buffer = "";
      state.textTotal = "";
      state.error = undefined;
      state.stopReason = undefined;
      state.usage = undefined;
      state.pendingReplays = [];
      state.replayed = new Set();
      state.observedToolIds = new Set();
      state.toolFailures = 0;
      state.activeToolIds = new Set();
      state.activeTools = 0;
      state.continuations = 0;
      state.lastActivity = Date.now();
      state.done = false;
      state.inFlight = true;
      state.safety = options.safety ?? new TurnSafety(readSettings().taskBudget, (reason) => { void this.cancel(key, reason.message); });
      if (state.safety.reason) {
        const error = state.safety.reason.message;
        await this.cancel(key, error);
        return { text: "", parked: false, error };
      }

      const fresh = options.inputs.slice(state.seenInputs);
      state.seenInputs = options.inputs.length;
      state.inputs = [...options.inputs];
      state.lastUsed = Date.now();

      const parts: string[] = [];
      if (options.instruction) parts.push(options.instruction);
      if (replay) {
        parts.push(`Earlier assistant replies in this conversation (context only):\n\n${replay}`);
      }
      if (rebuilt && options.historyPrompt) parts.push(options.historyPrompt);
      else if (fresh.length > 0) parts.push(fresh.join("\n\n"));
      const text = parts.join("\n\n---\n\n").trim() || "(continue)";

      // Selecting the model is part of the turn: agy keeps the choice on the
      // session, so it only has to be sent when it actually changed.
      const selection = resolveSelection(this.catalogue, options.model);
      if (options.model && !selection && this.catalogue.length > 0) {
        options.onModelWarning?.(`model ${options.model} is not offered by this account`);
      }
      const selectionError = await this.applySelection(client, state, selection);
      if (selectionError) options.onModelWarning?.(selectionError);

      const running = this.startPrompt(client, state, text, options);
      state.finished = running;

      const why = await this.waitForProgress(state, options);
      if (why === "call") return this.parkFor(state, options);
      if (why === "idle") return { text: this.drain(state), parked: false, idleTimedOut: true };

      const completed = await this.completeTurn(client, state, key, options, canRetry, this.drain(state));
      if (completed === "retry") {
        await new Promise((r) => setTimeout(r, ACP_RETRY_DELAY_MS));
        continue;
      }
      return completed;
    }
  }

  /** Subscribes text, thought, and raw tool events for one prompt. */
  private subscribe(client: AcpClient, state: SessionState, options: TurnHandlers): () => void {
    const offChunk = client.onChunk((sessionId, chunk) => {
      if (sessionId !== state.sessionId) return;
      state.buffer = (state.buffer ?? "") + chunk;
      this.noteActivity(state);
      options.onChunk(chunk);
    });
    const offThought = client.onThought((sessionId, text) => {
      if (sessionId !== state.sessionId) return;
      this.noteActivity(state);
      options.onThought?.(text);
    });
    const offTool = client.onTool((sessionId, event) => {
      if (sessionId !== state.sessionId) return;
      this.noteActivity(state);
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      const status = typeof event.status === "string" ? event.status : "";
      const active = status === "in_progress" || status === "pending";
      if (state.native && toolCallId && active && state.safety && !state.safety.reserve(toolCallId)) return;
      if (toolCallId && active) {
        state.activeToolIds ??= new Set();
        if (!state.activeToolIds.has(toolCallId)) {
          state.activeToolIds.add(toolCallId);
          state.activeTools = (state.activeTools ?? 0) + 1;
        }
      }
      const finished =
        status === "completed" ||
        status === "failed" ||
        (status === "" && (event as unknown as { rawOutput?: unknown }).rawOutput !== undefined);
      if (!toolCallId || !finished) return;

      if (state.activeToolIds?.delete(toolCallId)) {
        state.activeTools = Math.max(0, (state.activeTools ?? 0) - 1);
      }

      state.observedToolIds ??= new Set();
      if (state.observedToolIds.has(toolCallId)) return;
      state.observedToolIds.add(toolCallId);
      const out = toolOutputOf(event);
      const failed = status === "failed" || out.error !== undefined ||
        (out.exitCode !== undefined && out.exitCode !== 0) ||
        (isCommandTool(event.name || "") && hasFailedToolOutput(out.output));
      state.toolFailures = failed ? (state.toolFailures ?? 0) + 1 : 0;
      if (state.toolFailures >= CONSECUTIVE_TOOL_FAILURE_LIMIT) {
        const key = [...this.sessions].find(([, value]) => value === state)?.[0];
        if (key) void this.cancel(key, toolFailureMessage(event.name || event.title || "tool", state.toolFailures));
        return;
      }
      if (state.native) {
        state.safety?.complete(toolCallId, event.name || event.title || "tool", event.args ?? event.rawInput ?? {}, out);
        if (state.safety?.reason) return;
      }

      if (!options.nativeReplay) {
        const rendered = renderToolEvent(event);
        if (rendered) options.onToolEvent?.(rendered);
        return;
      }

      state.replayed ??= new Set();
      if (state.replayed.has(toolCallId)) return;
      state.replayed.add(toolCallId);
      const recorded = recordNativeReplay({
        toolCallId,
        tool: event.name || event.title || "tool",
        title: typeof event.title === "string" ? event.title : undefined,
        input: (event.args ?? event.rawInput ?? {}) as Record<string, unknown>,
        output: out.output,
        wrapper: options.toolWrapper ?? "direct",
        ...(out.exitCode !== undefined ? { exitCode: out.exitCode } : {}),
        ...(out.error !== undefined ? { error: out.error } : {}),
      });
      state.pendingReplays ??= [];
      state.pendingReplays.push(recorded.call);
      this.noteActivity(state);
    });
    return () => {
      offChunk();
      offThought();
      offTool();
    };
  }

  /** Starts one ACP prompt and keeps the listeners until it settles. */
  private startPrompt(
    client: AcpClient,
    state: SessionState,
    text: string,
    options: TurnHandlers,
  ): Promise<void> {
    const off = this.subscribe(client, state, options);
    state.unsubscribe = off;
    const running = client
      .promptWithReason(state.sessionId, text)
      .then(
        (result) => {
          if (state.cancelled) return;
          state.done = true;
          state.stopReason = result.stopReason;
          if (result.usage) state.usage = result.usage;
          this.noteActivity(state);
        },
        (err) => {
          if (state.cancelled) return;
          state.done = true;
          state.error = String((err as any)?.message ?? err).slice(0, 300);
          this.noteActivity(state);
        },
      )
      .finally(() => {
        state.inFlight = false;
        off();
        this.noteActivity(state);
      });
    state.finished = running;
    return running;
  }

  /** Finishes a completed prompt, including output-cap continuations. */
  private async completeTurn(
    client: AcpClient,
    state: SessionState,
    key: string,
    options: TurnHandlers,
    canRetry: boolean,
    initialText: string,
  ): Promise<AcpTurnResult | "retry"> {
    let text = initialText;
    while (
      !state.error &&
      state.stopReason === "max_tokens" &&
      (state.continuations ?? 0) < MAX_CONTINUATIONS
    ) {
      state.continuations = (state.continuations ?? 0) + 1;
      state.textTotal = (state.textTotal ?? "") + text;
      state.buffer = "";
      state.done = false;
      state.inFlight = true;
      state.lastActivity = Date.now();
      this.startPrompt(client, state, CONTINUE_PROMPT, options);
      const why = await this.waitForProgress(state);
      if (why === "call") {
        return { text: text + this.drain(state), parked: true, calls: this.takeReplays(state) };
      }
      if (why === "idle") {
        return { text: text + this.drain(state), parked: false, idleTimedOut: true };
      }
      text += this.drain(state);
    }

    const error = state.error;
    const usage = state.usage;
    const stopReason = state.stopReason;
    const produced = text.length > 0 || (state.textTotal ?? "").length > 0;
    if (state.cancelled) return { text, parked: false, ...(error ? { error } : {}) };

    // A successful prompt stays resident: the next user turn sends only its
    // new input. Failures drop it so a retry cannot inherit a wedged session.
    if (error && this.sessions.get(key) === state) this.sessions.delete(key);
    if (error && !produced && canRetry && isRetryable(error)) return "retry";
    if (error && !produced) throw new Error(error);
    state.safety?.finish();
    return {
      text,
      parked: false,
      ...(usage ? { usage } : {}),
      ...(stopReason ? { stopReason } : {}),
      ...(error ? { error } : {}),
    };
  }

  /** Returns one batch of native tool calls and any text before them. */
  private park(state: SessionState): AcpTurnResult {
    return {
      text: this.drain(state),
      parked: true,
      calls: this.takeReplays(state),
    };
  }

  /** Parks either a native mirror or an MCP call waiting on OpenCode. */
  private parkFor(
    state: SessionState,
    options: { parkedCalls?: () => AcpToolCall[] },
  ): AcpTurnResult {
    const external = options.parkedCalls?.() ?? [];
    if (external.length > 0) {
      return { text: this.drain(state), parked: true, calls: external };
    }
    return this.park(state);
  }

  private takeReplays(state: SessionState): AcpToolCall[] {
    const calls = state.pendingReplays ?? [];
    state.pendingReplays = [];
    return calls;
  }

  /**
   * Waits until a tool step is ready, the prompt ends, or no activity arrives
   * for the whole budget. A tool that is still running raises the budget.
   */
  private async waitForProgress(
    state: SessionState,
    options?: { parkedCalls?: () => AcpToolCall[] },
  ): Promise<"call" | "done" | "idle"> {
    for (;;) {
      if ((state.pendingReplays?.length ?? 0) > 0) return "call";
      // Bridged mode: agy blocks inside `tools/call` until the caller answers.
      // This is the signal to end the OpenAI response, not a reason to wait
      // for agy's MCP client to time out.
      if ((options?.parkedCalls?.().length ?? 0) > 0) return "call";
      if (state.done) return "done";
      const budget = idleBudgetMs(state.activeTools);
      const idle = Date.now() - (state.lastActivity ?? Date.now());
      if (idle >= budget) return "idle";
      await this.waitWake(state, Math.min(budget - idle, 1000));
    }
  }

  private waitWake(state: SessionState, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (state.wake === done) state.wake = null;
        resolve();
      };
      timer = setTimeout(done, Math.max(1, ms));
      state.wake = done;
    });
  }

  private noteActivity(state: SessionState): void {
    state.lastActivity = Date.now();
    // Idle is measured from the last sign of life, not from turn start: a
    // twenty-minute answer must not look idle the moment it lands.
    state.lastUsed = state.lastActivity;
    const wake = state.wake;
    state.wake = null;
    wake?.();
  }

  /**
   * Takes everything buffered since the last call.
   *
   * The buffer is drained rather than read because each OpenAI request must
   * receive only the text produced since the previous one; resending it would
   * duplicate the message in the client.
   */
  private drain(state: SessionState): string {
    const text = state.buffer ?? "";
    state.buffer = "";
    state.textTotal = (state.textTotal ?? "") + text;
    return text;
  }
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const [, c] of this.clients) c.kill();
    this.clients.clear();
    this.sessions.clear();
  }

  /** Test/diagnostics hook: what is currently resident. */
  stats(): { clients: number; sessions: number; open: number; kept: number } {
    let open = 0;
    for (const [, state] of this.sessions) {
      if (state.closed !== true) open += 1;
    }
    return {
      clients: this.clients.size,
      sessions: this.sessions.size,
      open,
      kept: this.sessions.size - open,
    };
  }
}

export const acpPool = new AcpPool();

/** Test/diagnostics hook: installs the agent preset into `home` and reports why it failed. */
export const __ensureAgentPreset = ensureAgentPreset;
