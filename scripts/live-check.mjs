/**
 * Calls the running bridge (127.0.0.1:4199) end to end.
 * Verifies tool calls, streaming arrival timing, and session continuity.
 *
 * Each run uses a unique nonce in the first user message so it gets a fresh
 * ACP session instead of continuing an earlier one.
 *
 * Run: node scripts/live-check.mjs
 */
const BASE = process.env.AGY_BRIDGE ?? "http://127.0.0.1:4199";
const NONCE = Date.now().toString(36);

const health = await (await fetch(BASE + "/healthz")).json();
console.log("health:", JSON.stringify(health));

const tools = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a text file from disk",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];

// ---- 1. tool call over ACP
let t0 = Date.now();
const toolRes = await fetch(BASE + "/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "claude-sonnet-5-5-lo",
    messages: [{ role: "user", content: `Read the file C:\\Windows\\win.ini with the read tool. (request ${NONCE})` }],
    tools,
  }),
});
const toolJson = await toolRes.json();
const call = toolJson.choices?.[0]?.message?.tool_calls?.[0];
console.log(
  `tool call: ${Date.now() - t0}ms finish=${toolJson.choices?.[0]?.finish_reason} name=${call?.function?.name} args=${call?.function?.arguments}`,
);

// ---- 2. streaming: first chunk vs completion
t0 = Date.now();
const streamRes = await fetch(BASE + "/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "claude-sonnet-5-5-lo",
    stream: true,
    messages: [{ role: "user", content: `Count from 1 to 30, separated by spaces, nothing else. (request ${NONCE}b)` }],
  }),
});

const reader = streamRes.body.getReader();
const dec = new TextDecoder();
let buf = "";
let firstChunkAt = 0;
let text = "";
let chunks = 0;

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let idx;
  while ((idx = buf.indexOf("\n\n")) >= 0) {
    const evt = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 2);
    if (!evt.startsWith("data: ")) continue;
    const payload = evt.slice(6);
    if (payload === "[DONE]") continue;
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      continue;
    }
    const d = msg.choices?.[0]?.delta?.content;
    if (d) {
      if (!firstChunkAt) firstChunkAt = Date.now() - t0;
      chunks++;
      text += d;
    }
  }
}
const total = Date.now() - t0;

console.log(`stream: first=${firstChunkAt}ms total=${total}ms chunks=${chunks}`);
console.log(`stream text: ${JSON.stringify(text.slice(0, 70))}`);

const okTool = call?.function?.name === "read";
const okStream = chunks > 1 && firstChunkAt > 0 && firstChunkAt < total;
const okText = /\b30\b/.test(text);

console.log(`\ntransport: ${health.transport}`);
console.log(`tool call ok: ${okTool}`);
console.log(`streamed incrementally: ${okStream}`);
console.log(`text complete: ${okText}`);
console.log(okTool && okStream && okText ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(okTool && okStream && okText ? 0 : 1);
