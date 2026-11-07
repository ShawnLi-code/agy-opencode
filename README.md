# agy-opencode

Google **Antigravity** (`agy`) inside [OpenCode](https://opencode.ai) — three things in one plugin:

1. **`Antigravity (CLI)` provider** — agy's models show up in the model picker and run OpenCode's own tool loop, so you can pick one as your main model.
2. **`agy` tool** — hand a scoped task to the Antigravity CLI as a headless sub-agent (still useful for one-off bulk work).
3. **Desktop settings page** — manage several Google accounts, see who each one is, pick a default tier, read real quota.

Everything runs through the **official `agy` binary**. No OAuth token is reused, no private
endpoint is called, so there is no account-ban surface beyond normal CLI use.

---

## Requirements

| | |
|---|---|
| **agy CLI** | installed and logged in (`agy` alone, or `agy acp --login`). Every feature shells out to it. |
| **OpenCode** | 2.2.x (developed against 2.2.5). The plugin contract changed in 2.x: a plugin must export `{ id, setup }`, not a bare function. |
| **OS** | Windows is what it was built and tested on. macOS/Linux should work — account isolation only needs `HOME` — but it has **not been verified there**. |

---

## Install

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": ["github:ShawnLi-code/agy-opencode"]
}
```

Then **add the provider to the same file** (the plugin also repairs this block on
startup, so it is usually enough to restart once). OpenCode's model picker only lists
providers that come from configuration, so a plugin-registered provider never appears in it.
Build the block with your own port, or copy this one and keep the two port numbers identical.

```jsonc
"provider": {
  "agy-cli": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Antigravity (CLI)",
    "options": {
      "baseURL": "http://127.0.0.1:4199/v1",
      "apiKey": "agy-cli-local",
      // Runs take minutes. These must be POSITIVE INTEGERS: opencode 2.2.x
      // drops the whole provider when it sees `0` or `false`, and the models
      // then vanish from the picker.
      "timeout": 900000,
      "headerTimeout": 900000,
      "chunkTimeout": 900000
    },
    "models": {
      "argon-4-lo": { "name": "Gemini 4 Argon (Low)" },
      "argon-4-med": { "name": "Gemini 4 Argon (Medium)" },
      "argon-4-hi": { "name": "Gemini 4 Argon (High)" },
      "flash-3.8-lo": { "name": "Gemini 3.8 Flash (Low)" },
      "flash-3.8-med": { "name": "Gemini 3.8 Flash (Medium)" },
      "flash-3.8-hi": { "name": "Gemini 3.8 Flash (High)" },
      "claude-sonnet-5-5-lo": { "name": "Claude Sonnet 5.5 (Low)" },
      "claude-sonnet-5-5-med": { "name": "Claude Sonnet 5.5 (Medium)" },
      "claude-sonnet-5-5-hi": { "name": "Claude Sonnet 5.5 (High)" },
      "claude-opus-5-5-lo": { "name": "Claude Opus 5.5 (Low)" },
      "claude-opus-5-5-med": { "name": "Claude Opus 5.5 (Medium)" },
      "claude-opus-5-5-hi": { "name": "Claude Opus 5.5 (High)" },
      "gpt-oss-med": { "name": "GPT-OSS 120B (Medium)" }
    }
  }
}
```

Restart OpenCode. The bridge binds the port from that `baseURL`. On every start the plugin
also **reads and repairs** that block (port, model list, valid timeout values), keeping a
`.bak-agy-*` copy of any file it changes. If the block is missing and there is no `provider`
object to insert it into, the settings page still works, but the picker will not list the
models until you add it.

---

## How it works

```
OpenCode  ──OpenAI protocol──▶  http://127.0.0.1:<port>/v1  ──ACP──▶  agy acp
                                                                       │
                                          one session per conversation ┘
```

- **Transport: ACP.** `agy acp` is a persistent JSON-RPC server: one supervisor per account,
  one worker per session. Only the new input is sent each turn, and tokens stream as they
  appear. A worker costs roughly 180 MB, so idle sessions are closed after 10 minutes and
  at most 3 stay open; the session itself stays on disk, and `session/load` restores its
  history when you return to that conversation. The bridge consumes the full ACP event
  surface: `agent_message_chunk` text,
  `agent_thought_chunk` thinking (`reasoning_content`), `tool_call` / `tool_call_update`,
  and the per-turn `usage` (input, output, cache read/write, reasoning) plus `stopReason`.
  `agy --print` remains as a fallback (one process per turn, whole history re-sent).
- **Two tool modes.** In Settings → Antigravity, `native` ("agy 原生工具") lets agy execute
  its own tools; its permission requests are auto-approved by default and OpenCode's
  permissions and sandbox do not apply. Completed native steps are mirrored as real tool
  calls: in Code Mode through the `execute` wrapper (which calls `agy_tool`), or directly
  as `agy_tool` when the host exposes it. OpenCode renders its normal tool card, and the
  mirror returns the output agy already recorded — the command is never run twice.
  `bridged` ("OpenCode 工具") gives agy no built-in tools and passes OpenCode's tools
  through a local MCP bridge instead. OpenCode executes them under its own permission
  model and sandbox; a call blocks inside agy until OpenCode answers it. Changing mode
  affects new requests.
- **Turn boundaries and stopping.** Tool results are matched by call ID, not their
  position in the full history. New questions and edited/retried messages cannot drain
  a previous task's buffered answer. Disconnecting an active generation cancels its
  ACP session; the next request bootstraps from role-labelled history with the current
  question explicitly separated. Ordinary follow-ups and tool-result continuations
  still reuse the session. Bun uses its native HTTP request cancellation signal rather
  than the older `node:http` disconnect shim.
- **Failure circuit breaker.** Five consecutive explicit tool failures stop the
  current task in either mode, rather than continuously retrying and spending quota.
  A successful tool result resets the count; a new user turn resets a tripped guard.
  Nonzero shell exit markers become MCP `isError` results. On Windows, bridged
  `shell` commands containing physical newlines are refused before execution;
  write a script file using the file-edit tool and invoke its path instead. This
  avoids a reproduced host-shell bug where only the first physical line executes.
- **Activity watchdog, not a deadline.** A turn is not handed back just because time
  passed. With no open tool step the provider waits 10 minutes of silence; while a tool is
  running the budget is 4 hours. An exhausted budget is reported as an error, never as a
  successful `stop`.
- **Tool-free agent (bridged mode).** The plugin installs an agent preset
  (`tools: []`, `commandExecutionPolicy: off`) into
  `~/.gemini/antigravity-cli/gemini-root-config/agents/`. Without it agy tries to use its own
  tools, we must deny them, and the turn aborts with
  `⚠ Agent execution terminated due to error.`
- **Accounts are isolated by HOME.** Each account gets its own directory;
  `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` are pointed at it when `agy` is spawned, so
  each account keeps its own OAuth token. On Windows the CLI otherwise reads a single shared
  keyring entry (`gemini:antigravity`) that ignores HOME, so isolated accounts also get
  `SSH_CONNECTION` set: agy then stores the token in
  `<home>/.gemini/antigravity-cli/antigravity-oauth-token` (file storage) instead. The system
  account is left on the keyring.

---

## Settings page

Desktop app → **Settings → Antigravity**:

- account list with Argon / Claude / Flash capability badges (probed with `agy models`)
- **the Google account email** and sign-in state, decoded locally from the CLI's own
  `antigravity-oauth-token` (no network, no token reuse)
- add / remove accounts, and sign in **without a browser popping up**: the page shows the
  OAuth link `agy acp --login` prints, so you can open it in whichever browser profile is
  already signed in (ego, Chrome, ...) and paste the authorization code back
- default tier, routing (`fixed` / `sequential` / `round-robin`), cooldown after a quota or
  auth failure
- live usage counters, and **real quota** read with `agy --print=/usage` (10–30 s on a good
  day; the page shows elapsed seconds, stops at 30 s, and remembers a failed attempt for
  5 minutes instead of retrying on every visit)

---

## Known limits

| Limit | Detail |
|---|---|
| Picker needs the config block | Plugin-registered providers are visible to the model API but not to the model picker. The plugin writes/repairs the block above, but a restart is needed the first time. |
| Timeout values must be integers | `timeout`/`headerTimeout`/`chunkTimeout` accept a positive integer only. `0` or `false` makes opencode drop the whole provider, silently removing the models from the picker. |
| No quota without the CLI | Percentages come from `agy --print=/usage`. There is no local cache; nothing is read from private endpoints. A slow or offline `agy` means the read times out after 30 s. |
| Upstream capacity 503 | `UNAVAILABLE (code 503): No capacity available` means upstream load, not a context limit. The provider waits 5 s / 15 s / 30 s and retries the SAME model; it never silently downgrades. After ~50 s it returns a plain-language message. |
| Slow on long answers | A 3000-character SVG took 35–70 s. Short turns are ~15 s. agy queues requests upstream, so timings vary a lot. |
| Full-width context per turn (print mode) | Only when the ACP transport is unavailable: history is re-sent each turn. |
| Native cards are mirror cards | Native steps render as an `execute`/`agy_tool` card, not as OpenCode's own terminal/diff card. The title carries the original tool and command/path; the output is the real recorded result. |
| Mirror replay is in-memory | Recorded outputs live for 15 minutes (max 500 entries). A replayed card older than that returns an explicit “output no longer held” result instead of re-running the command. |
| One conversation key per chat | Sessions are keyed by the system prompt plus the first user message. Changing that prefix starts a new agy session. |
| Worker lifetime | Idle workers are closed after 10 min (at most 3 open). Closing releases the process, not the conversation: the next message reloads the session with its history. Tune in Settings → Antigravity → 调用设置 (空闲回收 / 进程上限), or with `AGY_ACP_IDLE_MS`, `AGY_ACP_MAX_SESSIONS`, `AGY_ACP_KEEP_SESSIONS`, `AGY_ACP_SWEEP_MS`. |

---

## Development

```bash
npm install
npm run build          # GUI bundle -> dist/gui-experimental.cjs
npm run check          # protocol tests (no agy needed) + GUI render check
node scripts/acp-check.mjs              # drives a real `agy acp` session
bun scripts/check-acp-native.mjs        # native tool mirror + watchdog + usage
bun scripts/check-acp-sessions.mjs      # idle worker exit + session/load keeps context
bun scripts/check-provider-acp.mjs      # native mode: thinking, usage, tool_calls
bun scripts/check-provider-bridged.mjs  # bridged mode: real MCP tool call + resume
bun scripts/check-mcp-bridge.mjs        # bare-string arguments, JSON wrapping, HTTP path
bun scripts/check-provider-capacity.mjs # 503 wait-and-retry, friendly message, no downgrade
bun scripts/check-models.mjs          # one family per model, so no effort is hidden in the picker
npm run check:turns                    # deterministic lifecycle + HTTP + multi-step tool regressions; no quota
npm run check:turns-live               # bounded real native follow-up / effort switch + bridged dependent tools
npm run check:stop-live                # bounded real stream interruption in both modes
npm run check:failure-live             # intentional real failures + circuit-breaker recovery in both modes
npm run check:acceptance               # fail-fast offline acceptance, with per-suite logs
npm run check:acceptance -- --live     # adds bounded real agy tests; consumes quota
node scripts/server-live.mjs            # full server + real agy, end to end
node scripts/live-check.mjs             # hits a running bridge
```

| Path | Purpose |
|---|---|
| `src/index.ts` | plugin entry (`{ id, setup }`) |
| `src/agy-runner.ts` | spawns `agy`, timeouts, error classification |
| `src/provider/server.ts` | OpenAI-compatible HTTP server |
| `src/provider/http-server.ts` | Node/Bun HTTP transport with client-disconnect cancellation |
| `src/provider/turn-safety.ts` | Per-turn tool/time/no-progress budgets |
| `src/provider/turn-identity.ts` | Per-session/per-message identity headers for budget sharing |
| `src/provider/acp.ts` | persistent ACP sessions |
| `src/provider/protocol.ts` | prompt assembly + JSON envelope parsing |
| `src/accounts.ts` | account model, HOME isolation, quota probe |
| `src/gui.tsx` | settings page + main-process IPC |

---

## Credits & license

MIT. The `agy` tool, runner and command/skill assets are derived from
[`chigarow/antigravity-for-opencode`](https://github.com/chigarow/antigravity-for-opencode)
(MIT, © its author); the provider bridge, account isolation and settings page are new here.

Not affiliated with Google. Antigravity, Gemini and Claude are trademarks of their owners.
