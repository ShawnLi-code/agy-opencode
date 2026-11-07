/**
 * End-to-end check of the OpenAI-compatible provider over a real agy ACP
 * session. Verifies the shapes OpenCode consumes:
 *   - reasoning_content + usage on a non-streaming reply
 *   - finish_reason tool_calls for a native agy tool step
 *   - resuming the same prompt after the tool replay
 *   - a usage chunk in the SSE stream
 *
 * Run: bun scripts/check-provider-acp.mjs
 */
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The native-tool mirror only exists in native mode. The user's settings file
// may be "bridged", so pin this test's mode instead of depending on it.
process.env.AGY_AGENT_MODE = "native";

const outfile = join(mkdtempSync(join(tmpdir(), "agy-provider-acp-")), "server.mjs");
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
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const server = await startProvider({ transport: "acp", port: 0 });
const base = server.url;

try {
  const models = await (await fetch(base + "/v1/models")).json();
  check("models: catalogue is non-empty", Array.isArray(models.data) && models.data.length > 0, `${models.data?.length ?? 0} models`);

  // ---- reasoning + usage --------------------------------------------------
  const reasoningRes = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gemini-3.8-flash-high",
      stream: false,
      messages: [{ role: "user", content: "Think carefully and show your reasoning, then answer: what is 137 * 19? Reply only the final number." }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const reasoning = await reasoningRes.json();
  const reasoningMessage = reasoning.choices?.[0]?.message ?? {};
  check("reasoning: HTTP 200", reasoningRes.status === 200, String(reasoningRes.status));
  check("reasoning: answer arrived", String(reasoningMessage.content ?? "").includes("2603"), JSON.stringify(reasoningMessage.content));
  check("reasoning: reasoning_content present", typeof reasoningMessage.reasoning_content === "string" && reasoningMessage.reasoning_content.length > 0, `${reasoningMessage.reasoning_content?.length ?? 0} chars`);
  check("reasoning: prompt tokens reported", (reasoning.usage?.prompt_tokens ?? 0) > 0, JSON.stringify(reasoning.usage));
  check("reasoning: output tokens reported", (reasoning.usage?.completion_tokens ?? 0) > 0, JSON.stringify(reasoning.usage));
  check("reasoning: thought tokens reported", (reasoning.usage?.completion_tokens_details?.reasoning_tokens ?? 0) > 0, JSON.stringify(reasoning.usage));

  // ---- native tool step ---------------------------------------------------
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
  const user = { role: "user", content: "Run the command: Get-Date. Then reply with exactly DONE. Do not do anything else." };
  const toolRes = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini-3.8-flash-medium", stream: false, messages: [user], tools: [replayTool] }),
    signal: AbortSignal.timeout(120_000),
  });
  const toolBody = await toolRes.json();
  const toolCall = toolBody.choices?.[0]?.message?.tool_calls?.[0];
  check("tool: HTTP 200", toolRes.status === 200, String(toolRes.status));
  check("tool: finish_reason tool_calls", toolBody.choices?.[0]?.finish_reason === "tool_calls", toolBody.choices?.[0]?.finish_reason);
  check("tool: mirrored as agy_tool", toolCall?.function?.name === "agy_tool", toolCall?.function?.name);
  check("tool: arguments carry a replay id", /"id"\s*:/.test(String(toolCall?.function?.arguments ?? "")), toolCall?.function?.arguments);

  // Give the prompt time to finish while OpenCode is "running" the mirror.
  // The resume must still return the final text, not start a second prompt
  // with the tool output as user input.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const resumedRes = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gemini-3.8-flash-medium",
      stream: false,
      tools: [replayTool],
      messages: [
        user,
        { role: "assistant", content: null, tool_calls: [toolCall] },
        { role: "tool", tool_call_id: toolCall.id, content: "Command output: 2026-11-07" },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const resumed = await resumedRes.json();
  check("resume: HTTP 200", resumedRes.status === 200, String(resumedRes.status));
  check("resume: finished with stop", resumed.choices?.[0]?.finish_reason === "stop", resumed.choices?.[0]?.finish_reason);
  check("resume: final text arrived", String(resumed.choices?.[0]?.message?.content ?? "").includes("DONE"), JSON.stringify(resumed.choices?.[0]?.message?.content));
  check("resume: usage carried to the final reply", (resumed.usage?.prompt_tokens ?? 0) > 0, JSON.stringify(resumed.usage));

  // ---- Code Mode wrapper: OpenCode exposes `execute`, not `agy_tool` ------
  const executeTool = {
    type: "function",
    function: {
      name: "execute",
      description: "Run a program that can call tools",
      parameters: {
        type: "object",
        properties: { code: { type: "string" }, description: { type: "string" } },
        required: ["code"],
      },
    },
  };
  const codeUser = {
    role: "user",
    content: `Use the terminal to run Get-Date, then reply DONE. (code ${Date.now()})`,
  };
  const codeRes = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini-3.8-flash-medium", stream: false, messages: [codeUser], tools: [executeTool] }),
    signal: AbortSignal.timeout(120_000),
  });
  const codeBody = await codeRes.json();
  const codeCall = codeBody.choices?.[0]?.message?.tool_calls?.[0];
  check("code mode: finish tool_calls", codeBody.choices?.[0]?.finish_reason === "tool_calls", codeBody.choices?.[0]?.finish_reason);
  check("code mode: uses the execute wrapper", codeCall?.function?.name === "execute", codeCall?.function?.name);
  let codeArgs = {};
  try {
    codeArgs = JSON.parse(String(codeCall?.function?.arguments ?? "{}"));
  } catch {
    codeArgs = {};
  }
  check("code mode: program calls agy_tool", String(codeArgs.code ?? "").includes("tools['agy_tool']"), String(codeArgs.code ?? "").slice(0, 100));
  check("code mode: card description present", typeof codeArgs.description === "string" && codeArgs.description.length > 0, codeArgs.description);

  await new Promise((resolve) => setTimeout(resolve, 3000));
  const codeResume = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gemini-3.8-flash-medium",
      stream: false,
      tools: [executeTool],
      messages: [
        codeUser,
        { role: "assistant", content: null, tool_calls: [codeCall] },
        { role: "tool", tool_call_id: codeCall?.id, content: "Command output: 2026-11-07" },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const codeResumed = await codeResume.json();
  check("code mode: resume stop", codeResumed.choices?.[0]?.finish_reason === "stop", codeResumed.choices?.[0]?.finish_reason);
  check("code mode: final text", String(codeResumed.choices?.[0]?.message?.content ?? "").includes("DONE"), JSON.stringify(codeResumed.choices?.[0]?.message?.content));

  // ---- streaming usage ----------------------------------------------------
  const streamRes = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gemini-3.8-flash-medium",
      stream: true,
      messages: [{ role: "user", content: "Reply with exactly STREAM_OK." }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawUsage = false;
  let sawText = "";
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
      if (typeof delta?.content === "string") sawText += delta.content;
    }
  }
  check("stream: text arrived", sawText.includes("STREAM_OK"), JSON.stringify(sawText));
  check("stream: usage chunk arrived", sawUsage);
  check("stream: terminated with [DONE]", sawDone);
} finally {
  await server.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(failed.length === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
