/**
 * Live check of the bridged ("OpenCode 工具") mode.
 *
 * The old failure was a bare string passed as a tool's arguments, plus a stale
 * JSON-envelope preamble telling the model to print tool calls while real MCP
 * tools were attached. This drives one real tool call over MCP and resumes it.
 *
 * Run: bun scripts/check-provider-bridged.mjs
 */
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.AGY_AGENT_MODE = "bridged";

const outfile = join(mkdtempSync(join(tmpdir(), "agy-bridged-check-")), "server.mjs");
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

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const server = await startProvider({ transport: "acp", port: 0 });
const tool = {
  type: "function",
  function: {
    name: "websearch",
    description: "Search the web. Arguments must be an object with a query string.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
  },
};
const user = {
  role: "user",
  content:
    'Use the websearch tool to search for: "dsh-go" OR "dsh go". Then reply with exactly DONE. Do not use any other tool.',
};

try {
  const firstRes = await fetch(server.url + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gemini-3.8-flash-medium",
      stream: false,
      messages: [user],
      tools: [tool],
    }),
    signal: AbortSignal.timeout(240_000),
  });
  const first = await firstRes.json();
  const call = first.choices?.[0]?.message?.tool_calls?.[0];
  check("bridged: HTTP 200", firstRes.status === 200, String(firstRes.status));
  check("bridged: parked as tool_calls", first.choices?.[0]?.finish_reason === "tool_calls", String(first.choices?.[0]?.finish_reason));
  check("bridged: tool name", call?.function?.name === "websearch", JSON.stringify(call?.function?.name));

  let args = {};
  try {
    args = JSON.parse(call?.function?.arguments ?? "{}");
  } catch {
    args = {};
  }
  check(
    "bridged: arguments are an object with the query",
    typeof args?.query === "string" && /dsh-go/i.test(args.query),
    JSON.stringify(args),
  );

  if (!call) {
    check("bridged: resume skipped (no call)", false);
  } else {
    const resumedRes = await fetch(server.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash-medium",
        stream: false,
        tools: [tool],
        messages: [
          user,
          { role: "assistant", content: null, tool_calls: [call] },
          { role: "tool", tool_call_id: call.id, content: '搜索结果：没有找到 "dsh-go" 的相关项目。' },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const resumed = await resumedRes.json();
    check("bridged resume: HTTP 200", resumedRes.status === 200, String(resumedRes.status));
    check("bridged resume: finished", resumed.choices?.[0]?.finish_reason === "stop", String(resumed.choices?.[0]?.finish_reason));
    check(
      "bridged resume: final text",
      /done/i.test(String(resumed.choices?.[0]?.message?.content ?? "")),
      JSON.stringify(resumed.choices?.[0]?.message?.content?.slice(0, 80)),
    );
  }
} catch (err) {
  check("bridged: run completed", false, String(err).slice(0, 300));
} finally {
  await server.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(failed.length === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
