/** Compare the quoted deliver proposal, old FIFO logic and current routing. No model calls. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const outfile = join(mkdtempSync(join(tmpdir(), "agy-routing-proposal-")), "bridge.mjs");
await build({ entryPoints: ["src/provider/tool-bridge.ts"], bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent" });
const { ToolBridge, toBridgeResult } = await import(pathToFileURL(outfile).href);

// Same routing algorithm as the user's quoted snippet, without TS annotations.
function proposedDeliver(conversationKey, messages) {
  const entry = this.entries.get(conversationKey);
  if (!entry) return 0;
  const unsettledById = new Map();
  for (const call of entry.calls) if (!call.settled) unsettledById.set(call.id, call);
  if (unsettledById.size === 0) return 0;
  let delivered = 0;
  for (const msg of messages) {
    if (msg.role !== "tool" || !msg.tool_call_id) continue;
    const targetCall = unsettledById.get(msg.tool_call_id);
    if (targetCall) {
      targetCall.answer(toBridgeResult(msg.content));
      unsettledById.delete(msg.tool_call_id);
      delivered++;
    }
  }
  return delivered;
}
function currentDeliver(key, messages) {
  return this.answerAll(key, messages.filter((m) => m.role === "tool").map((m) => ({ id: m.tool_call_id ?? "", result: toBridgeResult(m.content) })));
}
function legacyDeliver(key, messages) {
  const entry = this.entries.get(key);
  const open = entry.calls.filter((c) => !c.settled);
  const results = messages.filter((m) => m.role === "tool").map((m) => toBridgeResult(m.content));
  for (let i = 0; i < Math.min(open.length, results.length); i++) open[i].answer(results[i]);
}
function fixture() {
  const bridge = new ToolBridge();
  const received = new Map();
  bridge.entries.set("A", { key: "A", calls: [], tools: [], seq: 0, failures: 0, wake: null });
  bridge.entries.set("B", { key: "B", calls: [], tools: [], seq: 0, failures: 0, wake: null });
  const call = (id, key = "A") => {
    const target = { id, name: "read", arguments: "{}", settled: false,
      answer(result) { assert.equal(this.settled, false, "a Promise must not be settled twice"); this.settled = true; received.set(id, result.content[0].text); },
    };
    bridge.entries.get(key).calls.push(target);
    return target;
  };
  return { bridge, received, call };
}
const tool = (id, content) => ({ role: "tool", tool_call_id: id, content });
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
test("legacy FIFO reproduces old-result contamination", () => {
  const f = fixture(); f.call("new");
  legacyDeliver.call(f.bridge, "A", [tool("old", "OLD OUTPUT"), tool("new", "NEW OUTPUT")]);
  assert.equal(f.received.get("new"), "OLD OUTPUT");
});
for (const [name, deliver] of [["proposal", proposedDeliver], ["current", currentDeliver]]) {
  test(`${name}: historical, duplicate, unknown and missing IDs do not contaminate new calls`, () => {
    const f = fixture(); f.call("new");
    assert.equal(deliver.call(f.bridge, "A", [tool("old", "OLD"), tool("new", "NEW"), tool("new", "DUP"), { role: "tool", content: "NO ID" }]), 1);
    assert.equal(f.received.get("new"), "NEW");
    assert.equal(deliver.call(f.bridge, "A", [tool("new", "REPLAY")]), 0);
  });
  test(`${name}: parallel results can arrive reversed and in separate requests`, () => {
    const f = fixture(); f.call("one"); f.call("two"); f.call("three");
    assert.equal(deliver.call(f.bridge, "A", [tool("three", "3")]), 1);
    assert.equal(f.received.has("one"), false);
    assert.equal(deliver.call(f.bridge, "A", [tool("two", "2"), tool("one", "1")]), 2);
    assert.deepEqual([...f.received], [["three", "3"], ["two", "2"], ["one", "1"]]);
  });
  test(`${name}: conversation boundaries isolate pending calls`, () => {
    const f = fixture(); f.call("one", "A"); f.call("two", "B");
    assert.equal(deliver.call(f.bridge, "A", [tool("two", "WRONG CONVERSATION")]), 0);
    assert.equal(deliver.call(f.bridge, "B", [tool("two", "B OUTPUT")]), 1);
    assert.equal(f.received.has("one"), false);
  });
}
test("proposal snippet alone retains settled references; current implementation prunes each delivery", () => {
  const p = fixture(); const c = fixture();
  for (let i = 0; i < 100; i++) {
    p.call(`p${i}`); c.call(`c${i}`);
    proposedDeliver.call(p.bridge, "A", [tool(`p${i}`, "ok")]);
    currentDeliver.call(c.bridge, "A", [tool(`c${i}`, "ok")]);
  }
  assert.equal(p.bridge.entries.get("A").calls.length, 100);
  assert.equal(c.bridge.entries.get("A").calls.length, 0);
});
console.log(`RESULT: PASS (${passed} comparison scenarios; no model requests)`);
