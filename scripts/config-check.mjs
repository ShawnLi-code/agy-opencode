/**
 * Exercises the config writer against copies — never the real config.
 *
 * The failure mode being guarded against: a managed block whose trailing comma
 * lives outside the markers. If the block ends up as the last member, that comma
 * becomes a trailing comma and the whole config stops parsing, which drops every
 * model.
 *
 * Run: node scripts/config-check.mjs
 */
import { build } from "esbuild";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "agy-config-check-"));
const bundle = join(dir, "config-write.mjs");

await build({
  entryPoints: ["src/provider/config-write.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: bundle,
  logLevel: "silent",
});

const { ensureProviderConfig, readProviderPort } = await import(pathToFileURL(bundle).href);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

/** Whole-line `//` comments only: our managed markers, never a URL inside a string. */
function parseJsonc(text) {
  return JSON.parse(text.replace(/^\uFEFF/, "").replace(/^\s*\/\/.*$/gm, ""));
}

// ---------------------------------------------------------------- scenario 1
// A copy of the live config, which currently has the comma OUTSIDE the markers.
const real = join(homedir(), ".config", "opencode", "opencode.jsonc");
if (existsSync(real)) {
  const copy = join(dir, "live-copy.jsonc");
  copyFileSync(real, copy);

  const before = parseJsonc(readFileSync(copy, "utf8"));
  const port = readProviderPort(copy);
  check("live copy: port readable", typeof port === "number", String(port));

  const r1 = ensureProviderConfig(port, copy);
  const text1 = readFileSync(copy, "utf8");
  let parsed1 = null;
  try {
    parsed1 = parseJsonc(text1);
  } catch (e) {
    check("live copy: valid after rewrite", false, String(e.message).slice(0, 80));
  }
  if (parsed1) {
    check("live copy: valid after rewrite", true, r1.action);
    check("live copy: magpie preserved", !!parsed1.provider?.magpie);
    check("live copy: agy-cli present", !!parsed1.provider?.["agy-cli"]);
    check("live copy: model count kept", Object.keys(parsed1.provider?.["agy-cli"]?.models ?? {}).length === 13);
    check("live copy: other keys preserved", Object.keys(before).every((k) => k in parsed1));
  }

  const r2 = ensureProviderConfig(port, copy);
  check("live copy: idempotent", r2.changed === false, r2.action);
  check("live copy: byte-identical on rerun", readFileSync(copy, "utf8") === text1);
}

// ---------------------------------------------------------------- scenario 2
// Empty provider object: the block must be inserted without a trailing comma.
{
  const p = join(dir, "empty.jsonc");
  writeFileSync(p, `{\n  "provider": {}\n}\n`, "utf8");
  const r = ensureProviderConfig(4199, p);
  const text = readFileSync(p, "utf8");
  let ok = true;
  try {
    const j = parseJsonc(text);
    ok = j.provider["agy-cli"].options.baseURL.includes("4199");
  } catch (e) {
    ok = false;
  }
  check("empty provider: inserted and valid", ok, r.action);
  check("empty provider: idempotent", ensureProviderConfig(4199, p).changed === false);
}

// ---------------------------------------------------------------- scenario 3
// Block must end up LAST (neighbour removed): the comma has to disappear.
{
  const p = join(dir, "last.jsonc");
  writeFileSync(
    p,
    `{\n  "provider": {\n    "magpie": { "name": "Magpie" }\n  }\n}\n`,
    "utf8",
  );
  ensureProviderConfig(4199, p);
  // Drop magpie so the managed block becomes the final member.
  let text = readFileSync(p, "utf8").replace(/\n\s*"magpie"\s*:\s*\{[^}]*\},?/, "");
  writeFileSync(p, text, "utf8");

  const r = ensureProviderConfig(4199, p);
  const after = readFileSync(p, "utf8");
  let ok = true;
  let keys = [];
  try {
    const j = parseJsonc(after);
    keys = Object.keys(j.provider ?? {});
  } catch (e) {
    ok = false;
    console.log("   parse error:", e.message);
  }
  check("last member: still valid JSON", ok, r.action);
  check("last member: agy-cli is the only provider", keys.length === 1 && keys[0] === "agy-cli", JSON.stringify(keys));
  // A comma is required for this to be a trailing comma; the old optional
  // comma matched every normal nested object close.
  check("last member: no trailing comma before }", !/\},\s*\n\s*\}/.test(after));
}

// ---------------------------------------------------------------- scenario 4
// Port change rewrites only the port and keeps a single managed block.
{
  const p = join(dir, "port.jsonc");
  writeFileSync(p, `{\n  "provider": {}\n}\n`, "utf8");
  ensureProviderConfig(4199, p);
  const r = ensureProviderConfig(5099, p);
  const text = readFileSync(p, "utf8");
  const blocks = (text.match(/agy-opencode provider \(managed\) >>>/g) ?? []).length;
  let ok = true;
  try {
    const j = parseJsonc(text);
    ok = j.provider["agy-cli"].options.baseURL.includes("5099");
  } catch {
    ok = false;
  }
  check("port change: rewritten", r.changed === true);
  check("port change: new port applied", ok);
  check("port change: single block", blocks === 1, `${blocks} blocks`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(failed.length === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
