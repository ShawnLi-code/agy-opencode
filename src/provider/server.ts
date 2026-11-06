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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { TIER_LABEL, ALL_TIERS } from "../tiers";
import { buildPrompt, parseReply, protocolPreamble, type OpenAIMessage, type OpenAITool, type ParsedReply } from "./protocol";
import { acpPool } from "./acp";
import { loadAccounts, pickAccount, type Account } from "../accounts";

export interface ProviderServerOptions {
  port?: number;
  host?: string;
  /** One-shot runner for `print` transport. */
  run?: (tier: string, prompt: string, signal?: AbortSignal) => Promise<string>;
  /** Defaults to `acp`, or `print` when a `run` is injected. */
  transport?: "acp" | "print";
  /** Account resolution, injectable for tests. */
  resolveAccount?: () => Account;
}

export interface ProviderServer {
  port: number;
  url: string;
  close: () => Promise<void>;
  server: Server;
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

/** `agy-cli/argon-4-lo` and `argon-4-lo` both resolve. */
function tierOf(model: string | undefined, fallback = "flash-3.8-med"): string {
  if (!model) return fallback;
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  return TIER_LABEL[bare] ? bare : fallback;
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

/** Only user and tool messages are new input; assistant turns are the replies. */
function acpInputs(messages: readonly OpenAIMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const t = textOf(m.content);
      if (t) out.push(t);
    } else if (m.role === "tool") {
      out.push(`[TOOL RESULT${m.name ? ` name=${m.name}` : ""}]\n${textOf(m.content)}`);
    }
  }
  return out;
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

/** Non-streaming response built from a parsed reply. */
function wholeReply(res: ServerResponse, model: string, reply: ParsedReply): void {
  const message: Record<string, unknown> = { role: "assistant", content: reply.content || null };
  if (reply.toolCalls.length > 0) {
    message.tool_calls = reply.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }));
  }
  json(res, 200, {
    id: id("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: reply.toolCalls.length > 0 ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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
  const resolveAccount = options.resolveAccount ?? (() => pickAccount(loadAccounts()));

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    try {
      if (req.method === "GET" && (url === "/healthz" || url === "/")) {
        json(res, 200, { ok: true, provider: "agy-cli", transport, loadedAt: MODULE_LOADED_AT });
        return;
      }

      if (req.method === "GET" && url.startsWith("/v1/models")) {
        const created = Math.floor(Date.now() / 1000);
        json(res, 200, {
          object: "list",
          data: ALL_TIERS.map((t) => ({ id: t, object: "model", created, owned_by: "agy-cli", name: TIER_LABEL[t] })),
        });
        return;
      }

      if (req.method === "POST" && url.startsWith("/v1/chat/completions")) {
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
        const model = String(body.model ?? "flash-3.8-med");
        const tier = tierOf(model);
        const streaming = !!body.stream;

        const base = {
          id: id("chatcmpl"),
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
        };

        if (transport === "acp") {
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

          const emit = (text: string) => {
            if (!streaming || !text) return;
            emittedAny = true;
            for (let i = 0; i < text.length; i += CHUNK) {
              send(res, { ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + CHUNK) }, finish_reason: null }] });
            }
          };

          let assembled = "";
          const systemText = messages
            .filter((m) => m.role === "system")
            .map((m) => textOf(m.content))
            .filter(Boolean)
            .join("\n\n");
          const instruction = [systemText, protocolPreamble(tools)].filter(Boolean).join("\n\n---\n\n");

          try {
            assembled = await acpPool.turn({
              conversationKey: conversationKey(messages),
              account: resolveAccount(),
              inputs: acpInputs(messages),
              instruction,
              onChunk: (chunk) => {
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
            });
          } catch (err: any) {
            if (opened) {
              res.write("data: [DONE]\n\n");
              res.end();
            } else {
              json(res, 502, { error: { message: `agy acp failed: ${String(err?.message ?? err).slice(0, 300)}`, type: "upstream_error" } });
            }
            return;
          }

          const looksJson = mode === "json" || mode === "unknown";
          const reply: ParsedReply = looksJson ? parseReply(assembled) : { content: assembled, toolCalls: [] };

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
              send(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
            } else {
              // Nothing was streamed while producing the reply (a JSON
              // envelope, or a single late chunk): emit its content now.
              if (!emittedAny && reply.content) emit(reply.content);
              send(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
            }
            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            wholeReply(res, model, reply);
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
          rawReply = await run(tier, buildPrompt(messages, tools));
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
          streamFinished(res, model, reply);
        } else {
          wholeReply(res, model, reply);
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
    const candidate = createServer(handler);
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
    close: () =>
      new Promise<void>((resolve) => {
        running.closeAllConnections?.();
        running.close(() => resolve());
      }),
  };
}
