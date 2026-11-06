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

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountEnv, type Account } from "../accounts";

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

interface SessionState {
  sessionId: string;
  /** How many user/tool inputs have already been sent to this session. */
  seenInputs: number;
  lastUsed: number;
}

export type ChunkHandler = (text: string) => void;

const IDLE_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 16;

/**
 * A tool-free agent preset, installed by the plugin. Without it agy tries to
 * run its own tools, which we must deny — and a denial aborts the whole turn.
 */
const AGENT = process.env.AGY_ACP_AGENT ?? "agy-opencode-toolfree";

/**
 * Preset text installed into `~/.gemini/antigravity-cli/gemini-root-config/agents`.
 * `tools: []` plus `commandExecutionPolicy: off` leaves the agent no way to act
 * on its own, so it can only answer — or emit a tool call for the caller.
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
return the best text response.

Do not call tools, execute commands, access files, browse the network, use MCP,
or delegate to subagents. The caller owns the outer conversation and tool
policy: when a tool is needed you emit a JSON tool call instead of performing
it yourself.
`;

/** Installs the preset under this account's home, if it is not there yet. */
function ensureAgentPreset(accountHome: string): void {
  const root = accountHome || homedir();
  const dir = join(root, ".gemini", "antigravity-cli", "gemini-root-config", "agents");
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${AGENT}.md`);
    if (!existsSync(file)) writeFileSync(file, AGENT_PRESET, "utf8");
  } catch {
    /* a read-only home falls back to whatever preset already exists */
  }
}

class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready: Promise<void> | null = null;
  private closed = false;
  private listeners = new Set<(sessionId: string, text: string) => void>();

  constructor(private readonly account: Account) {}

  private env(): Record<string, string> {
    return { ...process.env, ...accountEnv(this.account) } as Record<string, string>;
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = new Promise<void>((resolve, reject) => {
      ensureAgentPreset(this.account.home);
      const child = spawn("agy", ["acp", "--agent", AGENT], {
        env: this.env(),
        cwd: process.cwd(),
        shell: true,
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;

      this.child = child;

      child.stdout.on("data", (b: Buffer) => this.onData(b.toString("utf8")));
      child.stderr.on("data", () => {
        /* agy logs to stderr; ignore so it cannot pollute the protocol */
      });
      child.on("exit", () => {
        this.closed = true;
        for (const [, p] of this.pending) p.reject(new Error("agy acp exited"));
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
        }
        continue;
      }

      // The agent asking to run one of its own tools. opencode owns tools here,
      // so refuse; the protocol prompt already forbids self-execution.
      if (msg.method === "session/request_permission" && msg.id !== undefined) {
        this.write({
          jsonrpc: "2.0",
          id: msg.id,
          result: { outcome: { outcome: "cancelled" } },
        });
      }
    }
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

  async newSession(): Promise<string> {
    await this.start();
    const res = await this.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    return res.sessionId as string;
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
    try {
      this.child?.kill();
    } catch {
      /* already gone */
    }
  }
}

export class AcpPool {
  private clients = new Map<string, AcpClient>();
  private sessions = new Map<string, SessionState>();

  private clientFor(account: Account): AcpClient {
    let c = this.clients.get(account.id);
    if (!c) {
      c = new AcpClient(account);
      this.clients.set(account.id, c);
    }
    return c;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, s] of this.sessions) {
      if (now - s.lastUsed > IDLE_MS) this.sessions.delete(key);
    }
    while (this.sessions.size > MAX_SESSIONS) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [key, s] of this.sessions) {
        if (s.lastUsed < oldest) {
          oldest = s.lastUsed;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.sessions.delete(oldestKey);
    }
  }

  /**
   * Sends only the inputs this conversation has not sent yet and streams the
   * reply. `inputs` are the user/tool messages in order; assistant turns are
   * already known to the session and are not re-sent.
   */
  async turn(options: {
    conversationKey: string;
    account: Account;
    inputs: string[];
    /** Sent ahead of the new input on every turn (tool catalogue + contract). */
    instruction?: string;
    onChunk: ChunkHandler;
  }): Promise<string> {
    this.sweep();
    const client = this.clientFor(options.account);

    let state = this.sessions.get(options.conversationKey);
    if (!state || state.seenInputs > options.inputs.length) {
      const sessionId = await client.newSession();
      state = { sessionId, seenInputs: 0, lastUsed: Date.now() };
      this.sessions.set(options.conversationKey, state);
    }

    const fresh = options.inputs.slice(state.seenInputs);
    state.seenInputs = options.inputs.length;
    state.lastUsed = Date.now();

    const parts: string[] = [];
    if (options.instruction) parts.push(options.instruction);
    if (fresh.length > 0) parts.push(fresh.join("\n\n"));
    const text = parts.join("\n\n---\n\n").trim() || "(continue)";

    let assembled = "";
    const off = client.onChunk((sessionId, chunk) => {
      if (sessionId !== state!.sessionId) return;
      assembled += chunk;
      options.onChunk(chunk);
    });

    try {
      await client.prompt(state.sessionId, text);
    } finally {
      off();
    }

    return assembled;
  }

  dispose(): void {
    for (const [, c] of this.clients) c.kill();
    this.clients.clear();
    this.sessions.clear();
  }

  /** Test/diagnostics hook: what is currently resident. */
  stats(): { clients: number; sessions: number } {
    return { clients: this.clients.size, sessions: this.sessions.size };
  }
}

export const acpPool = new AcpPool();
