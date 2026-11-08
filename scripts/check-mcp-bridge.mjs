/**
 * MCP bridge argument handling.
 *
 * agy sometimes sends a bare string for a single-parameter tool instead of an
 * object. Passing it through as `{}` made opencode's tool fail with a missing
 * required argument ("工具执行失败" in the UI). This covers the exact shape
 * from the reported websearch call.
 *
 * Run: bun scripts/check-mcp-bridge.mjs
 */
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outfile = join(mkdtempSync(join(tmpdir(), "agy-mcp-check-")), "mcp.mjs");
await build({
  entryPoints: ["src/provider/mcp-bridge.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile,
  logLevel: "silent",
});
const { McpBridge, coerceToolArguments } = await import(pathToFileURL(outfile).href);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const schema = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
};

// ---- pure coercion -------------------------------------------------------
check("args: object passes through", coerceToolArguments({ query: "x" }, schema).query === "x");
check("args: JSON object string is parsed", coerceToolArguments('{"query":"json"}', schema).query === "json");
check(
  "args: bare string wraps into the single string property",
  coerceToolArguments('"dsh-go" OR "dsh go"', schema).query === '"dsh-go" OR "dsh go"',
  JSON.stringify(coerceToolArguments('"dsh-go" OR "dsh go"', schema)),
);
check("args: unknown shape stays empty", JSON.stringify(coerceToolArguments(42, schema)) === "{}");
check(
  "args: multi-property bare string is not guessed",
  JSON.stringify(
    coerceToolArguments("hello", {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
    }),
  ) === "{}",
);

// ---- real HTTP path ------------------------------------------------------
const seen = [];
let releasePending;
const pendingResult = new Promise((resolve) => { releasePending = resolve; });
const bridge = new McpBridge({
  listTools: () => [{ name: "websearch", description: "Search", inputSchema: schema }],
  callTool: async (request) => {
    seen.push(request.arguments);
    if (request.arguments.query === "pending") await pendingResult;
    return { content: [{ type: "text", text: `searched: ${request.arguments.query}` }] };
  },
}, { keepAliveMs: 60_000 });
await bridge.start(0);
const tenant = bridge.createTenant();

async function callTool(argumentsValue) {
  const res = await fetch(tenant.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: tenant.header.value },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "websearch", arguments: argumentsValue },
    }),
  });
  return { status: res.status, text: await res.text() };
}

try {
  const bare = await callTool('"dsh-go" OR "dsh go"');
  check("http: bare string call succeeds", bare.status === 200 && bare.text.includes('"result"'), bare.text.slice(0, 120));
  check("http: bare string reached the router as query", seen[0]?.query === '"dsh-go" OR "dsh go"', JSON.stringify(seen[0]));
  check("http: tool output returned", bare.text.includes("searched:"), bare.text.slice(0, 160));

  const objectString = await callTool('{"query":"json string"}');
  check("http: JSON string is parsed", seen[1]?.query === "json string", JSON.stringify(seen[1]));
  check("http: second call succeeds", objectString.status === 200 && objectString.text.includes("searched:"), objectString.text.slice(0, 120));

  const notification = await fetch(tenant.url, {
    method: "POST", headers: { "content-type": "application/json", authorization: tenant.header.value },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/roots/list_changed" }),
  });
  check("http: unknown notifications receive 202 and no JSON-RPC reply", notification.status === 202 && (await notification.text()) === "");

  let pendingResponse;
  try {
    pendingResponse = await fetch(tenant.url, {
      method: "POST", headers: { "content-type": "application/json", authorization: tenant.header.value },
      body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "websearch", arguments: { query: "pending" } } }),
      signal: AbortSignal.timeout(1500),
    });
    check("http: pending tool sends SSE headers immediately", pendingResponse.status === 200 && pendingResponse.headers.get("content-type")?.includes("text/event-stream"));
  } catch (err) {
    check("http: pending tool sends SSE headers immediately", false, String(err));
  } finally {
    releasePending();
  }
  if (pendingResponse) check("http: pending tool result follows headers", (await pendingResponse.text()).includes("searched: pending"));
} finally {
  await bridge.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(failed.length === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
