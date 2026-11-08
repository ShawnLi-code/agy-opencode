import { Plugin, SettingsPage } from "@opencode/plugin/gui";
import { AgyAccounts } from "./contract";
import { createResource, createSignal, createMemo, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { createStore } from "solid-js/store";

/**
 * agy-opencode GUI half.
 *
 * - `setup` runs in every desktop window and contributes the settings page.
 * - `main` runs once in the desktop app's main process: it owns accounts.json
 *   and spawns `agy models` to probe an account.
 *
 * Styling uses the host's own `--v2-*` design tokens so the page matches the
 * app instead of shipping its own palette.
 */

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
  mono: "var(--v2-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)",
};

/** Model families, in display order, each with its thinking levels. */
const TIER_GROUPS: ReadonlyArray<{ model: string; tiers: ReadonlyArray<[string, string]> }> = [
  {
    model: "Gemini 4 Argon",
    tiers: [
      ["argon-4-lo", "Low"],
      ["argon-4-med", "Medium"],
      ["argon-4-hi", "High"],
    ],
  },
  {
    model: "Gemini 3.8 Flash",
    tiers: [
      ["flash-3.8-lo", "Low"],
      ["flash-3.8-med", "Medium"],
      ["flash-3.8-hi", "High"],
    ],
  },
  {
    model: "Claude Sonnet 5.5",
    tiers: [
      ["claude-sonnet-5-5-lo", "Low"],
      ["claude-sonnet-5-5-med", "Medium"],
      ["claude-sonnet-5-5-hi", "High"],
    ],
  },
  {
    model: "Claude Opus 5.5",
    tiers: [
      ["claude-opus-5-5-lo", "Low"],
      ["claude-opus-5-5-med", "Medium"],
      ["claude-opus-5-5-hi", "High"],
    ],
  },
  { model: "GPT-OSS 120B", tiers: [["gpt-oss-med", "Medium"]] },
];

const TIER_LABEL: Record<string, string> = Object.fromEntries(
  TIER_GROUPS.flatMap((g) => g.tiers.map(([id, level]) => [id, `${g.model} (${level})`])),
);

/** Maps an `agy models` id to the tool's tier name. */
const MODEL_TO_TIER: Record<string, string> = {
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
  "gpt-oss-120b-medium": "gpt-oss-med",
};

function allowedTiers(models: string[] | undefined): Set<string> | null {
  if (!models || models.length === 0) return null;
  const set = new Set(models.map((m) => MODEL_TO_TIER[m]).filter(Boolean));
  return set.size > 0 ? set : null;
}

const ROUTING: ReadonlyArray<[string, string, string]> = [
  ["active", "固定", "始终使用所选账号"],
  ["sequential", "顺序", "按列表顺序，到量才换下一个"],
  ["roundrobin", "轮询", "优先最久未使用的账号"],
];

function ago(ts: number | undefined, now: number): string {
  if (!ts) return "未调用";
  const mins = Math.max(0, Math.floor((now - ts) / 60000));
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

const label: Record<string, any> = {
  "font-size": "12px",
  color: T.muted,
  "margin-bottom": "8px",
  "letter-spacing": "0.01em",
};

const card: Record<string, any> = {
  background: T.layer1,
  border: `1px solid ${T.border}`,
  "border-radius": "10px",
};

/** Same card, but clipped - only for lists with rounded rows and no popovers. */
const cardClip: Record<string, any> = { ...card, overflow: "hidden" };

const row: Record<string, any> = {
  display: "grid",
  "grid-template-columns": "minmax(120px, 190px) 1fr",
  "align-items": "center",
  gap: "16px",
  padding: "11px 14px",
  "border-top": `1px solid ${T.border}`,
};

function chip(on: boolean | undefined, text: string) {
  return (
    <span
      style={{
        "font-size": "11px",
        "line-height": "18px",
        padding: "0 7px",
        "border-radius": "5px",
        border: `1px solid ${on ? "transparent" : T.border}`,
        background: on ? "color-mix(in srgb, var(--v2-green-600, #4ec98d) 16%, transparent)" : T.layer2,
        color: on ? T.green : T.faint,
        "font-weight": on ? 500 : 400,
      }}
    >
      {text}
    </span>
  );
}

function btnStyle(kind: "plain" | "primary" | "danger" = "plain"): Record<string, any> {
  if (kind === "primary") {
    return {
      "font-size": "12px",
      padding: "5px 11px",
      "border-radius": "6px",
      border: "1px solid transparent",
      background: "var(--v2-background-bg-accent, #3b5bdb)",
      color: "var(--v2-text-text-inverse, #fff)",
      cursor: "pointer",
    };
  }
  return {
    "font-size": "12px",
    padding: "5px 10px",
    "border-radius": "6px",
    border: `1px solid ${T.border}`,
    background: T.btn,
    color: kind === "danger" ? T.red : T.base,
    cursor: "pointer",
  };
}

export default Plugin.define({
  setup(ctx) {
    const client = ctx.main(AgyAccounts);

    ctx.add(SettingsPage, {
      id: "agy",
      title: "Antigravity",
      entries: [
        { id: "agy.accounts", title: "Antigravity 账号", description: "多账号、默认模型、路由与额度" },
        { id: "agy.add", title: "添加账号", description: "创建独立 HOME 并登录 Google" },
      ],
      render() {
        const [state, { refetch }] = createResource(() => client.read());
        const [busy, setBusy] = createSignal("");
        const [alias, setAlias] = createSignal("");
        const [msg, setMsg] = createSignal("");
        const [picker, setPicker] = createSignal(false);
        const [now, setNow] = createSignal(Date.now());
        const [elapsed, setElapsed] = createSignal(0);
        const [loginFor, setLoginFor] = createSignal("");
        const [loginUrl, setLoginUrl] = createSignal("");
        const [loginCode, setLoginCode] = createSignal("");
        const [loginError, setLoginError] = createSignal("");
        const [loginCopied, setLoginCopied] = createSignal(false);
        const [local, setLocal] = createStore<{ tier: string }>({ tier: "" });

        onMount(() => {
          const t = setInterval(() => setNow(Date.now()), 20_000);
          onCleanup(() => clearInterval(t));
        });

        // Elapsed seconds while a quota read is in flight: `agy --print=/usage`
        // can take a while, and a silent "读取中" looks like a hang.
        createEffect(() => {
          if (busy() !== "usage") {
            setElapsed(0);
            return;
          }
          const started = Date.now();
          const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
          onCleanup(() => clearInterval(t));
        });

        const allowed = createMemo(() => {
          const s = state();
          const active = s?.accounts.find((a) => a.id === s.activeAccountId);
          return allowedTiers(active?.models);
        });

        const groups = createMemo(() =>
          TIER_GROUPS.map((g) => ({
            model: g.model,
            tiers: g.tiers.filter(([id]) => !allowed() || allowed()!.has(id)),
          })).filter((g) => g.tiers.length > 0),
        );

        const tierOptions = createMemo(() => groups().flatMap((g) => g.tiers.map(([id]) => id)));

        const tier = createMemo(() => {
          const wanted = local.tier || state()?.defaultTier || "argon-4-lo";
          const opts = tierOptions();
          return opts.includes(wanted) ? wanted : (opts[0] ?? wanted);
        });

        const activeAccount = createMemo(() => {
          const s = state();
          return s?.accounts.find((a) => a.id === s.activeAccountId);
        });

        const activeUsage = createMemo(() => activeAccount()?.usage ?? []);

        // Quota reads can take 30 seconds. Do not start one automatically:
        // it used to occupy the shared busy state and silently block all buttons.

        function barColor(percent: number): string {
          if (percent >= 50) return T.green;
          if (percent >= 20) return T.yellow;
          return T.red;
        }

        function resetIn(iso: string, now: number): string {
          const t = Date.parse(iso);
          if (!Number.isFinite(t)) return iso;
          const mins = Math.round((t - now) / 60000);
          if (mins <= 0) return "已重置";
          if (mins < 60) return `${mins} 分钟后`;
          const hours = Math.floor(mins / 60);
          if (hours < 48) return `${hours} 小时后`;
          return `${Math.floor(hours / 24)} 天后`;
        }

        async function run(key: string, fn: () => Promise<unknown>, okMsg?: string) {
          if (busy()) { setMsg("另一项操作正在进行，请稍候。"); return; }
          setBusy(key);
          setMsg("");
          try {
            const result = await fn();
            if (result === false) throw new Error("操作未完成，请检查账号状态后重试。");
            if (okMsg) setMsg(okMsg);
            await refetch();
          } catch (e: any) {
            const raw = String(e?.message ?? e);
            // A method added to the IPC spec only exists after the app's main
            // process restarts: the provider object is created once at launch.
            setMsg(
              /no method/i.test(raw)
                ? "需要重启一次 App：主进程的 IPC 方法只在启动时注册，热更新不会补上。"
                : /usage TIMEOUT/i.test(raw)
                  ? "额度读取超时：官方 CLI 30 秒内没有返回（agy 无响应或网络慢），稍后再试。"
                  : `失败：${raw.slice(0, 200)}`,
            );
          } finally {
            setBusy("");
          }
        }

        // ---- Google sign-in -------------------------------------------------
        // The CLI prints an OAuth link and waits for the pasted code. We show
        // that link instead of letting agy pick a browser: the user can open it
        // in the browser profile that is already signed in (ego, Chrome, ...).
        async function startLogin(id: string) {
          if (busy()) { setMsg("另一项操作正在进行，请稍候。"); return; }
          setBusy(`login-${id}`);
          setMsg("");
          setLoginError("");
          try {
            const { url } = await client.login({ id });
            setLoginFor(id);
            setLoginUrl(url);
            setLoginCode("");
            setLoginCopied(false);
          } catch (e: any) {
            setMsg(`无法启动登录：${String(e?.message ?? e).slice(0, 200)}`);
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
            const result = await client.loginCode({ id, code });
            if (!result.ok) {
              setLoginError(result.error ?? "登录失败，请重新复制链接后再试。");
              return;
            }
            setLoginFor("");
            setLoginUrl("");
            setLoginCode("");
            setMsg(`登录成功${result.email ? `：${result.email}` : ""}`);
            await refetch();
          } catch (e: any) {
            setLoginError(String(e?.message ?? e).slice(0, 300));
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
            await client.loginCancel({ id });
          } catch {
            /* the CLI may already be gone */
          }
        }

        const loginAlias = createMemo(() => {
          const id = loginFor();
          return state()?.accounts.find((a) => a.id === id)?.alias ?? id;
        });

        return (
          <div style={{ padding: "22px 26px 40px", color: T.base, "font-size": "13px", "max-width": "900px" }}>
            <div style={{ "margin-bottom": "22px" }}>
              <h1 style={{ "font-size": "16px", "font-weight": 600, margin: "0 0 6px" }}>Antigravity</h1>
              <p style={{ color: T.muted, margin: 0, "line-height": 1.55, "font-size": "12.5px" }}>
                把 Antigravity 接成 OpenCode 的模型供应商：在模型里选{" "}
                <code style={{ font: `11.5px ${T.mono}`, color: T.accent }}>agy-cli</code> 就能直接当主模型用，
                也可以用 <code style={{ font: `11.5px ${T.mono}`, color: T.accent }}>agy</code>{" "}
                工具把任务交给它跑。每个账号用独立 HOME 目录隔离凭证，互不影响。
              </p>
            </div>

            <Show when={state.error}>
              <div style={{ color: T.red, "margin-bottom": "14px", "font-size": "12px" }}>读取失败：{String(state.error)}</div>
            </Show>
            <Show when={msg()}>
              <div role="status" style={{ color: T.muted, "margin-bottom": "14px", "font-size": "12px" }}>{msg()}</div>
            </Show>

            <Show when={state()}>
              {(data) => (
                <>
                  <div style={{ ...label, "margin-top": "26px" }}>工具执行方式</div>
                  <div style={{ ...cardClip, padding: "14px" }}>
                    <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
                      <For each={[["bridged", "OpenCode 工具"], ["native", "agy 原生工具"]]}>
                        {([mode, title]) => (
                          <button style={{ ...btnStyle(), "border-color": data().agentMode === mode ? T.accent : T.border }}
                            disabled={busy() === "mode"}
                            onClick={() => run("mode", () => client.setAgentMode({ mode }), "执行方式已保存，新请求生效")}>{title}</button>
                        )}
                      </For>
                    </div>
                    <p style={{ color: T.muted, "font-size": "12px", "line-height": 1.6, margin: "10px 0 0" }}>
                      {data().agentMode === "native"
                        ? (data().autoApproveNative ? "当前：agy 自己执行工具并自动批准权限，不受 OpenCode 权限和沙箱约束。" : "当前：agy 自己执行工具；自动批准已关闭，不受 OpenCode 权限和沙箱约束。")
                        : "当前：通过 MCP 交给 OpenCode 执行工具，使用 OpenCode 权限控制。"}
                    </p>
                  </div>
                  {/* ---------------- 账号 ---------------- */}
                  <div style={{ ...label, "margin-top": "26px" }}>账号</div>
                  <div style={{ color: T.muted, "font-size": "12px", "margin-bottom": "8px" }}>
                    下次路由：{data().accounts.find((a) => a.id === (data().nextAccountId || data().activeAccountId))?.alias ?? "未确定"}（实际请求时重新选择）
                  </div>
                  <div style={cardClip}>
                    <For each={data().accounts}>
                      {(acc) => {
                        const left = Math.max(0, Math.ceil(((acc.cooldownUntil ?? 0) - now()) / 60000));
                        const cooling = left > 0;
                        const isActive = acc.id === data().activeAccountId;
                        return (
                          <div
                            style={{
                              display: "flex",
                              "align-items": "flex-start",
                              gap: "14px",
                              padding: "12px 14px",
                              "border-top": acc === data().accounts[0] ? "none" : `1px solid ${T.border}`,
                              background: isActive ? T.layer2 : "transparent",
                            }}
                          >
                            <div style={{ "min-width": 0, flex: "1" }}>
                              <div style={{ display: "flex", "align-items": "baseline", gap: "8px", "min-width": 0 }}>
                                <span
                                  style={{
                                    width: "6px",
                                    height: "6px",
                                    "border-radius": "50%",
                                    "flex-shrink": 0,
                                    transform: "translateY(-2px)",
                                    background: cooling ? T.yellow : isActive ? T.green : T.faint,
                                  }}
                                />
                                <span
                                  style={{
                                    "font-weight": 500,
                                    "font-size": "13px",
                                    "white-space": "nowrap",
                                    overflow: "hidden",
                                    "text-overflow": "ellipsis",
                                  }}
                                >
                                  {acc.alias}
                                </span>
                                <Show when={isActive}>
                                  <span style={{ "font-size": "10.5px", color: T.accent, "flex-shrink": 0 }}>默认</span>
                                </Show>
                                <Show when={cooling}>
                                  <span style={{ color: T.yellow, "font-size": "11px", "flex-shrink": 0 }}>冷却剩 {left} 分</span>
                                </Show>
                              </div>

                              <div style={{ "margin-top": "4px", display: "flex", gap: "7px", "align-items": "center", "flex-wrap": "wrap" }}>
                                <Show
                                  when={acc.email}
                                  fallback={
                                    <span style={{ color: T.faint, "font-size": "11px" }}>
                                      {acc.id === "system" ? "未读取到登录账号" : "未登录 · 点「登录」授权"}
                                    </span>
                                  }
                                >
                                  <span style={{ color: T.muted, font: `11.5px ${T.mono}` }}>{acc.alias === acc.email ? "" : acc.email}{acc.id === "system" ? "（本地 token，系统钥匙串可能不同）" : ""}</span>
                                </Show>
                                <span style={{ color: T.faint, "font-size": "10px" }} title={acc.id}>
                                  {acc.id}
                                </span>
                              </div>

                              <div style={{ display: "flex", gap: "5px", "margin-top": "8px", "flex-wrap": "wrap" }}>
                                {chip(acc.argon, "Argon")}
                                {chip(acc.claude, "Claude")}
                                {chip(acc.flash, "Flash")}
                              </div>

                              <div style={{ "margin-top": "8px", color: T.weak, "font-size": "11.5px", "line-height": 1.5 }}>
                                调用 {acc.calls ?? 0} · 失败 {acc.failures ?? 0} · 最近 {ago(acc.lastUsedAt, now())}
                                <Show when={acc.checkedAt}>
                                  <span style={{ color: T.faint }}> · 探测 {ago(acc.checkedAt, now())}</span>
                                </Show>
                                <Show when={acc.lastError}>
                                  <span style={{ color: T.yellow }}> · 上次 {acc.lastError}</span>
                                </Show>
                              </div>
                            </div>

                            <div style={{ display: "flex", gap: "6px", "flex-shrink": 0, "flex-wrap": "wrap", "justify-content": "flex-end", "max-width": "210px" }}>
                              <button
                                style={btnStyle()}
                                disabled={busy() === acc.id}
                                onClick={() => run(acc.id, () => client.probe({ id: acc.id }), "探测完成")}
                              >
                                {busy() === acc.id ? "探测中" : "探测"}
                              </button>
                              <button
                                style={btnStyle()}
                                disabled={busy() === `login-${acc.id}`}
                                onClick={() => void startLogin(acc.id)}
                              >
                                {busy() === `login-${acc.id}` ? "准备中" : "登录"}
                              </button>
                              <Show when={cooling}>
                                <button
                                  style={btnStyle()}
                                  onClick={() => run(`cd-${acc.id}`, () => client.clearCooldown({ id: acc.id }), "已解除冷却")}
                                >
                                  解除
                                </button>
                              </Show>
                              <Show when={!isActive}>
                                  <button
                                    style={btnStyle()}
                                    onClick={() => run(acc.id, () => client.setActive({ id: acc.id }), "已切换默认账号")}
                                  >
                                    设为默认
                                  </button>
                              </Show>
                                <button
                                  style={btnStyle("danger")}
                                  disabled={data().accounts.length <= 1}
                                  title={acc.id === "system" ? "仅移除插件内的入口，不删除系统登录凭证" : "仅移除插件内的账号入口"}
                                  onClick={() => {
                                    if (window.confirm(acc.id === "system" ? "移除系统账号入口？不会删除系统登录凭证。" : "移除此账号入口？不会删除登录凭证。"))
                                      void run(acc.id, () => client.remove({ id: acc.id }), "账号入口已移除");
                                  }}
                                >
                                  删除
                                </button>
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </div>

                  <div style={{ display: "flex", gap: "8px", "margin-top": "10px" }}>
                    <input
                      placeholder="新账号备注，例如「备用 Google 账号」"
                      value={alias()}
                      onInput={(e) => setAlias(e.currentTarget.value)}
                      style={{
                        flex: "1",
                        "font-size": "12px",
                        padding: "6px 10px",
                        "border-radius": "6px",
                        border: `1px solid ${T.border}`,
                        background: T.layer1,
                        color: T.base,
                        outline: "none",
                      }}
                    />
                    <button
                      style={btnStyle("primary")}
                      disabled={busy() === "add"}
                      onClick={() =>
                        void run("add", () => client.add({ alias: alias() }), "已创建，点该账号的「登录」完成授权").then(() =>
                          setAlias(""),
                        )
                      }
                    >
                      添加账号
                    </button>
                  </div>

                  {/* ---------------- Google 登录 ---------------- */}
                  <Show when={loginFor()}>
                    <div style={{ ...card, "margin-top": "12px", overflow: "hidden" }}>
                      <div
                        style={{
                          display: "flex",
                          "align-items": "center",
                          "justify-content": "space-between",
                          gap: "12px",
                          padding: "12px 14px",
                          background: T.layer2,
                        }}
                      >
                        <div>
                          <div style={{ "font-size": "12.5px" }}>登录「{loginAlias()}」</div>
                          <div style={{ color: T.faint, "font-size": "11px", "margin-top": "2px" }}>
                            不会自动弹浏览器：请在你已经登录 Google 的浏览器里打开下面的链接
                          </div>
                        </div>
                        <button style={btnStyle()} onClick={() => void cancelLogin()}>
                          取消
                        </button>
                      </div>
                      <div style={{ padding: "12px 14px" }}>
                        <div style={{ display: "flex", gap: "8px" }}>
                          <input
                            readonly
                            value={loginUrl()}
                            onFocus={(e) => e.currentTarget.select()}
                            style={{
                              flex: "1",
                              "min-width": 0,
                              font: `11px ${T.mono}`,
                              padding: "6px 9px",
                              "border-radius": "6px",
                              border: `1px solid ${T.border}`,
                              background: T.layer1,
                              color: T.muted,
                              outline: "none",
                            }}
                          />
                          <button style={btnStyle("primary")} onClick={() => void copyLoginUrl()}>
                            {loginCopied() ? "已复制" : "复制链接"}
                          </button>
                        </div>
                        <div style={{ color: T.weak, "font-size": "11.5px", "line-height": 1.7, "margin-top": "10px" }}>
                          1. 打开链接，完成 Google 授权。
                          <br />
                          2. 把浏览器地址栏里的<b>完整地址</b>，或页面显示的<b>授权码</b>，粘到下面。
                        </div>
                        <div style={{ display: "flex", gap: "8px", "margin-top": "8px" }}>
                          <input
                            placeholder="粘贴授权码或回调页面地址"
                            value={loginCode()}
                            onInput={(e) => setLoginCode(e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void submitLoginCode();
                            }}
                            style={{
                              flex: "1",
                              "min-width": 0,
                              "font-size": "12px",
                              padding: "6px 10px",
                              "border-radius": "6px",
                              border: `1px solid ${T.border}`,
                              background: T.layer1,
                              color: T.base,
                              outline: "none",
                            }}
                          />
                          <button
                            style={btnStyle("primary")}
                            disabled={busy() === `code-${loginFor()}`}
                            onClick={() => void submitLoginCode()}
                          >
                            {busy() === `code-${loginFor()}` ? "校验中" : "完成登录"}
                          </button>
                        </div>
                        <Show when={loginError()}>
                          <div style={{ color: T.yellow, "font-size": "11.5px", "margin-top": "8px", "line-height": 1.6 }}>
                            {loginError()}
                          </div>
                        </Show>
                        <div style={{ color: T.faint, "font-size": "10.5px", "margin-top": "10px", "line-height": 1.6 }}>
                          额外账号把 token 存在自己的 HOME 里（不走系统钥匙串），不会覆盖系统账号的登录。
                        </div>
                      </div>
                    </div>
                  </Show>

                  {/* ---------------- 调用设置 ---------------- */}
                  <div style={{ ...label, "margin-top": "26px" }}>调用设置</div>
                  <div style={card}>
                    <div style={{ ...row, "border-top": "none" }}>
                      <div>
                        <div style={{ "font-size": "12.5px" }}>默认档位</div>
                        <div style={{ color: T.faint, "font-size": "11px", "margin-top": "2px" }}>未指定 tier 时使用</div>
                      </div>
                      <div style={{ position: "relative", "justify-self": "start" }}>
                        <button
                          style={{
                            ...btnStyle(),
                            "min-width": "250px",
                            display: "flex",
                            "align-items": "center",
                            "justify-content": "space-between",
                            gap: "12px",
                            // The host's neutral button token is translucent;
                            // over the glass background this control became
                            // unreadable. Use the opaque base surface instead.
                            background: "var(--v2-background-bg-base, #16191f)",
                            "border-color": T.borderStrong,
                            color: T.base,
                            "font-weight": 500,
                            opacity: 1,
                          }}
                          onClick={() => setPicker((v) => !v)}
                        >
                          <span>{TIER_LABEL[tier()] ?? tier()}</span>
                          <span style={{ color: T.muted, "font-size": "10px" }}>{picker() ? "▲" : "▼"}</span>
                        </button>
                        <Show when={picker()}>
                          <div
                            style={{
                              position: "absolute",
                              top: "calc(100% + 6px)",
                              left: 0,
                              "z-index": 50,
                              "min-width": "260px",
                              "max-height": "320px",
                              "overflow-y": "auto",
                              background: "var(--v2-background-bg-base, #16191f)",
                              border: `1px solid ${T.borderStrong}`,
                              "border-radius": "8px",
                              "box-shadow": "0 12px 32px rgba(0,0,0,0.5)",
                              padding: "6px",
                            }}
                          >
                            <For each={groups()}>
                              {(g) => (
                                <>
                                  <div style={{ padding: "7px 8px 3px", color: T.faint, "font-size": "10.5px", "letter-spacing": "0.03em" }}>
                                    {g.model}
                                  </div>
                                  <For each={g.tiers}>
                                    {([id, level]) => (
                                      <div
                                        data-tier={id}
                                        onClick={() => {
                                          setPicker(false);
                                          setLocal("tier", id);
                                          void run("tier", () => client.setDefaultTier({ tier: id }), "默认档位已保存");
                                        }}
                                        style={{
                                          display: "flex",
                                          "justify-content": "space-between",
                                          padding: "5px 8px",
                                          "border-radius": "5px",
                                          cursor: "pointer",
                                          background: id === tier() ? T.layer2 : "transparent",
                                          color: id === tier() ? T.base : T.muted,
                                          "font-size": "12px",
                                        }}
                                      >
                                        <span>{level}</span>
                                        <Show when={id === tier()}>
                                          <span style={{ color: T.accent }}>✓</span>
                                        </Show>
                                      </div>
                                    )}
                                  </For>
                                </>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    </div>

                    <div style={row}>
                      <div>
                        <div style={{ "font-size": "12.5px" }}>路由策略</div>
                        <div style={{ color: T.faint, "font-size": "11px", "margin-top": "2px" }}>
                          {ROUTING.find(([v]) => v === data().routing)?.[2] ?? ""}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: "4px", "justify-self": "start" }}>
                        <For each={ROUTING}>
                          {([value, text]) => (
                            <button
                              style={{
                                ...btnStyle(),
                                "border-color": data().routing === value ? T.accent : T.border,
                                background: data().routing === value ? "color-mix(in srgb, var(--v2-blue-600, #3b5bdb) 18%, transparent)" : T.btn,
                                color: data().routing === value ? T.base : T.muted,
                              }}
                              onClick={() => run("routing", () => client.setRouting({ routing: value }), "路由策略已保存")}
                            >
                              {text}
                            </button>
                          )}
                        </For>
                      </div>
                    </div>

                    <div style={row}>
                      <div>
                        <div style={{ "font-size": "12.5px" }}>冷却时长</div>
                        <div style={{ color: T.faint, "font-size": "11px", "margin-top": "2px" }}>配额或未授权时暂停该账号</div>
                      </div>
                      <div style={{ display: "flex", "align-items": "center", gap: "8px", "justify-self": "start" }}>
                        <input
                          type="number"
                          min="1"
                          max="240"
                          value={Math.round((data().cooldownMs ?? 900000) / 60000)}
                          onChange={(e) => {
                            const minutes = Number(e.currentTarget.value);
                            if (!Number.isFinite(minutes) || minutes < 1) return;
                            void run("cooldown", () => client.setCooldown({ minutes }), "已保存");
                          }}
                          style={{
                            width: "64px",
                            "font-size": "12px",
                            padding: "5px 8px",
                            "border-radius": "6px",
                            border: `1px solid ${T.border}`,
                            background: T.layer1,
                            color: T.base,
                            outline: "none",
                          }}
                        />
                        <span style={{ color: T.faint, "font-size": "11.5px" }}>分钟</span>
                      </div>
                    </div>

                    <div style={row}>
                      <div>
                        <div style={{ "font-size": "12.5px" }}>上下文窗口</div>
                        <div style={{ color: T.faint, "font-size": "11px", "margin-top": "2px" }}>
                          1M 需要先给 agy 打补丁；官方二进制只支持 256K
                        </div>
                      </div>
                      <div style={{ display: "flex", "align-items": "center", gap: "8px", "justify-self": "start" }}>
                        <select
                          value={(data().contextWindow ?? 256000) >= 900000 ? "983040" : "256000"}
                          onChange={(e) => {
                            void run(
                              "context-window",
                              () => client.setContextWindow({ tokens: Number(e.currentTarget.value) }),
                              "已保存，重载插件后生效",
                            );
                          }}
                          style={{
                            "font-size": "12px",
                            padding: "5px 8px",
                            "border-radius": "6px",
                            border: `1px solid ${T.border}`,
                            background: T.layer1,
                            color: T.base,
                            outline: "none",
                          }}
                        >
                          <option value="256000">256K（官方）</option>
                          <option value="983040">1M（已打补丁）</option>
                        </select>
                      </div>
                    </div>

                    <div style={row}>
                      <div>
                        <div style={{ "font-size": "12.5px" }}>空闲回收</div>
                        <div style={{ color: T.faint, "font-size": "11px", "margin-top": "2px" }}>
                          超时后关闭 worker，回来时自动恢复上下文
                        </div>
                      </div>
                      <div style={{ display: "flex", "align-items": "center", gap: "8px", "justify-self": "start" }}>
                        <input
                          type="number"
                          min="1"
                          max="1440"
                          value={data().acpIdleMinutes ?? 10}
                          onChange={(e) => {
                            const minutes = Number(e.currentTarget.value);
                            if (!Number.isFinite(minutes) || minutes < 1) return;
                            void run(
                              "acp-idle",
                              () =>
                                client.setAcpLimits({
                                  idleMinutes: minutes,
                                  maxSessions: data().acpMaxSessions ?? 3,
                                }),
                              "已保存",
                            );
                          }}
                          style={{
                            width: "64px",
                            "font-size": "12px",
                            padding: "5px 8px",
                            "border-radius": "6px",
                            border: `1px solid ${T.border}`,
                            background: T.layer1,
                            color: T.base,
                            outline: "none",
                          }}
                        />
                        <span style={{ color: T.faint, "font-size": "11.5px" }}>分钟</span>
                      </div>
                    </div>

                    <div style={row}>
                      <div>
                        <div style={{ "font-size": "12.5px" }}>进程上限</div>
                        <div style={{ color: T.faint, "font-size": "11px", "margin-top": "2px" }}>
                          同时保留的 agy worker 数量
                        </div>
                      </div>
                      <div style={{ display: "flex", "align-items": "center", gap: "8px", "justify-self": "start" }}>
                        <input
                          type="number"
                          min="1"
                          max="16"
                          value={data().acpMaxSessions ?? 3}
                          onChange={(e) => {
                            const sessions = Number(e.currentTarget.value);
                            if (!Number.isFinite(sessions) || sessions < 1) return;
                            void run(
                              "acp-max",
                              () =>
                                client.setAcpLimits({
                                  idleMinutes: data().acpIdleMinutes ?? 10,
                                  maxSessions: sessions,
                                }),
                              "已保存",
                            );
                          }}
                          style={{
                            width: "64px",
                            "font-size": "12px",
                            padding: "5px 8px",
                            "border-radius": "6px",
                            border: `1px solid ${T.border}`,
                            background: T.layer1,
                            color: T.base,
                            outline: "none",
                          }}
                        />
                        <span style={{ color: T.faint, "font-size": "11.5px" }}>个</span>
                      </div>
                    </div>
                  </div>

                  {/* ---------------- 额度 ---------------- */}
                  <div style={{ ...label, "margin-top": "26px", display: "flex", "align-items": "center", "justify-content": "space-between" }}>
                    <span>
                      额度
                      <span style={{ color: T.faint, "margin-left": "8px", "font-size": "11px" }}>
                        来自 <code style={{ font: `11px ${T.mono}` }}>agy --print=/usage</code>
                        {activeAccount()?.usageCheckedAt
                          ? ` · ${ago(activeAccount()!.usageCheckedAt, now())}`
                          : ""}
                      </span>
                    </span>
                    <button
                      style={btnStyle()}
                      disabled={busy() === "usage"}
                      onClick={() => run("usage", () => client.usage({ id: data().activeAccountId }), "额度已刷新")}
                    >
                      {busy() === "usage" ? `读取中 ${elapsed()}s` : "刷新"}
                    </button>
                  </div>

                  <div style={card}>
                    <Show
                      when={activeUsage().length > 0}
                      fallback={
                        <div style={{ padding: "14px", color: T.muted, "font-size": "11.5px", "line-height": 1.6 }}>
                          {busy() === "usage"
                            ? `正在向官方 CLI 读取… 已等待 ${elapsed()} 秒（最长 30 秒，超时会自动停止）`
                            : "暂无数据，点右上角「刷新」读取。官方 CLI 首次读取通常要 10–30 秒。"}
                        </div>
                      }
                    >
                      <For each={activeUsage()}>
                        {(u, i) => (
                          <div
                            style={{
                              display: "grid",
                              "grid-template-columns": "minmax(180px, 260px) 1fr",
                              "align-items": "center",
                              gap: "16px",
                              padding: "10px 14px",
                              "border-top": i() === 0 ? "none" : `1px solid ${T.border}`,
                            }}
                          >
                            <div>
                              <div style={{ "font-size": "12.5px" }}>{u.label}</div>
                              <div style={{ color: T.faint, "font-size": "11px", "margin-top": "2px" }}>
                                {u.group} · {resetIn(u.resetAt, now())}
                              </div>
                            </div>
                            <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
                              <div
                                style={{
                                  flex: "1",
                                  height: "6px",
                                  "border-radius": "3px",
                                  background: T.layer2,
                                  overflow: "hidden",
                                }}
                              >
                                <div
                                  style={{
                                    width: `${Math.max(0, Math.min(100, u.percent))}%`,
                                    height: "100%",
                                    background: barColor(u.percent),
                                  }}
                                />
                              </div>
                              <span
                                style={{
                                  width: "40px",
                                  "text-align": "right",
                                  "font-size": "12px",
                                  color: u.percent >= 20 ? T.base : T.red,
                                  font: `12px ${T.mono}`,
                                }}
                              >
                                {u.percent}%
                              </span>
                            </div>
                          </div>
                        )}
                      </For>
                    </Show>
                    <Show when={activeAccount()?.usageError && busy() !== "usage"}>
                      <div
                        style={{
                          padding: "10px 14px",
                          "border-top": `1px solid ${T.border}`,
                          color: T.yellow,
                          "font-size": "11px",
                          "line-height": 1.55,
                        }}
                      >
                        上次读取失败：{activeAccount()!.usageError}
                        <span style={{ color: T.faint }}> · 5 分钟内不会自动重试，可以点「刷新」手动重试。</span>
                      </div>
                    </Show>
                  </div>
                </>
              )}
            </Show>
          </div>
        );
      },
    });
  },

  async main(ctx) {
    const accounts = await import("./accounts");
    const providerSettings = await import("./provider/settings");

    type LoginSession = { child: any; output: string; timer: ReturnType<typeof setTimeout> };
    const logins = new Map<string, LoginSession>();

    function stopLogin(id: string): void {
      const session = logins.get(id);
      if (!session) return;
      clearTimeout(session.timer);
      try {
        session.child.stdin?.end();
      } catch {
        /* already closed */
      }
      try {
        session.child.kill();
      } catch {
        /* already gone */
      }
      logins.delete(id);
    }

    /** The CLI prints the Google OAuth link before waiting for the code. */
    function authUrlOf(text: string): string | null {
      const match = text.match(/https:\/\/accounts\.google\.com\/[^\s"'<>]+/);
      return match ? match[0] : null;
    }

    function snapshot() {
      const data = accounts.loadAccounts();
      const settings = providerSettings.settingsFromEnv();
      const enriched = data.accounts.map((a) => {
        // Identity is a local file read (`id_token`), so it is always current
        // and never depends on the slow `agy models` probe.
        const ident = accounts.readIdentity(a);
        const email = ident.email ?? a.email;
        // Preserve user-chosen aliases; replace only the generated defaults.
        const automaticAlias = a.id === "system" || /^账号\s*\d+$/.test(a.alias);
        return {
          ...a,
          alias: automaticAlias && email ? email : a.alias,
          email,
          name: ident.name ?? a.name,
        };
      });
      // Keep the default account at the top: the list is a picker, and the
      // account every request uses should not be buried half way down.
      const ordered = [...enriched].sort((a, b) => {
        const rank = (row: typeof a) => (row.id === data.activeAccountId ? 0 : 1);
        return rank(a) - rank(b);
      });
      return {
        activeAccountId: data.activeAccountId,
        defaultTier: data.defaultTier,
        routing: data.routing,
        cooldownMs: data.cooldownMs,
        agentMode: settings.agentMode,
        autoApproveNative: settings.autoApproveNative,
        acpIdleMinutes: settings.acpIdleMinutes,
        acpMaxSessions: settings.acpMaxSessions,
        contextWindow: settings.contextWindow,
        nextAccountId: accounts.pickAccount(data).id,
        accounts: ordered,
      };
    }

    ctx.provide(AgyAccounts, {
      read: async () => snapshot(),

      add: async ({ alias }) => accounts.createAccount(alias),

      remove: async ({ id, purgeHome }) => accounts.removeAccount(id, purgeHome === true),

      probe: async ({ id }) => {
        const data = accounts.loadAccounts();
        const acc = data.accounts.find((a) => a.id === id);
        if (!acc) throw new Error(`账号不存在：${id}`);
        const result = await accounts.probeAccount(acc);
        const next = accounts.loadAccounts();
        const target = next.accounts.find((a) => a.id === id);
        if (target) {
          target.argon = result.argon;
          target.claude = result.claude;
          target.flash = result.flash;
          target.models = result.models;
          target.checkedAt = Date.now();
          target.error = result.ok ? undefined : result.error;
          const ident = accounts.readIdentity(target);
          target.email = ident.email ?? target.email;
          target.name = ident.name ?? target.name;
          accounts.saveAccounts(next);
        }
        return accounts.loadAccounts().accounts.find((a) => a.id === id)!;
      },

      setActive: async ({ id }) => {
        const data = accounts.loadAccounts();
        if (!data.accounts.some((a) => a.id === id)) return false;
        data.activeAccountId = id;
        accounts.saveAccounts(data);
        return true;
      },

      usage: async ({ id }) => {
        const data = accounts.loadAccounts();
        const acc = data.accounts.find((a) => a.id === id);
        if (!acc) throw new Error(`账号不存在：${id}`);
        let rows;
        try {
          rows = await accounts.fetchUsage(acc);
        } catch (err: any) {
          // Remember the failed attempt: otherwise every settings visit starts
          // another 30-second CLI read.
          const next = accounts.loadAccounts();
          const target = next.accounts.find((a) => a.id === id);
          if (target) {
            target.usageCheckedAt = Date.now();
            target.usageError = String(err?.message ?? err).slice(0, 200);
            accounts.saveAccounts(next);
          }
          throw err;
        }
        const next = accounts.loadAccounts();
        const target = next.accounts.find((a) => a.id === id);
        if (target) {
          target.usage = rows;
          target.usageCheckedAt = Date.now();
          target.usageError = undefined;
          accounts.saveAccounts(next);
        }
        return accounts.loadAccounts().accounts.find((a) => a.id === id)!;
      },

      setDefaultTier: async ({ tier }) => {
        const data = accounts.loadAccounts();
        data.defaultTier = tier;
        accounts.saveAccounts(data);
        return true;
      },

      setRouting: async ({ routing }) => {
        const data = accounts.loadAccounts();
        if (!["active", "sequential", "roundrobin"].includes(routing)) return false;
        data.routing = routing as any;
        accounts.saveAccounts(data);
        return true;
      },

      setAgentMode: async ({ mode }) => {
        if (mode !== "native" && mode !== "bridged") return false;
        providerSettings.writeSettings({ agentMode: mode });
        return true;
      },

      setCooldown: async ({ minutes }) => {
        const data = accounts.loadAccounts();
        data.cooldownMs = Math.max(60_000, Math.min(240, minutes) * 60_000);
        accounts.saveAccounts(data);
        return true;
      },

      setAcpLimits: async ({ idleMinutes, maxSessions }) => {
        const idle = Math.max(1, Math.min(1440, Math.round(idleMinutes)));
        const max = Math.max(1, Math.min(16, Math.round(maxSessions)));
        providerSettings.writeSettings({ acpIdleMinutes: idle, acpMaxSessions: max });
        return true;
      },

      setContextWindow: async ({ tokens }) => {
        // Only the two windows agy can actually run at: the official cap and
        // the patched cap. Anything else would make opencode send context the
        // CLI then truncates.
        const next = tokens >= 900_000 ? 983_040 : 256_000;
        providerSettings.writeSettings({ contextWindow: next });
        return true;
      },

      clearCooldown: async ({ id }) => {
        const data = accounts.loadAccounts();
        const acc = data.accounts.find((a) => a.id === id);
        if (!acc) return false;
        acc.cooldownUntil = undefined;
        accounts.saveAccounts(data);
        return true;
      },

      resetUsage: async ({ id }) => {
        const data = accounts.loadAccounts();
        const acc = data.accounts.find((a) => a.id === id);
        if (!acc) return false;
        acc.calls = 0;
        acc.failures = 0;
        acc.lastError = undefined;
        acc.lastUsedAt = undefined;
        accounts.saveAccounts(data);
        return true;
      },

      login: async ({ id }) => {
        const data = accounts.loadAccounts();
        const acc = data.accounts.find((a) => a.id === id);
        if (!acc) throw new Error(`账号不存在：${id}`);

        stopLogin(id);
        const { spawn } = await import("node:child_process");
        const env = { ...process.env, ...accounts.accountEnv(acc) } as Record<string, string>;
        const child = spawn("agy", ["acp", "--login"], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: true,
          windowsHide: true,
        });

        const session: LoginSession = {
          child,
          output: "",
          timer: setTimeout(() => stopLogin(id), 10 * 60 * 1000),
        };
        logins.set(id, session);

        return new Promise<{ url: string }>((resolve, reject) => {
          let settled = false;
          const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            fn();
          };

          const onData = (chunk: Buffer) => {
            session.output += chunk.toString("utf8");
            const url = authUrlOf(session.output);
            if (url) finish(() => resolve({ url }));
          };

          child.stdout?.on("data", onData);
          child.stderr?.on("data", onData);
          child.on("error", (err) => finish(() => {
            stopLogin(id);
            reject(err);
          }));
          child.on("exit", () => finish(() => {
            const url = authUrlOf(session.output);
            if (url) {
              resolve({ url });
              return;
            }
            stopLogin(id);
            reject(new Error(`agy 没有返回登录链接：${session.output.trim().slice(0, 200) || "无输出"}`));
          }));

          setTimeout(() => finish(() => {
            stopLogin(id);
            reject(new Error("等待登录链接超时（20 秒）"));
          }), 20_000);
        });
      },

      loginCode: async ({ id, code }) => {
        const session = logins.get(id);
        if (!session) return { ok: false, error: "没有进行中的登录，请先点账号上的「登录」。" };

        const value = code.trim();
        if (!value) return { ok: false, error: "请先粘贴授权码或回调页面地址。" };

        const exitCode = await new Promise<number | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), 60_000);
          session.child.once("exit", (code) => {
            clearTimeout(timer);
            resolve(typeof code === "number" ? code : 1);
          });
          try {
            session.child.stdin?.write(`${value}\n`);
          } catch {
            clearTimeout(timer);
            resolve(1);
          }
        });

        const output = session.output;
        stopLogin(id);

        if (exitCode === null) return { ok: false, error: "等待 Google 校验超时（60 秒），请重新点「登录」。" };
        if (exitCode !== 0) {
          const last = output.trim().split(/\r?\n/).filter(Boolean).pop();
          return { ok: false, error: (last ?? "登录失败，请重新复制链接后再试。").slice(0, 300) };
        }

        const next = accounts.loadAccounts();
        const target = next.accounts.find((a) => a.id === id);
        if (target) {
          const ident = accounts.readIdentity(target);
          target.email = ident.email ?? target.email;
          target.name = ident.name ?? target.name;
          target.checkedAt = Date.now();
          accounts.saveAccounts(next);
        }
        const email = accounts.loadAccounts().accounts.find((a) => a.id === id)?.email;
        return { ok: true, email };
      },

      loginCancel: async ({ id }) => {
        stopLogin(id);
        return true;
      },
    });
  },
});
