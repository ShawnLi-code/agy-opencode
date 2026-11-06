# agy-opencode

Google **Antigravity** (`agy`) inside [OpenCode](https://opencode.ai) — three things in one plugin:

1. **`agy` tool** — delegate a scoped task to the Antigravity CLI as a headless sub-agent.
2. **`Antigravity (CLI)` provider** — the agy models show up as selectable models and drive OpenCode's own tool loop.
3. **Desktop settings page** — manage several Google accounts, pick a default tier, read real quota.

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

Then **add the provider to the same file**. This step is not optional: OpenCode's model
picker only lists providers that come from configuration, so a plugin-registered provider
never appears in it. Build the block with your own port, or copy this one and keep the two
port numbers identical.

```jsonc
"provider": {
  "agy-cli": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Antigravity (CLI)",
    "options": {
      "baseURL": "http://127.0.0.1:4199/v1",
      "apiKey": "agy-cli-local",
      // Turns run for minutes; default timeouts abort them.
      "timeout": 0,
      "headerTimeout": 0,
      "chunkTimeout": 0
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

Restart OpenCode. The bridge binds the port from that `baseURL`, so the plugin only ever
**reads** your config — it never writes to it.

---

## How it works

```
OpenCode  ──OpenAI protocol──▶  http://127.0.0.1:<port>/v1  ──ACP──▶  agy acp
                                                                       │
                                          one session per conversation ┘
```

- **Transport: ACP.** `agy acp` is a persistent JSON-RPC server: one process per account, one
  session per conversation. Only the new input is sent each turn, and tokens stream as they
  appear. `agy --print` remains as a fallback (one process per turn, whole history re-sent).
- **Tool calls stay in OpenCode.** The model never executes a tool itself. It answers with
  `{"tool_calls":[{"name":"read","arguments":{...}}]}`; OpenCode runs the tool, returns the
  result, and the next turn continues. Approvals and sandboxing therefore behave normally.
- **Tool-free agent.** On first run the plugin installs an agent preset
  (`tools: []`, `commandExecutionPolicy: off`) into
  `~/.gemini/antigravity-cli/gemini-root-config/agents/`. Without it agy tries to use its own
  tools, we must deny them, and the turn aborts with
  `⚠ Agent execution terminated due to error.`
- **Accounts are isolated by HOME.** Each account gets its own directory;
  `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` are pointed at it when `agy` is spawned, so
  each account keeps its own OAuth token.

---

## Settings page

Desktop app → **Settings → Antigravity**:

- account list with Argon / Claude / Flash capability badges (probed with `agy models`)
- add / remove accounts, start the Google sign-in flow per account
- default tier, routing (`fixed` / `sequential` / `round-robin`), cooldown after a quota or
  auth failure
- live usage counters, and **real quota** read with `agy --print=/usage`

---

## Known limits

| Limit | Detail |
|---|---|
| Picker needs the config block | Plugin-registered providers are visible to the model API but not to the model picker. That is why the `provider` block above is required. |
| No quota without the CLI | Percentages come from `agy --print=/usage`. There is no local cache; nothing is read from private endpoints. |
| Slow on long answers | A 3000-character SVG took 35–70 s. Short turns are ~15 s. agy queues requests upstream, so timings vary a lot. |
| Full-width context per turn (print mode) | Only when the ACP transport is unavailable: history is re-sent each turn. |
| Text-only tool results | Tool output is replayed to the model as `[TOOL RESULT name=…]` text. Single-step tool use is verified; long multi-step chains are not. |
| One conversation key per chat | Sessions are keyed by the system prompt plus the first user message. Changing that prefix starts a new agy session. |

---

## Development

```bash
npm install
npm run build          # GUI bundle -> dist/gui-experimental.cjs
npm run check          # protocol tests (no agy needed) + GUI render check
node scripts/acp-check.mjs     # drives a real `agy acp` session
node scripts/server-live.mjs   # full server + real agy, end to end
node scripts/live-check.mjs    # hits a running bridge
```

| Path | Purpose |
|---|---|
| `src/index.ts` | plugin entry (`{ id, setup }`) |
| `src/agy-runner.ts` | spawns `agy`, timeouts, error classification |
| `src/provider/server.ts` | OpenAI-compatible HTTP server |
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
