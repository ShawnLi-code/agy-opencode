/**
 * Drives the ACP transport against a real `agy acp`.
 *
 * Checks the two things `--print` cannot do: reuse one session across turns
 * (only the new input is sent) and stream text while it is generated.
 *
 * Run: node scripts/acp-check.mjs
 */
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "agy-acp-check-"));
const outfile = join(dir, "acp.mjs");

await build({
  entryPoints: ["src/provider/acp.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile,
  logLevel: "silent",
});

const { AcpPool } = await import(pathToFileURL(outfile).href);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const account = { id: "system", alias: "sys", home: "", enabled: true, createdAt: 0 };
const pool = new AcpPool();
const key = "test-conversation-" + Date.now();

let t0 = Date.now();
try {
  // ---- turn 1
  const chunks1 = [];
  let firstChunkAt = 0;
  const reply1 = (await pool.turn({
    conversationKey: key,
    account,
    inputs: ["Count from 1 to 40, separated by spaces, nothing else."],
    onChunk: (c) => {
      if (!firstChunkAt) firstChunkAt = Date.now() - t0;
      chunks1.push(c);
    },
  })).text;
  const elapsed1 = Date.now() - t0;

  check("turn 1 produced text", reply1.length > 0, JSON.stringify(reply1.slice(0, 60)));
  check("turn 1 contains 40", /\b40\b/.test(reply1));
  check("turn 1 streamed in more than one chunk", chunks1.length > 1, `${chunks1.length} chunks`);
  check("chunks concatenate to the reply", chunks1.join("") === reply1);
  check("streaming started before completion", firstChunkAt > 0 && firstChunkAt < elapsed1, `${firstChunkAt}ms vs ${elapsed1}ms`);

  const after1 = pool.stats();
  check("one session after turn 1", after1.sessions === 1, JSON.stringify(after1));

  // ---- turn 2: same conversation, only the new input is sent
  t0 = Date.now();
  const chunks2 = [];
  const reply2 = (await pool.turn({
    conversationKey: key,
    account,
    inputs: ["Count from 1 to 40, separated by spaces, nothing else.", "Now reply with exactly: BANANA"],
    onChunk: (c) => chunks2.push(c),
  })).text;

  check("turn 2 produced text", reply2.length > 0, JSON.stringify(reply2.slice(0, 60)));
  check("turn 2 contains BANANA", /BANANA/i.test(reply2));
  check("turn 2 reused the session", pool.stats().sessions === 1, JSON.stringify(pool.stats()));
  check("turn 2 streamed", chunks2.length > 0, `${chunks2.length} chunks`);

  // ---- tool envelope still honoured over ACP
  const chunks3 = [];
  const protocol = [
    "You are being used as the model behind an API. Reply with exactly one JSON object, nothing else.",
    'To call a tool: {"tool_calls":[{"name":"<tool>","arguments":{...}}]}',
    'To answer: {"content":"<answer>"}',
    "Do NOT use your own tools. Only these exist:",
    '[{"name":"read","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}]',
    "USER:",
    "Read C:\\Windows\\win.ini with the read tool.",
  ].join("\n");
  const reply3 = (await pool.turn({
    conversationKey: key + "-tools",
    account,
    inputs: [protocol],
    onChunk: (c) => chunks3.push(c),
  })).text;
  const json = (reply3.match(/\{[\s\S]*\}/) ?? [""])[0];
  let parsed = null;
  try {
    parsed = JSON.parse(json);
  } catch {
    /* reported below */
  }
  check(
    "tool envelope honoured over ACP",
    !!parsed && Array.isArray(parsed.tool_calls) && parsed.tool_calls[0]?.name === "read",
    JSON.stringify(reply3.slice(0, 120)),
  );
} finally {
  pool.dispose();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(failed.length === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
