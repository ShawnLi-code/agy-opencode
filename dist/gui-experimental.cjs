"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
Object.defineProperties(exports, { __esModule: { value: true }, [Symbol.toStringTag]: { value: "Module" } });
const web = require("solid-js/web");
const gui$1 = require("@opencode/plugin/gui");
const Effect = require("effect");
const solidJs = require("solid-js");
const store = require("solid-js/store");
const node_child_process = require("node:child_process");
const node_fs = require("node:fs");
const node_os = require("node:os");
const node_path = require("node:path");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const Effect__namespace = /* @__PURE__ */ _interopNamespaceDefault(Effect);
const UsageRowSchema = Effect__namespace.Schema.Struct({
  group: Effect__namespace.Schema.String,
  label: Effect__namespace.Schema.String,
  percent: Effect__namespace.Schema.Number,
  resetAt: Effect__namespace.Schema.String
});
const AccountSchema = Effect__namespace.Schema.Struct({
  id: Effect__namespace.Schema.String,
  alias: Effect__namespace.Schema.String,
  home: Effect__namespace.Schema.String,
  enabled: Effect__namespace.Schema.Boolean,
  createdAt: Effect__namespace.Schema.Number,
  argon: Effect__namespace.Schema.optional(Effect__namespace.Schema.Boolean),
  claude: Effect__namespace.Schema.optional(Effect__namespace.Schema.Boolean),
  flash: Effect__namespace.Schema.optional(Effect__namespace.Schema.Boolean),
  models: Effect__namespace.Schema.optional(Effect__namespace.Schema.Array(Effect__namespace.Schema.String)),
  checkedAt: Effect__namespace.Schema.optional(Effect__namespace.Schema.Number),
  error: Effect__namespace.Schema.optional(Effect__namespace.Schema.String),
  calls: Effect__namespace.Schema.optional(Effect__namespace.Schema.Number),
  failures: Effect__namespace.Schema.optional(Effect__namespace.Schema.Number),
  lastUsedAt: Effect__namespace.Schema.optional(Effect__namespace.Schema.Number),
  lastError: Effect__namespace.Schema.optional(Effect__namespace.Schema.String),
  cooldownUntil: Effect__namespace.Schema.optional(Effect__namespace.Schema.Number),
  usage: Effect__namespace.Schema.optional(Effect__namespace.Schema.Array(UsageRowSchema)),
  usageCheckedAt: Effect__namespace.Schema.optional(Effect__namespace.Schema.Number),
  usageError: Effect__namespace.Schema.optional(Effect__namespace.Schema.String),
  email: Effect__namespace.Schema.optional(Effect__namespace.Schema.String),
  name: Effect__namespace.Schema.optional(Effect__namespace.Schema.String),
  loggedIn: Effect__namespace.Schema.optional(Effect__namespace.Schema.Boolean),
  expired: Effect__namespace.Schema.optional(Effect__namespace.Schema.Boolean)
});
const StateSchema = Effect__namespace.Schema.Struct({
  activeAccountId: Effect__namespace.Schema.String,
  defaultTier: Effect__namespace.Schema.String,
  routing: Effect__namespace.Schema.String,
  cooldownMs: Effect__namespace.Schema.Number,
  accounts: Effect__namespace.Schema.Array(AccountSchema)
});
const AgyAccounts = gui$1.Ipc.define({
  id: "agy-opencode.accounts",
  methods: {
    /** Current state: accounts plus the selected defaults. */
    read: { output: StateSchema },
    /** Create a new account with an isolated HOME. */
    add: { input: Effect__namespace.Schema.Struct({ alias: Effect__namespace.Schema.String }), output: AccountSchema },
    /** Delete an account entry (optionally its HOME directory). */
    remove: {
      input: Effect__namespace.Schema.Struct({ id: Effect__namespace.Schema.String, purgeHome: Effect__namespace.Schema.optional(Effect__namespace.Schema.Boolean) }),
      output: Effect__namespace.Schema.Boolean
    },
    /** Run `agy models` as this account and cache what it can use. */
    probe: { input: Effect__namespace.Schema.Struct({ id: Effect__namespace.Schema.String }), output: AccountSchema },
    /** Read remaining quota via the official `agy --print=/usage` command. */
    usage: { input: Effect__namespace.Schema.Struct({ id: Effect__namespace.Schema.String }), output: AccountSchema },
    /** Pick the account the tool uses by default. */
    setActive: { input: Effect__namespace.Schema.Struct({ id: Effect__namespace.Schema.String }), output: Effect__namespace.Schema.Boolean },
    /** Pick the tier used when a call does not specify one. */
    setDefaultTier: { input: Effect__namespace.Schema.Struct({ tier: Effect__namespace.Schema.String }), output: Effect__namespace.Schema.Boolean },
    /** Pick how the next account is chosen: active / sequential / roundrobin. */
    setRouting: { input: Effect__namespace.Schema.Struct({ routing: Effect__namespace.Schema.String }), output: Effect__namespace.Schema.Boolean },
    /** How long an account rests after a quota/auth failure, in minutes. */
    setCooldown: { input: Effect__namespace.Schema.Struct({ minutes: Effect__namespace.Schema.Number }), output: Effect__namespace.Schema.Boolean },
    /** Clear a cooldown so the account is used again immediately. */
    clearCooldown: { input: Effect__namespace.Schema.Struct({ id: Effect__namespace.Schema.String }), output: Effect__namespace.Schema.Boolean },
    /** Reset the local usage counters for an account. */
    resetUsage: { input: Effect__namespace.Schema.Struct({ id: Effect__namespace.Schema.String }), output: Effect__namespace.Schema.Boolean },
    /** Open the Google sign-in flow for an account (runs `agy acp --login` in it). */
    login: { input: Effect__namespace.Schema.Struct({ id: Effect__namespace.Schema.String }), output: Effect__namespace.Schema.Boolean }
  }
});
var _tmpl$ = /* @__PURE__ */ web.template(`<span style="font-size:11px;line-height:18px;padding:0 7px;border-radius:5px">`), _tmpl$2 = /* @__PURE__ */ web.template(`<div style=margin-bottom:14px;font-size:12px>读取失败：`), _tmpl$3 = /* @__PURE__ */ web.template(`<div style="padding:22px 26px 40px;font-size:13px;max-width:900px"><div style=margin-bottom:22px><h1 style="font-size:16px;font-weight:600;margin:0 0 6px">Antigravity</h1><p style=margin:0;line-height:1.55;font-size:12.5px>把 Antigravity 接成 OpenCode 的模型供应商：在模型里选 <code>agy-cli</code> 就能直接当主模型用， 也可以用 <code>agy</code> 工具把任务交给它跑。每个账号用独立 HOME 目录隔离凭证，互不影响。`), _tmpl$4 = /* @__PURE__ */ web.template(`<div style=margin-top:26px>账号`), _tmpl$5 = /* @__PURE__ */ web.template(`<div>`), _tmpl$6 = /* @__PURE__ */ web.template(`<div style=display:flex;gap:8px;margin-top:10px><input placeholder="新账号备注，例如「备用 Google 账号」"style="flex:1;font-size:12px;padding:6px 10px;border-radius:6px;outline:none"><button>添加账号`), _tmpl$7 = /* @__PURE__ */ web.template(`<div style=margin-top:26px>调用设置`), _tmpl$8 = /* @__PURE__ */ web.template(`<div style="position:absolute;top:calc(100% + 6px);left:0;z-index:50;min-width:260px;max-height:320px;overflow-y:auto;background:var(--v2-background-bg-base, #16191f);border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,0.5);padding:6px">`), _tmpl$9 = /* @__PURE__ */ web.template(`<div><div style=border-top:none><div><div style=font-size:12.5px>默认档位</div><div style=font-size:11px;margin-top:2px>未指定 tier 时使用</div></div><div style=position:relative;justify-self:start><button style=min-width:250px;text-align:left> </button></div></div><div><div><div style=font-size:12.5px>路由策略</div><div style=font-size:11px;margin-top:2px></div></div><div style=display:flex;gap:4px;justify-self:start></div></div><div><div><div style=font-size:12.5px>冷却时长</div><div style=font-size:11px;margin-top:2px>配额或未授权时暂停该账号</div></div><div style=display:flex;align-items:center;gap:8px;justify-self:start><input type=number min=1 max=240 style="width:64px;font-size:12px;padding:5px 8px;border-radius:6px;outline:none"><span style=font-size:11.5px>分钟`), _tmpl$0 = /* @__PURE__ */ web.template(`<div style=margin-top:26px;display:flex;align-items:center;justify-content:space-between><span>额度<span style=margin-left:8px;font-size:11px>来自 <code>agy --print=/usage</code></span></span><button>`), _tmpl$1 = /* @__PURE__ */ web.template(`<div style="padding:10px 14px;font-size:11px;line-height:1.55">上次读取失败：<span> · 5 分钟内不会自动重试，可以点「刷新」手动重试。`), _tmpl$10 = /* @__PURE__ */ web.template(`<div style=margin-top:14px;font-size:11.5px>`), _tmpl$11 = /* @__PURE__ */ web.template(`<span style=font-size:10.5px;flex-shrink:0>默认`), _tmpl$12 = /* @__PURE__ */ web.template(`<span style=font-size:11px;flex-shrink:0>冷却剩 <!> 分`), _tmpl$13 = /* @__PURE__ */ web.template(`<span>`), _tmpl$14 = /* @__PURE__ */ web.template(`<span style=font-size:10.5px>登录已过期`), _tmpl$15 = /* @__PURE__ */ web.template(`<span> · 探测 `), _tmpl$16 = /* @__PURE__ */ web.template(`<span> · 上次 `), _tmpl$17 = /* @__PURE__ */ web.template(`<button>登录`), _tmpl$18 = /* @__PURE__ */ web.template(`<button>解除`), _tmpl$19 = /* @__PURE__ */ web.template(`<button>设为默认`), _tmpl$20 = /* @__PURE__ */ web.template(`<button>删除`), _tmpl$21 = /* @__PURE__ */ web.template(`<div style="display:flex;align-items:flex-start;gap:14px;padding:12px 14px"><div style=min-width:0;flex:1><div style=display:flex;align-items:baseline;gap:8px;min-width:0><span style=width:6px;height:6px;border-radius:50%;flex-shrink:0;transform:translateY(-2px)></span><span style=font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis></span></div><div style=margin-top:4px;display:flex;gap:7px;align-items:center;flex-wrap:wrap><span style=font-size:10px></span></div><div style=display:flex;gap:5px;margin-top:8px;flex-wrap:wrap></div><div style=margin-top:8px;font-size:11.5px;line-height:1.5>调用 <!> · 失败 <!> · 最近 </div></div><div style=display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;max-width:210px><button>`), _tmpl$22 = /* @__PURE__ */ web.template(`<span style=font-size:11px>`), _tmpl$23 = /* @__PURE__ */ web.template(`<div style="padding:7px 8px 3px;font-size:10.5px;letter-spacing:0.03em">`), _tmpl$24 = /* @__PURE__ */ web.template(`<span>✓`), _tmpl$25 = /* @__PURE__ */ web.template(`<div style="display:flex;justify-content:space-between;padding:5px 8px;border-radius:5px;cursor:pointer;font-size:12px"><span>`), _tmpl$26 = /* @__PURE__ */ web.template(`<button>`), _tmpl$27 = /* @__PURE__ */ web.template(`<div style=padding:14px;font-size:11.5px;line-height:1.6>`), _tmpl$28 = /* @__PURE__ */ web.template(`<div style="display:grid;grid-template-columns:minmax(180px, 260px) 1fr;align-items:center;gap:16px;padding:10px 14px"><div><div style=font-size:12.5px></div><div style=font-size:11px;margin-top:2px> · </div></div><div style=display:flex;align-items:center;gap:10px><div style=flex:1;height:6px;border-radius:3px;overflow:hidden><div style=height:100%></div></div><span style=width:40px;text-align:right;font-size:12px>%`);
const T = {
  base: "var(--v2-text-text-base, #e6e9ef)",
  muted: "var(--v2-text-text-muted, #93a0b6)",
  weak: "var(--v2-text-text-weak, #7d8aa0)",
  faint: "var(--v2-text-text-faint, #5f6b80)",
  accent: "var(--v2-text-text-accent, #7aa2ff)",
  border: "var(--v2-border-border-muted, rgba(255,255,255,0.08))",
  borderStrong: "var(--v2-border-border-base, rgba(255,255,255,0.12))",
  layer1: "var(--v2-background-bg-layer-01, rgba(255,255,255,0.03))",
  layer2: "var(--v2-background-bg-layer-02, rgba(255,255,255,0.05))",
  btn: "var(--v2-background-bg-button-neutral, rgba(255,255,255,0.06))",
  green: "var(--v2-green-600, #4ec98d)",
  yellow: "var(--v2-yellow-600, #e0b341)",
  red: "var(--v2-red-600, #ef6f6c)",
  mono: "var(--v2-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)"
};
const TIER_GROUPS = [{
  model: "Gemini 4 Argon",
  tiers: [["argon-4-lo", "Low"], ["argon-4-med", "Medium"], ["argon-4-hi", "High"]]
}, {
  model: "Gemini 3.8 Flash",
  tiers: [["flash-3.8-lo", "Low"], ["flash-3.8-med", "Medium"], ["flash-3.8-hi", "High"]]
}, {
  model: "Claude Sonnet 5.5",
  tiers: [["claude-sonnet-5-5-lo", "Low"], ["claude-sonnet-5-5-med", "Medium"], ["claude-sonnet-5-5-hi", "High"]]
}, {
  model: "Claude Opus 5.5",
  tiers: [["claude-opus-5-5-lo", "Low"], ["claude-opus-5-5-med", "Medium"], ["claude-opus-5-5-hi", "High"]]
}, {
  model: "GPT-OSS 120B",
  tiers: [["gpt-oss-med", "Medium"]]
}];
const TIER_LABEL = Object.fromEntries(TIER_GROUPS.flatMap((g) => g.tiers.map(([id, level]) => [id, `${g.model} (${level})`])));
const MODEL_TO_TIER = {
  "gemini-4-argon-low": "argon-4-lo",
  "gemini-4-argon-medium": "argon-4-med",
  "gemini-4-argon-high": "argon-4-hi",
  "gemini-3.8-flash-low": "flash-3.8-lo",
  "gemini-3.8-flash-medium": "flash-3.8-med",
  "gemini-3.8-flash-high": "flash-3.8-hi",
  "claude-sonnet-5-5-low": "claude-sonnet-5-5-lo",
  "claude-sonnet-5-5-medium": "claude-sonnet-5-5-med",
  "claude-sonnet-5-5-high": "claude-sonnet-5-5-hi",
  "claude-opus-5-5-low": "claude-opus-5-5-lo",
  "claude-opus-5-5-medium": "claude-opus-5-5-med",
  "claude-opus-5-5-high": "claude-opus-5-5-hi",
  "gpt-oss-120b-medium": "gpt-oss-med"
};
function allowedTiers(models) {
  if (!models || models.length === 0) return null;
  const set = new Set(models.map((m) => MODEL_TO_TIER[m]).filter(Boolean));
  return set.size > 0 ? set : null;
}
const ROUTING = [["active", "固定", "始终使用所选账号"], ["sequential", "顺序", "按列表顺序，到量才换下一个"], ["roundrobin", "轮询", "优先最久未使用的账号"]];
function ago(ts, now) {
  if (!ts) return "未调用";
  const mins = Math.max(0, Math.floor((now - ts) / 6e4));
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
const label = {
  "font-size": "12px",
  color: T.muted,
  "margin-bottom": "8px",
  "letter-spacing": "0.01em"
};
const card = {
  background: T.layer1,
  border: `1px solid ${T.border}`,
  "border-radius": "10px"
};
const cardClip = {
  ...card,
  overflow: "hidden"
};
const row = {
  display: "grid",
  "grid-template-columns": "minmax(120px, 190px) 1fr",
  "align-items": "center",
  gap: "16px",
  padding: "11px 14px",
  "border-top": `1px solid ${T.border}`
};
function chip(on, text) {
  return (() => {
    var _el$ = _tmpl$();
    web.setStyleProperty(_el$, "font-weight", on ? 500 : 400);
    web.insert(_el$, text);
    web.effect((_p$) => {
      var _v$ = `1px solid ${on ? "transparent" : T.border}`, _v$2 = on ? "color-mix(in srgb, var(--v2-green-600, #4ec98d) 16%, transparent)" : T.layer2, _v$3 = on ? T.green : T.faint;
      _v$ !== _p$.e && web.setStyleProperty(_el$, "border", _p$.e = _v$);
      _v$2 !== _p$.t && web.setStyleProperty(_el$, "background", _p$.t = _v$2);
      _v$3 !== _p$.a && web.setStyleProperty(_el$, "color", _p$.a = _v$3);
      return _p$;
    }, {
      e: void 0,
      t: void 0,
      a: void 0
    });
    return _el$;
  })();
}
function btnStyle(kind = "plain") {
  if (kind === "primary") {
    return {
      "font-size": "12px",
      padding: "5px 11px",
      "border-radius": "6px",
      border: "1px solid transparent",
      background: "var(--v2-background-bg-accent, #3b5bdb)",
      color: "var(--v2-text-text-inverse, #fff)",
      cursor: "pointer"
    };
  }
  return {
    "font-size": "12px",
    padding: "5px 10px",
    "border-radius": "6px",
    border: `1px solid ${T.border}`,
    background: T.btn,
    color: kind === "danger" ? T.red : T.base,
    cursor: "pointer"
  };
}
const gui = gui$1.Plugin.define({
  setup(ctx) {
    const client = ctx.main(AgyAccounts);
    ctx.add(gui$1.SettingsPage, {
      id: "agy",
      title: "Antigravity",
      entries: [{
        id: "agy.accounts",
        title: "Antigravity 账号",
        description: "多账号、默认模型、路由与额度"
      }, {
        id: "agy.add",
        title: "添加账号",
        description: "创建独立 HOME 并登录 Google"
      }],
      render() {
        const [state, {
          refetch
        }] = solidJs.createResource(() => client.read());
        const [busy, setBusy] = solidJs.createSignal("");
        const [alias, setAlias] = solidJs.createSignal("");
        const [msg, setMsg] = solidJs.createSignal("");
        const [picker, setPicker] = solidJs.createSignal(false);
        const [now, setNow] = solidJs.createSignal(Date.now());
        const [elapsed, setElapsed] = solidJs.createSignal(0);
        const [local, setLocal] = store.createStore({
          tier: ""
        });
        solidJs.onMount(() => {
          const t = setInterval(() => setNow(Date.now()), 2e4);
          solidJs.onCleanup(() => clearInterval(t));
        });
        solidJs.createEffect(() => {
          if (busy() !== "usage") {
            setElapsed(0);
            return;
          }
          const started = Date.now();
          const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1e3)), 1e3);
          solidJs.onCleanup(() => clearInterval(t));
        });
        const allowed = solidJs.createMemo(() => {
          const s = state();
          const active = s == null ? void 0 : s.accounts.find((a) => a.id === s.activeAccountId);
          return allowedTiers(active == null ? void 0 : active.models);
        });
        const groups = solidJs.createMemo(() => TIER_GROUPS.map((g) => ({
          model: g.model,
          tiers: g.tiers.filter(([id]) => !allowed() || allowed().has(id))
        })).filter((g) => g.tiers.length > 0));
        const tierOptions = solidJs.createMemo(() => groups().flatMap((g) => g.tiers.map(([id]) => id)));
        const tier = solidJs.createMemo(() => {
          var _a;
          const wanted = local.tier || ((_a = state()) == null ? void 0 : _a.defaultTier) || "argon-4-lo";
          const opts = tierOptions();
          return opts.includes(wanted) ? wanted : opts[0] ?? wanted;
        });
        const activeAccount = solidJs.createMemo(() => {
          const s = state();
          return s == null ? void 0 : s.accounts.find((a) => a.id === s.activeAccountId);
        });
        const activeUsage = solidJs.createMemo(() => {
          var _a;
          return ((_a = activeAccount()) == null ? void 0 : _a.usage) ?? [];
        });
        let autoTried = false;
        solidJs.createEffect(() => {
          const s = state();
          if (!s || autoTried) return;
          autoTried = true;
          const acc = s.accounts.find((a) => a.id === s.activeAccountId);
          const fresh = (acc == null ? void 0 : acc.usageCheckedAt) && Date.now() - acc.usageCheckedAt < 5 * 60 * 1e3;
          if (!fresh) void run("usage", () => client.usage({
            id: s.activeAccountId
          }));
        });
        function barColor(percent) {
          if (percent >= 50) return T.green;
          if (percent >= 20) return T.yellow;
          return T.red;
        }
        function resetIn(iso, now2) {
          const t = Date.parse(iso);
          if (!Number.isFinite(t)) return iso;
          const mins = Math.round((t - now2) / 6e4);
          if (mins <= 0) return "已重置";
          if (mins < 60) return `${mins} 分钟后`;
          const hours = Math.floor(mins / 60);
          if (hours < 48) return `${hours} 小时后`;
          return `${Math.floor(hours / 24)} 天后`;
        }
        async function run(key, fn, okMsg) {
          if (busy()) return;
          setBusy(key);
          setMsg("");
          try {
            await fn();
            if (okMsg) setMsg(okMsg);
            await refetch();
          } catch (e) {
            const raw = String((e == null ? void 0 : e.message) ?? e);
            setMsg(/no method/i.test(raw) ? "需要重启一次 App：主进程的 IPC 方法只在启动时注册，热更新不会补上。" : /usage TIMEOUT/i.test(raw) ? "额度读取超时：官方 CLI 30 秒内没有返回（agy 无响应或网络慢），稍后再试。" : `失败：${raw.slice(0, 200)}`);
          } finally {
            setBusy("");
          }
        }
        return (() => {
          var _el$2 = _tmpl$3(), _el$3 = _el$2.firstChild, _el$4 = _el$3.firstChild, _el$5 = _el$4.nextSibling, _el$6 = _el$5.firstChild, _el$8 = _el$6.nextSibling, _el$9 = _el$8.nextSibling, _el$0 = _el$9.nextSibling;
          web.insert(_el$2, web.createComponent(solidJs.Show, {
            get when() {
              return state.error;
            },
            get children() {
              var _el$1 = _tmpl$2();
              _el$1.firstChild;
              web.insert(_el$1, () => String(state.error), null);
              web.effect((_$p) => web.setStyleProperty(_el$1, "color", T.red));
              return _el$1;
            }
          }), null);
          web.insert(_el$2, web.createComponent(solidJs.Show, {
            get when() {
              return state();
            },
            children: (data) => [(() => {
              var _el$11 = _tmpl$4();
              web.effect((_$p) => web.style(_el$11, {
                ...label
              }, _$p));
              return _el$11;
            })(), (() => {
              var _el$12 = _tmpl$5();
              web.insert(_el$12, web.createComponent(solidJs.For, {
                get each() {
                  return data().accounts;
                },
                children: (acc) => {
                  const left = Math.max(0, Math.ceil(((acc.cooldownUntil ?? 0) - now()) / 6e4));
                  const cooling = left > 0;
                  const isActive = acc.id === data().activeAccountId;
                  return (() => {
                    var _el$50 = _tmpl$21(), _el$51 = _el$50.firstChild, _el$52 = _el$51.firstChild, _el$53 = _el$52.firstChild, _el$54 = _el$53.nextSibling, _el$60 = _el$52.nextSibling, _el$63 = _el$60.firstChild, _el$64 = _el$60.nextSibling, _el$65 = _el$64.nextSibling, _el$66 = _el$65.firstChild, _el$73 = _el$66.nextSibling, _el$67 = _el$73.nextSibling, _el$74 = _el$67.nextSibling;
                    _el$74.nextSibling;
                    var _el$75 = _el$51.nextSibling, _el$76 = _el$75.firstChild;
                    web.insert(_el$54, () => acc.alias);
                    web.insert(_el$52, web.createComponent(solidJs.Show, {
                      when: isActive,
                      get children() {
                        var _el$55 = _tmpl$11();
                        web.effect((_$p) => web.setStyleProperty(_el$55, "color", T.accent));
                        return _el$55;
                      }
                    }), null);
                    web.insert(_el$52, web.createComponent(solidJs.Show, {
                      when: cooling,
                      get children() {
                        var _el$56 = _tmpl$12(), _el$57 = _el$56.firstChild, _el$59 = _el$57.nextSibling;
                        _el$59.nextSibling;
                        web.insert(_el$56, left, _el$59);
                        web.effect((_$p) => web.setStyleProperty(_el$56, "color", T.yellow));
                        return _el$56;
                      }
                    }), null);
                    web.insert(_el$60, web.createComponent(solidJs.Show, {
                      get when() {
                        return acc.email;
                      },
                      get fallback() {
                        return (() => {
                          var _el$81 = _tmpl$22();
                          web.insert(_el$81, () => acc.id === "system" ? "未读取到登录账号" : "未登录 · 点「登录」授权");
                          web.effect((_$p) => web.setStyleProperty(_el$81, "color", T.faint));
                          return _el$81;
                        })();
                      },
                      get children() {
                        var _el$61 = _tmpl$13();
                        web.insert(_el$61, () => acc.email);
                        web.effect((_p$) => {
                          var _v$33 = T.muted, _v$34 = `11.5px ${T.mono}`;
                          _v$33 !== _p$.e && web.setStyleProperty(_el$61, "color", _p$.e = _v$33);
                          _v$34 !== _p$.t && web.setStyleProperty(_el$61, "font", _p$.t = _v$34);
                          return _p$;
                        }, {
                          e: void 0,
                          t: void 0
                        });
                        return _el$61;
                      }
                    }), _el$63);
                    web.insert(_el$60, web.createComponent(solidJs.Show, {
                      get when() {
                        return acc.expired;
                      },
                      get children() {
                        var _el$62 = _tmpl$14();
                        web.effect((_$p) => web.setStyleProperty(_el$62, "color", T.yellow));
                        return _el$62;
                      }
                    }), _el$63);
                    web.insert(_el$63, () => acc.id);
                    web.insert(_el$64, () => chip(acc.argon, "Argon"), null);
                    web.insert(_el$64, () => chip(acc.claude, "Claude"), null);
                    web.insert(_el$64, () => chip(acc.flash, "Flash"), null);
                    web.insert(_el$65, () => acc.calls ?? 0, _el$73);
                    web.insert(_el$65, () => acc.failures ?? 0, _el$74);
                    web.insert(_el$65, () => ago(acc.lastUsedAt, now()), null);
                    web.insert(_el$65, web.createComponent(solidJs.Show, {
                      get when() {
                        return acc.checkedAt;
                      },
                      get children() {
                        var _el$69 = _tmpl$15();
                        _el$69.firstChild;
                        web.insert(_el$69, () => ago(acc.checkedAt, now()), null);
                        web.effect((_$p) => web.setStyleProperty(_el$69, "color", T.faint));
                        return _el$69;
                      }
                    }), null);
                    web.insert(_el$65, web.createComponent(solidJs.Show, {
                      get when() {
                        return acc.lastError;
                      },
                      get children() {
                        var _el$71 = _tmpl$16();
                        _el$71.firstChild;
                        web.insert(_el$71, () => acc.lastError, null);
                        web.effect((_$p) => web.setStyleProperty(_el$71, "color", T.yellow));
                        return _el$71;
                      }
                    }), null);
                    _el$76.$$click = () => run(acc.id, () => client.probe({
                      id: acc.id
                    }), "探测完成");
                    web.insert(_el$76, () => busy() === acc.id ? "探测中" : "探测");
                    web.insert(_el$75, web.createComponent(solidJs.Show, {
                      get when() {
                        return acc.home;
                      },
                      get children() {
                        var _el$77 = _tmpl$17();
                        _el$77.$$click = () => run(`login-${acc.id}`, () => client.login({
                          id: acc.id
                        }), "已打开浏览器授权");
                        web.effect((_p$) => {
                          var _v$35 = btnStyle(), _v$36 = busy() === `login-${acc.id}`;
                          _p$.e = web.style(_el$77, _v$35, _p$.e);
                          _v$36 !== _p$.t && (_el$77.disabled = _p$.t = _v$36);
                          return _p$;
                        }, {
                          e: void 0,
                          t: void 0
                        });
                        return _el$77;
                      }
                    }), null);
                    web.insert(_el$75, web.createComponent(solidJs.Show, {
                      when: cooling,
                      get children() {
                        var _el$78 = _tmpl$18();
                        _el$78.$$click = () => run(`cd-${acc.id}`, () => client.clearCooldown({
                          id: acc.id
                        }), "已解除冷却");
                        web.effect((_$p) => web.style(_el$78, btnStyle(), _$p));
                        return _el$78;
                      }
                    }), null);
                    web.insert(_el$75, web.createComponent(solidJs.Show, {
                      get when() {
                        return acc.id !== "system";
                      },
                      get children() {
                        return [web.createComponent(solidJs.Show, {
                          when: !isActive,
                          get children() {
                            var _el$79 = _tmpl$19();
                            _el$79.$$click = () => run(acc.id, () => client.setActive({
                              id: acc.id
                            }), "已切换默认账号");
                            web.effect((_$p) => web.style(_el$79, btnStyle(), _$p));
                            return _el$79;
                          }
                        }), (() => {
                          var _el$80 = _tmpl$20();
                          _el$80.$$click = () => run(acc.id, () => client.remove({
                            id: acc.id
                          }), "已删除");
                          web.effect((_$p) => web.style(_el$80, btnStyle("danger"), _$p));
                          return _el$80;
                        })()];
                      }
                    }), null);
                    web.effect((_p$) => {
                      var _v$37 = acc === data().accounts[0] ? "none" : `1px solid ${T.border}`, _v$38 = isActive ? T.layer2 : "transparent", _v$39 = cooling ? T.yellow : isActive ? T.green : T.faint, _v$40 = T.faint, _v$41 = acc.id, _v$42 = T.weak, _v$43 = btnStyle(), _v$44 = busy() === acc.id;
                      _v$37 !== _p$.e && web.setStyleProperty(_el$50, "border-top", _p$.e = _v$37);
                      _v$38 !== _p$.t && web.setStyleProperty(_el$50, "background", _p$.t = _v$38);
                      _v$39 !== _p$.a && web.setStyleProperty(_el$53, "background", _p$.a = _v$39);
                      _v$40 !== _p$.o && web.setStyleProperty(_el$63, "color", _p$.o = _v$40);
                      _v$41 !== _p$.i && web.setAttribute(_el$63, "title", _p$.i = _v$41);
                      _v$42 !== _p$.n && web.setStyleProperty(_el$65, "color", _p$.n = _v$42);
                      _p$.s = web.style(_el$76, _v$43, _p$.s);
                      _v$44 !== _p$.h && (_el$76.disabled = _p$.h = _v$44);
                      return _p$;
                    }, {
                      e: void 0,
                      t: void 0,
                      a: void 0,
                      o: void 0,
                      i: void 0,
                      n: void 0,
                      s: void 0,
                      h: void 0
                    });
                    return _el$50;
                  })();
                }
              }));
              web.effect((_$p) => web.style(_el$12, cardClip, _$p));
              return _el$12;
            })(), (() => {
              var _el$13 = _tmpl$6(), _el$14 = _el$13.firstChild, _el$15 = _el$14.nextSibling;
              _el$14.$$input = (e) => setAlias(e.currentTarget.value);
              _el$15.$$click = () => void run("add", () => client.add({
                alias: alias()
              }), "已创建，点该账号的「登录」完成授权").then(() => setAlias(""));
              web.effect((_p$) => {
                var _v$0 = `1px solid ${T.border}`, _v$1 = T.layer1, _v$10 = T.base, _v$11 = btnStyle("primary"), _v$12 = busy() === "add";
                _v$0 !== _p$.e && web.setStyleProperty(_el$14, "border", _p$.e = _v$0);
                _v$1 !== _p$.t && web.setStyleProperty(_el$14, "background", _p$.t = _v$1);
                _v$10 !== _p$.a && web.setStyleProperty(_el$14, "color", _p$.a = _v$10);
                _p$.o = web.style(_el$15, _v$11, _p$.o);
                _v$12 !== _p$.i && (_el$15.disabled = _p$.i = _v$12);
                return _p$;
              }, {
                e: void 0,
                t: void 0,
                a: void 0,
                o: void 0,
                i: void 0
              });
              web.effect(() => _el$14.value = alias());
              return _el$13;
            })(), (() => {
              var _el$16 = _tmpl$7();
              web.effect((_$p) => web.style(_el$16, {
                ...label
              }, _$p));
              return _el$16;
            })(), (() => {
              var _el$17 = _tmpl$9(), _el$18 = _el$17.firstChild, _el$19 = _el$18.firstChild, _el$20 = _el$19.firstChild, _el$21 = _el$20.nextSibling, _el$22 = _el$19.nextSibling, _el$23 = _el$22.firstChild, _el$24 = _el$23.firstChild, _el$26 = _el$18.nextSibling, _el$27 = _el$26.firstChild, _el$28 = _el$27.firstChild, _el$29 = _el$28.nextSibling, _el$30 = _el$27.nextSibling, _el$31 = _el$26.nextSibling, _el$32 = _el$31.firstChild, _el$33 = _el$32.firstChild, _el$34 = _el$33.nextSibling, _el$35 = _el$32.nextSibling, _el$36 = _el$35.firstChild, _el$37 = _el$36.nextSibling;
              _el$23.$$click = () => setPicker((v) => !v);
              web.insert(_el$23, () => TIER_LABEL[tier()] ?? tier(), _el$24);
              web.insert(_el$23, () => picker() ? "▴" : "▾", null);
              web.insert(_el$22, web.createComponent(solidJs.Show, {
                get when() {
                  return picker();
                },
                get children() {
                  var _el$25 = _tmpl$8();
                  web.insert(_el$25, web.createComponent(solidJs.For, {
                    get each() {
                      return groups();
                    },
                    children: (g) => [(() => {
                      var _el$82 = _tmpl$23();
                      web.insert(_el$82, () => g.model);
                      web.effect((_$p) => web.setStyleProperty(_el$82, "color", T.faint));
                      return _el$82;
                    })(), web.createComponent(solidJs.For, {
                      get each() {
                        return g.tiers;
                      },
                      children: ([id, level]) => (() => {
                        var _el$83 = _tmpl$25(), _el$84 = _el$83.firstChild;
                        _el$83.$$click = () => {
                          setPicker(false);
                          setLocal("tier", id);
                          void run("tier", () => client.setDefaultTier({
                            tier: id
                          }), "默认档位已保存");
                        };
                        web.setAttribute(_el$83, "data-tier", id);
                        web.insert(_el$84, level);
                        web.insert(_el$83, web.createComponent(solidJs.Show, {
                          get when() {
                            return id === tier();
                          },
                          get children() {
                            var _el$85 = _tmpl$24();
                            web.effect((_$p) => web.setStyleProperty(_el$85, "color", T.accent));
                            return _el$85;
                          }
                        }), null);
                        web.effect((_p$) => {
                          var _v$45 = id === tier() ? T.layer2 : "transparent", _v$46 = id === tier() ? T.base : T.muted;
                          _v$45 !== _p$.e && web.setStyleProperty(_el$83, "background", _p$.e = _v$45);
                          _v$46 !== _p$.t && web.setStyleProperty(_el$83, "color", _p$.t = _v$46);
                          return _p$;
                        }, {
                          e: void 0,
                          t: void 0
                        });
                        return _el$83;
                      })()
                    })]
                  }));
                  web.effect((_$p) => web.setStyleProperty(_el$25, "border", `1px solid ${T.borderStrong}`));
                  return _el$25;
                }
              }), null);
              web.insert(_el$29, () => {
                var _a;
                return ((_a = ROUTING.find(([v]) => v === data().routing)) == null ? void 0 : _a[2]) ?? "";
              });
              web.insert(_el$30, web.createComponent(solidJs.For, {
                each: ROUTING,
                children: ([value, text]) => (() => {
                  var _el$86 = _tmpl$26();
                  _el$86.$$click = () => run("routing", () => client.setRouting({
                    routing: value
                  }), "路由策略已保存");
                  web.insert(_el$86, text);
                  web.effect((_$p) => web.style(_el$86, {
                    ...btnStyle(),
                    "border-color": data().routing === value ? T.accent : T.border,
                    background: data().routing === value ? "color-mix(in srgb, var(--v2-blue-600, #3b5bdb) 18%, transparent)" : T.btn,
                    color: data().routing === value ? T.base : T.muted
                  }, _$p));
                  return _el$86;
                })()
              }));
              _el$36.addEventListener("change", (e) => {
                const minutes = Number(e.currentTarget.value);
                if (!Number.isFinite(minutes) || minutes < 1) return;
                void run("cooldown", () => client.setCooldown({
                  minutes
                }), "已保存");
              });
              web.effect((_p$) => {
                var _v$13 = card, _v$14 = {
                  ...row
                }, _v$15 = T.faint, _v$16 = {
                  ...btnStyle()
                }, _v$17 = row, _v$18 = T.faint, _v$19 = row, _v$20 = T.faint, _v$21 = `1px solid ${T.border}`, _v$22 = T.layer1, _v$23 = T.base, _v$24 = T.faint;
                _p$.e = web.style(_el$17, _v$13, _p$.e);
                _p$.t = web.style(_el$18, _v$14, _p$.t);
                _v$15 !== _p$.a && web.setStyleProperty(_el$21, "color", _p$.a = _v$15);
                _p$.o = web.style(_el$23, _v$16, _p$.o);
                _p$.i = web.style(_el$26, _v$17, _p$.i);
                _v$18 !== _p$.n && web.setStyleProperty(_el$29, "color", _p$.n = _v$18);
                _p$.s = web.style(_el$31, _v$19, _p$.s);
                _v$20 !== _p$.h && web.setStyleProperty(_el$34, "color", _p$.h = _v$20);
                _v$21 !== _p$.r && web.setStyleProperty(_el$36, "border", _p$.r = _v$21);
                _v$22 !== _p$.d && web.setStyleProperty(_el$36, "background", _p$.d = _v$22);
                _v$23 !== _p$.l && web.setStyleProperty(_el$36, "color", _p$.l = _v$23);
                _v$24 !== _p$.u && web.setStyleProperty(_el$37, "color", _p$.u = _v$24);
                return _p$;
              }, {
                e: void 0,
                t: void 0,
                a: void 0,
                o: void 0,
                i: void 0,
                n: void 0,
                s: void 0,
                h: void 0,
                r: void 0,
                d: void 0,
                l: void 0,
                u: void 0
              });
              web.effect(() => _el$36.value = Math.round((data().cooldownMs ?? 9e5) / 6e4));
              return _el$17;
            })(), (() => {
              var _el$38 = _tmpl$0(), _el$39 = _el$38.firstChild, _el$40 = _el$39.firstChild, _el$41 = _el$40.nextSibling, _el$42 = _el$41.firstChild, _el$43 = _el$42.nextSibling, _el$44 = _el$39.nextSibling;
              web.insert(_el$41, (() => {
                var _c$ = web.memo(() => {
                  var _a;
                  return !!((_a = activeAccount()) == null ? void 0 : _a.usageCheckedAt);
                });
                return () => _c$() ? ` · ${ago(activeAccount().usageCheckedAt, now())}` : "";
              })(), null);
              _el$44.$$click = () => run("usage", () => client.usage({
                id: data().activeAccountId
              }), "额度已刷新");
              web.insert(_el$44, (() => {
                var _c$2 = web.memo(() => busy() === "usage");
                return () => _c$2() ? `读取中 ${elapsed()}s` : "刷新";
              })());
              web.effect((_p$) => {
                var _v$25 = {
                  ...label
                }, _v$26 = T.faint, _v$27 = `11px ${T.mono}`, _v$28 = btnStyle(), _v$29 = busy() === "usage";
                _p$.e = web.style(_el$38, _v$25, _p$.e);
                _v$26 !== _p$.t && web.setStyleProperty(_el$41, "color", _p$.t = _v$26);
                _v$27 !== _p$.a && web.setStyleProperty(_el$43, "font", _p$.a = _v$27);
                _p$.o = web.style(_el$44, _v$28, _p$.o);
                _v$29 !== _p$.i && (_el$44.disabled = _p$.i = _v$29);
                return _p$;
              }, {
                e: void 0,
                t: void 0,
                a: void 0,
                o: void 0,
                i: void 0
              });
              return _el$38;
            })(), (() => {
              var _el$45 = _tmpl$5();
              web.insert(_el$45, web.createComponent(solidJs.Show, {
                get when() {
                  return activeUsage().length > 0;
                },
                get fallback() {
                  return (() => {
                    var _el$87 = _tmpl$27();
                    web.insert(_el$87, (() => {
                      var _c$3 = web.memo(() => busy() === "usage");
                      return () => _c$3() ? `正在向官方 CLI 读取… 已等待 ${elapsed()} 秒（最长 30 秒，超时会自动停止）` : "暂无数据，点右上角「刷新」读取。官方 CLI 首次读取通常要 10–30 秒。";
                    })());
                    web.effect((_$p) => web.setStyleProperty(_el$87, "color", T.muted));
                    return _el$87;
                  })();
                },
                get children() {
                  return web.createComponent(solidJs.For, {
                    get each() {
                      return activeUsage();
                    },
                    children: (u, i) => (() => {
                      var _el$88 = _tmpl$28(), _el$89 = _el$88.firstChild, _el$90 = _el$89.firstChild, _el$91 = _el$90.nextSibling, _el$92 = _el$91.firstChild, _el$93 = _el$89.nextSibling, _el$94 = _el$93.firstChild, _el$95 = _el$94.firstChild, _el$96 = _el$94.nextSibling, _el$97 = _el$96.firstChild;
                      web.insert(_el$90, () => u.label);
                      web.insert(_el$91, () => u.group, _el$92);
                      web.insert(_el$91, () => resetIn(u.resetAt, now()), null);
                      web.insert(_el$96, () => u.percent, _el$97);
                      web.effect((_p$) => {
                        var _v$47 = i() === 0 ? "none" : `1px solid ${T.border}`, _v$48 = T.faint, _v$49 = T.layer2, _v$50 = `${Math.max(0, Math.min(100, u.percent))}%`, _v$51 = barColor(u.percent), _v$52 = u.percent >= 20 ? T.base : T.red, _v$53 = `12px ${T.mono}`;
                        _v$47 !== _p$.e && web.setStyleProperty(_el$88, "border-top", _p$.e = _v$47);
                        _v$48 !== _p$.t && web.setStyleProperty(_el$91, "color", _p$.t = _v$48);
                        _v$49 !== _p$.a && web.setStyleProperty(_el$94, "background", _p$.a = _v$49);
                        _v$50 !== _p$.o && web.setStyleProperty(_el$95, "width", _p$.o = _v$50);
                        _v$51 !== _p$.i && web.setStyleProperty(_el$95, "background", _p$.i = _v$51);
                        _v$52 !== _p$.n && web.setStyleProperty(_el$96, "color", _p$.n = _v$52);
                        _v$53 !== _p$.s && web.setStyleProperty(_el$96, "font", _p$.s = _v$53);
                        return _p$;
                      }, {
                        e: void 0,
                        t: void 0,
                        a: void 0,
                        o: void 0,
                        i: void 0,
                        n: void 0,
                        s: void 0
                      });
                      return _el$88;
                    })()
                  });
                }
              }), null);
              web.insert(_el$45, web.createComponent(solidJs.Show, {
                get when() {
                  return web.memo(() => {
                    var _a;
                    return !!((_a = activeAccount()) == null ? void 0 : _a.usageError);
                  })() && busy() !== "usage";
                },
                get children() {
                  var _el$46 = _tmpl$1(), _el$47 = _el$46.firstChild, _el$48 = _el$47.nextSibling;
                  web.insert(_el$46, () => activeAccount().usageError, _el$48);
                  web.effect((_p$) => {
                    var _v$30 = `1px solid ${T.border}`, _v$31 = T.yellow, _v$32 = T.faint;
                    _v$30 !== _p$.e && web.setStyleProperty(_el$46, "border-top", _p$.e = _v$30);
                    _v$31 !== _p$.t && web.setStyleProperty(_el$46, "color", _p$.t = _v$31);
                    _v$32 !== _p$.a && web.setStyleProperty(_el$48, "color", _p$.a = _v$32);
                    return _p$;
                  }, {
                    e: void 0,
                    t: void 0,
                    a: void 0
                  });
                  return _el$46;
                }
              }), null);
              web.effect((_$p) => web.style(_el$45, card, _$p));
              return _el$45;
            })(), web.createComponent(solidJs.Show, {
              get when() {
                return msg();
              },
              get children() {
                var _el$49 = _tmpl$10();
                web.insert(_el$49, msg);
                web.effect((_$p) => web.setStyleProperty(_el$49, "color", T.muted));
                return _el$49;
              }
            })]
          }), null);
          web.effect((_p$) => {
            var _v$4 = T.base, _v$5 = T.muted, _v$6 = `11.5px ${T.mono}`, _v$7 = T.accent, _v$8 = `11.5px ${T.mono}`, _v$9 = T.accent;
            _v$4 !== _p$.e && web.setStyleProperty(_el$2, "color", _p$.e = _v$4);
            _v$5 !== _p$.t && web.setStyleProperty(_el$5, "color", _p$.t = _v$5);
            _v$6 !== _p$.a && web.setStyleProperty(_el$8, "font", _p$.a = _v$6);
            _v$7 !== _p$.o && web.setStyleProperty(_el$8, "color", _p$.o = _v$7);
            _v$8 !== _p$.i && web.setStyleProperty(_el$0, "font", _p$.i = _v$8);
            _v$9 !== _p$.n && web.setStyleProperty(_el$0, "color", _p$.n = _v$9);
            return _p$;
          }, {
            e: void 0,
            t: void 0,
            a: void 0,
            o: void 0,
            i: void 0,
            n: void 0
          });
          return _el$2;
        })();
      }
    });
  },
  async main(ctx) {
    const accounts$1 = await Promise.resolve().then(() => accounts);
    function snapshot() {
      const data = accounts$1.loadAccounts();
      const enriched = data.accounts.map((a) => {
        const ident = accounts$1.readIdentity(a);
        return {
          ...a,
          email: ident.email ?? a.email,
          name: ident.name ?? a.name,
          loggedIn: ident.loggedIn,
          expired: ident.expired === true
        };
      });
      return {
        activeAccountId: data.activeAccountId,
        defaultTier: data.defaultTier,
        routing: data.routing,
        cooldownMs: data.cooldownMs,
        accounts: enriched
      };
    }
    ctx.provide(AgyAccounts, {
      read: async () => snapshot(),
      add: async ({
        alias
      }) => accounts$1.createAccount(alias),
      remove: async ({
        id,
        purgeHome
      }) => accounts$1.removeAccount(id, purgeHome === true),
      probe: async ({
        id
      }) => {
        const data = accounts$1.loadAccounts();
        const acc = data.accounts.find((a) => a.id === id);
        if (!acc) throw new Error(`账号不存在：${id}`);
        const result = await accounts$1.probeAccount(acc);
        const next = accounts$1.loadAccounts();
        const target = next.accounts.find((a) => a.id === id);
        if (target) {
          target.argon = result.argon;
          target.claude = result.claude;
          target.flash = result.flash;
          target.models = result.models;
          target.checkedAt = Date.now();
          target.error = result.ok ? void 0 : result.error;
          const ident = accounts$1.readIdentity(target);
          target.email = ident.email ?? target.email;
          target.name = ident.name ?? target.name;
          accounts$1.saveAccounts(next);
        }
        return accounts$1.loadAccounts().accounts.find((a) => a.id === id);
      },
      setActive: async ({
        id
      }) => {
        const data = accounts$1.loadAccounts();
        if (!data.accounts.some((a) => a.id === id)) return false;
        data.activeAccountId = id;
        accounts$1.saveAccounts(data);
        return true;
      },
      usage: async ({
        id
      }) => {
        const data = accounts$1.loadAccounts();
        const acc = data.accounts.find((a) => a.id === id);
        if (!acc) throw new Error(`账号不存在：${id}`);
        let rows;
        try {
          rows = await accounts$1.fetchUsage(acc);
        } catch (err) {
          const next2 = accounts$1.loadAccounts();
          const target2 = next2.accounts.find((a) => a.id === id);
          if (target2) {
            target2.usageCheckedAt = Date.now();
            target2.usageError = String((err == null ? void 0 : err.message) ?? err).slice(0, 200);
            accounts$1.saveAccounts(next2);
          }
          throw err;
        }
        const next = accounts$1.loadAccounts();
        const target = next.accounts.find((a) => a.id === id);
        if (target) {
          target.usage = rows;
          target.usageCheckedAt = Date.now();
          target.usageError = void 0;
          accounts$1.saveAccounts(next);
        }
        return accounts$1.loadAccounts().accounts.find((a) => a.id === id);
      },
      setDefaultTier: async ({
        tier
      }) => {
        const data = accounts$1.loadAccounts();
        data.defaultTier = tier;
        accounts$1.saveAccounts(data);
        return true;
      },
      setRouting: async ({
        routing
      }) => {
        const data = accounts$1.loadAccounts();
        if (!["active", "sequential", "roundrobin"].includes(routing)) return false;
        data.routing = routing;
        accounts$1.saveAccounts(data);
        return true;
      },
      setCooldown: async ({
        minutes
      }) => {
        const data = accounts$1.loadAccounts();
        data.cooldownMs = Math.max(6e4, Math.min(240, minutes) * 6e4);
        accounts$1.saveAccounts(data);
        return true;
      },
      clearCooldown: async ({
        id
      }) => {
        const data = accounts$1.loadAccounts();
        const acc = data.accounts.find((a) => a.id === id);
        if (!acc) return false;
        acc.cooldownUntil = void 0;
        accounts$1.saveAccounts(data);
        return true;
      },
      resetUsage: async ({
        id
      }) => {
        const data = accounts$1.loadAccounts();
        const acc = data.accounts.find((a) => a.id === id);
        if (!acc) return false;
        acc.calls = 0;
        acc.failures = 0;
        acc.lastError = void 0;
        acc.lastUsedAt = void 0;
        accounts$1.saveAccounts(data);
        return true;
      },
      login: async ({
        id
      }) => {
        const data = accounts$1.loadAccounts();
        const acc = data.accounts.find((a) => a.id === id);
        if (!acc) return false;
        const {
          spawn
        } = await import("node:child_process");
        const env = {
          ...process.env,
          ...accounts$1.accountEnv(acc)
        };
        const child = spawn("agy", ["acp", "--login"], {
          env,
          detached: true,
          stdio: "ignore",
          shell: true,
          windowsHide: true
        });
        child.unref();
        return true;
      }
    });
  }
});
web.delegateEvents(["input", "click"]);
const SYSTEM_ACCOUNT_ID = "system";
const DEFAULT_FILE = {
  version: 1,
  activeAccountId: SYSTEM_ACCOUNT_ID,
  defaultTier: "argon-4-lo",
  routing: "active",
  cooldownMs: 15 * 60 * 1e3,
  accounts: [
    {
      id: SYSTEM_ACCOUNT_ID,
      alias: "系统账号（agy 已登录）",
      home: "",
      enabled: true,
      createdAt: 0
    }
  ]
};
function stateDir() {
  return node_path.join(node_os.homedir(), ".config", "opencode", "agy");
}
function accountsFile() {
  return node_path.join(stateDir(), "accounts.json");
}
function accountHome(id) {
  return node_path.join(stateDir(), "accounts", id);
}
function loadAccounts() {
  const file = accountsFile();
  try {
    if (!node_fs.existsSync(file)) {
      node_fs.mkdirSync(stateDir(), { recursive: true });
      node_fs.writeFileSync(file, JSON.stringify(DEFAULT_FILE, null, 2), "utf8");
      return structuredClone(DEFAULT_FILE);
    }
    const parsed = JSON.parse(node_fs.readFileSync(file, "utf8"));
    if (!parsed || !Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
      return structuredClone(DEFAULT_FILE);
    }
    return {
      version: 1,
      activeAccountId: parsed.activeAccountId ?? SYSTEM_ACCOUNT_ID,
      defaultTier: parsed.defaultTier ?? "argon-4-lo",
      routing: parsed.routing ?? "active",
      cooldownMs: typeof parsed.cooldownMs === "number" ? parsed.cooldownMs : 15 * 60 * 1e3,
      accounts: parsed.accounts
    };
  } catch {
    return structuredClone(DEFAULT_FILE);
  }
}
function saveAccounts(data) {
  node_fs.mkdirSync(stateDir(), { recursive: true });
  node_fs.writeFileSync(accountsFile(), JSON.stringify(data, null, 2), "utf8");
}
function inCooldown(account, now = Date.now()) {
  return typeof account.cooldownUntil === "number" && account.cooldownUntil > now;
}
function pickAccount(data = loadAccounts(), now = Date.now()) {
  const enabled = data.accounts.filter((a) => a.enabled);
  const pool = enabled.length > 0 ? enabled : data.accounts;
  const ready = pool.filter((a) => !inCooldown(a, now));
  if (ready.length === 0) {
    return [...pool].sort((a, b) => (a.cooldownUntil ?? 0) - (b.cooldownUntil ?? 0))[0];
  }
  if (data.routing === "sequential") return ready[0];
  if (data.routing === "roundrobin") {
    return [...ready].sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))[0];
  }
  const active = ready.find((a) => a.id === data.activeAccountId);
  return active ?? ready[0];
}
function resolveActiveAccount(data = loadAccounts()) {
  return pickAccount(data);
}
const COOLDOWN_CODES = /* @__PURE__ */ new Set(["QUOTA_EXHAUSTED", "AUTH_REQUIRED"]);
function recordResult(id, outcome) {
  const data = loadAccounts();
  const acc = data.accounts.find((a) => a.id === id);
  if (!acc) return;
  acc.calls = (acc.calls ?? 0) + 1;
  acc.lastUsedAt = Date.now();
  if (!outcome.ok) {
    acc.failures = (acc.failures ?? 0) + 1;
    acc.lastError = outcome.code ?? "UNEXPECTED";
    if (outcome.code && COOLDOWN_CODES.has(outcome.code)) {
      acc.cooldownUntil = Date.now() + data.cooldownMs;
    }
  }
  saveAccounts(data);
}
function accountEnv(account) {
  if (!account.home) return {};
  return {
    HOME: account.home,
    USERPROFILE: account.home,
    APPDATA: node_path.join(account.home, "AppData", "Roaming"),
    LOCALAPPDATA: node_path.join(account.home, "AppData", "Local")
  };
}
function accountTokenPath(account) {
  const base = account.home || node_os.homedir();
  return node_path.join(base, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}
function jwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
function readIdentity(account) {
  var _a, _b;
  const file = accountTokenPath(account);
  if (!node_fs.existsSync(file)) return { loggedIn: false };
  try {
    const data = JSON.parse(node_fs.readFileSync(file, "utf8"));
    const access = (_a = data == null ? void 0 : data.token) == null ? void 0 : _a.access_token;
    const payload = jwtPayload(data == null ? void 0 : data.id_token) ?? jwtPayload(access);
    const expiry = typeof ((_b = data == null ? void 0 : data.token) == null ? void 0 : _b.expiry) === "string" ? Date.parse(data.token.expiry) : NaN;
    return {
      email: typeof (payload == null ? void 0 : payload.email) === "string" ? payload.email : void 0,
      name: typeof (payload == null ? void 0 : payload.name) === "string" ? payload.name : void 0,
      loggedIn: typeof access === "string" && access.length > 0,
      expired: Number.isFinite(expiry) ? expiry < Date.now() : void 0
    };
  } catch {
    return { loggedIn: false };
  }
}
function killTree(child, signal) {
  if (process.platform === "win32" && child.pid) {
    try {
      node_child_process.spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      });
      return;
    } catch {
    }
  }
  try {
    child.kill(signal ?? "SIGKILL");
  } catch {
  }
}
function probeAccount(account, timeoutMs = 9e4) {
  return new Promise((resolve) => {
    var _a, _b;
    const env = { ...process.env, ...accountEnv(account) };
    let out = "";
    let err = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let child;
    try {
      child = node_child_process.spawn("agy", ["models"], { env, shell: true, windowsHide: true });
    } catch (e) {
      finish({ ok: false, models: [], argon: false, claude: false, flash: false, error: String((e == null ? void 0 : e.message) ?? e) });
      return;
    }
    const timer = setTimeout(() => {
      killTree(child);
      finish({ ok: false, models: [], argon: false, claude: false, flash: false, error: "TIMEOUT" });
    }, timeoutMs);
    (_a = child.stdout) == null ? void 0 : _a.on("data", (b) => out += String(b));
    (_b = child.stderr) == null ? void 0 : _b.on("data", (b) => err += String(b));
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, models: [], argon: false, claude: false, flash: false, error: String((e == null ? void 0 : e.message) ?? e) });
    });
    child.on("close", () => {
      clearTimeout(timer);
      const models = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[a-z0-9][a-z0-9.\-]*\t/i.test(l)).map((l) => l.split("	")[0].trim());
      if (models.length === 0) {
        finish({
          ok: false,
          models: [],
          argon: false,
          claude: false,
          flash: false,
          error: (err || out).trim().slice(0, 300) || "EMPTY"
        });
        return;
      }
      finish({
        ok: true,
        models,
        argon: models.some((m) => m.startsWith("gemini-4-argon")),
        claude: models.some((m) => m.startsWith("claude-")),
        flash: models.some((m) => m.startsWith("gemini-3.8-flash"))
      });
    });
  });
}
function fetchUsage(account, timeoutMs = 3e4) {
  return new Promise((resolve, reject) => {
    var _a, _b;
    const env = { ...process.env, ...accountEnv(account) };
    let out = "";
    let err = "";
    let done = false;
    let child;
    try {
      child = node_child_process.spawn("agy", ["--print=/usage"], { env, shell: true, windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      killTree(child);
      if (!done) {
        done = true;
        reject(new Error("usage TIMEOUT"));
      }
    }, timeoutMs);
    (_a = child.stdout) == null ? void 0 : _a.on("data", (b) => out += String(b));
    (_b = child.stderr) == null ? void 0 : _b.on("data", (b) => err += String(b));
    child.on("error", (e) => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        reject(e);
      }
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      const rows = out.split(/\r?\n/).map((l) => l.split("	").map((c) => c.trim())).filter((c) => c.length >= 4 && /^\d+%$/.test(c[2])).map((c) => ({
        group: c[0],
        label: c[1],
        percent: Number(c[2].replace("%", "")),
        resetAt: c[3]
      }));
      if (rows.length === 0) {
        reject(new Error((err || out).trim().slice(0, 300) || "usage EMPTY"));
        return;
      }
      resolve(rows);
    });
  });
}
function createAccount(alias) {
  const id = `acc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const home = accountHome(id);
  node_fs.mkdirSync(node_path.join(home, ".gemini"), { recursive: true });
  node_fs.mkdirSync(node_path.join(home, "AppData", "Roaming"), { recursive: true });
  node_fs.mkdirSync(node_path.join(home, "AppData", "Local"), { recursive: true });
  const data = loadAccounts();
  const account = {
    id,
    alias: alias.trim() || `账号 ${data.accounts.length + 1}`,
    home,
    enabled: true,
    createdAt: Date.now()
  };
  data.accounts.push(account);
  saveAccounts(data);
  return account;
}
function removeAccount(id, purgeHome = false) {
  if (id === SYSTEM_ACCOUNT_ID) return false;
  const data = loadAccounts();
  const target = data.accounts.find((a) => a.id === id);
  if (!target) return false;
  data.accounts = data.accounts.filter((a) => a.id !== id);
  if (data.activeAccountId === id) data.activeAccountId = SYSTEM_ACCOUNT_ID;
  saveAccounts(data);
  if (purgeHome && target.home) {
    try {
      node_fs.rmSync(target.home, { recursive: true, force: true });
    } catch {
    }
  }
  return true;
}
const accounts = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  SYSTEM_ACCOUNT_ID,
  accountEnv,
  accountHome,
  accountTokenPath,
  accountsFile,
  createAccount,
  fetchUsage,
  inCooldown,
  loadAccounts,
  pickAccount,
  probeAccount,
  readIdentity,
  recordResult,
  removeAccount,
  resolveActiveAccount,
  saveAccounts,
  stateDir
}, Symbol.toStringTag, { value: "Module" }));
exports.default = gui;
