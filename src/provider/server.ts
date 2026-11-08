/**
 * OpenAI-compatible HTTP server backed by the local `agy` CLI.
 *
 * Two transports:
 * - `acp` (default): one persistent `agy acp` process per account, one session
 *   per conversation. Only the new input is sent each turn and tokens stream as
 *   they arrive.
 * - `print`: one-shot `agy --print`, whole history each turn, reply emitted
 *   after it completes. Fallback when ACP is unavailable.
 *
 * Either way the model only *decides* which tools to call; opencode executes
 * them, so its approvals and sandbox still apply.
 */

import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createProviderHttpServer } from "./http-server";
import { modelLabel } from "./catalogue";
import { settingsFromEnv, type ProviderSettings } from "./settings";
import { buildPrompt, parseReply, type OpenAIMessage, type OpenAITool, type ParsedReply } from "./protocol";
import { acpPool, type AcpTurnResult, type AcpUsage } from "./acp";
import { ToolBridge, toBridgeResult } from "./tool-bridge";
import { DEFAULT_TURN_LIMITS, TurnSafety } from "./turn-safety";

/** The fields both the MCP bridge and native replay expose to the wire. */
interface EmittedToolCall {
  id: string;
  name: string;
  arguments: string;
}
import { loadAccounts, pickAccount, type Account } from "../accounts";

export interface ProviderServerOptions {
  port?: number;
  host?: string;
  /** One-shot runner for `print` transport. */
  run?: (model: string, prompt: string, signal?: AbortSignal) => Promise<string>;
  /** Defaults to `acp`, or `print` when a `run` is injected. */
  transport?: "acp" | "print";
  /** Provider settings, injectable for tests. */
  settings?: ProviderSettings;
  /** Tool bridge, injectable for tests. */
  toolBridge?: ToolBridge;
  /** Account resolution, injectable for tests. */
  resolveAccount?: () => Account;
  /** ACP turn runner, injectable for tests (capacity retry, error shapes). */
  turn?: (options: any) => Promise<AcpTurnResult>;
  /** Wait-and-retry delays for upstream capacity 503s. */
  capacityDelaysMs?: number[];
}

export interface ProviderServer {
  port: number;
  url: string;
  close: () => Promise<void>;
  server: Server;
  /**
   * The ACP pool owned by this server. A hot reload reuses the old server,
   * so callers must use this pool instead of the module-level singleton:
   * discovering on a fresh, unused pool spawns an agy process that is never
   * closed.
   */
  pool: typeof acpPool;
}

/** Changes whenever this module is freshly loaded: proves a reload happened. */
const MODULE_LOADED_AT = new Date().toISOString();

let requestSeq = 0;

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${++requestSeq}`;
}

async function readBody(req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * The model id exactly as the caller sent it.
 *
 * Deliberately NOT validated here: the live catalogue decides what exists, and
 * AcpPool.applySelection reports what agy actually accepted. Mapping through a
 * hardcoded table is precisely what made every selection silently run the
 * account's default model.
 */
function requestedModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
}

function textOf(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n");
  }
  return "";
}

/** Stable per-conversation key: the system prompt plus the first user turn. */
function conversationKey(messages: readonly OpenAIMessage[]): string {
  const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const firstUser = messages.find((m) => m.role === "user");
  const seed = system + "\u0000" + textOf(firstUser?.content ?? "");
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  return `c${(h >>> 0).toString(36)}_${seed.length.toString(36)}`;
}

/**
 * Only user turns become ACP prompt input.
 *
 * A tool result must NOT be replayed into agy: in native mode agy already ran
 * the tool, and in bridged mode the result is delivered over MCP. Counting it
 * here used to make the next request look like a new user turn, which could
 * start a second prompt with the tool output as text.
 */
function acpInputs(messages: readonly OpenAIMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    const t = textOf(m.content);
    if (t) out.push(t);
  }
  return out;
}

/** Role-labelled bootstrap only; never flatten old questions into new tasks. */
export function acpHistory(messages: readonly OpenAIMessage[]): string {
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  const history = messages.slice(0, lastUser).filter((m) => m.role !== "system").map((m) => ({
    role: m.role,
    content: textOf(m.content),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
  }));
  return [
    "Answer ONLY the current user request below. The earlier conversation is background context: do not repeat it, do not continue the previous assistant reply, and do not re-answer an older question.",
    "CURRENT USER REQUEST (answer this request directly):",
    textOf(messages[lastUser]?.content ?? ""),
    "EARLIER CONVERSATION (context only, already answered):",
    JSON.stringify(history),
  ].join("\n\n");
}

function sseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

function send(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const CHUNK = 48;

/** Default wait-and-retry schedule for upstream capacity 503s. No downgrade. */
const CAPACITY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

/** Upstream capacity failures, as opposed to auth/quota/context errors. */
export function isCapacityError(error: unknown): boolean {
  const message = String((error as any)?.message ?? error);
  const code = String((error as any)?.code ?? "");
  return /UNAVAILABLE|No capacity available|capacity.*unavailable|503/i.test(`${code} ${message}`);
}

/**
 * Transport failures: the connection died before the reply finished.
 *
 * Seen on this machine as `write tcp 127.0.0.1:*->127.0.0.1:7897: wsasend:
 * An existing connection was forcibly closed by the remote host` — the local
 * proxy closed the stream, not the model. Also covers resets, EOF and socket
 * hangs. Reported separately so the UI can say what actually broke.
 */
export function isTransportError(error: unknown): boolean {
  const message = String((error as any)?.message ?? error);
  return /wsasend|WSAECONN|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|socket hang up|connection reset|forcibly closed|unexpected EOF|\bEOF\b|proxy/i.test(
    message,
  );
}

/** Human-facing transport message: no raw Winsock errno or proxy address. */
export function transportMessage(attempts = 0): string {
  const tries = attempts > 0 ? `已重试 ${attempts} 次，` : "";
  return (
    "连接在传输途中被中断，回复没有收完。这不是模型不可用，也不是对话太长；" +
    `常见原因是本机代理或网络在流式传输时断开了连接。${tries}请检查代理节点后重试。`
  );
}


/** Human-facing capacity message: never the raw upstream envelope. */
export function capacityMessage(waitedMs = 0): string {
  const seconds = waitedMs > 0 ? Math.max(1, Math.round(waitedMs / 1000)) : 0;
  const waited = seconds > 0 ? `已等待约 ${seconds} 秒并重试，` : "已重试，";
  return (
    "Antigravity 上游暂时没有可用容量（503）。这不是对话太长，也不是账号掉线。" +
    `${waited}仍未恢复，请稍后再试。`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Prior assistant replies, used when a capacity retry needs a new session. */
function assistantDigest(messages: readonly OpenAIMessage[]): string {
  return messages
    .filter((message) => message.role === "assistant")
    .map((message) => textOf(message.content))
    .filter(Boolean)
    .join("\n\n")
    .slice(-20_000);
}

/** OpenAI token bucket from ACP's per-turn usage. */
export function toOpenAIUsage(usage: AcpUsage | undefined): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
} | undefined {
  if (!usage) return undefined;
  // agy's `inputTokens` already counts the whole prompt, cached part included.
  // Its `cachedReadTokens` is a per-turn cache-hit counter that keeps growing
  // across internal tool steps (one 8-step turn reported 200k of "cache" for a
  // 44k context), so adding it double-counted the prompt and made opencode
  // believe a 44k conversation was at 96% of a 256k window.
  const prompt = usage.inputTokens ?? 0;
  const completion = usage.outputTokens ?? 0;
  const cached = Math.min(usage.cachedReadTokens ?? 0, prompt);
  const total = usage.totalTokens ?? prompt + completion;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    ...(usage.cachedReadTokens !== undefined
      ? { prompt_tokens_details: { cached_tokens: cached } }
      : {}),
    ...(usage.thoughtTokens !== undefined
      ? { completion_tokens_details: { reasoning_tokens: usage.thoughtTokens } }
      : {}),
  };
}

/** SSE error event; ends the response without pretending the turn succeeded. */
function sseError(res: ServerResponse, message: string, code: string): void {
  res.write(
    `data: ${JSON.stringify({ error: { message, type: "upstream_error", code } })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

/** Non-streaming response built from a parsed reply. */
function wholeReply(
  res: ServerResponse,
  model: string,
  reply: ParsedReply,
  usage?: AcpUsage,
  reasoning?: string,
): void {
  const message: Record<string, unknown> = { role: "assistant", content: reply.content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (reply.toolCalls.length > 0) {
    message.tool_calls = reply.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }));
  }
  const openAIUsage = toOpenAIUsage(usage);
  json(res, 200, {
    id: id("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: reply.toolCalls.length > 0 ? "tool_calls" : "stop" }],
    ...(openAIUsage ? { usage: openAIUsage } : {}),
  });
}

/** Streaming response for a reply that is already complete (print transport). */
function streamFinished(res: ServerResponse, model: string, reply: ParsedReply): void {
  const base = { id: id("chatcmpl"), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  send(res, { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

  if (reply.toolCalls.length > 0) {
    if (reply.content) send(res, { ...base, choices: [{ index: 0, delta: { content: reply.content }, finish_reason: null }] });
    reply.toolCalls.forEach((call, index) => {
      send(res, {
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] },
            finish_reason: null,
          },
        ],
      });
    });
    send(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  } else {
    const text = reply.content;
    for (let i = 0; i < text.length; i += CHUNK) {
      send(res, { ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + CHUNK) }, finish_reason: null }] });
    }
    send(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

export async function startProvider(options: ProviderServerOptions = {}): Promise<ProviderServer> {
  const host = options.host ?? "127.0.0.1";
  const transport = options.transport ?? (options.run ? "print" : "acp");
  const run = options.run;
  const turnRunner = options.turn ?? ((turnOptions: any) => acpPool.turn(turnOptions));
  const capacityDelays = options.capacityDelaysMs ?? CAPACITY_RETRY_DELAYS_MS;
  const resolveAccount = options.resolveAccount ?? (() => pickAccount(loadAccounts()));

  // One MCP bridge for every conversation. It is started on the first request
  // that actually carries tools, so a tool-free chat never pays for a port.
  const bridge = options.toolBridge ?? new ToolBridge({
    log: (m) => console.warn("[agy-cli] " + m),
    onFailureLimit: (key, reason) => { void acpPool.cancel(key, reason); },
    allowWindowsMultiline: (options.settings ?? settingsFromEnv()).windowsMultilineShell === true,
  });
  const budgets = new Map<string, { turn: string; safety: TurnSafety }>();

  // Settings are read once at start: a mode switch means a different agent,
  // which a running prompt cannot survive anyway.
  const configuredSettings = options.settings;

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    try {
      if (req.method === "GET" && (url === "/healthz" || url === "/")) {
        json(res, 200, { ok: true, provider: "agy-cli", transport, loadedAt: MODULE_LOADED_AT });
        return;
      }

      if (req.method === "GET" && url.startsWith("/v1/models")) {
        const created = Math.floor(Date.now() / 1000);
        // Reported from the catalogue agy actually advertised. When discovery
        // has not run yet this is the on-disk cache, and may be empty on a very
        // first start — an empty list is honest, invented ids are not.
        const rows: any[] = [];
        for (const m of acpPool.models()) {
          if (m.efforts.length === 0) {
            rows.push({ id: m.id, object: "model", created, owned_by: "agy-cli", name: m.name });
            continue;
          }
          for (const effort of m.efforts) {
            rows.push({
              id: `${m.id}-${effort}`,
              object: "model",
              created,
              owned_by: "agy-cli",
              name: modelLabel(m, effort),
            });
          }
        }
        json(res, 200, { object: "list", data: rows });
        return;
      }

      if (req.method === "POST" && url.startsWith("/v1/chat/completions")) {
        const settings: ProviderSettings = configuredSettings ?? settingsFromEnv();
        const raw = await readBody(req);
        let body: any;
        try {
          body = JSON.parse(raw);
        } catch {
          json(res, 400, { error: { message: "invalid JSON body", type: "invalid_request_error" } });
          return;
        }

        const messages = (body.messages ?? []) as OpenAIMessage[];
        const tools = (body.tools ?? []) as OpenAITool[];
        const model = requestedModel(body.model);
        const streaming = !!body.stream;

        // The id echoed back to the caller. `model` is undefined when the
        // request omitted it; the reply still has to name something, and the
        // catalogue's first entry is what agy would have used anyway.
        const echoed = model ?? acpPool.models()[0]?.id ?? "agy-cli";

        const base = {
          id: id("chatcmpl"),
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: echoed,
        };

        if (transport === "acp") {
          // Set when the requested model could not be applied. The turn still
          // runs (agy keeps its current model), so this is reported to the
          // caller instead of failing the request outright. A holder is used
          // because a `let` assigned inside a callback narrows to `never`.
          const turnState: {
            modelWarning: string | null;
            parked: boolean;
            bridgeError: string | null;
            nativeCalls: EmittedToolCall[];
            usage?: AcpUsage;
            idleTimedOut: boolean;
            error?: string;
          } = {
            modelWarning: null,
            parked: false,
            bridgeError: null,
            nativeCalls: [],
            idleTimedOut: false,
          };

          // Buffer the opening characters: a reply that starts with `{` (or a
          // fenced block) is a tool envelope and must not leak to the client as
          // content. Everything else streams live.
          let mode: "unknown" | "text" | "json" = "unknown";
          let pending = "";
          let opened = false;
          let emittedAny = false;

          if (streaming) {
            sseHeaders(res);
            send(res, { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
            opened = true;
          }

          // Thinking is a separate channel from the answer. It streams as
          // `reasoning_content`, which the openai-compatible adapter already
          // understands, and is attached to a non-streaming message too.
          const reasoningParts: string[] = [];
          const emitReasoning = (text: string) => {
            if (!text) return;
            reasoningParts.push(text);
            if (!streaming) return;
            for (let i = 0; i < text.length; i += CHUNK) {
              send(res, {
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: { reasoning_content: text.slice(i, i + CHUNK) },
                    finish_reason: null,
                  },
                ],
              });
            }
          };

          const emit = (text: string) => {
            if (!streaming || !text) return;
            emittedAny = true;
            for (let i = 0; i < text.length; i += CHUNK) {
              send(res, { ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + CHUNK) }, finish_reason: null }] });
            }
          };

          /** Fallback text markers, only used when native tool replay is off. */
          const toolTranscript: string[] = [];
          const noteTool = (rendered: string) => {
            if (!rendered) return;
            toolTranscript.push(rendered);
            emit(rendered);
          };

          let assembled = "";
          // `native` lets agy run its own tools and shows them here; `bridged`
          // hands opencode's tools over MCP instead. They are mutually
          // exclusive: native needs the tools agy already has.
          const native = settings.agentMode === "native";
          // Mirror only when this request actually advertises the replay tool.
          // Emitting a tool call the caller cannot execute turns a real result
          // into "No tool named agy_tool is currently available".
          const hasDirectReplay = tools.some((tool) => tool?.function?.name === "agy_tool");
          const hasCodeMode = tools.some((tool) => tool?.function?.name === "execute");
          const nativeMirror = native && (hasDirectReplay || hasCodeMode);
          const toolWrapper: "direct" | "code" | undefined = hasDirectReplay
            ? "direct"
            : hasCodeMode
              ? "code"
              : undefined;

          const systemText = messages
            .filter((m) => m.role === "system")
            .map((m) => textOf(m.content))
            .filter(Boolean)
            .join("\n\n");

          const sessionHeader = req.headers["x-agy-session-id"];
          const turnHeader = req.headers["x-agy-turn-id"];
          const kindHeader = req.headers["x-agy-request-kind"];
          const validID = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
          const kind = typeof kindHeader === "string" && ["primary", "compaction", "title", "generate"].includes(kindHeader) ? kindHeader : "primary";
          const conversation = validID(sessionHeader) ? `session:${sessionHeader}:${kind}` : conversationKey(messages);
          const turn = validID(turnHeader) ? turnHeader : JSON.stringify(acpInputs(messages));
          let budget = budgets.get(conversation);
          if (!budget || budget.turn !== turn) {
            if (budget?.safety.active) {
              budget.safety.finish();
              bridge.cancelCalls(conversation);
              await acpPool.cancel(conversation);
            }
            const safety = new TurnSafety(settings.taskBudget ?? DEFAULT_TURN_LIMITS, (reason) => {
              bridge.cancelCalls(conversation);
              void acpPool.cancel(conversation, reason.message);
            });
            budget = { turn, safety };
            budgets.set(conversation, budget);
            // Keep terminal records bounded; never evict a running timer/task.
            if (budgets.size > 256) for (const [key, value] of budgets) {
              if (budgets.size <= 256) break;
              if (key !== conversation && !value.safety.active) budgets.delete(key);
            }
          }
          const safety = budget.safety;
          const deliveredStop = safety.getReason();
          if (deliveredStop) {
            if (opened) sseError(res, deliveredStop.message, deliveredStop.code);
            else json(res, 409, { error: { message: deliveredStop.message, type: "task_budget", code: deliveredStop.code } });
            return;
          }

          // With tools, agy talks to opencode over MCP: the schema list goes
          // out on session/new and each call comes back as a real tools/call.
          // Without tools there is nothing to bridge, and plain text is both
          // faster and immune to a tool protocol the model might imitate.
          let mcpServers: { type: "http"; name: string; url: string; headers: { name: string; value: string }[] }[] = [];
          if (!native && tools.length > 0) {
            try {
              if (!bridge.listening) await bridge.start();
              const session = bridge.attach(conversation, tools);
              if (session) {
                mcpServers = [{ type: "http", name: "opencode", url: session.url, headers: [session.header] }];
              }
            } catch (err: any) {
              turnState.bridgeError = String(err?.message ?? err).slice(0, 200);
            }
          }

          // Tools are either agy's own (native) or real MCP tools (bridged).
          // The old JSON-envelope preamble belongs to the `--print` fallback;
          // prepending it here told the model to print JSON while real tools
          // were attached, which produced malformed calls and long detours.
          if (!native && tools.length > 0 && mcpServers.length === 0) {
            const message = `OpenCode 工具桥接启动失败：${turnState.bridgeError ?? "没有挂上 MCP 会话"}`;
            if (opened) sseError(res, message, "AGY_BRIDGE");
            else json(res, 502, { error: { message, type: "bridge_error" } });
            return;
          }
          const instruction = systemText;
          bridge.beginTurn(conversation, turn, safety);

          // Results the caller ran last time are answered before the prompt
          // continues, so agy resumes inside the same turn.
          if (!native && tools.length > 0) {
            const callNames = new Map(messages.flatMap((message) => (message.tool_calls ?? []).map((call) => [call.id, call.function?.name] as const)));
            const results = messages
              .filter((m) => m.role === "tool")
              .map((m) => ({ id: m.tool_call_id ?? "", result: toBridgeResult(m.content, m.name ?? callNames.get(m.tool_call_id)) }));
            if (results.length > 0) bridge.answerAll(conversation, results);
          }
          const toolFailure = bridge.failureReason(conversation);
          if (toolFailure) {
            await acpPool.cancel(conversation, toolFailure);
            bridge.cancelCalls(conversation);
            if (opened) sseError(res, toolFailure, "AGY_TOOL_FAILURE_LIMIT");
            else json(res, 409, { error: { message: toolFailure, type: "tool_failure_limit", code: "AGY_TOOL_FAILURE_LIMIT" } });
            return;
          }
          if (safety.reason) {
            if (opened) sseError(res, safety.reason.message, safety.reason.code);
            else json(res, 409, { error: { message: safety.reason.message, type: "task_budget", code: safety.reason.code } });
            return;
          }

          const turnOptions = {
            conversationKey: conversation,
            account: resolveAccount(),
            inputs: acpInputs(messages),
            instruction,
            model,
            // Only used if the ACP session had to be rebuilt: restores the
            // assistant side of the transcript, not just the user turns.
            replayDigest: assistantDigest(messages),
            historyPrompt: acpHistory(messages),
            safety,
            onSupersede: () => bridge.cancelCalls(conversation),
            mcpServers,
            // Native mode leaves agy's own prompt alone: the opencode system
            nativeTools: native,
            // Native tools already ran inside agy. Mirror their completed
            // steps as real tool calls so OpenCode renders cards instead of
            // a wall of ▸/✓ text.
            nativeReplay: nativeMirror,
            toolWrapper,
            autoApprove: settings.autoApproveNative,
            ...(nativeMirror ? {} : { onToolEvent: noteTool }),
            onThought: emitReasoning,
            onModelWarning: (message: string) => {
              turnState.modelWarning = message;
            },
            ...(mcpServers.length > 0
              ? {
                  hasParkedCall: () => bridge.openCalls(conversation).length > 0,
                  parkedCalls: () =>
                    bridge.openCalls(conversation).map((call) => ({
                      id: call.id,
                      name: call.name,
                      arguments: call.arguments,
                    })),
                  waitForPark: (isDone: () => boolean, timeoutMs: number) =>
                    bridge.waitForPark(conversation, isDone, timeoutMs),
                }
              : {}),
            onChunk: (chunk: string) => {
              if (mode === "json") return;
              if (mode === "text") {
                emit(chunk);
                return;
              }
              pending += chunk;
              const t = pending.trimStart();
              if (!t) return;
              if (t.startsWith("{") || t.startsWith("`")) {
                mode = "json";
                return;
              }
              mode = "text";
              const out = pending;
              pending = "";
              emit(out);
            },
          };

          // Capacity 503s are upstream load, not a bad prompt. Wait and retry
          // the SAME model; never silently downgrade the user's choice.
          let outcome: AcpTurnResult | undefined;
          let lastCapacity: unknown;
          let waitedMs = 0;
          let disconnected = false;
          const onDisconnect = () => {
            if (res.writableEnded || disconnected) return;
            disconnected = true;
            safety.finish();
            bridge.cancelCalls(conversation);
            void acpPool.cancel(conversation);
          };
          res.once("close", onDisconnect);
          req.once("aborted", onDisconnect);
          req.socket?.once("close", onDisconnect);
          req.socket?.once("end", onDisconnect);
          try {
          for (let attempt = 0; ; attempt++) {
            if (disconnected) return;
            try {
              const attemptInstruction =
                attempt === 0
                  ? instruction
                  : [instruction, assistantDigest(messages)].filter(Boolean).join("\n\n---\n\n");
              outcome = await turnRunner({
                ...turnOptions,
                instruction: attemptInstruction,
                model,
              });
              if (
                outcome.error &&
                isCapacityError(outcome.error) &&
                !emittedAny &&
                !outcome.text &&
                attempt < capacityDelays.length
              ) {
                lastCapacity = outcome.error;
                outcome = undefined;
                pending = "";
                mode = "unknown";
                const delay = capacityDelays[attempt];
                waitedMs += delay;
                console.warn(
                  `[agy-cli] upstream capacity 503, waiting ${delay}ms (retry ${attempt + 1}/${capacityDelays.length})`,
                );
                await sleep(delay);
                continue;
              }
              break;
            } catch (err: any) {
              if (isCapacityError(err)) {
                lastCapacity = err;
                if (!emittedAny && attempt < capacityDelays.length) {
                  pending = "";
                  mode = "unknown";
                  const delay = capacityDelays[attempt];
                  waitedMs += delay;
                  console.warn(
                    `[agy-cli] upstream capacity 503, waiting ${delay}ms (retry ${attempt + 1}/${capacityDelays.length})`,
                  );
                  await sleep(delay);
                  continue;
                }
                outcome = undefined;
                break;
              }
              // A transport reset before any text is a reportable failure, not a
              // 500 with a Winsock errno in it.
              if (isTransportError(err) && !emittedAny) {
                lastCapacity = err;
                outcome = undefined;
                break;
              }
              throw err;
            }
          }
          } finally {
            res.off("close", onDisconnect);
            req.off("aborted", onDisconnect);
            req.socket?.off("close", onDisconnect);
            req.socket?.off("end", onDisconnect);
          }
          if (disconnected) return;
          // A thrown transport failure reaches here instead of turnState.error.
          if (!outcome && isTransportError(lastCapacity)) {
            const message = transportMessage(0);
            if (opened) sseError(res, message, "AGY_TRANSPORT");
            else json(res, 502, { error: { message, type: "upstream_transport", code: "AGY_TRANSPORT" } });
            return;
          }

          if (!outcome) {
            const message = capacityMessage(waitedMs);
            if (opened) sseError(res, message, "AGY_CAPACITY");
            else json(res, 503, { error: { message, type: "upstream_unavailable", code: "CAPACITY" } });
            return;
          }

          assembled = outcome.text;
          if (!outcome.parked && !outcome.idleTimedOut) safety.finish();
          turnState.parked = outcome.parked;
          turnState.usage = outcome.usage;
          turnState.idleTimedOut = outcome.idleTimedOut === true;
          turnState.error = outcome.error;
          turnState.nativeCalls = (outcome.calls ?? []).map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          }));


          const warning = turnState.modelWarning;
          if (warning !== null) {
            // Headers may already be sent (streaming mode), so the warning goes
            // to the log and to a response header when there is still time.
            try {
              if (!res.headersSent) res.setHeader("x-agy-model-warning", warning.slice(0, 200));
            } catch {
              /* headers already flushed */
            }
            console.warn("[agy-cli] " + warning);
          }

          if (turnState.idleTimedOut) {
            const message =
              "agy produced no activity for the whole idle budget; the turn is still running and was not reported as complete.";
            if (opened) sseError(res, message, "AGY_IDLE_TIMEOUT");
            else json(res, 504, { error: { message, type: "upstream_timeout" } });
            return;
          }

          if (turnState.error) {
            const capacity = isCapacityError(turnState.error);
            const transport = !capacity && isTransportError(turnState.error);
            const message = capacity
              ? capacityMessage(waitedMs)
              : transport
                ? transportMessage(waitedMs > 0 ? 1 : 0)
                : `agy stopped with an error: ${turnState.error}`;
            const code = capacity ? "AGY_CAPACITY" : transport ? "AGY_TRANSPORT" : "AGY_TURN_ERROR";
            if (opened) sseError(res, message, code);
            else {
              json(res, capacity ? 503 : 502, {
                error: {
                  message,
                  type: capacity ? "upstream_unavailable" : transport ? "upstream_transport" : "upstream_error",
                  code,
                },
              });
            }
            return;
          }

          // A parked call ends the OpenAI response: the caller runs the tool and
          // sends the result on the next request, where the prompt resumes.
          const parkedCalls: EmittedToolCall[] = turnState.parked
            ? turnState.nativeCalls.length > 0
              ? turnState.nativeCalls
              : bridge.openCalls(conversation)
            : [];

          // Widened on purpose: the streaming callback assigns `mode`, which
          // TypeScript cannot see from here and narrows to the initial value.
          const settledMode: string = mode;
          const looksJson = settledMode === "json" || settledMode === "unknown";

          if (parkedCalls.length > 0) {
            if (streaming) {
              parkedCalls.forEach((call, index) => {
                send(res, {
                  ...base,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          { index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                });
              });
              send(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
              res.write("data: [DONE]\n\n");
              res.end();
            } else {
              json(res, 200, {
                id: base.id,
                object: "chat.completion",
                created: base.created,
                model: echoed,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: assembled || null,
                      ...(reasoningParts.length > 0 ? { reasoning_content: reasoningParts.join("") } : {}),
                      tool_calls: parkedCalls.map((call) => ({
                        id: call.id,
                        type: "function",
                        function: { name: call.name, arguments: call.arguments },
                      })),
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              });
            }
            return;
          }

          const parsed: ParsedReply = looksJson ? parseReply(assembled) : { content: assembled, toolCalls: [] };

          // The caller sees the tool trail before the answer it produced.
          const transcript = toolTranscript.length > 0 ? toolTranscript.join("").replace(/\n+$/, "") : "";
          const reply: ParsedReply =
            transcript && parsed.content
              ? { content: transcript + "\n\n" + parsed.content, toolCalls: parsed.toolCalls }
              : transcript && parsed.toolCalls.length === 0
                ? { content: transcript, toolCalls: [] }
                : parsed;

          const usage = toOpenAIUsage(turnState.usage);
          if (streaming) {
            if (reply.toolCalls.length > 0) {
              reply.toolCalls.forEach((call, index) => {
                send(res, {
                  ...base,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }],
                      },
                      finish_reason: null,
                    },
                  ],
                });
              });
              if (usage) send(res, { ...base, choices: [], usage });
              send(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
            } else {
              // Nothing was streamed while producing the reply (a JSON
              // envelope, or a single late chunk): emit its content now.
              if (!emittedAny && reply.content) emit(reply.content);
              if (usage) send(res, { ...base, choices: [], usage });
              send(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
            }
            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            wholeReply(res, echoed, reply, turnState.usage, reasoningParts.join(""));
          }
          return;
        }
        // ---- print transport -------------------------------------------------
        if (!run) {
          json(res, 500, { error: { message: "print transport selected without a runner", type: "server_error" } });
          return;
        }

        let rawReply: string;
        try {
          rawReply = await run!(model ?? "", buildPrompt(messages, tools));
        } catch (err: any) {
          json(res, 502, {
            error: {
              message: `agy failed: ${String(err?.message ?? err).slice(0, 400)}`,
              type: "upstream_error",
              code: err?.code,
            },
          });
          return;
        }

        const reply = parseReply(rawReply);
        if (streaming) {
          sseHeaders(res);
          streamFinished(res, echoed, reply);
        } else {
          wholeReply(res, echoed, reply);
        }
        return;
      }

      json(res, 404, { error: { message: `no route for ${req.method} ${url}`, type: "invalid_request_error" } });
    } catch (err: any) {
      if (!res.headersSent) {
        json(res, 500, { error: { message: String(err?.message ?? err), type: "server_error" } });
      } else {
        try {
          res.end();
        } catch {}
      }
    }
  };

  // Fixed port: the provider block written into opencode.jsonc references it, so
  // the number has to survive restarts. A busy port fails loudly rather than
  // silently moving to a port the config does not know about.
  const startPort = options.port ?? Number(process.env.AGY_PROVIDER_PORT ?? 4199);

  const listenOn = (server: Server, port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: any) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
  // A fresh Server per attempt: re-listening a server that just errored is not
  // reliable, and that is what turned a busy port into "no bridge at all".
  let server: Server | null = null;
  let port = startPort;
  for (let attempt = 0; ; attempt++) {
    const candidate = createProviderHttpServer(handler);
    // agy can think for minutes; do not let the socket time out mid-turn.
    candidate.requestTimeout = 0;
    candidate.headersTimeout = 60_000;
    candidate.keepAliveTimeout = 65_000;
    try {
      port = await listenOn(candidate, startPort + attempt);
      server = candidate;
      break;
    } catch (err: any) {
      try {
        candidate.close();
      } catch {}
      if (err?.code !== "EADDRINUSE" || attempt >= 0) throw err;
    }
  }

  const running = server as Server;

  return {
    port,
    url: `http://${host}:${port}`,
    server: running,
    pool: acpPool,
    close: async () => {
      for (const { safety } of budgets.values()) safety.finish();
      budgets.clear();
      await acpPool.settleStops();
      acpPool.dispose();
      await bridge.close();
      await new Promise<void>((resolve) => {
        running.closeAllConnections?.();
        running.close(() => resolve());
      });
    },
  };
}
