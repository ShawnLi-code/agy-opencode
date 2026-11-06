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
  usageCheckedAt: Effect__namespace.Schema.optional(Effect__namespace.Schema.Number)
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
var _tmpl$ = /* @__PURE__ */ web.template(`<span style="font-size:11px;line-height:18px;padding:0 7px;border-radius:5px">`), _tmpl$2 = /* @__PURE__ */ web.template(`<div style=margin-bottom:14px;font-size:12px>读取失败：`), _tmpl$3 = /* @__PURE__ */ web.template(`<div style="padding:22px 26px 40px;font-size:13px;max-width:900px"><div style=margin-bottom:22px><h1 style="font-size:16px;font-weight:600;margin:0 0 6px">Antigravity</h1><p style=margin:0;line-height:1.55;font-size:12.5px>把 <code>agy</code> 当子 agent 调用。每个账号用独立 HOME 目录隔离凭证，互不影响。`), _tmpl$4 = /* @__PURE__ */ web.template(`<div style=margin-top:26px>账号`), _tmpl$5 = /* @__PURE__ */ web.template(`<div>`), _tmpl$6 = /* @__PURE__ */ web.template(`<div style=display:flex;gap:8px;margin-top:10px><input placeholder="新账号备注，例如「备用 Google 账号」"style="flex:1;font-size:12px;padding:6px 10px;border-radius:6px;outline:none"><button>添加账号`), _tmpl$7 = /* @__PURE__ */ web.template(`<div style=margin-top:26px>调用设置`), _tmpl$8 = /* @__PURE__ */ web.template(`<div style="position:absolute;top:calc(100% + 6px);left:0;z-index:50;min-width:260px;max-height:320px;overflow-y:auto;background:var(--v2-background-bg-base, #16191f);border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,0.5);padding:6px">`), _tmpl$9 = /* @__PURE__ */ web.template(`<div><div style=border-top:none><div><div style=font-size:12.5px>默认档位</div><div style=font-size:11px;margin-top:2px>未指定 tier 时使用</div></div><div style=position:relative;justify-self:start><button style=min-width:250px;text-align:left> </button></div></div><div><div><div style=font-size:12.5px>路由策略</div><div style=font-size:11px;margin-top:2px></div></div><div style=display:flex;gap:4px;justify-self:start></div></div><div><div><div style=font-size:12.5px>冷却时长</div><div style=font-size:11px;margin-top:2px>配额或未授权时暂停该账号</div></div><div style=display:flex;align-items:center;gap:8px;justify-self:start><input type=number min=1 max=240 style="width:64px;font-size:12px;padding:5px 8px;border-radius:6px;outline:none"><span style=font-size:11.5px>分钟`), _tmpl$0 = /* @__PURE__ */ web.template(`<div style=margin-top:26px;display:flex;align-items:center;justify-content:space-between><span>额度<span style=margin-left:8px;font-size:11px>来自 <code>agy --print=/usage</code></span></span><button>`), _tmpl$1 = /* @__PURE__ */ web.template(`<div style=margin-top:14px;font-size:11.5px>`), _tmpl$10 = /* @__PURE__ */ web.template(`<span style=font-size:10.5px;flex-shrink:0>默认`), _tmpl$11 = /* @__PURE__ */ web.template(`<span style=font-size:11px;flex-shrink:0>冷却剩 <!> 分`), _tmpl$12 = /* @__PURE__ */ web.template(`<span> · 探测 `), _tmpl$13 = /* @__PURE__ */ web.template(`<span> · 上次 `), _tmpl$14 = /* @__PURE__ */ web.template(`<button>登录`), _tmpl$15 = /* @__PURE__ */ web.template(`<button>解除`), _tmpl$16 = /* @__PURE__ */ web.template(`<button>设为默认`), _tmpl$17 = /* @__PURE__ */ web.template(`<button>删除`), _tmpl$18 = /* @__PURE__ */ web.template(`<div style="display:flex;align-items:flex-start;gap:14px;padding:12px 14px"><div style=min-width:0;flex:1><div style=display:flex;align-items:baseline;gap:8px;min-width:0><span style=width:6px;height:6px;border-radius:50%;flex-shrink:0;transform:translateY(-2px)></span><span style=font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis></span></div><div style=font-size:10.5px;margin-top:3px></div><div style=display:flex;gap:5px;margin-top:8px;flex-wrap:wrap></div><div style=margin-top:8px;font-size:11.5px;line-height:1.5>调用 <!> · 失败 <!> · 最近 </div></div><div style=display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;max-width:210px><button>`), _tmpl$19 = /* @__PURE__ */ web.template(`<div style="padding:7px 8px 3px;font-size:10.5px;letter-spacing:0.03em">`), _tmpl$20 = /* @__PURE__ */ web.template(`<span>✓`), _tmpl$21 = /* @__PURE__ */ web.template(`<div style="display:flex;justify-content:space-between;padding:5px 8px;border-radius:5px;cursor:pointer;font-size:12px"><span>`), _tmpl$22 = /* @__PURE__ */ web.template(`<button>`), _tmpl$23 = /* @__PURE__ */ web.template(`<div style=padding:14px;font-size:11.5px>`), _tmpl$24 = /* @__PURE__ */ web.template(`<div style="display:grid;grid-template-columns:minmax(180px, 260px) 1fr;align-items:center;gap:16px;padding:10px 14px"><div><div style=font-size:12.5px></div><div style=font-size:11px;margin-top:2px> · </div></div><div style=display:flex;align-items:center;gap:10px><div style=flex:1;height:6px;border-radius:3px;overflow:hidden><div style=height:100%></div></div><span style=width:40px;text-align:right;font-size:12px>%`);
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
        description: "多账号、默认档位、路由与用量"
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
        const [local, setLocal] = store.createStore({
          tier: ""
        });
        solidJs.onMount(() => {
          const t = setInterval(() => setNow(Date.now()), 2e4);
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
            setMsg(/no method/i.test(raw) ? "需要重启一次 App：主进程的 IPC 方法只在启动时注册，热更新不会补上。" : `失败：${raw.slice(0, 200)}`);
          } finally {
            setBusy("");
          }
        }
        return (() => {
          var _el$2 = _tmpl$3(), _el$3 = _el$2.firstChild, _el$4 = _el$3.firstChild, _el$5 = _el$4.nextSibling, _el$6 = _el$5.firstChild, _el$7 = _el$6.nextSibling;
          web.insert(_el$2, web.createComponent(solidJs.Show, {
            get when() {
              return state.error;
            },
            get children() {
              var _el$8 = _tmpl$2();
              _el$8.firstChild;
              web.insert(_el$8, () => String(state.error), null);
              web.effect((_$p) => web.setStyleProperty(_el$8, "color", T.red));
              return _el$8;
            }
          }), null);
          web.insert(_el$2, web.createComponent(solidJs.Show, {
            get when() {
              return state();
            },
            children: (data) => [(() => {
              var _el$0 = _tmpl$4();
              web.effect((_$p) => web.style(_el$0, {
                ...label
              }, _$p));
              return _el$0;
            })(), (() => {
              var _el$1 = _tmpl$5();
              web.insert(_el$1, web.createComponent(solidJs.For, {
                get each() {
                  return data().accounts;
                },
                children: (acc) => {
                  const left = Math.max(0, Math.ceil(((acc.cooldownUntil ?? 0) - now()) / 6e4));
                  const cooling = left > 0;
                  const isActive = acc.id === data().activeAccountId;
                  return (() => {
                    var _el$44 = _tmpl$18(), _el$45 = _el$44.firstChild, _el$46 = _el$45.firstChild, _el$47 = _el$46.firstChild, _el$48 = _el$47.nextSibling, _el$54 = _el$46.nextSibling, _el$55 = _el$54.nextSibling, _el$56 = _el$55.nextSibling, _el$57 = _el$56.firstChild, _el$64 = _el$57.nextSibling, _el$58 = _el$64.nextSibling, _el$65 = _el$58.nextSibling;
                    _el$65.nextSibling;
                    var _el$66 = _el$45.nextSibling, _el$67 = _el$66.firstChild;
                    web.insert(_el$48, () => acc.alias);
                    web.insert(_el$46, web.createComponent(solidJs.Show, {
                      when: isActive,
                      get children() {
                        var _el$49 = _tmpl$10();
                        web.effect((_$p) => web.setStyleProperty(_el$49, "color", T.accent));
                        return _el$49;
                      }
                    }), null);
                    web.insert(_el$46, web.createComponent(solidJs.Show, {
                      when: cooling,
                      get children() {
                        var _el$50 = _tmpl$11(), _el$51 = _el$50.firstChild, _el$53 = _el$51.nextSibling;
                        _el$53.nextSibling;
                        web.insert(_el$50, left, _el$53);
                        web.effect((_$p) => web.setStyleProperty(_el$50, "color", T.yellow));
                        return _el$50;
                      }
                    }), null);
                    web.insert(_el$54, () => acc.id);
                    web.insert(_el$55, () => chip(acc.argon, "Argon"), null);
                    web.insert(_el$55, () => chip(acc.claude, "Claude"), null);
                    web.insert(_el$55, () => chip(acc.flash, "Flash"), null);
                    web.insert(_el$56, () => acc.calls ?? 0, _el$64);
                    web.insert(_el$56, () => acc.failures ?? 0, _el$65);
                    web.insert(_el$56, () => ago(acc.lastUsedAt, now()), null);
                    web.insert(_el$56, web.createComponent(solidJs.Show, {
                      get when() {
                        return acc.checkedAt;
                      },
                      get children() {
                        var _el$60 = _tmpl$12();
                        _el$60.firstChild;
                        web.insert(_el$60, () => ago(acc.checkedAt, now()), null);
                        web.effect((_$p) => web.setStyleProperty(_el$60, "color", T.faint));
                        return _el$60;
                      }
                    }), null);
                    web.insert(_el$56, web.createComponent(solidJs.Show, {
                      get when() {
                        return acc.lastError;
                      },
                      get children() {
                        var _el$62 = _tmpl$13();
                        _el$62.firstChild;
                        web.insert(_el$62, () => acc.lastError, null);
                        web.effect((_$p) => web.setStyleProperty(_el$62, "color", T.yellow));
                        return _el$62;
                      }
                    }), null);
                    _el$67.$$click = () => run(acc.id, () => client.probe({
                      id: acc.id
                    }), "探测完成");
                    web.insert(_el$67, () => busy() === acc.id ? "探测中" : "探测");
                    web.insert(_el$66, web.createComponent(solidJs.Show, {
                      get when() {
                        return acc.home;
                      },
                      get children() {
                        var _el$68 = _tmpl$14();
                        _el$68.$$click = () => run(`login-${acc.id}`, () => client.login({
                          id: acc.id
                        }), "已打开浏览器授权");
                        web.effect((_p$) => {
                          var _v$28 = btnStyle(), _v$29 = busy() === `login-${acc.id}`;
                          _p$.e = web.style(_el$68, _v$28, _p$.e);
                          _v$29 !== _p$.t && (_el$68.disabled = _p$.t = _v$29);
                          return _p$;
                        }, {
                          e: void 0,
                          t: void 0
                        });
                        return _el$68;
                      }
                    }), null);
                    web.insert(_el$66, web.createComponent(solidJs.Show, {
                      when: cooling,
                      get children() {
                        var _el$69 = _tmpl$15();
                        _el$69.$$click = () => run(`cd-${acc.id}`, () => client.clearCooldown({
                          id: acc.id
                        }), "已解除冷却");
                        web.effect((_$p) => web.style(_el$69, btnStyle(), _$p));
                        return _el$69;
                      }
                    }), null);
                    web.insert(_el$66, web.createComponent(solidJs.Show, {
                      get when() {
                        return acc.id !== "system";
                      },
                      get children() {
                        return [web.createComponent(solidJs.Show, {
                          when: !isActive,
                          get children() {
                            var _el$70 = _tmpl$16();
                            _el$70.$$click = () => run(acc.id, () => client.setActive({
                              id: acc.id
                            }), "已切换默认账号");
                            web.effect((_$p) => web.style(_el$70, btnStyle(), _$p));
                            return _el$70;
                          }
                        }), (() => {
                          var _el$71 = _tmpl$17();
                          _el$71.$$click = () => run(acc.id, () => client.remove({
                            id: acc.id
                          }), "已删除");
                          web.effect((_$p) => web.style(_el$71, btnStyle("danger"), _$p));
                          return _el$71;
                        })()];
                      }
                    }), null);
                    web.effect((_p$) => {
                      var _v$30 = acc === data().accounts[0] ? "none" : `1px solid ${T.border}`, _v$31 = isActive ? T.layer2 : "transparent", _v$32 = cooling ? T.yellow : isActive ? T.green : T.faint, _v$33 = T.faint, _v$34 = `10.5px ${T.mono}`, _v$35 = T.weak, _v$36 = btnStyle(), _v$37 = busy() === acc.id;
                      _v$30 !== _p$.e && web.setStyleProperty(_el$44, "border-top", _p$.e = _v$30);
                      _v$31 !== _p$.t && web.setStyleProperty(_el$44, "background", _p$.t = _v$31);
                      _v$32 !== _p$.a && web.setStyleProperty(_el$47, "background", _p$.a = _v$32);
                      _v$33 !== _p$.o && web.setStyleProperty(_el$54, "color", _p$.o = _v$33);
                      _v$34 !== _p$.i && web.setStyleProperty(_el$54, "font", _p$.i = _v$34);
                      _v$35 !== _p$.n && web.setStyleProperty(_el$56, "color", _p$.n = _v$35);
                      _p$.s = web.style(_el$67, _v$36, _p$.s);
                      _v$37 !== _p$.h && (_el$67.disabled = _p$.h = _v$37);
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
                    return _el$44;
                  })();
                }
              }));
              web.effect((_$p) => web.style(_el$1, cardClip, _$p));
              return _el$1;
            })(), (() => {
              var _el$10 = _tmpl$6(), _el$11 = _el$10.firstChild, _el$12 = _el$11.nextSibling;
              _el$11.$$input = (e) => setAlias(e.currentTarget.value);
              _el$12.$$click = () => void run("add", () => client.add({
                alias: alias()
              }), "已创建，点该账号的「登录」完成授权").then(() => setAlias(""));
              web.effect((_p$) => {
                var _v$8 = `1px solid ${T.border}`, _v$9 = T.layer1, _v$0 = T.base, _v$1 = btnStyle("primary"), _v$10 = busy() === "add";
                _v$8 !== _p$.e && web.setStyleProperty(_el$11, "border", _p$.e = _v$8);
                _v$9 !== _p$.t && web.setStyleProperty(_el$11, "background", _p$.t = _v$9);
                _v$0 !== _p$.a && web.setStyleProperty(_el$11, "color", _p$.a = _v$0);
                _p$.o = web.style(_el$12, _v$1, _p$.o);
                _v$10 !== _p$.i && (_el$12.disabled = _p$.i = _v$10);
                return _p$;
              }, {
                e: void 0,
                t: void 0,
                a: void 0,
                o: void 0,
                i: void 0
              });
              web.effect(() => _el$11.value = alias());
              return _el$10;
            })(), (() => {
              var _el$13 = _tmpl$7();
              web.effect((_$p) => web.style(_el$13, {
                ...label
              }, _$p));
              return _el$13;
            })(), (() => {
              var _el$14 = _tmpl$9(), _el$15 = _el$14.firstChild, _el$16 = _el$15.firstChild, _el$17 = _el$16.firstChild, _el$18 = _el$17.nextSibling, _el$19 = _el$16.nextSibling, _el$20 = _el$19.firstChild, _el$21 = _el$20.firstChild, _el$23 = _el$15.nextSibling, _el$24 = _el$23.firstChild, _el$25 = _el$24.firstChild, _el$26 = _el$25.nextSibling, _el$27 = _el$24.nextSibling, _el$28 = _el$23.nextSibling, _el$29 = _el$28.firstChild, _el$30 = _el$29.firstChild, _el$31 = _el$30.nextSibling, _el$32 = _el$29.nextSibling, _el$33 = _el$32.firstChild, _el$34 = _el$33.nextSibling;
              _el$20.$$click = () => setPicker((v) => !v);
              web.insert(_el$20, () => TIER_LABEL[tier()] ?? tier(), _el$21);
              web.insert(_el$20, () => picker() ? "▴" : "▾", null);
              web.insert(_el$19, web.createComponent(solidJs.Show, {
                get when() {
                  return picker();
                },
                get children() {
                  var _el$22 = _tmpl$8();
                  web.insert(_el$22, web.createComponent(solidJs.For, {
                    get each() {
                      return groups();
                    },
                    children: (g) => [(() => {
                      var _el$72 = _tmpl$19();
                      web.insert(_el$72, () => g.model);
                      web.effect((_$p) => web.setStyleProperty(_el$72, "color", T.faint));
                      return _el$72;
                    })(), web.createComponent(solidJs.For, {
                      get each() {
                        return g.tiers;
                      },
                      children: ([id, level]) => (() => {
                        var _el$73 = _tmpl$21(), _el$74 = _el$73.firstChild;
                        _el$73.$$click = () => {
                          setPicker(false);
                          setLocal("tier", id);
                          void run("tier", () => client.setDefaultTier({
                            tier: id
                          }), "默认档位已保存");
                        };
                        web.setAttribute(_el$73, "data-tier", id);
                        web.insert(_el$74, level);
                        web.insert(_el$73, web.createComponent(solidJs.Show, {
                          get when() {
                            return id === tier();
                          },
                          get children() {
                            var _el$75 = _tmpl$20();
                            web.effect((_$p) => web.setStyleProperty(_el$75, "color", T.accent));
                            return _el$75;
                          }
                        }), null);
                        web.effect((_p$) => {
                          var _v$38 = id === tier() ? T.layer2 : "transparent", _v$39 = id === tier() ? T.base : T.muted;
                          _v$38 !== _p$.e && web.setStyleProperty(_el$73, "background", _p$.e = _v$38);
                          _v$39 !== _p$.t && web.setStyleProperty(_el$73, "color", _p$.t = _v$39);
                          return _p$;
                        }, {
                          e: void 0,
                          t: void 0
                        });
                        return _el$73;
                      })()
                    })]
                  }));
                  web.effect((_$p) => web.setStyleProperty(_el$22, "border", `1px solid ${T.borderStrong}`));
                  return _el$22;
                }
              }), null);
              web.insert(_el$26, () => {
                var _a;
                return ((_a = ROUTING.find(([v]) => v === data().routing)) == null ? void 0 : _a[2]) ?? "";
              });
              web.insert(_el$27, web.createComponent(solidJs.For, {
                each: ROUTING,
                children: ([value, text]) => (() => {
                  var _el$76 = _tmpl$22();
                  _el$76.$$click = () => run("routing", () => client.setRouting({
                    routing: value
                  }), "路由策略已保存");
                  web.insert(_el$76, text);
                  web.effect((_$p) => web.style(_el$76, {
                    ...btnStyle(),
                    "border-color": data().routing === value ? T.accent : T.border,
                    background: data().routing === value ? "color-mix(in srgb, var(--v2-blue-600, #3b5bdb) 18%, transparent)" : T.btn,
                    color: data().routing === value ? T.base : T.muted
                  }, _$p));
                  return _el$76;
                })()
              }));
              _el$33.addEventListener("change", (e) => {
                const minutes = Number(e.currentTarget.value);
                if (!Number.isFinite(minutes) || minutes < 1) return;
                void run("cooldown", () => client.setCooldown({
                  minutes
                }), "已保存");
              });
              web.effect((_p$) => {
                var _v$11 = card, _v$12 = {
                  ...row
                }, _v$13 = T.faint, _v$14 = {
                  ...btnStyle()
                }, _v$15 = row, _v$16 = T.faint, _v$17 = row, _v$18 = T.faint, _v$19 = `1px solid ${T.border}`, _v$20 = T.layer1, _v$21 = T.base, _v$22 = T.faint;
                _p$.e = web.style(_el$14, _v$11, _p$.e);
                _p$.t = web.style(_el$15, _v$12, _p$.t);
                _v$13 !== _p$.a && web.setStyleProperty(_el$18, "color", _p$.a = _v$13);
                _p$.o = web.style(_el$20, _v$14, _p$.o);
                _p$.i = web.style(_el$23, _v$15, _p$.i);
                _v$16 !== _p$.n && web.setStyleProperty(_el$26, "color", _p$.n = _v$16);
                _p$.s = web.style(_el$28, _v$17, _p$.s);
                _v$18 !== _p$.h && web.setStyleProperty(_el$31, "color", _p$.h = _v$18);
                _v$19 !== _p$.r && web.setStyleProperty(_el$33, "border", _p$.r = _v$19);
                _v$20 !== _p$.d && web.setStyleProperty(_el$33, "background", _p$.d = _v$20);
                _v$21 !== _p$.l && web.setStyleProperty(_el$33, "color", _p$.l = _v$21);
                _v$22 !== _p$.u && web.setStyleProperty(_el$34, "color", _p$.u = _v$22);
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
              web.effect(() => _el$33.value = Math.round((data().cooldownMs ?? 9e5) / 6e4));
              return _el$14;
            })(), (() => {
              var _el$35 = _tmpl$0(), _el$36 = _el$35.firstChild, _el$37 = _el$36.firstChild, _el$38 = _el$37.nextSibling, _el$39 = _el$38.firstChild, _el$40 = _el$39.nextSibling, _el$41 = _el$36.nextSibling;
              web.insert(_el$38, (() => {
                var _c$ = web.memo(() => {
                  var _a;
                  return !!((_a = activeAccount()) == null ? void 0 : _a.usageCheckedAt);
                });
                return () => _c$() ? ` · ${ago(activeAccount().usageCheckedAt, now())}` : "";
              })(), null);
              _el$41.$$click = () => run("usage", () => client.usage({
                id: data().activeAccountId
              }), "额度已刷新");
              web.insert(_el$41, () => busy() === "usage" ? "读取中" : "刷新");
              web.effect((_p$) => {
                var _v$23 = {
                  ...label
                }, _v$24 = T.faint, _v$25 = `11px ${T.mono}`, _v$26 = btnStyle(), _v$27 = busy() === "usage";
                _p$.e = web.style(_el$35, _v$23, _p$.e);
                _v$24 !== _p$.t && web.setStyleProperty(_el$38, "color", _p$.t = _v$24);
                _v$25 !== _p$.a && web.setStyleProperty(_el$40, "font", _p$.a = _v$25);
                _p$.o = web.style(_el$41, _v$26, _p$.o);
                _v$27 !== _p$.i && (_el$41.disabled = _p$.i = _v$27);
                return _p$;
              }, {
                e: void 0,
                t: void 0,
                a: void 0,
                o: void 0,
                i: void 0
              });
              return _el$35;
            })(), (() => {
              var _el$42 = _tmpl$5();
              web.insert(_el$42, web.createComponent(solidJs.Show, {
                get when() {
                  return activeUsage().length > 0;
                },
                get fallback() {
                  return (() => {
                    var _el$77 = _tmpl$23();
                    web.insert(_el$77, () => busy() === "usage" ? "正在向官方 CLI 读取…" : "暂无数据，点右上角「刷新」读取。");
                    web.effect((_$p) => web.setStyleProperty(_el$77, "color", T.muted));
                    return _el$77;
                  })();
                },
                get children() {
                  return web.createComponent(solidJs.For, {
                    get each() {
                      return activeUsage();
                    },
                    children: (u, i) => (() => {
                      var _el$78 = _tmpl$24(), _el$79 = _el$78.firstChild, _el$80 = _el$79.firstChild, _el$81 = _el$80.nextSibling, _el$82 = _el$81.firstChild, _el$83 = _el$79.nextSibling, _el$84 = _el$83.firstChild, _el$85 = _el$84.firstChild, _el$86 = _el$84.nextSibling, _el$87 = _el$86.firstChild;
                      web.insert(_el$80, () => u.label);
                      web.insert(_el$81, () => u.group, _el$82);
                      web.insert(_el$81, () => resetIn(u.resetAt, now()), null);
                      web.insert(_el$86, () => u.percent, _el$87);
                      web.effect((_p$) => {
                        var _v$40 = i() === 0 ? "none" : `1px solid ${T.border}`, _v$41 = T.faint, _v$42 = T.layer2, _v$43 = `${Math.max(0, Math.min(100, u.percent))}%`, _v$44 = barColor(u.percent), _v$45 = u.percent >= 20 ? T.base : T.red, _v$46 = `12px ${T.mono}`;
                        _v$40 !== _p$.e && web.setStyleProperty(_el$78, "border-top", _p$.e = _v$40);
                        _v$41 !== _p$.t && web.setStyleProperty(_el$81, "color", _p$.t = _v$41);
                        _v$42 !== _p$.a && web.setStyleProperty(_el$84, "background", _p$.a = _v$42);
                        _v$43 !== _p$.o && web.setStyleProperty(_el$85, "width", _p$.o = _v$43);
                        _v$44 !== _p$.i && web.setStyleProperty(_el$85, "background", _p$.i = _v$44);
                        _v$45 !== _p$.n && web.setStyleProperty(_el$86, "color", _p$.n = _v$45);
                        _v$46 !== _p$.s && web.setStyleProperty(_el$86, "font", _p$.s = _v$46);
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
                      return _el$78;
                    })()
                  });
                }
              }));
              web.effect((_$p) => web.style(_el$42, card, _$p));
              return _el$42;
            })(), web.createComponent(solidJs.Show, {
              get when() {
                return msg();
              },
              get children() {
                var _el$43 = _tmpl$1();
                web.insert(_el$43, msg);
                web.effect((_$p) => web.setStyleProperty(_el$43, "color", T.muted));
                return _el$43;
              }
            })]
          }), null);
          web.effect((_p$) => {
            var _v$4 = T.base, _v$5 = T.muted, _v$6 = `11.5px ${T.mono}`, _v$7 = T.accent;
            _v$4 !== _p$.e && web.setStyleProperty(_el$2, "color", _p$.e = _v$4);
            _v$5 !== _p$.t && web.setStyleProperty(_el$5, "color", _p$.t = _v$5);
            _v$6 !== _p$.a && web.setStyleProperty(_el$7, "font", _p$.a = _v$6);
            _v$7 !== _p$.o && web.setStyleProperty(_el$7, "color", _p$.o = _v$7);
            return _p$;
          }, {
            e: void 0,
            t: void 0,
            a: void 0,
            o: void 0
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
      return {
        activeAccountId: data.activeAccountId,
        defaultTier: data.defaultTier,
        routing: data.routing,
        cooldownMs: data.cooldownMs,
        accounts: data.accounts
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
        const rows = await accounts$1.fetchUsage(acc);
        const next = accounts$1.loadAccounts();
        const target = next.accounts.find((a) => a.id === id);
        if (target) {
          target.usage = rows;
          target.usageCheckedAt = Date.now();
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
      try {
        child.kill();
      } catch {
      }
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
function fetchUsage(account, timeoutMs = 6e4) {
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
      try {
        child.kill();
      } catch {
      }
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
  accountsFile,
  createAccount,
  fetchUsage,
  inCooldown,
  loadAccounts,
  pickAccount,
  probeAccount,
  recordResult,
  removeAccount,
  resolveActiveAccount,
  saveAccounts,
  stateDir
}, Symbol.toStringTag, { value: "Module" }));
exports.default = gui;
