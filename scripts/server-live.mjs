/**
 * Runs the provider server standalone (transport: acp) against the real agy
 * binary and exercises it over HTTP. This validates the shipped code without
 * relying on opencode's plugin hot reload.
 *
 * Run: node scripts/server-live.mjs
 */
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "agy-srv-live-"));
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

const provider = await startProvider({ transport: "acp", port: 4321 });
const BASE = provider.url;
console.log("server:", BASE, JSON.stringify(await (await fetch(BASE + "/healthz")).json()));

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const nonce = Date.now().toString(36);

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

try {
  // ---- tool call
  let t0 = Date.now();
  const toolRes = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5-5-lo",
      messages: [{ role: "user", content: `Read the file C:\\Windows\\win.ini with the read tool. (live ${nonce})` }],
      tools,
    }),
  });
  const toolJson = await toolRes.json();
  const call = toolJson.choices?.[0]?.message?.tool_calls?.[0];
  check("tool call returned", call?.function?.name === "read", `${Date.now() - t0}ms ${call?.function?.arguments}`);
  check("finish_reason tool_calls", toolJson.choices?.[0]?.finish_reason === "tool_calls");

  // ---- streaming text
  t0 = Date.now();
  const streamRes = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5-5-lo",
      stream: true,
      messages: [{ role: "user", content: `Count from 1 to 20 separated by spaces, nothing else. (live ${nonce}b)` }],
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
  check("stream produced text", text.length > 0, `${JSON.stringify(text.slice(0, 40))}`);
  check("stream contains 20", /\b20\b/.test(text));
  check("stream arrived in chunks", chunks > 1, `${chunks} chunks`);
  console.log(`   first=${firstChunkAt}ms total=${total}ms`);

  // ---- session continuity: same conversation, second turn reuses it
  const key = `Count again from 21 to 25 separated by spaces, nothing else. (live ${nonce}b)`;
  const followRes = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5-5-lo",
      messages: [
        { role: "user", content: `Count from 1 to 20 separated by spaces, nothing else. (live ${nonce}b)` },
        { role: "assistant", content: text },
        { role: "user", content: key },
      ],
    }),
  });
  const follow = await followRes.json();
  check("follow-up answered", !!follow.choices?.[0]?.message?.content, JSON.stringify(String(follow.choices?.[0]?.message?.content ?? "").slice(0, 40)));
} finally {
  await provider.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(failed.length === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
