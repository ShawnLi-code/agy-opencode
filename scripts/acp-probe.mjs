/**
 * Speaks ACP to `agy acp` to learn the handshake and event shapes.
 *
 * ACP is JSON-RPC 2.0 over stdio, one JSON object per line. This script drives
 * the minimum useful flow — initialize → session/new → session/prompt — and
 * prints every message the agent sends back.
 *
 * Run: node scripts/acp-probe.mjs ["your prompt"]
 */
import { spawn } from "node:child_process";

import { readFileSync } from "node:fs";

const arg = process.argv[2];
const prompt =
  arg && arg.startsWith("--file ")
    ? readFileSync(arg.slice("--file ".length).trim(), "utf8")
    : (arg ?? "Reply with exactly: ACP_OK");
const cwd = process.cwd();

const child = spawn("agy", ["acp"], {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  shell: true,
  windowsHide: true,
});

let buf = "";
let sessionId = null;
let nextId = 1;
const started = Date.now();

const send = (method, params) => {
  const msg = { jsonrpc: "2.0", id: nextId++, method, params };
  console.log(`--> ${method} ${JSON.stringify(params).slice(0, 200)}`);
  child.stdin.write(JSON.stringify(msg) + "\n");
};

const notify = (method, params) => {
  console.log(`--> (notify) ${method}`);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
};

child.stdout.on("data", (b) => {
  buf += b.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log(`<-- (non-json) ${line.slice(0, 200)}`);
      continue;
    }

    // Result of our requests.
    if (msg.id && !msg.method) {
      console.log(`<-- result id=${msg.id} after ${Date.now() - started}ms`);
      const brief = JSON.parse(JSON.stringify(msg));
      if (brief.result?.agentCapabilities) {
        brief.result.agentCapabilities = "<omitted>";
        brief.result.authMethods = (brief.result.authMethods ?? []).map((a) => a.id);
      }
      console.log(JSON.stringify(brief, null, 1).slice(0, 1200));

      if (msg.id === 1) {
        send("session/new", { cwd, mcpServers: [] });
        continue;
      }
      if (msg.result?.sessionId) {
        sessionId = msg.result.sessionId;
        console.log(`\n>>> sessionId = ${sessionId}\n`);
        send("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        });
        continue;
      }
      continue;
    }

    // Notifications from the agent (streaming, tool calls, permission asks).
    const method = msg.method;
    const kind = msg.params?.update?.sessionUpdate ?? "";
    const text = msg.params?.update?.content?.text ?? "";
    console.log(`<-- ${method}${kind ? " [" + kind + "]" : ""} ${String(text).slice(0, 160)}`);

    if (method === "session/update" && kind === "agent_message_chunk") {
      process.stdout.write("");
    }
    if (method === "session/request_permission") {
      // Auto-allow so the probe can finish unattended.
      const options = msg.params?.options ?? [];
      const allow = options.find((o) => /allow/i.test(o.optionId ?? "")) ?? options[0];
      if (msg.id) {
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: allow ? { optionId: allow.optionId } : { outcome: { outcome: "cancelled" } },
          }) + "\n",
        );
        console.log(`--> permission reply ${allow?.optionId ?? "cancel"}`);
      }
    }
  }
});

child.stderr.on("data", (b) => {
  const s = b.toString("utf8").trim();
  if (s) console.log(`[stderr] ${s.slice(0, 300)}`);
});

child.on("exit", (code) => {
  console.log(`\n[exit] code=${code} after ${Date.now() - started}ms`);
  process.exit(0);
});

// Kick off the handshake.
send("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});

setTimeout(() => {
  console.log("\n[timeout] closing");
  child.kill();
  process.exit(0);
}, 120_000);
