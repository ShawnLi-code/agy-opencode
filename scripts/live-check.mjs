/**
 * Calls the running bridge (127.0.0.1:4199) end to end.
 *
 * Verifies the shapes OpenCode consumes: thinking text, real usage, a native
 * agy tool step mirrored as `agy_tool`, resuming after that tool, and a usage
 * chunk on the SSE stream.
 *
 * Run: node scripts/live-check.mjs
 */
const BASE = process.env.AGY_BRIDGE ?? "http://127.0.0.1:4199";
const NONCE = Date.now().toString(36);
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const health = await (await fetch(BASE + "/healthz")).json();
check("health", health.ok === true, JSON.stringify(health));

// ---- 1. thinking + usage -------------------------------------------------
const reasoningRes = await fetch(BASE + "/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "gemini-3.8-flash-high",
    stream: false,
    messages: [
      {
        role: "user",
        content: `Think carefully and show your reasoning, then answer: what is 137 * 19? Reply only the final number. (${NONCE})`,
      },
    ],
  }),
  signal: AbortSignal.timeout(180_000),
});
const reasoning = await reasoningRes.json();
const message = reasoning.choices?.[0]?.message ?? {};
check("reasoning: HTTP 200", reasoningRes.status === 200, String(reasoningRes.status));
check("reasoning: answer", String(message.content ?? "").includes("2603"), JSON.stringify(message.content));
check("reasoning: reasoning_content", typeof message.reasoning_content === "string" && message.reasoning_content.length > 0, `${message.reasoning_content?.length ?? 0} chars`);
check("reasoning: usage", (reasoning.usage?.prompt_tokens ?? 0) > 0 && (reasoning.usage?.completion_tokens ?? 0) > 0, JSON.stringify(reasoning.usage));

// ---- 2. native tool step -------------------------------------------------
const replayTool = {
  type: "function",
  function: {
    name: "agy_tool",
    description: "Internal replay of an agy tool step.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
};
const user = {
  role: "user",
  content: `Run the command: Get-Date. Then reply with exactly DONE. Do not do anything else. (${NONCE})`,
};
const toolRes = await fetch(BASE + "/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "gemini-3.8-flash-medium", stream: false, messages: [user], tools: [replayTool] }),
  signal: AbortSignal.timeout(180_000),
});
const toolJson = await toolRes.json();
const call = toolJson.choices?.[0]?.message?.tool_calls?.[0];
check("tool: finish_reason tool_calls", toolJson.choices?.[0]?.finish_reason === "tool_calls", toolJson.choices?.[0]?.finish_reason);
check("tool: mirrored as agy_tool", call?.function?.name === "agy_tool", call?.function?.name);
check("tool: replay id present", /"id"\s*:/.test(String(call?.function?.arguments ?? "")), call?.function?.arguments);

// ---- 3. resume after the replay ------------------------------------------
// Wait so the prompt can finish while OpenCode "runs" the mirror. The resume
// must still return the final text and must not start a second prompt.
await new Promise((resolve) => setTimeout(resolve, 3000));
const resumedRes = await fetch(BASE + "/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "gemini-3.8-flash-medium",
    stream: false,
    tools: [replayTool],
    messages: [
      user,
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call?.id, content: "Command exited with code 0. Command output: 2026-11-07" },
    ],
  }),
  signal: AbortSignal.timeout(180_000),
});
const resumed = await resumedRes.json();
check("resume: HTTP 200", resumedRes.status === 200, String(resumedRes.status));
check("resume: finish stop", resumed.choices?.[0]?.finish_reason === "stop", resumed.choices?.[0]?.finish_reason);
check("resume: final text", String(resumed.choices?.[0]?.message?.content ?? "").includes("DONE"), JSON.stringify(resumed.choices?.[0]?.message?.content));
check("resume: usage", (resumed.usage?.prompt_tokens ?? 0) > 0, JSON.stringify(resumed.usage));

// ---- 4. streaming usage ---------------------------------------------------
const streamRes = await fetch(BASE + "/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "gemini-3.8-flash-medium",
    stream: true,
    messages: [{ role: "user", content: `Reply with exactly STREAM_OK. (${NONCE}b)` }],
  }),
  signal: AbortSignal.timeout(180_000),
});
const reader = streamRes.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let text = "";
let sawUsage = false;
let sawDone = false;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buffer.indexOf("\n\n")) >= 0) {
    const event = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 2);
    if (!event.startsWith("data: ")) continue;
    const payload = event.slice(6);
    if (payload === "[DONE]") {
      sawDone = true;
      continue;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (chunk.usage) sawUsage = true;
    const delta = chunk.choices?.[0]?.delta;
    if (typeof delta?.content === "string") text += delta.content;
  }
}
check("stream: text", text.includes("STREAM_OK"), JSON.stringify(text));
check("stream: usage chunk", sawUsage);
check("stream: [DONE]", sawDone);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(failed.length === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
