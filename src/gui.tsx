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
        { id: "agy.accounts", title: "Antigravity 账号", description: "多账号、默认档位、路由与用量" },
        { id: "agy.add", title: "添加账号", description: "创建独立 HOME 并登录 Google" },
      ],
      render() {
        const [state, { refetch }] = createResource(() => client.read());
        const [busy, setBusy] = createSignal("");
        const [alias, setAlias] = createSignal("");
        const [msg, setMsg] = createSignal("");
        const [picker, setPicker] = createSignal(false);
        const [now, setNow] = createSignal(Date.now());
        const [local, setLocal] = createStore<{ tier: string }>({ tier: "" });

        onMount(() => {
          const t = setInterval(() => setNow(Date.now()), 20_000);
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

        // Load quota once per mount when the cached reading is stale. The
        // reading comes from the official `agy --print=/usage` command.
        let autoTried = false;
        createEffect(() => {
          const s = state();
          if (!s || autoTried) return;
          autoTried = true;
          const acc = s.accounts.find((a) => a.id === s.activeAccountId);
          const fresh = acc?.usageCheckedAt && Date.now() - acc.usageCheckedAt < 5 * 60 * 1000;
          if (!fresh) void run("usage", () => client.usage({ id: s.activeAccountId }));
        });

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
          if (busy()) return;
          setBusy(key);
          setMsg("");
          try {
            await fn();
            if (okMsg) setMsg(okMsg);
            await refetch();
          } catch (e: any) {
            const raw = String(e?.message ?? e);
            // A method added to the IPC spec only exists after the app's main
            // process restarts: the provider object is created once at launch.
            setMsg(
              /no method/i.test(raw)
                ? "需要重启一次 App：主进程的 IPC 方法只在启动时注册，热更新不会补上。"
                : `失败：${raw.slice(0, 200)}`,
            );
          } finally {
            setBusy("");
          }
        }

        return (
          <div style={{ padding: "22px 26px 40px", color: T.base, "font-size": "13px", "max-width": "900px" }}>
            <div style={{ "margin-bottom": "22px" }}>
              <h1 style={{ "font-size": "16px", "font-weight": 600, margin: "0 0 6px" }}>Antigravity</h1>
              <p style={{ color: T.muted, margin: 0, "line-height": 1.55, "font-size": "12.5px" }}>
                把 <code style={{ font: `11.5px ${T.mono}`, color: T.accent }}>agy</code> 当子 agent 调用。每个账号用独立
                HOME 目录隔离凭证，互不影响。
              </p>
            </div>

            <Show when={state.error}>
              <div style={{ color: T.red, "margin-bottom": "14px", "font-size": "12px" }}>读取失败：{String(state.error)}</div>
            </Show>

            <Show when={state()}>
              {(data) => (
                <>
                  {/* ---------------- 账号 ---------------- */}
                  <div style={{ ...label, "margin-top": "26px" }}>账号</div>
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

                              <div style={{ color: T.faint, "font-size": "10.5px", font: `10.5px ${T.mono}`, "margin-top": "3px" }}>
                                {acc.id}
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
                              <Show when={acc.home}>
                                <button
                                  style={btnStyle()}
                                  disabled={busy() === `login-${acc.id}`}
                                  onClick={() =>
                                    run(`login-${acc.id}`, () => client.login({ id: acc.id }), "已打开浏览器授权")
                                  }
                                >
                                  登录
                                </button>
                              </Show>
                              <Show when={cooling}>
                                <button
                                  style={btnStyle()}
                                  onClick={() => run(`cd-${acc.id}`, () => client.clearCooldown({ id: acc.id }), "已解除冷却")}
                                >
                                  解除
                                </button>
                              </Show>
                              <Show when={acc.id !== "system"}>
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
                                  onClick={() => run(acc.id, () => client.remove({ id: acc.id }), "已删除")}
                                >
                                  删除
                                </button>
                              </Show>
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
                          style={{ ...btnStyle(), "min-width": "250px", "text-align": "left" }}
                          onClick={() => setPicker((v) => !v)}
                        >
                          {TIER_LABEL[tier()] ?? tier()} {picker() ? "▴" : "▾"}
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
                      {busy() === "usage" ? "读取中" : "刷新"}
                    </button>
                  </div>

                  <div style={card}>
                    <Show
                      when={activeUsage().length > 0}
                      fallback={
                        <div style={{ padding: "14px", color: T.muted, "font-size": "11.5px" }}>
                          {busy() === "usage" ? "正在向官方 CLI 读取…" : "暂无数据，点右上角「刷新」读取。"}
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
                  </div>

                  <Show when={msg()}>
                    <div style={{ "margin-top": "14px", color: T.muted, "font-size": "11.5px" }}>{msg()}</div>
                  </Show>
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

    function snapshot() {
      const data = accounts.loadAccounts();
      return {
        activeAccountId: data.activeAccountId,
        defaultTier: data.defaultTier,
        routing: data.routing,
        cooldownMs: data.cooldownMs,
        accounts: data.accounts,
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
        const rows = await accounts.fetchUsage(acc);
        const next = accounts.loadAccounts();
        const target = next.accounts.find((a) => a.id === id);
        if (target) {
          target.usage = rows;
          target.usageCheckedAt = Date.now();
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

      setCooldown: async ({ minutes }) => {
        const data = accounts.loadAccounts();
        data.cooldownMs = Math.max(60_000, Math.min(240, minutes) * 60_000);
        accounts.saveAccounts(data);
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
        if (!acc) return false;
        const { spawn } = await import("node:child_process");
        const env = { ...process.env, ...accounts.accountEnv(acc) } as Record<string, string>;
        const child = spawn("agy", ["acp", "--login"], {
          env,
          detached: true,
          stdio: "ignore",
          shell: true,
          windowsHide: true,
        });
        child.unref();
        return true;
      },
    });
  },
});
