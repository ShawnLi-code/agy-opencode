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
require("node:crypto");
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
  name: Effect__namespace.Schema.optional(Effect__namespace.Schema.String)
});
const StateSchema = Effect__namespace.Schema.Struct({
  activeAccountId: Effect__namespace.Schema.String,
  defaultTier: Effect__namespace.Schema.String,
  routing: Effect__namespace.Schema.String,
  cooldownMs: Effect__namespace.Schema.Number,
  agentMode: Effect__namespace.Schema.String,
  autoApproveNative: Effect__namespace.Schema.Boolean,
  acpIdleMinutes: Effect__namespace.Schema.Number,
  acpMaxSessions: Effect__namespace.Schema.Number,
  /** Context window advertised to opencode; 256K official, 983,040 with the binary patch. */
  contextWindow: Effect__namespace.Schema.Number,
  nextAccountId: Effect__namespace.Schema.String,
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
    setAgentMode: { input: Effect__namespace.Schema.Struct({ mode: Effect__namespace.Schema.String }), output: Effect__namespace.Schema.Boolean },
    /** How long an account rests after a quota/auth failure, in minutes. */
    setCooldown: { input: Effect__namespace.Schema.Struct({ minutes: Effect__namespace.Schema.Number }), output: Effect__namespace.Schema.Boolean },
    /** Idle/min-open limits for the ACP worker pool. */
    setAcpLimits: {
      input: Effect__namespace.Schema.Struct({
        idleMinutes: Effect__namespace.Schema.Number,
        maxSessions: Effect__namespace.Schema.Number
      }),
      output: Effect__namespace.Schema.Boolean
    },
    /** Context window advertised to opencode (256K official / 983,040 patched). */
    setContextWindow: {
      input: Effect__namespace.Schema.Struct({ tokens: Effect__namespace.Schema.Number }),
      output: Effect__namespace.Schema.Boolean
    },
    /** Clear a cooldown so the account is used again immediately. */
    clearCooldown: { input: Effect__namespace.Schema.Struct({ id: Effect__namespace.Schema.String }), output: Effect__namespace.Schema.Boolean },
    /** Reset the local usage counters for an account. */
    resetUsage: { input: Effect__namespace.Schema.Struct({ id: Effect__namespace.Schema.String }), output: Effect__namespace.Schema.Boolean },
    /**
     * Start Google sign-in for an account. Returns the OAuth URL the CLI prints;
     * no browser is launched, so the user can open it in whichever browser is
     * already signed in.
     */
    login: {
      input: Effect__namespace.Schema.Struct({ id: Effect__namespace.Schema.String }),
      output: Effect__namespace.Schema.Struct({ url: Effect__namespace.Schema.String })
    },
    /** Hand the pasted authorization code (or redirect URL) back to the CLI. */
    loginCode: {
      input: Effect__namespace.Schema.Struct({ id: Effect__namespace.Schema.String, code: Effect__namespace.Schema.String }),
      output: Effect__namespace.Schema.Struct({
        ok: Effect__namespace.Schema.Boolean,
        email: Effect__namespace.Schema.optional(Effect__namespace.Schema.String),
        error: Effect__namespace.Schema.optional(Effect__namespace.Schema.String)
      })
    },
    /** Abandon an in-flight sign-in and stop the waiting CLI process. */
    loginCancel: { input: Effect__namespace.Schema.Struct({ id: Effect__namespace.Schema.String }), output: Effect__namespace.Schema.Boolean }
  }
});
var _tmpl$ = /* @__PURE__ */ web.template(`<span style="font-size:11px;line-height:18px;padding:0 7px;border-radius:5px">`), _tmpl$2 = /* @__PURE__ */ web.template(`<div style=margin-bottom:14px;font-size:12px>读取失败：`), _tmpl$3 = /* @__PURE__ */ web.template(`<div role=status style=margin-bottom:14px;font-size:12px>`), _tmpl$4 = /* @__PURE__ */ web.template(`<div style="padding:22px 26px 40px;font-size:13px;max-width:900px"><div style=margin-bottom:22px><h1 style="font-size:16px;font-weight:600;margin:0 0 6px">Antigravity</h1><p style=margin:0;line-height:1.55;font-size:12.5px>把 Antigravity 接成 OpenCode 的模型供应商：在模型里选 <code>agy-cli</code> 就能直接当主模型用， 也可以用 <code>agy</code> 工具把任务交给它跑。每个账号用独立 HOME 目录隔离凭证，互不影响。`), _tmpl$5 = /* @__PURE__ */ web.template(`<div style=margin-top:26px>工具执行方式`), _tmpl$6 = /* @__PURE__ */ web.template(`<div style=padding:14px><div style=display:flex;gap:8px;flex-wrap:wrap></div><p style="font-size:12px;line-height:1.6;margin:10px 0 0">`), _tmpl$7 = /* @__PURE__ */ web.template(`<div style=margin-top:26px>账号`), _tmpl$8 = /* @__PURE__ */ web.template(`<div style=font-size:12px;margin-bottom:8px>下次路由：<!>（实际请求时重新选择）`), _tmpl$9 = /* @__PURE__ */ web.template(`<div>`), _tmpl$0 = /* @__PURE__ */ web.template(`<div style=display:flex;gap:8px;margin-top:10px><input placeholder="新账号备注，例如「备用 Google 账号」"style="flex:1;font-size:12px;padding:6px 10px;border-radius:6px;outline:none"><button>添加账号`), _tmpl$1 = /* @__PURE__ */ web.template(`<div style=font-size:11.5px;margin-top:8px;line-height:1.6>`), _tmpl$10 = /* @__PURE__ */ web.template(`<div style=margin-top:12px;overflow:hidden><div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px"><div><div style=font-size:12.5px>登录「<!>」</div><div style=font-size:11px;margin-top:2px>不会自动弹浏览器：请在你已经登录 Google 的浏览器里打开下面的链接</div></div><button>取消</button></div><div style="padding:12px 14px"><div style=display:flex;gap:8px><input readonly style="flex:1;min-width:0;padding:6px 9px;border-radius:6px;outline:none"><button></button></div><div style=font-size:11.5px;line-height:1.7;margin-top:10px>1. 打开链接，完成 Google 授权。<br>2. 把浏览器地址栏里的<b>完整地址</b>，或页面显示的<b>授权码</b>，粘到下面。</div><div style=display:flex;gap:8px;margin-top:8px><input placeholder=粘贴授权码或回调页面地址 style="flex:1;min-width:0;font-size:12px;padding:6px 10px;border-radius:6px;outline:none"><button></button></div><div style=font-size:10.5px;margin-top:10px;line-height:1.6>额外账号把 token 存在自己的 HOME 里（不走系统钥匙串），不会覆盖系统账号的登录。`), _tmpl$11 = /* @__PURE__ */ web.template(`<div style=margin-top:26px>调用设置`), _tmpl$12 = /* @__PURE__ */ web.template(`<div style="position:absolute;top:calc(100% + 6px);left:0;z-index:50;min-width:260px;max-height:320px;overflow-y:auto;background:var(--v2-background-bg-base, #16191f);border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,0.5);padding:6px">`), _tmpl$13 = /* @__PURE__ */ web.template(`<div><div style=border-top:none><div><div style=font-size:12.5px>默认档位</div><div style=font-size:11px;margin-top:2px>未指定 tier 时使用</div></div><div style=position:relative;justify-self:start><button style="min-width:250px;display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--v2-background-bg-base, #16191f);font-weight:500;opacity:1"><span></span><span style=font-size:10px></span></button></div></div><div><div><div style=font-size:12.5px>路由策略</div><div style=font-size:11px;margin-top:2px></div></div><div style=display:flex;gap:4px;justify-self:start></div></div><div><div><div style=font-size:12.5px>冷却时长</div><div style=font-size:11px;margin-top:2px>配额或未授权时暂停该账号</div></div><div style=display:flex;align-items:center;gap:8px;justify-self:start><input type=number min=1 max=240 style="width:64px;font-size:12px;padding:5px 8px;border-radius:6px;outline:none"><span style=font-size:11.5px>分钟</span></div></div><div><div><div style=font-size:12.5px>上下文窗口</div><div style=font-size:11px;margin-top:2px>1M 需要先给 agy 打补丁；官方二进制只支持 256K</div></div><div style=display:flex;align-items:center;gap:8px;justify-self:start><select style="font-size:12px;padding:5px 8px;border-radius:6px;outline:none"><option value=256000>256K（官方）</option><option value=983040>1M（已打补丁）</option></select></div></div><div><div><div style=font-size:12.5px>空闲回收</div><div style=font-size:11px;margin-top:2px>超时后关闭 worker，回来时自动恢复上下文</div></div><div style=display:flex;align-items:center;gap:8px;justify-self:start><input type=number min=1 max=1440 style="width:64px;font-size:12px;padding:5px 8px;border-radius:6px;outline:none"><span style=font-size:11.5px>分钟</span></div></div><div><div><div style=font-size:12.5px>进程上限</div><div style=font-size:11px;margin-top:2px>同时保留的 agy worker 数量</div></div><div style=display:flex;align-items:center;gap:8px;justify-self:start><input type=number min=1 max=16 style="width:64px;font-size:12px;padding:5px 8px;border-radius:6px;outline:none"><span style=font-size:11.5px>个`), _tmpl$14 = /* @__PURE__ */ web.template(`<div style=margin-top:26px;display:flex;align-items:center;justify-content:space-between><span>额度<span style=margin-left:8px;font-size:11px>来自 <code>agy --print=/usage</code></span></span><button>`), _tmpl$15 = /* @__PURE__ */ web.template(`<div style="padding:10px 14px;font-size:11px;line-height:1.55">上次读取失败：<span> · 5 分钟内不会自动重试，可以点「刷新」手动重试。`), _tmpl$16 = /* @__PURE__ */ web.template(`<button>`), _tmpl$17 = /* @__PURE__ */ web.template(`<span style=font-size:10.5px;flex-shrink:0>默认`), _tmpl$18 = /* @__PURE__ */ web.template(`<span style=font-size:11px;flex-shrink:0>冷却剩 <!> 分`), _tmpl$19 = /* @__PURE__ */ web.template(`<span>`), _tmpl$20 = /* @__PURE__ */ web.template(`<span> · 探测 `), _tmpl$21 = /* @__PURE__ */ web.template(`<span> · 上次 `), _tmpl$22 = /* @__PURE__ */ web.template(`<button>解除`), _tmpl$23 = /* @__PURE__ */ web.template(`<button>设为默认`), _tmpl$24 = /* @__PURE__ */ web.template(`<div style="display:flex;align-items:flex-start;gap:14px;padding:12px 14px"><div style=min-width:0;flex:1><div style=display:flex;align-items:baseline;gap:8px;min-width:0><span style=width:6px;height:6px;border-radius:50%;flex-shrink:0;transform:translateY(-2px)></span><span style=font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis></span></div><div style=margin-top:4px;display:flex;gap:7px;align-items:center;flex-wrap:wrap><span style=font-size:10px></span></div><div style=display:flex;gap:5px;margin-top:8px;flex-wrap:wrap></div><div style=margin-top:8px;font-size:11.5px;line-height:1.5>调用 <!> · 失败 <!> · 最近 </div></div><div style=display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;max-width:210px><button></button><button></button><button>删除`), _tmpl$25 = /* @__PURE__ */ web.template(`<span style=font-size:11px>`), _tmpl$26 = /* @__PURE__ */ web.template(`<div style="padding:7px 8px 3px;font-size:10.5px;letter-spacing:0.03em">`), _tmpl$27 = /* @__PURE__ */ web.template(`<span>✓`), _tmpl$28 = /* @__PURE__ */ web.template(`<div style="display:flex;justify-content:space-between;padding:5px 8px;border-radius:5px;cursor:pointer;font-size:12px"><span>`), _tmpl$29 = /* @__PURE__ */ web.template(`<div style=padding:14px;font-size:11.5px;line-height:1.6>`), _tmpl$30 = /* @__PURE__ */ web.template(`<div style="display:grid;grid-template-columns:minmax(180px, 260px) 1fr;align-items:center;gap:16px;padding:10px 14px"><div><div style=font-size:12.5px></div><div style=font-size:11px;margin-top:2px> · </div></div><div style=display:flex;align-items:center;gap:10px><div style=flex:1;height:6px;border-radius:3px;overflow:hidden><div style=height:100%></div></div><span style=width:40px;text-align:right;font-size:12px>%`);
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
        const [loginFor, setLoginFor] = solidJs.createSignal("");
        const [loginUrl, setLoginUrl] = solidJs.createSignal("");
        const [loginCode, setLoginCode] = solidJs.createSignal("");
        const [loginError, setLoginError] = solidJs.createSignal("");
        const [loginCopied, setLoginCopied] = solidJs.createSignal(false);
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
          if (busy()) {
            setMsg("另一项操作正在进行，请稍候。");
            return;
          }
          setBusy(key);
          setMsg("");
          try {
            const result = await fn();
            if (result === false) throw new Error("操作未完成，请检查账号状态后重试。");
            if (okMsg) setMsg(okMsg);
            await refetch();
          } catch (e) {
            const raw = String((e == null ? void 0 : e.message) ?? e);
            setMsg(/no method/i.test(raw) ? "需要重启一次 App：主进程的 IPC 方法只在启动时注册，热更新不会补上。" : /usage TIMEOUT/i.test(raw) ? "额度读取超时：官方 CLI 30 秒内没有返回（agy 无响应或网络慢），稍后再试。" : `失败：${raw.slice(0, 200)}`);
          } finally {
            setBusy("");
          }
        }
        async function startLogin(id) {
          if (busy()) {
            setMsg("另一项操作正在进行，请稍候。");
            return;
          }
          setBusy(`login-${id}`);
          setMsg("");
          setLoginError("");
          try {
            const {
              url
            } = await client.login({
              id
            });
            setLoginFor(id);
            setLoginUrl(url);
            setLoginCode("");
            setLoginCopied(false);
          } catch (e) {
            setMsg(`无法启动登录：${String((e == null ? void 0 : e.message) ?? e).slice(0, 200)}`);
          } finally {
            setBusy("");
          }
        }
        async function copyLoginUrl() {
          try {
            await navigator.clipboard.writeText(loginUrl());
            setLoginCopied(true);
            setTimeout(() => setLoginCopied(false), 1500);
          } catch {
            setLoginError("复制失败：请手动选中链接复制。");
          }
        }
        async function submitLoginCode() {
          const id = loginFor();
          if (!id) return;
          const code = loginCode().trim();
          if (!code) {
            setLoginError("请先粘贴授权码或回调页面的完整地址。");
            return;
          }
          setBusy(`code-${id}`);
          setLoginError("");
          try {
            const result = await client.loginCode({
              id,
              code
            });
            if (!result.ok) {
              setLoginError(result.error ?? "登录失败，请重新复制链接后再试。");
              return;
            }
            setLoginFor("");
            setLoginUrl("");
            setLoginCode("");
            setMsg(`登录成功${result.email ? `：${result.email}` : ""}`);
            await refetch();
          } catch (e) {
            setLoginError(String((e == null ? void 0 : e.message) ?? e).slice(0, 300));
          } finally {
            setBusy("");
          }
        }
        async function cancelLogin() {
          const id = loginFor();
          setLoginFor("");
          setLoginUrl("");
          setLoginCode("");
          setLoginError("");
          if (!id) return;
          try {
            await client.loginCancel({
              id
            });
          } catch {
          }
        }
        const loginAlias = solidJs.createMemo(() => {
          var _a, _b;
          const id = loginFor();
          return ((_b = (_a = state()) == null ? void 0 : _a.accounts.find((a) => a.id === id)) == null ? void 0 : _b.alias) ?? id;
        });
        return (() => {
          var _el$2 = _tmpl$4(), _el$3 = _el$2.firstChild, _el$4 = _el$3.firstChild, _el$5 = _el$4.nextSibling, _el$6 = _el$5.firstChild, _el$8 = _el$6.nextSibling, _el$9 = _el$8.nextSibling, _el$0 = _el$9.nextSibling;
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
              return msg();
            },
            get children() {
              var _el$11 = _tmpl$3();
              web.insert(_el$11, msg);
              web.effect((_$p) => web.setStyleProperty(_el$11, "color", T.muted));
              return _el$11;
            }
          }), null);
          web.insert(_el$2, web.createComponent(solidJs.Show, {
            get when() {
              return state();
            },
            children: (data) => [(() => {
              var _el$12 = _tmpl$5();
              web.effect((_$p) => web.style(_el$12, {
                ...label
              }, _$p));
              return _el$12;
            })(), (() => {
              var _el$13 = _tmpl$6(), _el$14 = _el$13.firstChild, _el$15 = _el$14.nextSibling;
              web.insert(_el$14, web.createComponent(solidJs.For, {
                each: [["bridged", "OpenCode 工具"], ["native", "agy 原生工具"]],
                children: ([mode, title]) => (() => {
                  var _el$98 = _tmpl$16();
                  _el$98.$$click = () => run("mode", () => client.setAgentMode({
                    mode
                  }), "执行方式已保存，新请求生效");
                  web.insert(_el$98, title);
                  web.effect((_p$) => {
                    var _v$69 = {
                      ...btnStyle(),
                      "border-color": data().agentMode === mode ? T.accent : T.border
                    }, _v$70 = busy() === "mode";
                    _p$.e = web.style(_el$98, _v$69, _p$.e);
                    _v$70 !== _p$.t && (_el$98.disabled = _p$.t = _v$70);
                    return _p$;
                  }, {
                    e: void 0,
                    t: void 0
                  });
                  return _el$98;
                })()
              }));
              web.insert(_el$15, (() => {
                var _c$ = web.memo(() => data().agentMode === "native");
                return () => _c$() ? data().autoApproveNative ? "当前：agy 自己执行工具并自动批准权限，不受 OpenCode 权限和沙箱约束。" : "当前：agy 自己执行工具；自动批准已关闭，不受 OpenCode 权限和沙箱约束。" : "当前：通过 MCP 交给 OpenCode 执行工具，使用 OpenCode 权限控制。";
              })());
              web.effect((_p$) => {
                var _v$0 = {
                  ...cardClip
                }, _v$1 = T.muted;
                _p$.e = web.style(_el$13, _v$0, _p$.e);
                _v$1 !== _p$.t && web.setStyleProperty(_el$15, "color", _p$.t = _v$1);
                return _p$;
              }, {
                e: void 0,
                t: void 0
              });
              return _el$13;
            })(), (() => {
              var _el$16 = _tmpl$7();
              web.effect((_$p) => web.style(_el$16, {
                ...label
              }, _$p));
              return _el$16;
            })(), (() => {
              var _el$17 = _tmpl$8(), _el$18 = _el$17.firstChild, _el$20 = _el$18.nextSibling;
              _el$20.nextSibling;
              web.insert(_el$17, () => {
                var _a;
                return ((_a = data().accounts.find((a) => a.id === (data().nextAccountId || data().activeAccountId))) == null ? void 0 : _a.alias) ?? "未确定";
              }, _el$20);
              web.effect((_$p) => web.setStyleProperty(_el$17, "color", T.muted));
              return _el$17;
            })(), (() => {
              var _el$21 = _tmpl$9();
              web.insert(_el$21, web.createComponent(solidJs.For, {
                get each() {
                  return data().accounts;
                },
                children: (acc) => {
                  const left = Math.max(0, Math.ceil(((acc.cooldownUntil ?? 0) - now()) / 6e4));
                  const cooling = left > 0;
                  const isActive = acc.id === data().activeAccountId;
                  return (() => {
                    var _el$99 = _tmpl$24(), _el$100 = _el$99.firstChild, _el$101 = _el$100.firstChild, _el$102 = _el$101.firstChild, _el$103 = _el$102.nextSibling, _el$109 = _el$101.nextSibling, _el$111 = _el$109.firstChild, _el$112 = _el$109.nextSibling, _el$113 = _el$112.nextSibling, _el$114 = _el$113.firstChild, _el$121 = _el$114.nextSibling, _el$115 = _el$121.nextSibling, _el$122 = _el$115.nextSibling;
                    _el$122.nextSibling;
                    var _el$123 = _el$100.nextSibling, _el$124 = _el$123.firstChild, _el$125 = _el$124.nextSibling, _el$128 = _el$125.nextSibling;
                    web.insert(_el$103, () => acc.alias);
                    web.insert(_el$101, web.createComponent(solidJs.Show, {
                      when: isActive,
                      get children() {
                        var _el$104 = _tmpl$17();
                        web.effect((_$p) => web.setStyleProperty(_el$104, "color", T.accent));
                        return _el$104;
                      }
                    }), null);
                    web.insert(_el$101, web.createComponent(solidJs.Show, {
                      when: cooling,
                      get children() {
                        var _el$105 = _tmpl$18(), _el$106 = _el$105.firstChild, _el$108 = _el$106.nextSibling;
                        _el$108.nextSibling;
                        web.insert(_el$105, left, _el$108);
                        web.effect((_$p) => web.setStyleProperty(_el$105, "color", T.yellow));
                        return _el$105;
                      }
                    }), null);
                    web.insert(_el$109, web.createComponent(solidJs.Show, {
                      get when() {
                        return acc.email;
                      },
                      get fallback() {
                        return (() => {
                          var _el$129 = _tmpl$25();
                          web.insert(_el$129, () => acc.id === "system" ? "未读取到登录账号" : "未登录 · 点「登录」授权");
                          web.effect((_$p) => web.setStyleProperty(_el$129, "color", T.faint));
                          return _el$129;
                        })();
                      },
                      get children() {
                        var _el$110 = _tmpl$19();
                        web.insert(_el$110, (() => {
                          var _c$4 = web.memo(() => acc.alias === acc.email);
                          return () => _c$4() ? "" : acc.email;
                        })(), null);
                        web.insert(_el$110, () => acc.id === "system" ? "（本地 token，系统钥匙串可能不同）" : "", null);
                        web.effect((_p$) => {
                          var _v$71 = T.muted, _v$72 = `11.5px ${T.mono}`;
                          _v$71 !== _p$.e && web.setStyleProperty(_el$110, "color", _p$.e = _v$71);
                          _v$72 !== _p$.t && web.setStyleProperty(_el$110, "font", _p$.t = _v$72);
                          return _p$;
                        }, {
                          e: void 0,
                          t: void 0
                        });
                        return _el$110;
                      }
                    }), _el$111);
                    web.insert(_el$111, () => acc.id);
                    web.insert(_el$112, () => chip(acc.argon, "Argon"), null);
                    web.insert(_el$112, () => chip(acc.claude, "Claude"), null);
                    web.insert(_el$112, () => chip(acc.flash, "Flash"), null);
                    web.insert(_el$113, () => acc.calls ?? 0, _el$121);
                    web.insert(_el$113, () => acc.failures ?? 0, _el$122);
                    web.insert(_el$113, () => ago(acc.lastUsedAt, now()), null);
                    web.insert(_el$113, web.createComponent(solidJs.Show, {
                      get when() {
                        return acc.checkedAt;
                      },
                      get children() {
                        var _el$117 = _tmpl$20();
                        _el$117.firstChild;
                        web.insert(_el$117, () => ago(acc.checkedAt, now()), null);
                        web.effect((_$p) => web.setStyleProperty(_el$117, "color", T.faint));
                        return _el$117;
                      }
                    }), null);
                    web.insert(_el$113, web.createComponent(solidJs.Show, {
                      get when() {
                        return acc.lastError;
                      },
                      get children() {
                        var _el$119 = _tmpl$21();
                        _el$119.firstChild;
                        web.insert(_el$119, () => acc.lastError, null);
                        web.effect((_$p) => web.setStyleProperty(_el$119, "color", T.yellow));
                        return _el$119;
                      }
                    }), null);
                    _el$124.$$click = () => run(acc.id, () => client.probe({
                      id: acc.id
                    }), "探测完成");
                    web.insert(_el$124, () => busy() === acc.id ? "探测中" : "探测");
                    _el$125.$$click = () => void startLogin(acc.id);
                    web.insert(_el$125, () => busy() === `login-${acc.id}` ? "准备中" : "登录");
                    web.insert(_el$123, web.createComponent(solidJs.Show, {
                      when: cooling,
                      get children() {
                        var _el$126 = _tmpl$22();
                        _el$126.$$click = () => run(`cd-${acc.id}`, () => client.clearCooldown({
                          id: acc.id
                        }), "已解除冷却");
                        web.effect((_$p) => web.style(_el$126, btnStyle(), _$p));
                        return _el$126;
                      }
                    }), _el$128);
                    web.insert(_el$123, web.createComponent(solidJs.Show, {
                      when: !isActive,
                      get children() {
                        var _el$127 = _tmpl$23();
                        _el$127.$$click = () => run(acc.id, () => client.setActive({
                          id: acc.id
                        }), "已切换默认账号");
                        web.effect((_$p) => web.style(_el$127, btnStyle(), _$p));
                        return _el$127;
                      }
                    }), _el$128);
                    _el$128.$$click = () => {
                      if (window.confirm(acc.id === "system" ? "移除系统账号入口？不会删除系统登录凭证。" : "移除此账号入口？不会删除登录凭证。")) void run(acc.id, () => client.remove({
                        id: acc.id
                      }), "账号入口已移除");
                    };
                    web.effect((_p$) => {
                      var _v$73 = acc === data().accounts[0] ? "none" : `1px solid ${T.border}`, _v$74 = isActive ? T.layer2 : "transparent", _v$75 = cooling ? T.yellow : isActive ? T.green : T.faint, _v$76 = T.faint, _v$77 = acc.id, _v$78 = T.weak, _v$79 = btnStyle(), _v$80 = busy() === acc.id, _v$81 = btnStyle(), _v$82 = busy() === `login-${acc.id}`, _v$83 = btnStyle("danger"), _v$84 = data().accounts.length <= 1, _v$85 = acc.id === "system" ? "仅移除插件内的入口，不删除系统登录凭证" : "仅移除插件内的账号入口";
                      _v$73 !== _p$.e && web.setStyleProperty(_el$99, "border-top", _p$.e = _v$73);
                      _v$74 !== _p$.t && web.setStyleProperty(_el$99, "background", _p$.t = _v$74);
                      _v$75 !== _p$.a && web.setStyleProperty(_el$102, "background", _p$.a = _v$75);
                      _v$76 !== _p$.o && web.setStyleProperty(_el$111, "color", _p$.o = _v$76);
                      _v$77 !== _p$.i && web.setAttribute(_el$111, "title", _p$.i = _v$77);
                      _v$78 !== _p$.n && web.setStyleProperty(_el$113, "color", _p$.n = _v$78);
                      _p$.s = web.style(_el$124, _v$79, _p$.s);
                      _v$80 !== _p$.h && (_el$124.disabled = _p$.h = _v$80);
                      _p$.r = web.style(_el$125, _v$81, _p$.r);
                      _v$82 !== _p$.d && (_el$125.disabled = _p$.d = _v$82);
                      _p$.l = web.style(_el$128, _v$83, _p$.l);
                      _v$84 !== _p$.u && (_el$128.disabled = _p$.u = _v$84);
                      _v$85 !== _p$.c && web.setAttribute(_el$128, "title", _p$.c = _v$85);
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
                      u: void 0,
                      c: void 0
                    });
                    return _el$99;
                  })();
                }
              }));
              web.effect((_$p) => web.style(_el$21, cardClip, _$p));
              return _el$21;
            })(), (() => {
              var _el$22 = _tmpl$0(), _el$23 = _el$22.firstChild, _el$24 = _el$23.nextSibling;
              _el$23.$$input = (e) => setAlias(e.currentTarget.value);
              _el$24.$$click = () => void run("add", () => client.add({
                alias: alias()
              }), "已创建，点该账号的「登录」完成授权").then(() => setAlias(""));
              web.effect((_p$) => {
                var _v$10 = `1px solid ${T.border}`, _v$11 = T.layer1, _v$12 = T.base, _v$13 = btnStyle("primary"), _v$14 = busy() === "add";
                _v$10 !== _p$.e && web.setStyleProperty(_el$23, "border", _p$.e = _v$10);
                _v$11 !== _p$.t && web.setStyleProperty(_el$23, "background", _p$.t = _v$11);
                _v$12 !== _p$.a && web.setStyleProperty(_el$23, "color", _p$.a = _v$12);
                _p$.o = web.style(_el$24, _v$13, _p$.o);
                _v$14 !== _p$.i && (_el$24.disabled = _p$.i = _v$14);
                return _p$;
              }, {
                e: void 0,
                t: void 0,
                a: void 0,
                o: void 0,
                i: void 0
              });
              web.effect(() => _el$23.value = alias());
              return _el$22;
            })(), web.createComponent(solidJs.Show, {
              get when() {
                return loginFor();
              },
              get children() {
                var _el$25 = _tmpl$10(), _el$26 = _el$25.firstChild, _el$27 = _el$26.firstChild, _el$28 = _el$27.firstChild, _el$29 = _el$28.firstChild, _el$31 = _el$29.nextSibling;
                _el$31.nextSibling;
                var _el$32 = _el$28.nextSibling, _el$33 = _el$27.nextSibling, _el$34 = _el$26.nextSibling, _el$35 = _el$34.firstChild, _el$36 = _el$35.firstChild, _el$37 = _el$36.nextSibling, _el$38 = _el$35.nextSibling, _el$39 = _el$38.nextSibling, _el$40 = _el$39.firstChild, _el$41 = _el$40.nextSibling, _el$43 = _el$39.nextSibling;
                web.insert(_el$28, loginAlias, _el$31);
                _el$33.$$click = () => void cancelLogin();
                _el$36.addEventListener("focus", (e) => e.currentTarget.select());
                _el$37.$$click = () => void copyLoginUrl();
                web.insert(_el$37, () => loginCopied() ? "已复制" : "复制链接");
                _el$40.$$keydown = (e) => {
                  if (e.key === "Enter") void submitLoginCode();
                };
                _el$40.$$input = (e) => setLoginCode(e.currentTarget.value);
                _el$41.$$click = () => void submitLoginCode();
                web.insert(_el$41, () => busy() === `code-${loginFor()}` ? "校验中" : "完成登录");
                web.insert(_el$34, web.createComponent(solidJs.Show, {
                  get when() {
                    return loginError();
                  },
                  get children() {
                    var _el$42 = _tmpl$1();
                    web.insert(_el$42, loginError);
                    web.effect((_$p) => web.setStyleProperty(_el$42, "color", T.yellow));
                    return _el$42;
                  }
                }), _el$43);
                web.effect((_p$) => {
                  var _v$15 = {
                    ...card
                  }, _v$16 = T.layer2, _v$17 = T.faint, _v$18 = btnStyle(), _v$19 = `11px ${T.mono}`, _v$20 = `1px solid ${T.border}`, _v$21 = T.layer1, _v$22 = T.muted, _v$23 = btnStyle("primary"), _v$24 = T.weak, _v$25 = `1px solid ${T.border}`, _v$26 = T.layer1, _v$27 = T.base, _v$28 = btnStyle("primary"), _v$29 = busy() === `code-${loginFor()}`, _v$30 = T.faint;
                  _p$.e = web.style(_el$25, _v$15, _p$.e);
                  _v$16 !== _p$.t && web.setStyleProperty(_el$26, "background", _p$.t = _v$16);
                  _v$17 !== _p$.a && web.setStyleProperty(_el$32, "color", _p$.a = _v$17);
                  _p$.o = web.style(_el$33, _v$18, _p$.o);
                  _v$19 !== _p$.i && web.setStyleProperty(_el$36, "font", _p$.i = _v$19);
                  _v$20 !== _p$.n && web.setStyleProperty(_el$36, "border", _p$.n = _v$20);
                  _v$21 !== _p$.s && web.setStyleProperty(_el$36, "background", _p$.s = _v$21);
                  _v$22 !== _p$.h && web.setStyleProperty(_el$36, "color", _p$.h = _v$22);
                  _p$.r = web.style(_el$37, _v$23, _p$.r);
                  _v$24 !== _p$.d && web.setStyleProperty(_el$38, "color", _p$.d = _v$24);
                  _v$25 !== _p$.l && web.setStyleProperty(_el$40, "border", _p$.l = _v$25);
                  _v$26 !== _p$.u && web.setStyleProperty(_el$40, "background", _p$.u = _v$26);
                  _v$27 !== _p$.c && web.setStyleProperty(_el$40, "color", _p$.c = _v$27);
                  _p$.w = web.style(_el$41, _v$28, _p$.w);
                  _v$29 !== _p$.m && (_el$41.disabled = _p$.m = _v$29);
                  _v$30 !== _p$.f && web.setStyleProperty(_el$43, "color", _p$.f = _v$30);
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
                  u: void 0,
                  c: void 0,
                  w: void 0,
                  m: void 0,
                  f: void 0
                });
                web.effect(() => _el$36.value = loginUrl());
                web.effect(() => _el$40.value = loginCode());
                return _el$25;
              }
            }), (() => {
              var _el$44 = _tmpl$11();
              web.effect((_$p) => web.style(_el$44, {
                ...label
              }, _$p));
              return _el$44;
            })(), (() => {
              var _el$45 = _tmpl$13(), _el$46 = _el$45.firstChild, _el$47 = _el$46.firstChild, _el$48 = _el$47.firstChild, _el$49 = _el$48.nextSibling, _el$50 = _el$47.nextSibling, _el$51 = _el$50.firstChild, _el$52 = _el$51.firstChild, _el$53 = _el$52.nextSibling, _el$55 = _el$46.nextSibling, _el$56 = _el$55.firstChild, _el$57 = _el$56.firstChild, _el$58 = _el$57.nextSibling, _el$59 = _el$56.nextSibling, _el$60 = _el$55.nextSibling, _el$61 = _el$60.firstChild, _el$62 = _el$61.firstChild, _el$63 = _el$62.nextSibling, _el$64 = _el$61.nextSibling, _el$65 = _el$64.firstChild, _el$66 = _el$65.nextSibling, _el$67 = _el$60.nextSibling, _el$68 = _el$67.firstChild, _el$69 = _el$68.firstChild, _el$70 = _el$69.nextSibling, _el$71 = _el$68.nextSibling, _el$72 = _el$71.firstChild, _el$73 = _el$67.nextSibling, _el$74 = _el$73.firstChild, _el$75 = _el$74.firstChild, _el$76 = _el$75.nextSibling, _el$77 = _el$74.nextSibling, _el$78 = _el$77.firstChild, _el$79 = _el$78.nextSibling, _el$80 = _el$73.nextSibling, _el$81 = _el$80.firstChild, _el$82 = _el$81.firstChild, _el$83 = _el$82.nextSibling, _el$84 = _el$81.nextSibling, _el$85 = _el$84.firstChild, _el$86 = _el$85.nextSibling;
              _el$51.$$click = () => setPicker((v) => !v);
              web.insert(_el$52, () => TIER_LABEL[tier()] ?? tier());
              web.insert(_el$53, () => picker() ? "▲" : "▼");
              web.insert(_el$50, web.createComponent(solidJs.Show, {
                get when() {
                  return picker();
                },
                get children() {
                  var _el$54 = _tmpl$12();
                  web.insert(_el$54, web.createComponent(solidJs.For, {
                    get each() {
                      return groups();
                    },
                    children: (g) => [(() => {
                      var _el$130 = _tmpl$26();
                      web.insert(_el$130, () => g.model);
                      web.effect((_$p) => web.setStyleProperty(_el$130, "color", T.faint));
                      return _el$130;
                    })(), web.createComponent(solidJs.For, {
                      get each() {
                        return g.tiers;
                      },
                      children: ([id, level]) => (() => {
                        var _el$131 = _tmpl$28(), _el$132 = _el$131.firstChild;
                        _el$131.$$click = () => {
                          setPicker(false);
                          setLocal("tier", id);
                          void run("tier", () => client.setDefaultTier({
                            tier: id
                          }), "默认档位已保存");
                        };
                        web.setAttribute(_el$131, "data-tier", id);
                        web.insert(_el$132, level);
                        web.insert(_el$131, web.createComponent(solidJs.Show, {
                          get when() {
                            return id === tier();
                          },
                          get children() {
                            var _el$133 = _tmpl$27();
                            web.effect((_$p) => web.setStyleProperty(_el$133, "color", T.accent));
                            return _el$133;
                          }
                        }), null);
                        web.effect((_p$) => {
                          var _v$86 = id === tier() ? T.layer2 : "transparent", _v$87 = id === tier() ? T.base : T.muted;
                          _v$86 !== _p$.e && web.setStyleProperty(_el$131, "background", _p$.e = _v$86);
                          _v$87 !== _p$.t && web.setStyleProperty(_el$131, "color", _p$.t = _v$87);
                          return _p$;
                        }, {
                          e: void 0,
                          t: void 0
                        });
                        return _el$131;
                      })()
                    })]
                  }));
                  web.effect((_$p) => web.setStyleProperty(_el$54, "border", `1px solid ${T.borderStrong}`));
                  return _el$54;
                }
              }), null);
              web.insert(_el$58, () => {
                var _a;
                return ((_a = ROUTING.find(([v]) => v === data().routing)) == null ? void 0 : _a[2]) ?? "";
              });
              web.insert(_el$59, web.createComponent(solidJs.For, {
                each: ROUTING,
                children: ([value, text]) => (() => {
                  var _el$134 = _tmpl$16();
                  _el$134.$$click = () => run("routing", () => client.setRouting({
                    routing: value
                  }), "路由策略已保存");
                  web.insert(_el$134, text);
                  web.effect((_$p) => web.style(_el$134, {
                    ...btnStyle(),
                    "border-color": data().routing === value ? T.accent : T.border,
                    background: data().routing === value ? "color-mix(in srgb, var(--v2-blue-600, #3b5bdb) 18%, transparent)" : T.btn,
                    color: data().routing === value ? T.base : T.muted
                  }, _$p));
                  return _el$134;
                })()
              }));
              _el$65.addEventListener("change", (e) => {
                const minutes = Number(e.currentTarget.value);
                if (!Number.isFinite(minutes) || minutes < 1) return;
                void run("cooldown", () => client.setCooldown({
                  minutes
                }), "已保存");
              });
              _el$72.addEventListener("change", (e) => {
                void run("context-window", () => client.setContextWindow({
                  tokens: Number(e.currentTarget.value)
                }), "已保存，重载插件后生效");
              });
              _el$78.addEventListener("change", (e) => {
                const minutes = Number(e.currentTarget.value);
                if (!Number.isFinite(minutes) || minutes < 1) return;
                void run("acp-idle", () => client.setAcpLimits({
                  idleMinutes: minutes,
                  maxSessions: data().acpMaxSessions ?? 3
                }), "已保存");
              });
              _el$85.addEventListener("change", (e) => {
                const sessions = Number(e.currentTarget.value);
                if (!Number.isFinite(sessions) || sessions < 1) return;
                void run("acp-max", () => client.setAcpLimits({
                  idleMinutes: data().acpIdleMinutes ?? 10,
                  maxSessions: sessions
                }), "已保存");
              });
              web.effect((_p$) => {
                var _v$31 = card, _v$32 = {
                  ...row
                }, _v$33 = T.faint, _v$34 = {
                  ...btnStyle(),
                  "border-color": T.borderStrong,
                  color: T.base
                }, _v$35 = T.muted, _v$36 = row, _v$37 = T.faint, _v$38 = row, _v$39 = T.faint, _v$40 = `1px solid ${T.border}`, _v$41 = T.layer1, _v$42 = T.base, _v$43 = T.faint, _v$44 = row, _v$45 = T.faint, _v$46 = `1px solid ${T.border}`, _v$47 = T.layer1, _v$48 = T.base, _v$49 = row, _v$50 = T.faint, _v$51 = `1px solid ${T.border}`, _v$52 = T.layer1, _v$53 = T.base, _v$54 = T.faint, _v$55 = row, _v$56 = T.faint, _v$57 = `1px solid ${T.border}`, _v$58 = T.layer1, _v$59 = T.base, _v$60 = T.faint;
                _p$.e = web.style(_el$45, _v$31, _p$.e);
                _p$.t = web.style(_el$46, _v$32, _p$.t);
                _v$33 !== _p$.a && web.setStyleProperty(_el$49, "color", _p$.a = _v$33);
                _p$.o = web.style(_el$51, _v$34, _p$.o);
                _v$35 !== _p$.i && web.setStyleProperty(_el$53, "color", _p$.i = _v$35);
                _p$.n = web.style(_el$55, _v$36, _p$.n);
                _v$37 !== _p$.s && web.setStyleProperty(_el$58, "color", _p$.s = _v$37);
                _p$.h = web.style(_el$60, _v$38, _p$.h);
                _v$39 !== _p$.r && web.setStyleProperty(_el$63, "color", _p$.r = _v$39);
                _v$40 !== _p$.d && web.setStyleProperty(_el$65, "border", _p$.d = _v$40);
                _v$41 !== _p$.l && web.setStyleProperty(_el$65, "background", _p$.l = _v$41);
                _v$42 !== _p$.u && web.setStyleProperty(_el$65, "color", _p$.u = _v$42);
                _v$43 !== _p$.c && web.setStyleProperty(_el$66, "color", _p$.c = _v$43);
                _p$.w = web.style(_el$67, _v$44, _p$.w);
                _v$45 !== _p$.m && web.setStyleProperty(_el$70, "color", _p$.m = _v$45);
                _v$46 !== _p$.f && web.setStyleProperty(_el$72, "border", _p$.f = _v$46);
                _v$47 !== _p$.y && web.setStyleProperty(_el$72, "background", _p$.y = _v$47);
                _v$48 !== _p$.g && web.setStyleProperty(_el$72, "color", _p$.g = _v$48);
                _p$.p = web.style(_el$73, _v$49, _p$.p);
                _v$50 !== _p$.b && web.setStyleProperty(_el$76, "color", _p$.b = _v$50);
                _v$51 !== _p$.T && web.setStyleProperty(_el$78, "border", _p$.T = _v$51);
                _v$52 !== _p$.A && web.setStyleProperty(_el$78, "background", _p$.A = _v$52);
                _v$53 !== _p$.O && web.setStyleProperty(_el$78, "color", _p$.O = _v$53);
                _v$54 !== _p$.I && web.setStyleProperty(_el$79, "color", _p$.I = _v$54);
                _p$.S = web.style(_el$80, _v$55, _p$.S);
                _v$56 !== _p$.W && web.setStyleProperty(_el$83, "color", _p$.W = _v$56);
                _v$57 !== _p$.C && web.setStyleProperty(_el$85, "border", _p$.C = _v$57);
                _v$58 !== _p$.B && web.setStyleProperty(_el$85, "background", _p$.B = _v$58);
                _v$59 !== _p$.v && web.setStyleProperty(_el$85, "color", _p$.v = _v$59);
                _v$60 !== _p$.k && web.setStyleProperty(_el$86, "color", _p$.k = _v$60);
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
                u: void 0,
                c: void 0,
                w: void 0,
                m: void 0,
                f: void 0,
                y: void 0,
                g: void 0,
                p: void 0,
                b: void 0,
                T: void 0,
                A: void 0,
                O: void 0,
                I: void 0,
                S: void 0,
                W: void 0,
                C: void 0,
                B: void 0,
                v: void 0,
                k: void 0
              });
              web.effect(() => _el$65.value = Math.round((data().cooldownMs ?? 9e5) / 6e4));
              web.effect(() => _el$72.value = (data().contextWindow ?? 256e3) >= 9e5 ? "983040" : "256000");
              web.effect(() => _el$78.value = data().acpIdleMinutes ?? 10);
              web.effect(() => _el$85.value = data().acpMaxSessions ?? 3);
              return _el$45;
            })(), (() => {
              var _el$87 = _tmpl$14(), _el$88 = _el$87.firstChild, _el$89 = _el$88.firstChild, _el$90 = _el$89.nextSibling, _el$91 = _el$90.firstChild, _el$92 = _el$91.nextSibling, _el$93 = _el$88.nextSibling;
              web.insert(_el$90, (() => {
                var _c$2 = web.memo(() => {
                  var _a;
                  return !!((_a = activeAccount()) == null ? void 0 : _a.usageCheckedAt);
                });
                return () => _c$2() ? ` · ${ago(activeAccount().usageCheckedAt, now())}` : "";
              })(), null);
              _el$93.$$click = () => run("usage", () => client.usage({
                id: data().activeAccountId
              }), "额度已刷新");
              web.insert(_el$93, (() => {
                var _c$3 = web.memo(() => busy() === "usage");
                return () => _c$3() ? `读取中 ${elapsed()}s` : "刷新";
              })());
              web.effect((_p$) => {
                var _v$61 = {
                  ...label
                }, _v$62 = T.faint, _v$63 = `11px ${T.mono}`, _v$64 = btnStyle(), _v$65 = busy() === "usage";
                _p$.e = web.style(_el$87, _v$61, _p$.e);
                _v$62 !== _p$.t && web.setStyleProperty(_el$90, "color", _p$.t = _v$62);
                _v$63 !== _p$.a && web.setStyleProperty(_el$92, "font", _p$.a = _v$63);
                _p$.o = web.style(_el$93, _v$64, _p$.o);
                _v$65 !== _p$.i && (_el$93.disabled = _p$.i = _v$65);
                return _p$;
              }, {
                e: void 0,
                t: void 0,
                a: void 0,
                o: void 0,
                i: void 0
              });
              return _el$87;
            })(), (() => {
              var _el$94 = _tmpl$9();
              web.insert(_el$94, web.createComponent(solidJs.Show, {
                get when() {
                  return activeUsage().length > 0;
                },
                get fallback() {
                  return (() => {
                    var _el$135 = _tmpl$29();
                    web.insert(_el$135, (() => {
                      var _c$5 = web.memo(() => busy() === "usage");
                      return () => _c$5() ? `正在向官方 CLI 读取… 已等待 ${elapsed()} 秒（最长 30 秒，超时会自动停止）` : "暂无数据，点右上角「刷新」读取。官方 CLI 首次读取通常要 10–30 秒。";
                    })());
                    web.effect((_$p) => web.setStyleProperty(_el$135, "color", T.muted));
                    return _el$135;
                  })();
                },
                get children() {
                  return web.createComponent(solidJs.For, {
                    get each() {
                      return activeUsage();
                    },
                    children: (u, i) => (() => {
                      var _el$136 = _tmpl$30(), _el$137 = _el$136.firstChild, _el$138 = _el$137.firstChild, _el$139 = _el$138.nextSibling, _el$140 = _el$139.firstChild, _el$141 = _el$137.nextSibling, _el$142 = _el$141.firstChild, _el$143 = _el$142.firstChild, _el$144 = _el$142.nextSibling, _el$145 = _el$144.firstChild;
                      web.insert(_el$138, () => u.label);
                      web.insert(_el$139, () => u.group, _el$140);
                      web.insert(_el$139, () => resetIn(u.resetAt, now()), null);
                      web.insert(_el$144, () => u.percent, _el$145);
                      web.effect((_p$) => {
                        var _v$88 = i() === 0 ? "none" : `1px solid ${T.border}`, _v$89 = T.faint, _v$90 = T.layer2, _v$91 = `${Math.max(0, Math.min(100, u.percent))}%`, _v$92 = barColor(u.percent), _v$93 = u.percent >= 20 ? T.base : T.red, _v$94 = `12px ${T.mono}`;
                        _v$88 !== _p$.e && web.setStyleProperty(_el$136, "border-top", _p$.e = _v$88);
                        _v$89 !== _p$.t && web.setStyleProperty(_el$139, "color", _p$.t = _v$89);
                        _v$90 !== _p$.a && web.setStyleProperty(_el$142, "background", _p$.a = _v$90);
                        _v$91 !== _p$.o && web.setStyleProperty(_el$143, "width", _p$.o = _v$91);
                        _v$92 !== _p$.i && web.setStyleProperty(_el$143, "background", _p$.i = _v$92);
                        _v$93 !== _p$.n && web.setStyleProperty(_el$144, "color", _p$.n = _v$93);
                        _v$94 !== _p$.s && web.setStyleProperty(_el$144, "font", _p$.s = _v$94);
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
                      return _el$136;
                    })()
                  });
                }
              }), null);
              web.insert(_el$94, web.createComponent(solidJs.Show, {
                get when() {
                  return web.memo(() => {
                    var _a;
                    return !!((_a = activeAccount()) == null ? void 0 : _a.usageError);
                  })() && busy() !== "usage";
                },
                get children() {
                  var _el$95 = _tmpl$15(), _el$96 = _el$95.firstChild, _el$97 = _el$96.nextSibling;
                  web.insert(_el$95, () => activeAccount().usageError, _el$97);
                  web.effect((_p$) => {
                    var _v$66 = `1px solid ${T.border}`, _v$67 = T.yellow, _v$68 = T.faint;
                    _v$66 !== _p$.e && web.setStyleProperty(_el$95, "border-top", _p$.e = _v$66);
                    _v$67 !== _p$.t && web.setStyleProperty(_el$95, "color", _p$.t = _v$67);
                    _v$68 !== _p$.a && web.setStyleProperty(_el$97, "color", _p$.a = _v$68);
                    return _p$;
                  }, {
                    e: void 0,
                    t: void 0,
                    a: void 0
                  });
                  return _el$95;
                }
              }), null);
              web.effect((_$p) => web.style(_el$94, card, _$p));
              return _el$94;
            })()]
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
    const providerSettings = await Promise.resolve().then(() => settings);
    const logins = /* @__PURE__ */ new Map();
    function stopLogin(id) {
      var _a;
      const session = logins.get(id);
      if (!session) return;
      clearTimeout(session.timer);
      try {
        (_a = session.child.stdin) == null ? void 0 : _a.end();
      } catch {
      }
      try {
        session.child.kill();
      } catch {
      }
      logins.delete(id);
    }
    function authUrlOf(text) {
      const match = text.match(/https:\/\/accounts\.google\.com\/[^\s"'<>]+/);
      return match ? match[0] : null;
    }
    function snapshot() {
      const data = accounts$1.loadAccounts();
      const settings2 = providerSettings.settingsFromEnv();
      const enriched = data.accounts.map((a) => {
        const ident = accounts$1.readIdentity(a);
        const email = ident.email ?? a.email;
        const automaticAlias = a.id === "system" || /^账号\s*\d+$/.test(a.alias);
        return {
          ...a,
          alias: automaticAlias && email ? email : a.alias,
          email,
          name: ident.name ?? a.name
        };
      });
      const ordered = [...enriched].sort((a, b) => {
        const rank = (row2) => row2.id === data.activeAccountId ? 0 : 1;
        return rank(a) - rank(b);
      });
      return {
        activeAccountId: data.activeAccountId,
        defaultTier: data.defaultTier,
        routing: data.routing,
        cooldownMs: data.cooldownMs,
        agentMode: settings2.agentMode,
        autoApproveNative: settings2.autoApproveNative,
        acpIdleMinutes: settings2.acpIdleMinutes,
        acpMaxSessions: settings2.acpMaxSessions,
        contextWindow: settings2.contextWindow,
        nextAccountId: accounts$1.pickAccount(data).id,
        accounts: ordered
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
      setAgentMode: async ({
        mode
      }) => {
        if (mode !== "native" && mode !== "bridged") return false;
        providerSettings.writeSettings({
          agentMode: mode
        });
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
      setAcpLimits: async ({
        idleMinutes,
        maxSessions
      }) => {
        const idle = Math.max(1, Math.min(1440, Math.round(idleMinutes)));
        const max = Math.max(1, Math.min(16, Math.round(maxSessions)));
        providerSettings.writeSettings({
          acpIdleMinutes: idle,
          acpMaxSessions: max
        });
        return true;
      },
      setContextWindow: async ({
        tokens
      }) => {
        const next = tokens >= 9e5 ? 983040 : 256e3;
        providerSettings.writeSettings({
          contextWindow: next
        });
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
        if (!acc) throw new Error(`账号不存在：${id}`);
        stopLogin(id);
        const {
          spawn
        } = await import("node:child_process");
        const env = {
          ...process.env,
          ...accounts$1.accountEnv(acc)
        };
        const child = spawn("agy", ["acp", "--login"], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: true,
          windowsHide: true
        });
        const session = {
          child,
          output: "",
          timer: setTimeout(() => stopLogin(id), 10 * 60 * 1e3)
        };
        logins.set(id, session);
        return new Promise((resolve, reject) => {
          var _a, _b;
          let settled = false;
          const finish = (fn) => {
            if (settled) return;
            settled = true;
            fn();
          };
          const onData = (chunk) => {
            session.output += chunk.toString("utf8");
            const url = authUrlOf(session.output);
            if (url) finish(() => resolve({
              url
            }));
          };
          (_a = child.stdout) == null ? void 0 : _a.on("data", onData);
          (_b = child.stderr) == null ? void 0 : _b.on("data", onData);
          child.on("error", (err) => finish(() => {
            stopLogin(id);
            reject(err);
          }));
          child.on("exit", () => finish(() => {
            const url = authUrlOf(session.output);
            if (url) {
              resolve({
                url
              });
              return;
            }
            stopLogin(id);
            reject(new Error(`agy 没有返回登录链接：${session.output.trim().slice(0, 200) || "无输出"}`));
          }));
          setTimeout(() => finish(() => {
            stopLogin(id);
            reject(new Error("等待登录链接超时（20 秒）"));
          }), 2e4);
        });
      },
      loginCode: async ({
        id,
        code
      }) => {
        var _a;
        const session = logins.get(id);
        if (!session) return {
          ok: false,
          error: "没有进行中的登录，请先点账号上的「登录」。"
        };
        const value = code.trim();
        if (!value) return {
          ok: false,
          error: "请先粘贴授权码或回调页面地址。"
        };
        const exitCode = await new Promise((resolve) => {
          var _a2;
          const timer = setTimeout(() => resolve(null), 6e4);
          session.child.once("exit", (code2) => {
            clearTimeout(timer);
            resolve(typeof code2 === "number" ? code2 : 1);
          });
          try {
            (_a2 = session.child.stdin) == null ? void 0 : _a2.write(`${value}
`);
          } catch {
            clearTimeout(timer);
            resolve(1);
          }
        });
        const output = session.output;
        stopLogin(id);
        if (exitCode === null) return {
          ok: false,
          error: "等待 Google 校验超时（60 秒），请重新点「登录」。"
        };
        if (exitCode !== 0) {
          const last = output.trim().split(/\r?\n/).filter(Boolean).pop();
          return {
            ok: false,
            error: (last ?? "登录失败，请重新复制链接后再试。").slice(0, 300)
          };
        }
        const next = accounts$1.loadAccounts();
        const target = next.accounts.find((a) => a.id === id);
        if (target) {
          const ident = accounts$1.readIdentity(target);
          target.email = ident.email ?? target.email;
          target.name = ident.name ?? target.name;
          target.checkedAt = Date.now();
          accounts$1.saveAccounts(next);
        }
        const email = (_a = accounts$1.loadAccounts().accounts.find((a) => a.id === id)) == null ? void 0 : _a.email;
        return {
          ok: true,
          email
        };
      },
      loginCancel: async ({
        id
      }) => {
        stopLogin(id);
        return true;
      }
    });
  }
});
web.delegateEvents(["input", "click", "keydown"]);
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
    LOCALAPPDATA: node_path.join(account.home, "AppData", "Local"),
    SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 22"
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
      email: typeof (data == null ? void 0 : data.id_token_email) === "string" && data.id_token_email.trim() ? data.id_token_email.trim() : typeof (payload == null ? void 0 : payload.email) === "string" ? payload.email : void 0,
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
  const data = loadAccounts();
  const target = data.accounts.find((a) => a.id === id);
  if (!target) return false;
  if (data.accounts.length <= 1) return false;
  data.accounts = data.accounts.filter((a) => a.id !== id);
  if (data.activeAccountId === id) data.activeAccountId = (data.accounts.find((a) => a.enabled) ?? data.accounts[0]).id;
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
const DEFAULT_TURN_LIMITS = {
  maxToolCalls: 200,
  maxTurnMs: 20 * 6e4,
  maxRepeatedResults: 8
};
const ENFORCED_CONTEXT_WINDOW = 256e3;
const UNLOCKED_CONTEXT_WINDOW = 983040;
const DEFAULTS = {
  agentMode: "native",
  autoApproveNative: true,
  contextWindow: ENFORCED_CONTEXT_WINDOW,
  reuseSessions: true,
  acpIdleMinutes: 10,
  acpMaxSessions: 3,
  taskBudget: DEFAULT_TURN_LIMITS,
  windowsMultilineShell: false
};
function settingsPath() {
  return node_path.join(node_os.homedir(), ".config", "opencode", "agy", "settings.json");
}
function readSettings(path = settingsPath()) {
  var _a, _b, _c;
  try {
    if (!node_fs.existsSync(path)) return { ...DEFAULTS };
    const raw = JSON.parse(node_fs.readFileSync(path, "utf8"));
    return {
      agentMode: raw.agentMode === "bridged" ? "bridged" : "native",
      autoApproveNative: raw.autoApproveNative !== false,
      contextWindow: typeof raw.contextWindow === "number" && raw.contextWindow > 0 ? raw.contextWindow : DEFAULTS.contextWindow,
      reuseSessions: raw.reuseSessions !== false,
      windowsMultilineShell: raw.windowsMultilineShell === true,
      taskBudget: {
        maxToolCalls: positive((_a = raw.taskBudget) == null ? void 0 : _a.maxToolCalls, DEFAULT_TURN_LIMITS.maxToolCalls, 1e4),
        maxTurnMs: positive((_b = raw.taskBudget) == null ? void 0 : _b.maxTurnMs, DEFAULT_TURN_LIMITS.maxTurnMs, 24 * 60 * 6e4),
        maxRepeatedResults: positive((_c = raw.taskBudget) == null ? void 0 : _c.maxRepeatedResults, DEFAULT_TURN_LIMITS.maxRepeatedResults, 1e4)
      },
      acpIdleMinutes: typeof raw.acpIdleMinutes === "number" && raw.acpIdleMinutes >= 1 ? Math.min(1440, Math.round(raw.acpIdleMinutes)) : DEFAULTS.acpIdleMinutes,
      acpMaxSessions: typeof raw.acpMaxSessions === "number" && raw.acpMaxSessions >= 1 ? Math.min(16, Math.round(raw.acpMaxSessions)) : DEFAULTS.acpMaxSessions
    };
  } catch {
    return { ...DEFAULTS };
  }
}
function writeSettings(next, path = settingsPath()) {
  const merged = { ...readSettings(path), ...next };
  try {
    node_fs.mkdirSync(node_path.dirname(path), { recursive: true });
    node_fs.writeFileSync(path, JSON.stringify(merged, null, 2), "utf8");
  } catch {
  }
  return merged;
}
function settingsFromEnv(env = process.env) {
  const base = readSettings();
  const mode = env.AGY_AGENT_MODE;
  if (mode === "native" || mode === "bridged") base.agentMode = mode;
  if (env.AGY_CONTEXT_WINDOW) {
    const n = Number(env.AGY_CONTEXT_WINDOW);
    if (Number.isFinite(n) && n > 0) base.contextWindow = n;
  }
  if (env.AGY_AUTO_APPROVE === "0") base.autoApproveNative = false;
  base.taskBudget = {
    maxToolCalls: positive(env.AGY_MAX_TOOL_CALLS, base.taskBudget.maxToolCalls, 1e4),
    maxTurnMs: positive(env.AGY_MAX_TURN_MS, base.taskBudget.maxTurnMs, 24 * 60 * 6e4),
    maxRepeatedResults: positive(env.AGY_MAX_REPEATED_RESULTS, base.taskBudget.maxRepeatedResults, 1e4)
  };
  return base;
}
function positive(value, fallback, maximum) {
  if (value === void 0 || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= maximum ? n : fallback;
}
const settings = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  ENFORCED_CONTEXT_WINDOW,
  UNLOCKED_CONTEXT_WINDOW,
  readSettings,
  settingsFromEnv,
  settingsPath,
  writeSettings
}, Symbol.toStringTag, { value: "Module" }));
exports.default = gui;
