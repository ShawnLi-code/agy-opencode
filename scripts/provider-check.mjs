/**
 * Exercises the OpenAI-compatible provider without touching opencode or agy.
 *
 * The server module is bundled with esbuild first (the plugin's sources use
 * extensionless imports, which Bun resolves but plain Node does not), then the
 * HTTP surface is driven with real requests and a fake `run`.
 *
 * Run: node scripts/provider-check.mjs
 */
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "agy-provider-check-"));
const outfile = join(dir, "server.mjs");

await build({
  entryPoints: ["src/provider/server.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile,
  logLevel: "silent",
});

const { startProvider } = await import(pathToFileURL(outfile).href);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ---------------------------------------------------------------- fake agy
let lastPrompt = "";
let nextReply = '{"content":"hello from agy"}';

const provider = await startProvider({
  port: 4319,
  run: async (_tier, prompt) => {
    lastPrompt = prompt;
    return nextReply;
  },
});

const base = provider.url;
console.log("server:", base);

try {
  // ------------------------------------------------------------- /v1/models
  const modelsRes = await fetch(base + "/v1/models");
  const models = await modelsRes.json();
  const ids = (models.data ?? []).map((m) => m.id);
  check("GET /v1/models returns 13 tiers", ids.length === 13, `${ids.length} models`);
  check("argon-4-lo present", ids.includes("argon-4-lo"));
  check("gpt-oss-med present", ids.includes("gpt-oss-med"));

  // --------------------------------------------------- non-stream, plain text
  nextReply = '{"content":"hello from agy"}';
  const textRes = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "argon-4-lo",
      messages: [{ role: "user", content: "say hi" }],
    }),
  });
  const textBody = await textRes.json();
  check("text: HTTP 200", textRes.status === 200, String(textRes.status));
  check("text: content passed through", textBody.choices?.[0]?.message?.content === "hello from agy");
  check("text: finish_reason stop", textBody.choices?.[0]?.finish_reason === "stop");

  // ------------------------------------------------------------- tool call
  nextReply = '{"tool_calls":[{"name":"read","arguments":{"path":"a.txt"}}]}';
  const toolRes = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "agy-cli/argon-4-lo",
      messages: [{ role: "user", content: "read a.txt" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        },
      ],
    }),
  });
  const toolBody = await toolRes.json();
  const call = toolBody.choices?.[0]?.message?.tool_calls?.[0];
  check("tool: finish_reason tool_calls", toolBody.choices?.[0]?.finish_reason === "tool_calls");
  check("tool: name parsed", call?.function?.name === "read", call?.function?.name);
  check("tool: arguments is JSON string", call?.function?.arguments === '{"path":"a.txt"}', call?.function?.arguments);
  check("tool: call has id", typeof call?.id === "string" && call.id.startsWith("call_"));
  check("prompt carried the tool schema", lastPrompt.includes('"name":"read"') || lastPrompt.includes('"name": "read"'));
  check("prompt carried the protocol", lastPrompt.includes("tool_calls"));
  check("prompt carried the user turn", lastPrompt.includes("read a.txt"));

  // ---------------------------------------------------------------- streaming
  nextReply = '{"content":"streamed reply text"}';
  const streamRes = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "flash-3.8-lo",
      stream: true,
      messages: [{ role: "user", content: "stream please" }],
    }),
  });
  const raw = await streamRes.text();
  const events = raw
    .split("\n\n")
    .map((l) => l.replace(/^data: /, "").trim())
    .filter(Boolean);
  const doneSeen = events.includes("[DONE]");
  const chunks = events.filter((e) => e !== "[DONE]").map((e) => JSON.parse(e));
  const textStreamed = chunks
    .map((c) => c.choices?.[0]?.delta?.content ?? "")
    .join("");
  check("stream: content-type is SSE", (streamRes.headers.get("content-type") || "").includes("text/event-stream"));
  check("stream: terminated with [DONE]", doneSeen);
  check("stream: text reassembles", textStreamed === "streamed reply text", JSON.stringify(textStreamed));
  check("stream: finish_reason stop", chunks.at(-1)?.choices?.[0]?.finish_reason === "stop");

  // --------------------------------------------------------- streaming tools
  nextReply = '{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}}]}';
  const tfRes = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "argon-4-lo", stream: true, messages: [{ role: "user", content: "ls" }] }),
  });
  const tfRaw = await tfRes.text();
  const tfChunks = tfRaw
    .split("\n\n")
    .map((l) => l.replace(/^data: /, "").trim())
    .filter((e) => e && e !== "[DONE]")
    .map((e) => JSON.parse(e));
  const deltaCall = tfChunks.map((c) => c.choices?.[0]?.delta?.tool_calls?.[0]).find(Boolean);
  const finish = tfChunks.at(-1)?.choices?.[0]?.finish_reason;
  check("stream tool: delta carries name", deltaCall?.function?.name === "bash");
  check("stream tool: finish_reason tool_calls", finish === "tool_calls", String(finish));

  // ------------------------------------------------------- plain-text reply
  nextReply = "I am just prose, not JSON.";
  const proseRes = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "argon-4-lo", messages: [{ role: "user", content: "hi" }] }),
  });
  const prose = await proseRes.json();
  check(
    "fallback: prose kept as content",
    prose.choices?.[0]?.message?.content === "I am just prose, not JSON.",
    prose.choices?.[0]?.message?.content,
  );

  // ------------------------------------------------- fenced JSON still parses
  nextReply = '```json\n{"tool_calls":[{"name":"glob","arguments":{"pattern":"*.ts"}}]}\n```';
  const fenceRes = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "argon-4-lo", messages: [{ role: "user", content: "find ts" }] }),
  });
  const fence = await fenceRes.json();
  check("fenced: tool parsed", fence.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === "glob");
} finally {
  await provider.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(failed.length === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
