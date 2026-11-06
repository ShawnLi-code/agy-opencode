/** Prints the exact bytes the writer produces in the failing scenarios. */
import { build } from "esbuild";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "agy-dbg-"));
const bundle = join(dir, "cw.mjs");
await build({
  entryPoints: ["src/provider/config-write.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: bundle,
  logLevel: "silent",
});
const { ensureProviderConfig } = await import(pathToFileURL(bundle).href);

// scenario: last member
const p = join(dir, "last.jsonc");
writeFileSync(p, `{\n  "provider": {\n    "magpie": { "name": "Magpie" }\n  }\n}\n`, "utf8");
console.log("--- after insert ---");
ensureProviderConfig(4199, p);
console.log(readFileSync(p, "utf8"));

let text = readFileSync(p, "utf8").replace(/\n\s*"magpie"\s*:\s*\{[^}]*\},?/, "");
writeFileSync(p, text, "utf8");
console.log("--- after removing magpie ---");
console.log(text);

const r = ensureProviderConfig(4199, p);
console.log("--- after ensure (action " + r.action + ") ---");
console.log(readFileSync(p, "utf8"));

// scenario: port change
const q = join(dir, "port.jsonc");
writeFileSync(q, `{\n  "provider": {}\n}\n`, "utf8");
ensureProviderConfig(4199, q);
console.log("--- port insert ---");
console.log(readFileSync(q, "utf8"));
ensureProviderConfig(5099, q);
console.log("--- port replace ---");
console.log(readFileSync(q, "utf8"));
process.exit(0);
