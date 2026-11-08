/** Deterministic regressions. No agy process, account or model quota is used. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "agy-turn-regressions-"));
for (const name of ["acp", "tool-bridge", "server", "turn-safety"]) {
  await build({ entryPoints: [`src/provider/${name}.ts`], bundle: true, format: "esm", platform: "node", target: "node20", outfile: join(dir, `${name}.mjs`), logLevel: "silent" });
}
const { AcpPool } = await import(pathToFileURL(join(dir, "acp.mjs")).href);
const { ToolBridge, toBridgeResult } = await import(pathToFileURL(join(dir, "tool-bridge.mjs")).href);
const { acpHistory, startProvider, toOpenAIUsage } = await import(pathToFileURL(join(dir, "server.mjs")).href);
const { TurnSafety } = await import(pathToFileURL(join(dir, "turn-safety.mjs")).href);
const watchdog = setTimeout(() => { console.error("FAIL regression deadline (20s)"); process.exit(1); }, 20_000);
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
async function until(check, label) {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setImmediate(r));
  }
}
const account = { id: "mock", home: dir, enabled: true };

function fixture(pool = new AcpPool({ sweepMs: 60_000 })) {
  let serial = 0;
  const chunks = new Set();
  const tools = new Set();
  const client = {
    prompts: [], cancelled: [], closed: [], selections: [], pending: new Map(),
    async openSession() { return { sessionId: `mock-${++serial}` }; },
    async closeSession(id) { this.closed.push(id); this.finish(id); },
    async loadSession(id) { return { sessionId: id }; },
    cancelSession(id) { this.cancelled.push(id); this.finish(id); },
    onChunk(fn) { chunks.add(fn); return () => chunks.delete(fn); },
    onThought() { return () => {}; }, onTool(fn) { tools.add(fn); return () => tools.delete(fn); },
    tool(id, event) { for (const fn of tools) fn(id, event); },
    async setConfigOption(id, key, value) { this.selections.push({ id, key, value }); return { configOptions: [{ id: key, currentValue: value }] }; },
    promptWithReason(id, text) {
      this.prompts.push({ id, text });
      // A rebuilt session receives the bootstrap wrapper; the fixture answers the
      // current-request section only, the way a model should.
      const current = /CURRENT USER REQUEST[^\n]*\n+([\s\S]*?)\n\nEARLIER CONVERSATION/.exec(text)?.[1]?.trim();
      const asked = current || text;
      return new Promise((resolve) => {
        this.pending.set(id, resolve);
        if (!asked.includes("HOLD")) queueMicrotask(() => this.finish(id, `answer:${asked}`));
      });
    },
    finish(id, text = "") {
      const resolve = this.pending.get(id);
      if (!resolve) return;
      this.pending.delete(id);
      for (const fn of chunks) if (text) fn(id, text);
      resolve({ stopReason: "end_turn" });
    },
    kill() {},
  };
  pool.clients.set(account.id, client);
  pool.catalogue = [{ id: "model-a", efforts: [] }, { id: "model-b", efforts: [] }];
  return { pool, client, run: (options) => pool.turn({ conversationKey: "test", account, onChunk() {}, ...options }) };
}

try {
  await test("bootstrap keeps assistant answers and isolates current question", () => {
    const history = acpHistory([{ role: "user", content: "OLD" }, { role: "assistant", content: "ALREADY DONE" }, { role: "user", content: "NEW" }]);
    assert.ok(history.includes('"role":"assistant","content":"ALREADY DONE"'));
    assert.ok(history.indexOf("NEW") < history.indexOf('"role":"assistant"'), "current request comes before the background transcript");
    assert.ok(history.includes("CURRENT USER REQUEST"));
    assert.ok(history.includes("context only"));
  });

  await test("usage: agy's inputTokens already includes cached reads", () => {
    const usage = toOpenAIUsage({ inputTokens: 44102, outputTokens: 1807, cachedReadTokens: 200495 });
    assert.equal(usage.prompt_tokens, 44102, "prompt must not add the cumulative cache counter");
    assert.equal(usage.prompt_tokens_details.cached_tokens, 44102, "cached detail must be bounded by the prompt");
    const plain = toOpenAIUsage({ inputTokens: 21638, outputTokens: 1 });
    assert.equal(plain.prompt_tokens, 21638);
  });

  await test("tool errors: exact shell exit markers become MCP isError", () => {
    assert.equal(toBridgeResult("(no output)\nExited with code 1").isError, true);
    assert.equal(toBridgeResult("Exited with code -1").isError, true);
    assert.equal(toBridgeResult("Exited with code 0").isError, undefined);
    assert.equal(toBridgeResult("Documentation: error handling and failed tests").isError, undefined);
    assert.equal(toBridgeResult("Exited with code 1", "read").isError, undefined);
    assert.equal(toBridgeResult(JSON.stringify({ isError: true, content: [{ type: "text", text: "probe failed" }] }), "probe").isError, true);
  });

  await test("Windows multiline commands are refused before execution; fifth failure trips once", async () => {
    const trips = [];
    const bridge = new ToolBridge({ platform: "win32", onFailureLimit: (...args) => trips.push(args) });
    try {
      await bridge.start();
      bridge.attach("test", [{ function: { name: "shell" } }]);
      bridge.beginTurn("test", "turn-1");
      const key = bridge.session("test").key;
      for (let i = 0; i < 5; i++) {
        const result = await bridge.park(key, "shell", { command: "node -e \"\nconsole.log('x')\n\"" });
        assert.equal(result.isError, true);
        assert.equal(bridge.openCalls("test").length, 0, "invalid command must never reach host shell");
        if (i < 4) assert.equal(trips.length, 0);
      }
      assert.equal(trips.length, 1);
      assert.match(bridge.failureReason("test"), /AGY_TOOL_FAILURE_LIMIT/);
      assert.equal((await bridge.park(key, "shell", { command: "echo x" })).isError, true);
      assert.equal(trips.length, 1);
      bridge.beginTurn("test", "turn-1");
      assert.ok(bridge.failureReason("test"), "tool resume must not reset the breaker");
      bridge.beginTurn("test", "turn-2");
      assert.equal(bridge.failureReason("test"), undefined);
      const allowed = bridge.park(key, "shell", { command: "echo x" });
      const id = bridge.openCalls("test")[0].id;
      bridge.answerAll("test", [{ id, result: toBridgeResult("x") }]);
      assert.equal((await allowed).isError, undefined);
    } finally { await bridge.close(); }
  });

  await test("bridge: a successful result resets consecutive failures, stale results do not count", async () => {
    const bridge = new ToolBridge();
    try {
      await bridge.start();
      bridge.attach("test", [{ function: { name: "probe" } }]);
      const key = bridge.session("test").key;
      for (const value of [1, 1, 1, 1, 0, 1, 1, 1, 1]) {
        const waiting = bridge.park(key, "probe", {});
        const id = bridge.openCalls("test")[0].id;
        bridge.answerAll("test", [{ id: "stale", result: toBridgeResult("Exited with code 1") }, { id, result: toBridgeResult(`Exited with code ${value}`) }]);
        await waiting;
      }
      assert.equal(bridge.failureReason("test"), undefined);
    } finally { await bridge.close(); }
  });

  await test("native: repeated completed failures cancel ACP instead of executing indefinitely", async () => {
    const f = fixture();
    try {
      const running = f.run({ inputs: ["HOLD"], nativeTools: true });
      await until(() => f.client.prompts.length, "native failure prompt started");
      const id = f.client.prompts[0].id;
      for (let i = 0; i < 5; i++) {
        const event = { toolCallId: `failed-${i}`, name: "run_command", status: "completed", rawOutput: { output: "", exitCode: 1 } };
        f.client.tool(id, event);
        f.client.tool(id, event); // duplicate status updates must not inflate failures
      }
      const result = await running;
      assert.match(result.error, /AGY_TOOL_FAILURE_LIMIT/);
      assert.equal(f.client.cancelled.length, 1);
      assert.equal(f.pool.sessions.size, 0);
    } finally { f.pool.dispose(); }
  });

  for (const nativeTools of [true, false]) {
    const mode = nativeTools ? "native" : "bridged";
    await test(`${mode}: cancellation is isolated from a different running conversation`, async () => {
      const f = fixture();
      try {
        const first = f.run({ inputs: ["HOLD"], nativeTools });
        const other = f.run({ conversationKey: "other", inputs: ["HOLD"], nativeTools });
        await until(() => f.client.prompts.length === 2, "both independent prompts started");
        const otherState = f.pool.sessions.get("other");
        await f.pool.cancel("test");
        await first;
        assert.equal(f.pool.sessions.get("other"), otherState);
        assert.equal(otherState.cancelled, undefined);
        f.client.finish(otherState.sessionId, "OTHER FINISHED");
        assert.equal((await other).text, "OTHER FINISHED");
      } finally { f.pool.dispose(); }
    });
    await test(`${mode}: idle worker release and load keep input boundary`, async () => {
      const f = fixture();
      try {
        await f.run({ inputs: ["first"], nativeTools });
        await f.pool.reap({ force: true });
        assert.equal(f.pool.stats().open, 0);
        await f.run({ inputs: ["first", "next"], nativeTools });
        assert.equal(f.client.prompts[0].id, f.client.prompts[1].id);
        assert.equal(f.client.prompts[1].text, "next");
      } finally { f.pool.dispose(); }
    });
    await test(`${mode}: compaction/input shrink rebuilds rather than draining stale output`, async () => {
      const f = fixture();
      try {
        await f.run({ inputs: ["old", "old followup"], nativeTools });
        const next = await f.run({ inputs: ["compacted current"], nativeTools, historyPrompt: "CURRENT COMPACTED" });
        assert.notEqual(f.client.prompts[0].id, f.client.prompts[1].id);
        assert.equal(next.text, "answer:CURRENT COMPACTED");
      } finally { f.pool.dispose(); }
    });
    await test(`${mode}: normal follow-up reuses session and switches model`, async () => {
      const f = fixture();
      try {
        await f.run({ inputs: ["first"], nativeTools, model: "model-a", historyPrompt: "bootstrap" });
        await f.run({ inputs: ["first", "next"], nativeTools, model: "model-b" });
        assert.equal(f.client.prompts.length, 2);
        assert.equal(f.client.prompts[0].id, f.client.prompts[1].id);
        assert.equal(f.client.prompts[1].text, "next");
        assert.ok(f.client.selections.some((s) => s.value === "model-b"));
      } finally { f.pool.dispose(); }
    });
    await test(`${mode}: new question interrupts running task, never drains old answer`, async () => {
      const f = fixture();
      try {
        const old = f.run({ inputs: ["HOLD"], nativeTools });
        const settled = old.catch((error) => error);
        await until(() => f.client.prompts.length, "old prompt started");
        let superseded = 0;
        const next = await f.run({ inputs: ["HOLD", "NEW"], nativeTools, model: "model-b", historyPrompt: "CURRENT NEW", onSupersede() { superseded++; } });
        await settled;
        assert.equal(superseded, 1);
        assert.equal(f.client.cancelled.length, 1);
        assert.notEqual(f.client.prompts[0].id, f.client.prompts[1].id);
        assert.equal(next.text, "answer:CURRENT NEW");
        assert.ok(f.pool.sessions.has("test"), "late old completion must not delete new session");
      } finally { f.pool.dispose(); }
    });
    await test(`${mode}: stop then repeat same question creates a clean task`, async () => {
      const f = fixture();
      try {
        const old = f.run({ inputs: ["HOLD"], nativeTools }).catch((error) => error);
        await until(() => f.client.prompts.length, "stoppable prompt started");
        await f.pool.cancel("test");
        await old;
        const next = await f.run({ inputs: ["HOLD"], nativeTools, historyPrompt: "RETRY" });
        assert.equal(next.text, "answer:RETRY");
        assert.equal(f.client.cancelled.length, 1);
      } finally { f.pool.dispose(); }
    });
    await test(`${mode}: tool continuation does not start a second prompt`, async () => {
      const f = fixture();
      try {
        let parked = [{ id: "call-1", name: "read", arguments: "{}" }];
        const options = { inputs: ["HOLD"], nativeTools, parkedCalls: () => parked };
        const first = await f.run(options);
        assert.equal(first.parked, true);
        parked = [];
        f.client.finish(f.client.prompts[0].id, "FINAL");
        const next = await f.run(options);
        assert.equal(next.text, "FINAL");
        assert.equal(f.client.prompts.length, 1);
      } finally { f.pool.dispose(); }
    });
    await test(`${mode}: edited question with same input count is not treated as replay`, async () => {
      const f = fixture();
      try {
        await f.run({ inputs: ["original"], nativeTools });
        await f.run({ inputs: ["edited"], nativeTools });
        assert.equal(f.client.prompts.length, 2);
        assert.notEqual(f.client.prompts[0].id, f.client.prompts[1].id);
      } finally { f.pool.dispose(); }
    });
  }

  await test("native: a pending mirror cannot be returned as the answer to a new question", async () => {
    const f = fixture();
    try {
      const old = f.run({ inputs: ["HOLD"], nativeTools: true, nativeReplay: true });
      await until(() => f.client.prompts.length, "mirrored native prompt started");
      f.client.tool(f.client.prompts[0].id, { toolCallId: "mirror-1", name: "run_command", status: "completed", rawOutput: { output: "OLD TOOL", exitCode: 0 } });
      const parked = await old;
      assert.equal(parked.parked, true);
      const next = await f.run({ inputs: ["HOLD", "NEW"], nativeTools: true, nativeReplay: true, historyPrompt: "CURRENT NEW" });
      assert.equal(next.text, "answer:CURRENT NEW");
      assert.equal(next.calls, undefined);
    } finally { f.pool.dispose(); }
  });

  await test("bridge: historical and out-of-order results match IDs, not positions", async () => {
    const bridge = new ToolBridge();
    try {
      await bridge.start();
      bridge.attach("test", [{ function: { name: "read" } }]);
      const key = bridge.session("test").key;
      const result = (text) => ({ content: [{ type: "text", text }] });
      const a = bridge.park(key, "read", {});
      const oldId = bridge.openCalls("test")[0].id;
      bridge.answerAll("test", [{ id: oldId, result: result("OLD") }]);
      assert.equal((await a).content[0].text, "OLD");
      const b = bridge.park(key, "read", {});
      const c = bridge.park(key, "read", {});
      const [bi, ci] = bridge.openCalls("test").map((call) => call.id);
      assert.equal(bridge.answerAll("test", [{ id: oldId, result: result("WRONG") }]), 0);
      assert.equal(bridge.answerAll("test", [{ id: ci, result: result("C") }, { id: bi, result: result("B") }]), 2);
      assert.equal((await b).content[0].text, "B");
      assert.equal((await c).content[0].text, "C");
      assert.equal(bridge.answerAll("test", [{ id: ci, result: result("DUPLICATE") }]), 0);
      const pending = bridge.park(key, "read", {});
      bridge.cancelCalls("test");
      assert.equal((await pending).isError, true);
      assert.equal(bridge.session("test").key, key);
    } finally { await bridge.close(); }
  });

  await test("HTTP: successive bridged tools receive their own results from full history", async () => {
    const bridge = new ToolBridge();
    let nextCall;
    const received = [];
    let step = 0;
    const server = await startProvider({ transport: "acp", port: 0, toolBridge: bridge,
      settings: { agentMode: "bridged", autoApproveNative: false }, resolveAccount: () => account,
      turn: async (options) => {
        const key = bridge.session(options.conversationKey).key;
        if (step++ === 0) {
          nextCall = bridge.park(key, "probe", { step: 1 });
          return { text: "", parked: true, calls: bridge.openCalls(options.conversationKey) };
        }
        received.push((await nextCall).content[0].text);
        if (step === 2) {
          nextCall = bridge.park(key, "probe", { step: 2 });
          return { text: "", parked: true, calls: bridge.openCalls(options.conversationKey) };
        }
        return { text: received.join("|"), parked: false };
      },
    });
    const messages = [{ role: "user", content: "Use two tools" }];
    const request = async () => (await fetch(server.url + "/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "model-a", messages, tools: [{ function: { name: "probe", parameters: { type: "object", properties: {} } } }] }),
      signal: AbortSignal.timeout(2000),
    })).json();
    try {
      for (const output of ["FIRST", "SECOND"]) {
        const response = await request();
        const call = response.choices[0].message.tool_calls[0];
        messages.push({ role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: output });
      }
      const response = await request();
      assert.equal(response.choices[0].message.content, "FIRST|SECOND");
    } finally { await server.close(); }
  });

  await test("HTTP: fifth explicit failure stops before a sixth host execution; new question resets", async () => {
    const bridge = new ToolBridge();
    let executions = 0;
    const server = await startProvider({ transport: "acp", port: 0, toolBridge: bridge,
      settings: { agentMode: "bridged", autoApproveNative: false }, resolveAccount: () => account,
      turn: async (options) => {
        executions++;
        void bridge.park(bridge.session(options.conversationKey).key, "probe", {});
        return { text: "", parked: true, calls: bridge.openCalls(options.conversationKey) };
      },
    });
    const messages = [{ role: "user", content: "Investigate" }];
    const request = async () => {
      const response = await fetch(server.url + "/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages, tools: [{ function: { name: "probe" } }] }), signal: AbortSignal.timeout(2000),
      });
      return { status: response.status, body: await response.json() };
    };
    try {
      for (let i = 0; i < 5; i++) {
        const response = await request();
        assert.equal(response.status, 200);
        const call = response.body.choices[0].message.tool_calls[0];
        messages.push({ role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: JSON.stringify({ isError: true, content: [{ type: "text", text: "controlled tool failure" }] }) });
      }
      const stopped = await request();
      assert.equal(stopped.status, 400);
      assert.equal(stopped.body.error.code, "AGY_TOOL_FAILURE_LIMIT");
      assert.equal(executions, 5);
      const repeated = await request();
      assert.equal(repeated.status, 400);
      assert.equal(executions, 5);
      messages.push({ role: "user", content: "I fixed the environment. Retry now." });
      assert.equal((await request()).status, 200);
      assert.equal(executions, 6);
    } finally { await server.close(); }
  });

  for (const agentMode of ["native", "bridged"]) {
    await test(`HTTP ${agentMode}: disconnect cancels worker; re-asking works`, async () => {
      const server = await startProvider({ transport: "acp", port: 0,
        settings: { agentMode, autoApproveNative: true }, resolveAccount: () => account,
      });
      const f = fixture(server.pool);
      const post = (content, signal) => fetch(server.url + "/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content }] }), signal,
      });
      try {
        // Destroy the actual socket, independent of Bun/Node fetch pooling.
        const stoppedRequest = spawn("node", ["-e", `
          const req = require('http').request(${JSON.stringify(server.url + "/v1/chat/completions")}, { method: 'POST', headers: { 'content-type': 'application/json' } });
          req.on('error', () => {});
          req.end(JSON.stringify({ stream: true, messages: [{role:'user', content:'HOLD'}] }));
          setTimeout(() => { req.destroy(); }, 400);
        `], { stdio: "ignore" });
        await until(() => f.client.prompts.length, "HTTP prompt started");
        await until(() => f.client.cancelled.length, "HTTP disconnect cancellation");
        assert.equal(f.pool.sessions.size, 0);
        assert.equal(f.client.closed.length, 1);
        const retry = await post("RETRY", AbortSignal.timeout(2000));
        assert.equal(retry.status, 200);
        const retryBody = await retry.json();
        assert.ok(String(retryBody.choices?.[0]?.message?.content ?? "").endsWith("RETRY"), JSON.stringify(retryBody).slice(0, 300));
      } finally { await server.close(); }
    });
  }
  await test("reload waits for an in-flight turn before closing the bridge", async () => {
    const f = fixture();
    try {
      const running = f.run({ inputs: ["HOLD"], nativeTools: false });
      await until(() => f.client.prompts.length, "in-flight prompt started");
      assert.equal(await f.pool.waitForIdle(300), false, "busy turn must not look idle");
      f.client.finish(f.client.prompts[0].id, "DONE");
      await running;
      assert.equal(await f.pool.waitForIdle(2_000), true, "finished turn becomes idle");
    } finally { f.pool.dispose(); }
  });

  await test("budget: no-progress detection ignores key order and resets on different output", () => {
    let tripped;
    const safety = new TurnSafety({ maxToolCalls: 100, maxTurnMs: 60_000, maxRepeatedResults: 2 }, (r) => { tripped = r; });
    safety.complete("a", "read", { path: "x", limit: 1 }, { text: "same" });
    safety.complete("b", "read", { limit: 1, path: "x" }, { text: "same" });
    assert.equal(tripped.code, "AGY_NO_PROGRESS");
    assert.equal(safety.reserve("c"), false, "a tripped turn cannot start more calls");
    safety.finish();
    let reset;
    const other = new TurnSafety({ maxToolCalls: 100, maxTurnMs: 60_000, maxRepeatedResults: 2 }, (r) => { reset = r; });
    other.complete("a", "read", { path: "x" }, { text: "same" });
    other.complete("b", "read", { path: "x" }, { text: "different" });
    other.complete("c", "read", { path: "x" }, { text: "same" });
    assert.equal(reset, undefined);
    other.finish();
  });

  await test("budget: time stop is terminal for the same streamed turn and resets on a new turn", async () => {
    let calls = 0;
    const server = await startProvider({ transport: "acp", port: 0,
      settings: { agentMode: "native", autoApproveNative: false, taskBudget: { maxToolCalls: 200, maxTurnMs: 30, maxRepeatedResults: 8 } },
      resolveAccount: () => account,
      turn: async (options) => {
        calls++;
        if (calls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 70));
          return { text: "", parked: false, error: options.safety.reason?.message };
        }
        return { text: "NEW TURN OK", parked: false };
      },
    });
    const headers = { "content-type": "application/json", "x-agy-session-id": "ses_timeout_test", "x-agy-turn-id": "turn_one" };
    const body = { stream: true, messages: [{ role: "user", content: "first" }] };
    try {
      const first = await fetch(server.url + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) });
      assert.equal(first.status, 200);
      assert.match(await first.text(), /AGY_TURN_TIME_LIMIT/);
      const retry = await fetch(server.url + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) });
      assert.equal(retry.status, 400);
      assert.equal((await retry.json()).error.code, "AGY_TURN_TIME_LIMIT");
      assert.equal(calls, 1, "a retry of a stopped turn must not start a second prompt");
      const next = await fetch(server.url + "/v1/chat/completions", { method: "POST", headers: { ...headers, "x-agy-turn-id": "turn_two" },
        body: JSON.stringify({ messages: [{ role: "user", content: "next" }] }), signal: AbortSignal.timeout(2000) });
      assert.equal(next.status, 200);
      assert.equal((await next.json()).choices[0].message.content, "NEW TURN OK");
      assert.equal(calls, 2);
    } finally { await server.close(); }
  });

  await test("budget: tool count is shared across HTTP spans; a new user turn gets a fresh budget", async () => {
    const bridge = new ToolBridge();
    let parks = 0, accepted = new Set();
    const server = await startProvider({ transport: "acp", port: 0, toolBridge: bridge,
      settings: { agentMode: "bridged", autoApproveNative: false, taskBudget: { maxToolCalls: 2, maxTurnMs: 60_000, maxRepeatedResults: 100 } },
      resolveAccount: () => account,
      turn: async (options) => {
        parks++;
        const before = new Set(bridge.openCalls(options.conversationKey).map((c) => c.id));
        void bridge.park(bridge.session(options.conversationKey).key, "probe", { n: parks }).catch(() => {});
        const calls = bridge.openCalls(options.conversationKey);
        for (const call of calls) if (!before.has(call.id)) accepted.add(call.id);
        return { text: "", parked: calls.length > 0, calls };
      },
    });
    const headers = { "content-type": "application/json", "x-agy-session-id": "ses_test", "x-agy-turn-id": "msg_one" };
    const messages = [{ role: "user", content: "work" }];
    const request = async (extra = {}) => {
      const r = await fetch(server.url + "/v1/chat/completions", { method: "POST", headers: { ...headers, ...extra },
        body: JSON.stringify({ messages, tools: [{ function: { name: "probe" } }] }), signal: AbortSignal.timeout(2000) });
      return { status: r.status, body: await r.json() };
    };
    try {
      for (let i = 0; i < 3; i++) {
        const r = await request();
        const call = r.body?.choices?.[0]?.message?.tool_calls?.[0];
        if (!call) break;
        messages.push({ role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: `result-${i}` });
      }
      assert.ok(accepted.size <= 2, `budget must accept at most two tool calls (accepted=${accepted.size})`);
      assert.equal((await request()).status, 400, "a tool-result retry must not bypass the budget");
      const parksBeforeRetry = parks;
      const streamingRetry = await fetch(server.url + "/v1/chat/completions", { method: "POST", headers,
        body: JSON.stringify({ stream: true, messages, tools: [{ function: { name: "probe" } }] }), signal: AbortSignal.timeout(2000) });
      assert.equal(streamingRetry.status, 400, "a stopped streaming turn must return non-retryable HTTP status before SSE starts");
      assert.match((await streamingRetry.json()).error.code, /^AGY_/);
      assert.equal(parks, parksBeforeRetry, "a rejected retry must not invoke the runner");
      messages.push({ role: "user", content: "new work" });
      assert.equal((await request({ "x-agy-turn-id": "msg_two" })).status, 200);
    } finally { await server.close(); }
  });

  await test("argon: native and bridged modes both use ACP", async () => {
    for (const mode of ["native", "bridged"]) {
      const calls = [];
      const server = await startProvider({ transport: "acp", port: 0,
        settings: { agentMode: mode, autoApproveNative: mode === "native", taskBudget: { maxToolCalls: 10, maxTurnMs: 60_000, maxRepeatedResults: 10 } },
        resolveAccount: () => account,
        run: async () => { throw new Error("print must not be used"); },
        turn: async (options) => { calls.push(options); return { text: "ARGON OK", parked: false }; },
      });
      try {
        const r = await fetch(server.url + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gemini-4-argon-medium", messages: [{ role: "user", content: "hi" }] }), signal: AbortSignal.timeout(3000) });
        assert.equal(r.status, 200);
        assert.equal((await r.json()).choices[0].message.content, "ARGON OK");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].model, "gemini-4-argon-medium");
        assert.equal(calls[0].nativeTools, mode === "native");
      } finally { await server.close(); }
    }
  });

  console.log(`RESULT: PASS (${passed} scenarios, no model requests)`);
} finally { clearTimeout(watchdog); }
