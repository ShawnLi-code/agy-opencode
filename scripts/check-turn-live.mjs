/** Bounded live smoke: 2 native turns + 1 bridged multi-tool turn. Uses quota. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const outfile = join(mkdtempSync(join(tmpdir(), "agy-turn-live-")), "server.mjs");
await build({ entryPoints: ["src/provider/server.ts"], bundle: true, format: "esm", platform: "node", target: "node20", outfile, logLevel: "silent" });
const { startProvider } = await import(pathToFileURL(outfile).href);
let server;
const deadline = AbortSignal.timeout(120_000);
const watchdog = setTimeout(async () => {
  console.error("FAIL live deadline: shutting down test workers");
  await server?.close();
  process.exit(1);
}, 125_000);
const post = async (messages, tools = [], model = "gemini-3.8-flash-medium") => {
  const response = await fetch(server.url + "/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, tools, stream: false }),
    signal: AbortSignal.any([deadline, AbortSignal.timeout(45_000)]),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body).slice(0, 400));
  console.log("USAGE", JSON.stringify(body.usage ?? null));
  return body.choices[0];
};
try {
  server = await startProvider({ port: 0, settings: { agentMode: "native", autoApproveNative: true } });
  const messages = [{ role: "user", content: "Remember codeword OTTER49. Do not use tools. Reply exactly OK." }];
  const first = await post(messages);
  assert.match(first.message.content, /OK/);
  messages.push({ role: "assistant", content: first.message.content }, { role: "user", content: "What was the codeword? Do not use tools. Reply only with that codeword." });
  const next = await post(messages, [], "gemini-3.8-flash-high");
  assert.match(next.message.content, /OTTER49/);
  console.log("PASS live native: follow-up remembers context after model effort switch");
  await server.close();
  server = await startProvider({ port: 0, settings: { agentMode: "bridged", autoApproveNative: false } });
  const tools = [{ type: "function", function: { name: "probe", description: "Returns a secret token. Must be called in two stages.", parameters: { type: "object", properties: { stage: { type: "integer" }, previous: { type: "string" } }, required: ["stage"] } } }];
  const history = [{ role: "user", content: "Call probe with stage=1. Read its returned token. Then call probe with stage=2 and previous=<that exact token>. After reading the second result, reply only with its token. Do not invent results or use any other tools." }];
  for (const [stage, token] of [[1, "FIRST_83Q"], [2, "FINAL_61Z"]]) {
    const response = await post(history, tools);
    const calls = response.message.tool_calls ?? [];
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.function.name, "probe");
    const args = JSON.parse(call.function.arguments);
    assert.equal(args.stage, stage);
    if (stage === 2) assert.equal(args.previous, "FIRST_83Q");
    history.push(response.message, { role: "tool", tool_call_id: call.id, content: JSON.stringify({ token }) });
  }
  const final = await post(history, tools);
  assert.equal(final.finish_reason, "stop");
  assert.match(final.message.content, /FINAL_61Z/);
  console.log("PASS live bridged: two dependent tools receive distinct results");
  console.log("RESULT: PASS (3 logical model turns; 5 HTTP requests maximum)");
} finally {
  clearTimeout(watchdog);
  await server?.close();
}
