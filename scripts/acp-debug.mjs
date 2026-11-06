/**
 * Calls the ACP pool directly with the same instruction/input shape the server
 * uses, and prints the raw reply. Isolates agy behaviour from server logic.
 *
 * Run: node scripts/acp-debug.mjs
 */
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "agy-acp-debug-"));
const outfile = join(dir, "bundle.mjs");

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

const protocolOut = join(dir, "protocol.mjs");
await build({
  entryPoints: ["src/provider/protocol.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: protocolOut,
  logLevel: "silent",
});
const { protocolPreamble } = await import(pathToFileURL(protocolOut).href);

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

const pool = new AcpPool();
const nonce = Date.now().toString(36);
const chunks = [];
try {
  const reply = await pool.turn({
    conversationKey: "debug-" + nonce,
    account: { id: "system", alias: "sys", home: "", enabled: true, createdAt: 0 },
    inputs: [`Read the file C:\\Windows\\win.ini with the read tool. (debug ${nonce})`],
    instruction: protocolPreamble(tools),
    onChunk: (c) => chunks.push(c),
  });
  console.log("chunks:", chunks.length);
  console.log("chunk dump:", JSON.stringify(chunks.slice(0, 6)));
  console.log("raw reply:", JSON.stringify(reply));
} finally {
  pool.dispose();
}
process.exit(0);
