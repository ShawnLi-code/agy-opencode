/**
 * Pelican test against a freshly started provider (not the live bridge), so the
 * change is validated before anything touches the running session.
 *
 * Checks: plain chat is not JSON-wrapped (no escaped quotes), and tool turns
 * still produce a tool call.
 *
 * Run: node scripts/pelican-check.mjs
 */
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "agy-pelican-"));
const out = join(dir, "server.mjs");
await build({
  entryPoints: ["src/provider/server.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: out,
  logLevel: "silent",
});
const { startProvider } = await import(pathToFileURL(out).href);

const provider = await startProvider({ transport: "acp", port: 4321 });
const BASE = provider.url;
console.log("server:", BASE);

const results = [];
const check = (n, p, d) => {
  results.push(p);
  console.log(`${p ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
};

const nonce = Date.now().toString(36);
const pelican = [
  "Draw a pelican with inline SVG.",
  "Requirements: viewBox 0 0 400 400, a distinct body, a long beak with the characteristic pouch, one eye, two legs.",
  "Reply with the SVG markup only. No explanation, no markdown fence.",
  `(request ${nonce})`,
].join(" ");

try {
  // ---- plain chat turn (no tools)
  let t0 = Date.now();
  const res = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5-5-lo", messages: [{ role: "user", content: pelican }] }),
  });
  const body = await res.json();
  const content = String(body.choices?.[0]?.message?.content ?? "");
  const elapsed = Date.now() - t0;

  const escaped = (content.match(/\\"/g) ?? []).length;
  const hasSvg = /<svg[\s\S]*<\/svg>/i.test(content);
  const hasViewBox = /viewBox=/.test(content);

  check("pelican: reply has SVG", hasSvg, `${content.length} chars in ${elapsed}ms`);
  check("pelican: no escaped quotes", escaped === 0, `${escaped} occurrences`);
  check("pelican: has viewBox", hasViewBox);

  if (hasSvg) {
    const svg = content.match(/<svg[\s\S]*<\/svg>/i)[0];
    const file = join("artifacts", "pelican.svg");
    const { mkdirSync } = await import("node:fs");
    mkdirSync("artifacts", { recursive: true });
    writeFileSync(file, svg, "utf8");
    console.log(`   saved: ${file}`);
  }

  // ---- tool turn still uses the envelope
  const toolRes = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5-5-lo",
      messages: [{ role: "user", content: `Read C:\\Windows\\win.ini with the read tool. (t ${nonce})` }],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a text file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        },
      ],
    }),
  });
  const toolBody = await toolRes.json();
  const call = toolBody.choices?.[0]?.message?.tool_calls?.[0];
  check("tool turn: still emits a tool call", call?.function?.name === "read", call?.function?.arguments);
} finally {
  await provider.close();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
console.log(failed === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(failed === 0 ? 0 : 1);
