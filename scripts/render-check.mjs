/**
 * Renders the built GUI bundle in jsdom and checks what the settings page
 * actually produces. The app provides `@opencode/plugin/gui`, `effect` and
 * `solid-js` as host modules; here they are stubbed the same way, so the
 * component tree under test is the real one.
 *
 * Run: node --conditions=browser scripts/render-check.mjs
 */
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;

const require = createRequire(import.meta.url);

// `effect` ships CJS and is a real dependency, so it is passed through. Only
// the GUI SDK is host-provided and must be stubbed.
const guiStub = {
  Plugin: { define: (x) => x },
  SettingsPage: { kind: "registry", id: "settings-page" },
  Ipc: { define: (spec) => ({ kind: "ipc", id: spec.id, spec }) },
  Contract: { define: (id) => ({ kind: "contract", id }) },
  Store: { global: (...a) => ({ scope: "global", a }), session: (...a) => ({ scope: "session", a }) },
};

function hostRequire(id) {
  if (id === "@opencode/plugin/gui") return guiStub;
  if (id === "@opencode/plugin/gui/main") return guiStub;
  return require(id);
}

const dist = join(here, "..", "dist", "gui-experimental.cjs");
const mod = { exports: {} };
new Function("require", "module", "exports", readFileSync(dist, "utf8"))(hostRequire, mod, mod.exports);

const def = mod.exports.default ?? mod.exports;
if (typeof def.setup !== "function") {
  console.error("FAIL: bundle default export has no setup()");
  process.exit(1);
}

const iso = (mins) => new Date(Date.now() + mins * 60_000).toISOString();

const STATE = {
  activeAccountId: "system",
  defaultTier: "argon-4-lo",
  routing: "active",
  cooldownMs: 900000,
  accounts: [
    {
      id: "system",
      alias: "系统账号（agy 已登录）",
      home: "",
      enabled: true,
      createdAt: 0,
      argon: true,
      claude: true,
      flash: true,
      models: [
        "gemini-4-argon-low",
        "gemini-4-argon-medium",
        "gemini-4-argon-high",
        "gemini-3.8-flash-low",
        "gemini-3.8-flash-medium",
        "gemini-3.8-flash-high",
        "claude-opus-5-5-low",
        "claude-opus-5-5-medium",
        "claude-opus-5-5-high",
        "claude-sonnet-5-5-low",
        "claude-sonnet-5-5-medium",
        "claude-sonnet-5-5-high",
        "gpt-oss-120b-medium",
      ],
      checkedAt: Date.now() - 3600e3,
      usage: [
        { group: "Gemini Models", label: "Weekly Limit Remaining", percent: 71, resetAt: iso(2880) },
        { group: "Gemini Models", label: "Five Hour Limit Remaining", percent: 98, resetAt: iso(30) },
        { group: "Claude and GPT models", label: "Weekly Limit Remaining", percent: 81, resetAt: iso(7200) },
        { group: "Claude and GPT models", label: "Five Hour Limit Remaining", percent: 88, resetAt: iso(120) },
        { group: "Gemini 4 Argon", label: "Gemini 4 Argon Weekly Limit", percent: 59, resetAt: iso(4320) },
      ],
      usageCheckedAt: Date.now() - 60_000,
    },
  ],
};

const client = {
  read: async () => STATE,
  add: async () => STATE.accounts[0],
  remove: async () => true,
  probe: async () => STATE.accounts[0],
  usage: async () => STATE.accounts[0],
  setActive: async () => true,
  setDefaultTier: async () => true,
  setRouting: async () => true,
  setCooldown: async () => true,
  clearCooldown: async () => true,
  login: async () => true,
};

let page = null;
const ctx = {
  id: "agy-opencode",
  add(registry, value) {
    if (registry?.id === "settings-page" || value?.render) page = value;
  },
  t: (k) => k,
  plural: (k, n) => `${k}:${n}`,
  main: () => client,
  signal: new AbortController().signal,
};

def.setup(ctx);
if (!page) {
  console.error("FAIL: setup() did not register a SettingsPage");
  process.exit(1);
}
console.log("registered page:", page.id, "|", page.title);

const solidWeb = await import("solid-js/web");
const solid = await import("solid-js");

const root = document.getElementById("root");
solid.createRoot(() => {
  solidWeb.insert(root, solidWeb.createComponent(() => page.render({})));
});
await new Promise((r) => setTimeout(r, 150));

// Open the tier picker so its options mount.
const tierBtn = [...root.querySelectorAll("button")].find((b) => /Argon/i.test(b.textContent || ""));
if (tierBtn) {
  tierBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
}

// Regression guard: a clipping ancestor would hide every option below the card
// edge (Opus 5.5, GPT-OSS) even though they are in the DOM.
let clippedBy = null;
for (let el = root.querySelector("[data-tier]"); el && el !== root; el = el.parentElement) {
  const ov = el.style?.overflow;
  if (ov === "hidden" || ov === "clip") {
    clippedBy = `${el.tagName}[${el.getAttribute("style")?.slice(0, 40)}]`;
    break;
  }
}

const text = root.textContent || "";
const optionCount = root.querySelectorAll("[data-tier]").length;
const buttons = [...root.querySelectorAll("button")].map((b) => b.textContent.trim());
const disabled = [...root.querySelectorAll("button")].filter((b) => b.disabled).map((b) => b.textContent.trim());

console.log("--- rendered ---");
console.log("tier options:", optionCount);
console.log("buttons:", JSON.stringify(buttons));
console.log("disabled buttons:", JSON.stringify(disabled));
console.log("quota rows:", (text.match(/Limit Remaining|Argon Weekly Limit/g) || []).length);
console.log("clipped by ancestor:", clippedBy ?? "no");
console.log("alias rendered:", text.includes("系统账号"));

let ok = true;
const fail = (m) => {
  console.log("CHECK FAIL: " + m);
  ok = false;
};
if (optionCount !== 13) fail(`expected 13 tier options, got ${optionCount}`);
if (clippedBy) fail("dropdown is clipped by " + clippedBy);
if (!text.includes("系统账号")) fail("account row missing");
if (!text.includes("Weekly Limit Remaining")) fail("quota rows missing");
if (!text.includes("71%")) fail("quota percentage missing");
if (!buttons.some((b) => b.includes("轮询"))) fail("routing buttons missing");
if (disabled.length > 0) fail("unexpected disabled buttons: " + JSON.stringify(disabled));

console.log(ok ? "\nRESULT: PASS" : "\nRESULT: FAIL");
process.exit(ok ? 0 : 1);
