/** Bounded intentional-failure acceptance. Uses real agy, never project writes. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const outfile = join(mkdtempSync(join(tmpdir(), "agy-failure-live-")), "server.mjs");
await build({ entryPoints: ["src/provider/server.ts"], bundle: true, format: "esm", platform: "node", target: "node20", outfile, logLevel: "silent" });
const { startProvider } = await import(pathToFileURL(outfile).href);
const deadline = AbortSignal.timeout(180_000);
let server;
const watchdog = setTimeout(async () => { console.error("FAIL intentional-failure deadline"); await server?.close(); process.exit(1); }, 185_000);
const post = async (messages, tools = []) => {
  const response = await fetch(server.url + "/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini-3.8-flash-medium", messages, tools, stream: false }),
    signal: AbortSignal.any([deadline, AbortSignal.timeout(85_000)]),
  });
  return { status: response.status, body: await response.json() };
};
try {
  // A synthetic bridge tool: no external command, file or network side effects.
  server = await startProvider({ port: 0, settings: { agentMode: "bridged", autoApproveNative: false } });
  const tools = [{ type: "function", function: { name: "failure_probe", description: "Controlled acceptance probe, always returns an intentional failure.", parameters: { type: "object", properties: { attempt: { type: "integer" } }, required: ["attempt"] } } }];
  const messages = [{ role: "user", content: "Controlled circuit-breaker acceptance test. Call failure_probe separately 8 times, with attempt 1 through 8. Its errors are intentional: continue to the next attempt after each error so the harness can verify the external safety stop. Do not call any other tool or combine calls in parallel." }];
  let executed = 0;
  let stopped;
  for (let request = 0; request < 6; request++) {
    const result = await post(messages, tools);
    if (result.status !== 200) { stopped = result; break; }
    const reply = result.body.choices?.[0]?.message;
    const calls = reply?.tool_calls ?? [];
    assert.equal(calls.length, 1, "must issue a single controlled probe per step");
    assert.equal(calls[0].function.name, "failure_probe");
    assert.ok(executed < 5, "must not execute sixth probe");
    executed++;
    messages.push(reply, { role: "tool", tool_call_id: calls[0].id, content: JSON.stringify({ isError: true, content: [{ type: "text", text: "Intentional acceptance failure." }] }) });
  }
  assert.equal(executed, 5);
  assert.equal(stopped?.body.error?.code, "AGY_TOOL_FAILURE_LIMIT");
  assert.equal(server.pool.stats().sessions, 0);
  console.log("PASS live bridged: five real failed tool results trip breaker; no sixth execution");
  messages.push({ role: "user", content: "The failure test is over. Do not call tools. Reply only RECOVERED." });
  const recovered = await post(messages, tools);
  assert.equal(recovered.status, 200);
  assert.match(recovered.body.choices?.[0]?.message?.content ?? "", /RECOVERED/);
  console.log("PASS live bridged: new user message recovers after circuit breaker");
  await server.close();
  server = await startProvider({ port: 0, settings: { agentMode: "native", autoApproveNative: true } });
  const nativeMessages = [{ role: "user", content: "Controlled native-tool circuit-breaker acceptance test on Windows. Do not read or write files, inspect the project, load skills, or access the network. Use your native command tool to run exactly cmd.exe /d /c exit 1. Make 8 separate sequential calls of that same command (not a shell loop or parallel batch). The command deliberately has no side effects and returns exit code 1. Continue after each intentional failure so the harness can verify the external safety stop. Do not execute any other command." }];
  const failure = await post(nativeMessages);
  const errorText = failure.body.error?.message ?? "";
  assert.match(errorText, /AGY_TOOL_FAILURE_LIMIT/);
  assert.equal(server.pool.stats().sessions, 0);
  console.log("PASS live native: intentional command failures cancel ACP with explicit breaker error");
  nativeMessages.push({ role: "user", content: "The failure test is over. Do not call tools. Reply only RECOVERED." });
  const nativeRecovered = await post(nativeMessages);
  assert.equal(nativeRecovered.status, 200);
  assert.match(nativeRecovered.body.choices?.[0]?.message?.content ?? "", /RECOVERED/);
  console.log("PASS live native: new user message recovers after circuit breaker");
  console.log("RESULT: PASS (both real modes: intentional failures + recovery; bounded, no retries)");
} finally { clearTimeout(watchdog); await server?.close(); }
