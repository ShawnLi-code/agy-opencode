# Turn lifecycle / failure-loop acceptance

Scope: the reported old-answer, stop/retry and repeated-failed-shell incidents,
covering native and bridged tool modes on the current Windows host. This is not
a certification of every OpenCode GUI feature, model, operating system or agent
behavior. The repository-wide GUI/type configuration has known unrelated issues;
provider modules receive a separate strict TypeScript check.

## Required automated suites

`bun scripts/check-acceptance.mjs --live` executes the current source once, in
sequence, failing immediately on the first failing suite. Each suite has a hard
timeout. The script records exit status, duration and a separate log in a new
`agy-acceptance-*` temporary directory. It does not automatically retry failed
acceptance suites or silently downgrade a model.

1. Node deterministic lifecycle/HTTP regression suite.
2. Bun deterministic lifecycle/HTTP regression suite.
3. Protocol conversion checks.
4. MCP argument/result transport checks.
5. Bounded same-model capacity retries.
6. Model picker registration checks.
7. Strict typing of the changed provider modules and their dependencies.
8. Real native tool execution, recorded output replay and same-prompt continuation.
9. Real native follow-up/effort switch and bridged dependent tool results.
10. Real native and bridged stream interruption, session cleanup.
11. Real native and bridged deliberate failure sequences, breaker errors and
    successful recovery after a new user message.

## Deterministic scenario matrix

Both modes: normal follow-up and selection changes; new input during an active
task; stop then repeat; tool-only continuation; same-length input edits; context
compaction/input shrink; idle worker release/load; and isolation from a different
running conversation.

Additional boundaries: role-labelled bootstrap; structured tool errors; no false
failure from reading a document containing an exit marker; Windows multiline
rejection before host execution; five-failure cutoff; successful-step reset;
stale/duplicate results; duplicated native completion events; native mirror cards
left pending when a new question arrives; two dependent bridged calls with full
tool history; HTTP failure cutoff before a sixth execution; no reset from merely
replaying tool history; recovery on a new user turn; HTTP disconnect cancellation.

## Safety boundary / remaining limits

- Five consecutive **explicitly failed** tool steps stop the task. A successful
  step resets that count. This prevents the reported 223-failure chain.
- It is not a proof that every semantic loop is detected. Repeated successful
  but useless calls, alternating success/failure, or an infinite loop inside a
  single external command are different cases. The user stop/cancel path remains
  necessary; the activity watchdog alone is not a total runtime budget.
- Windows multiline-shell truncation in the host remains outside the plugin.
  Bridged shell calls are blocked before partial execution; scripts should be
  written with the file-edit tool and invoked by path. This restriction does not
  disable agy's separate native shell implementation.
- Stops do not reverse file/command side effects or refund already consumed quota.
- The full desktop-button workflow was not independently driven as GUI automation;
  cancellation acceptance exercises the actual provider HTTP and ACP paths.

Final status is established by an actual all-pass `results.json`, not by this
checklist or by a model saying its own work is finished.

## Shell transport fix — 2026-11-08

Root cause reproduced outside the plugin: `cross-spawn` 7.0.6 does not recognise
the `WindowsApps\pwsh.exe` App Execution Alias as an executable (it is a
reparse-point alias, not a `.exe` path that `resolveCommand` resolves). It then
routes the call through `cmd.exe /c "pwsh ... ^" ... multiline ... ^""`, and
only the first physical line reaches PowerShell. The same command launched
directly, or through cross-spawn with the real
`C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.9.0_x64__8wekyb3d8bbwe\pwsh.exe`,
prints both lines under Node and Bun.

Fix: global `opencode.json` now sets `shell` to that real pwsh.exe path
(backup: `opencode.json.before-shell-fix-20261108`). Verified through the live
`shell` tool: two-line PowerShell and the previously failing multiline
`node -e` both run fully. This is a machine-specific absolute path; it must be
updated when the installed PowerShell package version changes.

Because the host fix is verified for this machine, the plugin's Windows
multiline blocker is now opt-in via `windowsMultilineShell` (default false for
older shell targets). Set it to true after re-running the multiline check on any
new host. It remains a guard, not the root fix.

## Task budgets

`taskBudget` in `~/.config/opencode/agy/settings.json` limits each user turn
across every tool-result HTTP span:

```json
"taskBudget": { "maxToolCalls": 200, "maxTurnMs": 1200000, "maxRepeatedResults": 8 }
```

- `maxToolCalls`: hard cap on distinct tool calls in one turn.
- `maxTurnMs`: wall-clock cap; a long build raises this explicitly.
- `maxRepeatedResults`: pause after N identical (tool, args, result) triples,
  regardless of success; different output resets the counter.

Environment overrides: `AGY_MAX_TOOL_CALLS`, `AGY_MAX_TURN_MS`,
`AGY_MAX_REPEATED_RESULTS`. A tripped budget stops the turn, keeps the reason,
and a new user message starts a fresh budget. Tool-result retries cannot reset
it. These are deterministic limits; they do not claim to detect every
successful-but-unproductive semantic loop, but they bound wasted work.

## Final status — 2026-11-08

After the shell and budget changes:

- 29 deterministic scenarios pass under both Node and Bun (both modes, lifecycle,
  stop, routing, error conversion, failure breaker, call limit, no-progress,
  cross-span budget sharing, new-turn reset, conversation isolation).
- 11/11 acceptance suites pass in one run with real agy: exit 0, no timeouts;
  evidence `C:\Users\Shawn\AppData\Local\Temp\agy-acceptance-1F13wr\results.json`.
  Includes live native mirror/replay, real effort-switch follow-up, real stop in
  both modes, and deliberate failure + recovery in both modes.
- Strict typing of the changed provider modules passes.
- Live `shell` multiline regression passes on this host after the `shell` config
  fix.

`windowsMultilineShell` is enabled for this machine because the real pwsh.exe
path was verified; `taskBudget` is set to 200 calls / 20 minutes / 8 identical
results. Both are read on provider start, so a plugin reload or service restart
is needed for a settings change to take effect.

Known limits that remain outside this acceptance: successful-but-unproductive
semantic loops are bounded by the budget but not semantically identified;
PowerShell updates change the versioned `shell` path; and the desktop GUI button
flow was not itself automated (the real provider HTTP/ACP paths were).

## Previous result — version 18 (superseded)

The frozen version-18 provider passed all 11 required suites in one acceptance
run, with real agy enabled. Every suite exited 0 and none timed out. Duration:
approximately 171 seconds, from 2026-11-07 16:48:40 UTC to 16:51:31 UTC.

Evidence: `C:\Users\Shawn\AppData\Local\Temp\agy-acceptance-uXFEJW\results.json`.
The same directory contains individual logs for each suite.

- Node and Bun each passed the 27-scenario lifecycle/HTTP regression suite.
- Protocol, MCP, capacity retry, model registration and provider typing passed.
- Real native execution/mirror replay, effort-switch context retention and
  bridged dependent result delivery passed.
- Real stop/cancel and deliberate-failure-breaker/recovery tests passed in both
  native and bridged modes.
- The separate proposed-routing comparison also passed 8 offline scenarios.

Acceptance is successful **within the scope and safety boundaries above**. It
does not assert that all possible successful-but-unproductive agent loops are
detected, that the host multiline-shell bug is fixed, or that the full GUI and
repository-wide typecheck are certified.
