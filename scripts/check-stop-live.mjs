/** Two bounded real ACP cancellations; no file-writing tool is offered. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const outfile = join(mkdtempSync(join(tmpdir(), "agy-stop-live-")), "server.mjs");
await build({ entryPoints: ["src/provider/server.ts"], bundle: true, format: "esm", platform: "node", target: "node20", outfile, logLevel: "silent" });
const { startProvider } = await import(pathToFileURL(outfile).href);
let server;
const deadline = AbortSignal.timeout(90_000);
const watchdog = setTimeout(async () => { console.error("FAIL cancellation deadline"); await server?.close(); process.exit(1); }, 95_000);
try {
  for (const agentMode of ["native", "bridged"]) {
    server = await startProvider({ port: 0, settings: { agentMode, autoApproveNative: true } });
    const controller = new AbortController();
    const response = await fetch(server.url + "/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true, model: "gemini-3.8-flash-medium", messages: [{ role: "user", content: "Do not use tools. Write the integers 1 through 1000, one integer per line, without explanation." }] }),
      signal: AbortSignal.any([deadline, controller.signal]),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let sawContent = false;
    for (let i = 0; i < 300; i++) {
      const item = await reader.read();
      if (item.done) break;
      const text = new TextDecoder().decode(item.value);
      if (text.includes('"content":')) { sawContent = true; break; }
    }
    assert.ok(sawContent, "must cancel a real running prompt, not just connection setup");
    const started = Date.now();
    controller.abort();
    await reader.cancel().catch(() => {});
    while (server.pool.stats().sessions !== 0 && Date.now() - started < 5000) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(server.pool.stats().sessions, 0, "cancelled session must not be resumable as old output");
    console.log(`PASS live ${agentMode}: interrupted real stream; session released in ${Date.now() - started}ms`);
    await server.close();
    server = undefined;
  }
  console.log("RESULT: PASS (two real interrupted prompts; no retries)");
} finally { clearTimeout(watchdog); await server?.close(); }
