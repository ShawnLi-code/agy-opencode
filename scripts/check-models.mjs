/**
 * Regression guard for the model picker's default visibility.
 *
 * OpenCode keeps only the newest model per `family` visible by default. When
 * every effort shared `family: "Antigravity"`, Low/High were hidden and only
 * Medium remained. Each picker entry must be its own family.
 *
 * Run: bun scripts/check-models.mjs
 */
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outfile = join(mkdtempSync(join(tmpdir(), "agy-models-check-")), "register.mjs");
await build({
  entryPoints: ["src/provider/register.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile,
  logLevel: "silent",
});
const { modelInfos } = await import(pathToFileURL(outfile).href);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const rows = modelInfos("http://127.0.0.1:4199", [
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", efforts: [] },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", efforts: [] },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", efforts: [] },
]);

const ids = rows.map((row) => row.id);
const families = rows.map((row) => row.family);

check("models: six picker entries", rows.length === 6, JSON.stringify(ids));
check("models: every family is unique", new Set(families).size === families.length, JSON.stringify(families));
check("models: family equals the model id", rows.every((row) => row.family === row.id));
check("models: all flash efforts present", ["low", "medium", "high"].every((level) => ids.includes(`gemini-3.8-flash-${level}`)), JSON.stringify(ids));
check("models: every entry is enabled", rows.every((row) => row.enabled === true && row.status === "active"));

// Simulate OpenCode's default visibility: newest per provider+family must
// still be every row, otherwise a sibling would be hidden.
const groups = new Map();
for (const row of rows) {
  const key = `${row.providerID}:${row.family}`;
  const list = groups.get(key) ?? [];
  list.push(row);
  groups.set(key, list);
}
const visible = [...groups.values()].map((group) => group.reduce((a, b) => (b.time.released > a.time.released ? b : a)).id);
check("visibility: no entry is collapsed into a sibling", visible.length === rows.length, JSON.stringify(visible));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(failed.length === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
