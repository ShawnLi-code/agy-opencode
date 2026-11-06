/**
 * Pelican test over the live bridge: a fresh conversation, streaming on.
 * Saves whatever SVG comes back and reports whether it is usable.
 *
 * Run: node scripts/pelican.mjs [model]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE = process.env.AGY_BRIDGE ?? "http://127.0.0.1:1778";
const model = process.argv[2] ?? "claude-sonnet-5-5-lo";
const nonce = Date.now().toString(36);

const prompt = [
  "Draw a pelican with inline SVG.",
  "Requirements: viewBox 0 0 400 400, a distinct body, a long beak with the characteristic pouch, one eye, two legs.",
  "Reply with the SVG markup only. No explanation, no markdown fence.",
  `(request ${nonce})`,
].join(" ");

const t0 = Date.now();
const res = await fetch(BASE + "/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model,
    stream: true,
    messages: [{ role: "user", content: prompt }],
  }),
});

if (!res.ok) {
  console.log("HTTP", res.status, await res.text());
  process.exit(1);
}

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let text = "";
let chunks = 0;
let firstAt = 0;

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
      if (!firstAt) firstAt = Date.now() - t0;
      chunks++;
      text += d;
    }
  }
}

const total = Date.now() - t0;
const svgMatch = text.match(/<svg[\s\S]*<\/svg>/i);
const out = join(tmpdir(), `pelican-${nonce}.svg`);
if (svgMatch) writeFileSync(out, svgMatch[0], "utf8");

console.log(`model:   ${model}`);
console.log(`time:    first=${firstAt}ms total=${total}ms chunks=${chunks}`);
console.log(`chars:   ${text.length}`);
console.log(`has svg: ${!!svgMatch}`);
if (svgMatch) {
  const svg = svgMatch[0];
  console.log(`saved:   ${out}`);
  console.log(`viewBox: ${(svg.match(/viewBox="([^"]+)"/) ?? [])[1] ?? "none"}`);
  console.log(`shapes:  path=${(svg.match(/<path/g) ?? []).length} circle=${(svg.match(/<circle/g) ?? []).length} ellipse=${(svg.match(/<ellipse/g) ?? []).length} polygon=${(svg.match(/<polygon/g) ?? []).length}`);
} else {
  console.log("--- head of reply ---");
  console.log(text.slice(0, 400));
}
process.exit(svgMatch ? 0 : 1);
