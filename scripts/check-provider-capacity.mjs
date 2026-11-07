/**
 * Capacity 503 behavior, with an injected turn runner (no real agy needed).
 *
 * The upstream sometimes answers "UNAVAILABLE (code 503): No capacity
 * available". That is load, not context length, so the provider waits and
 * retries the SAME model. It never silently downgrades the user's choice.
 *
 * Run: bun scripts/check-provider-capacity.mjs
 */
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outfile = join(mkdtempSync(join(tmpdir(), "agy-capacity-")), "server.mjs");
await build({
  entryPoints: ["src/provider/server.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile,
  logLevel: "silent",
});
const { startProvider, isCapacityError, capacityMessage } = await import(pathToFileURL(outfile).href);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const capacity = "UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server";

// ---- pure classification -------------------------------------------------
check("capacity: UNAVAILABLE matches", isCapacityError(new Error(capacity)));
check("capacity: plain 503 matches", isCapacityError("upstream returned 503"));
check("capacity: auth does not match", !isCapacityError("AUTH_REQUIRED: please sign in"));
check("capacity: quota does not match", !isCapacityError("QUOTA_EXHAUSTED"));
check("capacity: message says it is not context length", capacityMessage(50_000).includes("不是对话太长"), capacityMessage(50_000));

const request = (base, model) =>
  fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

// ---- retry succeeds ------------------------------------------------------
{
  const seen = [];
  let attempts = 0;
  const server = await startProvider({
    transport: "acp",
    port: 0,
    capacityDelaysMs: [10, 20],
    turn: async (options) => {
      seen.push(options.model);
      attempts += 1;
      if (attempts < 3) throw new Error(capacity);
      return { text: "recovered", parked: false, usage: { inputTokens: 10, outputTokens: 2 } };
    },
  });
  try {
    const res = await request(server.url, "gemini-3.8-flash-high");
    const body = await res.json();
    check("retry: HTTP 200 after two waits", res.status === 200, String(res.status));
    check("retry: final text", body.choices?.[0]?.message?.content === "recovered", JSON.stringify(body.choices?.[0]?.message?.content));
    check("retry: same model, no downgrade", seen.every((m) => m === "gemini-3.8-flash-high"), JSON.stringify(seen));
    check("retry: three calls total", seen.length === 3, String(seen.length));
    check("retry: usage kept", (body.usage?.prompt_tokens ?? 0) === 10, JSON.stringify(body.usage));
  } finally {
    await server.close();
  }
}

// ---- all retries exhausted ----------------------------------------------
{
  const seen = [];
  const server = await startProvider({
    transport: "acp",
    port: 0,
    capacityDelaysMs: [10, 20],
    turn: async (options) => {
      seen.push(options.model);
      throw new Error(capacity);
    },
  });
  try {
    const res = await request(server.url, "gemini-3.8-flash-high");
    const body = await res.json();
    const message = String(body.error?.message ?? "");
    check("exhausted: HTTP 503", res.status === 503, String(res.status));
    check("exhausted: friendly message", message.includes("上游暂时没有可用容量") && message.includes("不是对话太长"), message);
    check("exhausted: no raw upstream text", !message.includes("No capacity available") && !message.includes("UNAVAILABLE"), message);
    check("exhausted: same model every time", seen.every((m) => m === "gemini-3.8-flash-high"), JSON.stringify(seen));
    check("exhausted: one initial + two waits", seen.length === 3, String(seen.length));
  } finally {
    await server.close();
  }
}

// ---- once text has streamed, do not replay -------------------------------
{
  let calls = 0;
  const server = await startProvider({
    transport: "acp",
    port: 0,
    capacityDelaysMs: [10, 20],
    turn: async () => {
      calls += 1;
      return { text: "partial answer", parked: false, error: capacity };
    },
  });
  try {
    const res = await request(server.url, "gemini-3.8-flash-high");
    const body = await res.json();
    check("partial: HTTP 503", res.status === 503, String(res.status));
    check("partial: no duplicate retry", calls === 1, String(calls));
    check("partial: friendly capacity message", String(body.error?.message ?? "").includes("上游暂时没有可用容量"), JSON.stringify(body.error?.message));
  } finally {
    await server.close();
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(failed.length === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
