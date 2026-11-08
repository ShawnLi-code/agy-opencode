/**
 * Loopback MCP server that lets the agy agent call opencode's tools directly.
 *
 * Why this replaces the JSON envelope: the envelope asked the model to *print*
 * `{"tool_calls":[...]}` and trusted it to comply. That path cannot express a
 * tool result as anything but re-serialised text, cannot stream, and cannot run
 * two tools at once. MCP is what agy natively speaks, so tool calls arrive as
 * real `tools/call` requests with structured results going back.
 *
 * The shape follows the Agent Client Protocol contract agy already uses: the
 * server is passed on `session/new`, and each session gets its own path and
 * bearer token so two sessions can never see each other's tools.
 *
 * Transport: MCP Streamable HTTP. A `tools/call` answers with an SSE stream so
 * response headers leave immediately — the agent's HTTP client abandons a
 * request that produces no headers within 60 seconds, which is far shorter than
 * a real opencode tool can take.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";

/** One tool schema advertised over MCP. */
export interface BridgeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One content item returned to the agent. */
export type BridgeContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Result of one tool call. */
export interface BridgeToolResult {
  content: BridgeContent[];
  isError?: boolean;
}

/** One `tools/call` request handed to opencode. */
export interface BridgeCallRequest {
  /** Session key from the request path, so the owner knows who is calling. */
  sessionKey: string;
  /** Tool name without any agent-side prefix. */
  name: string;
  /** Parsed arguments. */
  arguments: Record<string, unknown>;
  /** Aborts when the agent disconnects or cancels. */
  signal: AbortSignal;
}

/** What the bridge needs from its owner. */
export interface BridgeRouter {
  /** Tools one session may call. */
  listTools(sessionKey: string): BridgeTool[];
  /** Runs one tool call; may stay pending for the whole tool execution. */
  callTool(request: BridgeCallRequest): Promise<BridgeToolResult>;
}

export interface McpBridgeOptions {
  /** Interval for SSE keepalive comments while a call is parked. */
  keepAliveMs?: number;
  log?: (message: string) => void;
}

/** MCP protocol revision this server implements. */
const MCP_PROTOCOL_VERSION = "2025-06-18";

/** One registered session endpoint. */
interface Tenant {
  key: string;
  secret: string;
}

/** Streamable-HTTP MCP server bound to loopback. */
export class McpBridge {
  private server: Server | null = null;
  private tenants = new Map<string, Tenant>();
  private actualPort = 0;

  constructor(
    private readonly router: BridgeRouter,
    private readonly options: McpBridgeOptions = {},
  ) {}

  /** Base URL, valid after `start()`. */
  get url(): string {
    return `http://127.0.0.1:${this.actualPort}`;
  }

  get port(): number {
    return this.actualPort;
  }

  /**
   * Starts listening on an ephemeral loopback port.
   *
   * @param port - 0 (default) lets the OS choose, which avoids collisions with a
   *   previous instance that has not finished closing.
   */
  async start(port = 0): Promise<void> {
    if (this.server) return;

    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.options.log?.(`mcp bridge: ${String(err).slice(0, 200)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "bridge error" }, id: null }));
        } else {
          res.end();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.server = server;
    this.actualPort = (server.address() as AddressInfo).port;
  }

  /**
   * Registers one isolated endpoint and returns what `session/new` needs.
   *
   * A distinct path plus a bearer token means a session can only reach the tools
   * advertised for it, and a leaked URL is useless without the token.
   */
  createTenant(): { key: string; url: string; header: { name: string; value: string } } {
    // Handing out a URL before the socket is bound produces `:0/mcp/...`,
    // which agy accepts without complaint and then never connects to — the
    // session just times out with no request ever arriving. Fail loudly here
    // instead of debugging that from the far side.
    if (!this.server) throw new Error("McpBridge.createTenant() called before start()");

    const key = randomBytes(16).toString("hex");
    const secret = randomBytes(24).toString("hex");
    this.tenants.set(key, { key, secret });
    return {
      key,
      url: `${this.url}/mcp/${key}`,
      header: { name: "Authorization", value: `Bearer ${secret}` },
    };
  }

  /** Forgets one endpoint. */
  removeTenant(key: string): void {
    this.tenants.delete(key);
  }

  /** Stops serving, closing every open connection. */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.tenants.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Constant-time bearer check for one endpoint. */
  private authorised(key: string | null, header: string | undefined): Tenant | null {
    if (!key) return null;
    const tenant = this.tenants.get(key);
    if (!tenant) return null;
    const got = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1] ?? "";
    const a = Buffer.from(got);
    const b = Buffer.from(tenant.secret);
    if (a.length !== b.length) return null;
    return timingSafeEqual(a, b) ? tenant : null;
  }

  /** Routes one HTTP request. */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    // agy probes OAuth discovery before it trusts a server as unauthenticated.
    // Measured on 1.5.2: answering 404 makes its MCP client give up without
    // ever sending a request (the session preload then times out); answering
    // 200 with no metadata is read as "this server needs no OAuth" and the
    // handshake proceeds immediately. dsh returns 404 here, which is why its
    // bridge is not known to work against this CLI build.
    if (url.pathname.startsWith("/.well-known/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }

    const match = /^\/mcp\/([0-9a-f]+)$/.exec(url.pathname);

    if (!match) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const tenant = this.authorised(match[1], req.headers.authorization);
    if (!tenant) {
      // The authorized handshake is the only accepted probing evidence, so an
      // unauthorised request learns nothing about the tool list.
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (req.method !== "POST") {
      // Streamable HTTP allows a GET for server-initiated streams; this bridge
      // never initiates, so answer with an empty method list instead of hanging.
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    const body = await readJson(req);
    if (body === null) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null }));
      return;
    }

    // A batch is an array; MCP treats it as several requests.
    if (Array.isArray(body)) {
      const answers = [];
      for (const one of body) {
        const answer = await this.dispatch(tenant, one, res);
        if (answer !== undefined) answers.push(answer);
      }
      if (res.headersSent) return;
      if (answers.length === 0) {
        // Only notifications: acknowledge without a body.
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answers));
      return;
    }

    const answer = await this.dispatch(tenant, body, res);
    if (res.headersSent) return;

    if (answer === undefined) {
      // A notification has no reply body. It still needs a response: leaving
      // the request open makes the client hang on its next step and the whole
      // MCP preload times out. 202 is what the spec asks for.
      res.writeHead(202);
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
  }

  /**
   * Handles one JSON-RPC message.
   *
   * `tools/call` writes its own SSE response, so it returns undefined: the reply
   * is already on the wire by the time it resolves.
   */
  private async dispatch(tenant: Tenant, msg: any, res: ServerResponse): Promise<unknown> {
    const id = msg?.id ?? null;
    const method = typeof msg?.method === "string" ? msg.method : "";
    const params = msg?.params ?? {};

    // Notifications never carry an id and must not receive JSON-RPC replies.
    // In particular agy sends notifications/roots/list_changed during preload.
    if (msg?.id === undefined && method) return undefined;

    // agy probes `server/discover` before `initialize` (protocol 2026-07-28+).
    // Answering it with the same capability block keeps the handshake to one
    // round trip; replying -32601 costs one more and blew the 5s preload budget.
    if (method === "server/discover" || method === "initialize") {
      const requested =
        typeof params?.protocolVersion === "string" && params.protocolVersion.length > 0
          ? params.protocolVersion
          : MCP_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          // Echo the client's revision. agy opens with 2025-11-25 and tolerates
          // an older answer, but echoing avoids a second negotiation round.
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "agy-opencode", version: "1.0.0" },
        },
      };
    }

    if (method === "notifications/initialized" || method === "initialized") {
      return undefined;
    }

    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: this.router.listTools(tenant.key).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };
    }

    if (method === "tools/call") {
      await this.streamToolCall(tenant, id, params, res);
      return undefined;
    }

    // Unknown method: JSON-RPC says answer with -32601, not silence.
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
  }

  /**
   * Runs one tool call and streams its result.
   *
   * Headers leave before the tool runs, so the agent's 60-second header deadline
   * cannot fire. Comment frames keep the connection visibly alive while a slow
   * tool (a build, a subagent) is still working.
   */
  private async streamToolCall(
    tenant: Tenant,
    id: unknown,
    params: any,
    res: ServerResponse,
  ): Promise<void> {
    const name = typeof params?.name === "string" ? params.name : "";
    const schema = this.router.listTools(tenant.key).find((tool) => tool.name === name)?.inputSchema;
    const args = coerceToolArguments(params?.arguments, schema);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    });
    // writeHead alone buffers the headers until the first body write. A parked
    // OpenCode tool may take minutes, so flush before awaiting its result.
    res.flushHeaders();

    const controller = new AbortController();
    res.on("close", () => controller.abort());

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    }, this.options.keepAliveMs ?? 15_000);

    const sendResult = (result: unknown): void => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`);
      res.end();
    };

    try {
      const result = await this.router.callTool({
        sessionKey: tenant.key,
        name,
        arguments: args as Record<string, unknown>,
        signal: controller.signal,
      });
      sendResult({
        content: result.content.map((c) =>
          c.type === "text" ? { type: "text", text: c.text } : { type: "image", data: c.data, mimeType: c.mimeType },
        ),
        ...(result.isError ? { isError: true } : {}),
      });
    } catch (err) {
      // A tool failure is a result, not a transport error: the agent has to see
      // the message to decide what to do next.
      sendResult({
        content: [{ type: "text", text: String((err as any)?.message ?? err).slice(0, 4000) }],
        isError: true,
      });
    } finally {
      clearInterval(keepAlive);
    }
  }
}

/**
 * Normalises the arguments of one `tools/call`.
 *
 * agy's model sometimes sends a bare string for a single-parameter tool (for
 * example the search query itself) even though MCP expects an object. Passing
 * that through as `{}` made opencode report "tool execution failed" because
 * the required `query` was missing. A JSON object string is parsed; a plain
 * string is wrapped under the schema's single required string property.
 *
 * @param raw - `params.arguments` as received over MCP.
 * @param schema - the tool's input schema, when it is known.
 */
export function coerceToolArguments(
  raw: unknown,
  schema?: Record<string, unknown>,
): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") return {};

  const text = raw.trim();
  if (!text) return {};

  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* not a JSON object; fall through to the single-parameter wrap */
    }
  }

  const props =
    schema?.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, any>)
      : {};
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((key): key is string => typeof key === "string" && key in props)
    : [];
  const keys = required.length > 0 ? required : Object.keys(props);
  const stringKeys = keys.filter((key) => props[key]?.type === "string");
  if (stringKeys.length === 1) return { [stringKeys[0]]: text };
  if (keys.length === 1) return { [keys[0]]: text };
  return {};
}

/** Reads and parses one JSON body. */
function readJson(req: IncomingMessage): Promise<any | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}
