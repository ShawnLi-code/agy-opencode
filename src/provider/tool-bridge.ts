/**
 * Bridges opencode's tools into agy over MCP, and turns agy's tool calls back
 * into OpenAI `tool_calls`.
 *
 * Why a bridge at all: the previous design asked the model to *print*
 * `{"tool_calls":[...]}` and parsed the text. That cannot carry a structured
 * result back, cannot stream, and silently degrades when the model ignores the
 * format. MCP is what agy natively speaks, so a tool call becomes a real
 * `tools/call` request and a real result.
 *
 * The conversation shape is the hard part. OpenAI is request/response: a turn
 * ends with `finish_reason: "tool_calls"`, and the caller sends results back on
 * the *next* request. MCP is blocking: agy calls a tool and waits on the same
 * HTTP request. They are reconciled by parking a call, which makes one agy
 * prompt span several OpenAI requests:
 *
 *   1. agy emits `tools/call`; the bridge records it and does not answer.
 *   2. The parked call is surfaced as an OpenAI `tool_calls` finish, so the
 *      caller can run the tools.
 *   3. The next request carries the results; the parked call is answered, agy
 *      resumes inside the *same* prompt, and the reply keeps streaming.
 *
 * Nothing here executes a tool. opencode does that.
 */

import { McpBridge, type BridgeTool, type BridgeToolResult } from "./mcp-bridge";
import type { OpenAITool } from "./protocol";
import { CONSECUTIVE_TOOL_FAILURE_LIMIT, hasFailedToolOutput, isCommandTool, toolFailureMessage } from "./tool-failures";
import type { TurnSafety } from "./turn-safety";

/** One tool call agy issued and is waiting on. */
export interface ParkedCall {
  /** OpenAI tool-call id. */
  id: string;
  name: string;
  /** JSON string, as OpenAI wants it. */
  arguments: string;
  /** Set once answered; a settled call is never emitted twice. */
  settled: boolean;
  /** Answers agy. Safe to call more than once. */
  answer(result: BridgeToolResult): void;
}

/** What `session/new` needs to reach one conversation's tools. */
export interface ToolSession {
  key: string;
  url: string;
  header: { name: string; value: string };
}

/** One conversation's bridge state. */
interface Entry {
  key: string;
  /** Tool schemas agy may call in this conversation. */
  tools: BridgeTool[];
  /** Every call agy issued, settled or not. */
  calls: ParkedCall[];
  seq: number;
  /** Settles whenever a call is parked, to wake a waiting request. */
  wake: (() => void) | null;
  turn?: string;
  failures: number;
  failureReason?: string;
  safety?: TurnSafety;
}

export interface ToolBridgeOptions {
  /** SSE keepalive interval while agy waits on a parked call. */
  keepAliveMs?: number;
  log?: (message: string) => void;
  onFailureLimit?: (conversationKey: string, message: string) => void;
  platform?: NodeJS.Platform;
  allowWindowsMultiline?: boolean;
}

/**
 * Owns the MCP server and the parked-call bookkeeping.
 *
 * One MCP endpoint per conversation, so two sessions can never see each other's
 * tools and a leaked URL is useless without its bearer token.
 */
export class ToolBridge {
  private bridge: McpBridge;
  private entries = new Map<string, Entry>();
  private byKey = new Map<string, string>();

  constructor(private readonly options: ToolBridgeOptions = {}) {
    this.bridge = new McpBridge(
      {
        listTools: (sessionKey) => this.entries.get(this.byKey.get(sessionKey) ?? "")?.tools ?? [],
        callTool: (request) => this.park(request.sessionKey, request.name, request.arguments),
      },
      { keepAliveMs: options.keepAliveMs, log: options.log },
    );
  }

  /** Starts listening on an ephemeral loopback port. */
  async start(): Promise<void> {
    await this.bridge.start(0);
  }

  /** Stops listening. Parked calls are failed so agy never hangs on shutdown. */
  async close(): Promise<void> {
    for (const key of [...this.entries.keys()]) this.detach(key);
    await this.bridge.close();
  }

  /** True once the server is listening. */
  get listening(): boolean {
    return this.bridge.port > 0;
  }

  /**
   * Registers the tools one conversation may call and returns its endpoint.
   *
   * The endpoint is created once per conversation and reused, so agy does not
   * have to reopen its MCP session when the schema list changes.
   *
   * @param conversationKey - stable per conversation.
   * @param tools - OpenAI tool descriptors from the current request.
   * @returns the MCP descriptor, or null when the caller offered no tools.
   */
  attach(conversationKey: string, tools: readonly OpenAITool[]): ToolSession | null {
    const schemas = normalise(tools);
    if ((this.options.platform ?? process.platform) === "win32" && !this.options.allowWindowsMultiline) {
      for (const schema of schemas) if (schema.name === "shell") {
        schema.description += "\nWindows transport restriction: command must be one physical line. For multiline programs, write a script file with the file-edit tool and invoke its path. Multiline shell commands are rejected before execution.";
      }
    }
    const existing = this.entries.get(conversationKey);

    if (schemas.length === 0) {
      if (existing) this.detach(conversationKey);
      return null;
    }

    if (existing) {
      existing.tools = schemas;
      return this.descriptor(conversationKey);
    }

    this.bridge.createTenant();
    const tenant = this.lastTenant();
    const entry: Entry = { key: tenant.key, tools: schemas, calls: [], seq: 0, wake: null, failures: 0 };
    this.entries.set(conversationKey, entry);
    this.byKey.set(tenant.key, conversationKey);
    return { key: tenant.key, url: tenant.url, header: tenant.header };
  }

  /** The endpoint for a conversation that is already attached. */
  session(conversationKey: string): ToolSession | null {
    return this.entries.has(conversationKey) ? this.descriptor(conversationKey) : null;
  }

  /** Forgets one conversation, failing anything it left parked. */
  detach(conversationKey: string): void {
    const entry = this.entries.get(conversationKey);
    if (!entry) return;
    entry.safety?.finish();
    for (const call of entry.calls) {
      if (!call.settled) {
        call.answer({ content: [{ type: "text", text: "The caller ended this conversation." }], isError: true });
      }
    }
    this.entries.delete(conversationKey);
    this.byKey.delete(entry.key);
    this.bridge.removeTenant(entry.key);
  }

  /** Unanswered calls, in the order agy issued them. */
  openCalls(conversationKey: string): ParkedCall[] {
    return (this.entries.get(conversationKey)?.calls ?? []).filter((c) => !c.settled);
  }

  /** Tool-result requests do not reset the budget; only a new user turn does. */
  beginTurn(conversationKey: string, turn: string, safety?: TurnSafety): void {
    const entry = this.entries.get(conversationKey);
    if (!entry) return;
    if (entry.turn === turn) {
      if (safety) entry.safety = safety;
      return;
    }
    entry.turn = turn;
    entry.failures = 0;
    entry.failureReason = undefined;
    entry.safety = safety;
  }

  failureReason(conversationKey: string): string | undefined {
    return this.entries.get(conversationKey)?.failureReason;
  }

  private recordResult(key: string, entry: Entry, tool: string, result: BridgeToolResult, id: string, args: unknown): void {
    const failed = result.isError === true || (isCommandTool(tool) && hasFailedToolOutput(result.content.map((c) => c.type === "text" ? c.text : "").join("\n")));
    entry.failures = failed ? entry.failures + 1 : 0;
    if (entry.failures >= CONSECUTIVE_TOOL_FAILURE_LIMIT && !entry.failureReason) {
      entry.failureReason = toolFailureMessage(tool, entry.failures);
      entry.safety?.finish();
      this.options.onFailureLimit?.(key, entry.failureReason);
    }
    if (!entry.failureReason) entry.safety?.complete(id, tool, args, result);
  }

  /**
   * Answers the calls the caller just ran.
   *
   * @param conversationKey - the conversation.
   * @param results - results keyed by the OpenAI tool-call id. Historical,
   * duplicate and out-of-order results must never answer a newer call.
   * @returns how many calls were answered.
   */
  answerAll(conversationKey: string, results: readonly { id: string; result: BridgeToolResult }[]): number {
    const entry = this.entries.get(conversationKey);
    if (!entry) return 0;
    let answered = 0;
    for (const { id, result } of results) {
      const call = entry.calls.find((c) => c.id === id && !c.settled);
      if (!call) continue;
      this.recordResult(conversationKey, entry, call.name, result, call.id, JSON.parse(call.arguments));
      call.answer(result);
      answered++;
    }
    entry.calls = entry.calls.filter((c) => !c.settled);
    return answered;
  }

  /** Ends only outstanding calls, retaining the authenticated MCP endpoint. */
  cancelCalls(conversationKey: string): void {
    const entry = this.entries.get(conversationKey);
    if (!entry) return;
    for (const call of entry.calls) {
      call.answer({ content: [{ type: "text", text: "The user interrupted this task." }], isError: true });
    }
    entry.calls = [];
    entry.wake?.();
  }

  /**
   * Resolves true as soon as agy parks a call, false when the prompt finishes
   * first or the deadline passes.
   *
   * @param conversationKey - the conversation.
   * @param isDone - true once the ACP prompt has resolved.
   * @param timeoutMs - longest wait, in milliseconds.
   */
  waitForPark(conversationKey: string, isDone: () => boolean, timeoutMs: number): Promise<boolean> {
    const entry = this.entries.get(conversationKey);
    if (!entry) return Promise.resolve(false);
    const hasOpen = () => entry.calls.some((c) => !c.settled);
    if (hasOpen()) return Promise.resolve(true);
    if (isDone()) return Promise.resolve(false);

    return new Promise((resolve) => {
      const finish = (parked: boolean): void => {
        clearTimeout(timer);
        if (entry.wake === wake) entry.wake = null;
        resolve(parked);
      };
      const timer = setTimeout(() => finish(hasOpen()), timeoutMs);
      const wake = (): void => finish(hasOpen());
      entry.wake = wake;
    });
  }

  /** The descriptor for a conversation whose tenant already exists. */
  private descriptor(conversationKey: string): ToolSession {
    const entry = this.entries.get(conversationKey) as Entry;
    const tenant = this.tenantOf(entry.key);
    return { key: entry.key, url: tenant.url, header: tenant.header };
  }

  /** Re-creates a descriptor from the tenant key the bridge already holds. */
  private tenantOf(key: string): { url: string; header: { name: string; value: string } } {
    const tenants = (this.bridge as unknown as { tenants: Map<string, { secret: string }> }).tenants;
    const secret = tenants?.get(key)?.secret ?? "";
    return {
      url: `${this.bridge.url}/mcp/${key}`,
      header: { name: "Authorization", value: `Bearer ${secret}` },
    };
  }

  /** The tenant `createTenant()` just made. */
  private lastTenant(): { key: string; url: string; header: { name: string; value: string } } {
    const tenants = (this.bridge as unknown as { tenants: Map<string, { secret: string }> }).tenants;
    const key = [...(tenants?.keys() ?? [])].pop() ?? "";
    return {
      key,
      url: `${this.bridge.url}/mcp/${key}`,
      header: { name: "Authorization", value: `Bearer ${tenants?.get(key)?.secret ?? ""}` },
    };
  }

  /** Records one call and blocks until the caller answers it. */
  private park(sessionKey: string, name: string, args: Record<string, unknown>): Promise<BridgeToolResult> {
    const conversationKey = this.byKey.get(sessionKey);
    const entry = conversationKey ? this.entries.get(conversationKey) : undefined;
    if (!entry) {
      return Promise.resolve({
        content: [{ type: "text", text: "No tools are registered for this session." }],
        isError: true,
      });
    }

    if (entry.failureReason) {
      return Promise.resolve({ content: [{ type: "text", text: entry.failureReason }], isError: true });
    }
    const callId = `call_agy_${Date.now().toString(36)}_${++entry.seq}`;
    if (entry.safety && !entry.safety.reserve(callId)) {
      return Promise.resolve({ content: [{ type: "text", text: entry.safety.reason?.message ?? "This task has ended. Send a new user message." }], isError: true });
    }
    // The affected Windows shell transport truncates at physical newlines.
    // Reject before execution rather than silently running only a prefix, or
    // hiding an encoded command from OpenCode's permission/audit display.
    if (!this.options.allowWindowsMultiline && (this.options.platform ?? process.platform) === "win32" && name === "shell" &&
        typeof args.command === "string" && /[\r\n]/.test(args.command)) {
      const result: BridgeToolResult = { content: [{ type: "text", text:
        "WINDOWS_MULTILINE_SHELL_UNSUPPORTED: Nothing was executed. This host's shell transport may execute only the first physical line. Use a single-line PowerShell command, or write a .ps1/.mjs file with the file-edit tool and invoke that file by path. Do not repeat the multiline command." }], isError: true };
      this.recordResult(conversationKey!, entry, name, result, callId, args);
      return Promise.resolve(result);
    }

    let settle!: (r: BridgeToolResult) => void;
    const waiting = new Promise<BridgeToolResult>((resolve) => {
      settle = resolve;
    });

    const call: ParkedCall = {
      id: callId,
      name,
      arguments: JSON.stringify(args ?? {}),
      settled: false,
      answer: (result) => {
        if (call.settled) return;
        call.settled = true;
        settle(result);
      },
    };

    entry.calls.push(call);

    // Wake whatever is waiting for a park, then clear the hook.
    const wake = entry.wake;
    entry.wake = null;
    wake?.();

    return waiting;
  }
}

/**
 * Normalises OpenAI tool descriptors into MCP schemas.
 *
 * opencode sends `{ type: "function", function: { name, parameters } }`, but the
 * print transport also accepted a flat `{ name, parameters }`, so both shapes
 * are read. Duplicate names are dropped: two MCP tools with one name would make
 * agy's calls ambiguous.
 *
 * @param tools - descriptors from the request, possibly undefined.
 * @returns the schemas, in request order.
 */
export function normalise(tools: readonly OpenAITool[] | undefined): BridgeTool[] {
  const out: BridgeTool[] = [];
  const seen = new Set<string>();
  for (const t of tools ?? []) {
    const fn = t?.function ?? t;
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const params = fn?.parameters;
    out.push({
      name,
      description: typeof fn?.description === "string" ? fn.description : "",
      inputSchema:
        params && typeof params === "object"
          ? (params as Record<string, unknown>)
          : { type: "object", properties: {} },
    });
  }
  return out;
}

/** Converts one OpenAI tool result message into an MCP result. */
export function toBridgeResult(content: string | Array<{ type?: string; text?: string }> | null | undefined, toolName?: string): BridgeToolResult {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n")
        : "";
  // Some tool executors serialize an MCP result into the OpenAI tool body.
  // Preserve an explicit error flag for non-command tools as well.
  try {
    const structured = JSON.parse(text);
    if (structured?.isError === true && Array.isArray(structured.content)) {
      return { content: [{ type: "text", text }], isError: true };
    }
  } catch { /* ordinary text output */ }
  return { content: [{ type: "text", text }], ...((!toolName || isCommandTool(toolName)) && hasFailedToolOutput(text) ? { isError: true } : {}) };
}
