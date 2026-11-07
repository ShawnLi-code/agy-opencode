/**
 * Live check of the ACP native-tool mirror.
 *
 * Proves three things against a real agy session:
 * 1. a completed agy tool step is returned as a real OpenAI tool call;
 * 2. the recorded output can be replayed without running the command again;
 * 3. the next request continues the same prompt and finishes with usage.
 *
 * Run: bun scripts/check-acp-native.mjs
 */
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "agy-native-check-"));
const outfile = join(dir, "acp.mjs");
const replayFile = join(dir, "replay.mjs");
await build({
  entryPoints: ["src/provider/acp.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile,
  logLevel: "silent",
});
await build({
  entryPoints: ["src/provider/replay.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: replayFile,
  logLevel: "silent",
});

const { AcpPool, normalizeUsage, toolOutputOf, idleBudgetMs } = await import(pathToFileURL(outfile).href);
// The replay store lives on globalThis, so this second bundle observes the
// exact entries the provider recorded.
const { readNativeReplay, replayToolResult } = await import(pathToFileURL(replayFile).href);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ---- pure mapping ---------------------------------------------------------
const usage = normalizeUsage({
  inputTokens: 120,
  outputTokens: 30,
  cachedReadTokens: 40,
  cachedWriteTokens: 5,
  thoughtTokens: 7,
  totalTokens: 155,
});
check("usage: input kept", usage.inputTokens === 120);
check("usage: cache kept", usage.cachedReadTokens === 40 && usage.cachedWriteTokens === 5);
check("usage: thought kept", usage.thoughtTokens === 7);
const output = toolOutputOf({
  sessionUpdate: "tool_call_update",
  status: "completed",
  rawOutput: { output: "hello", exit_code: 0 },
});
check("tool output: rawOutput flattened", output.output === "hello" && output.exitCode === 0);
check("watchdog: normal idle budget is 10 minutes", idleBudgetMs(0) === 10 * 60 * 1000, String(idleBudgetMs(0)));
check("watchdog: active tool budget is 4 hours", idleBudgetMs(1) === 4 * 60 * 60 * 1000, String(idleBudgetMs(1)));

// The fixed 85-second cutoff is gone: the wait ends on a tool, completion, or
// an expired ACTIVITY budget.
const probe = new AcpPool();
const baseState = { sessionId: "fake", seenInputs: 0, lastUsed: Date.now() };
check(
  "watchdog: pending replay wins",
  (await probe.waitForProgress({ ...baseState, pendingReplays: [{ id: "x", name: "agy_tool", arguments: "{}" }] })) === "call",
);
check("watchdog: finished prompt wins", (await probe.waitForProgress({ ...baseState, done: true })) === "done");
check(
  "watchdog: idle after the normal budget",
  (await probe.waitForProgress({ ...baseState, done: false, lastActivity: Date.now() - idleBudgetMs(0) - 1 })) === "idle",
);
probe.dispose();

// ---- live agy session -----------------------------------------------------
const account = {
  id: "acc_mw64ua7s_qprzd",
  alias: "check",
  home: "C:/Users/Shawn/.config/opencode/agy/accounts/acc_mw64ua7s_qprzd",
  enabled: true,
  createdAt: 0,
};
const pool = new AcpPool();
const key = `native-check-${Date.now()}`;
const inputs = ["Run the command: Get-Date. Then reply with exactly DONE. Do not do anything else."];
const chunks = [];

try {
  const first = await pool.turn({
    conversationKey: key,
    account,
    inputs,
    nativeTools: true,
    nativeReplay: true,
    autoApprove: true,
    onChunk: (text) => chunks.push(text),
  });
  check("turn 1: parked for a tool call", first.parked === true, JSON.stringify({ parked: first.parked }));
  check("turn 1: returned a tool call", (first.calls?.length ?? 0) > 0, JSON.stringify(first.calls));
  check("turn 1: no usage on an intermediate span", first.usage === undefined);

  const call = first.calls?.[0];
  let replayId = "";
  if (call) {
    try {
      replayId = JSON.parse(call.arguments).id;
    } catch {
      replayId = "";
    }
  }
  check("turn 1: call points at the replay store", typeof replayId === "string" && replayId.length > 0, replayId);

  const record = replayId ? readNativeReplay(replayId) : undefined;
  check("turn 1: recorded output is replayable", !!record && record.output.length > 0, record?.tool);
  check("turn 1: recorded the real command output", !!record && /code 0|20\d\d/.test(record.output), record?.output.slice(0, 60));

  const replayed = replayId ? replayToolResult(replayId) : undefined;
  check("replay tool: returns the recorded output", !!replayed && replayed.content === record?.output, replayed?.content.slice(0, 60));
  check("replay tool: reports the original tool", replayed?.metadata?.tool === "run_command", JSON.stringify(replayed?.metadata));
  const missing = replayToolResult("missing-replay");
  check("replay tool: expired id degrades cleanly", missing.metadata?.code === "REPLAY_EXPIRED", JSON.stringify(missing.metadata));

  const second = await pool.turn({
    conversationKey: key,
    account,
    inputs,
    nativeTools: true,
    nativeReplay: true,
    autoApprove: true,
    onChunk: (text) => chunks.push(text),
  });
  check("turn 2: finished instead of parking", second.parked === false, JSON.stringify({ parked: second.parked }));
  check("turn 2: final text arrived", second.text.includes("DONE"), JSON.stringify(second.text.slice(0, 80)));
  check("turn 2: usage arrived", (second.usage?.inputTokens ?? 0) > 0 && (second.usage?.outputTokens ?? 0) > 0, JSON.stringify(second.usage));
  check("turn 2: stop reason is end_turn", second.stopReason === "end_turn", second.stopReason);
} finally {
  pool.dispose();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(failed.length === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
