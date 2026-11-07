# Repeated shell failure incident — 2026-11-08

## Evidence

The interrupted turn had 226 tool calls: one file read, one delegated agy call,
and 224 shell calls. Of the shell calls, all 223 multiline commands exited with
code 1 and no diagnostic output. The only single-line shell command succeeded.
The first failed command attempted to read tool-bridge.ts and write a dump file;
later commands read outputs of previous failed commands without verifying they
existed. These expected output files were not found during inspection.

Safe reproduction through the current OpenCode shell tool:

- One-line `node -e` console output: succeeds.
- The same `node -e` program written with physical newlines: exit 1, no output.
- Two PowerShell Write-Output statements on separate physical lines: only the
  first marker appears. This is a partial-execution risk, not just display loss
  of the user's latest message.

Control experiment: passing the same four cases directly to the exact pwsh.exe
path with spawnSync succeeds under both Node and Bun, including both output
markers and the multiline Node program. OpenCode logs contain the full multiline
command. Thus this reproduction isolates the problem to the host shell execution
path; it does not establish the exact failing line inside the closed/bundled host.
The plugin does not modify that host implementation.

## Why it continued

1. Multiline commands failed on the host shell path.
2. Subsequent commands assumed earlier output files existed, extending the failure
   chain rather than testing the original premise.
3. The old bridge matched results by array order, so historical tool output could
   be supplied to a later call. That defect was fixed in the prior change.
4. The MCP conversion omitted isError even for explicit nonzero exit output.
5. There was no repeated-failure breaker. Each new tool event refreshed the
   activity watchdog, so repeated failures were activity, not an idle timeout.

This is an agent/tool feedback loop, not proof that a single shell process was
stuck executing an infinite while loop.

## Plugin mitigation

- Advertise the Windows one-physical-line restriction in the bridged shell schema.
- Reject multiline shell requests before forwarding any prefix to OpenCode. Tell
  the model to use a single-line command or write and invoke a script file.
- Do not encode/obfuscate commands or automatically execute rewritten programs;
  retain OpenCode's permission and audit boundary.
- Convert explicit shell exit-failure markers to MCP isError results, preserving
  the original diagnostic text.
- Count consecutive explicit tool failures. At five, cancel the current ACP task
  and report AGY_TOOL_FAILURE_LIMIT; do not permit a sixth execution in that turn.
  Native ACP tool completions have the same guard and deduplicate repeated status
  notifications. Successful results reset the count. New user turns reset a
  tripped guard; replaying the same tool history does not.

The conservative five-failure threshold intentionally stops some unsuccessful
debugging attempts early. It does not limit successful tools, long-running builds
or the total number of steps in a productive turn. It is not a detector for every
possible agent loop (e.g. endless successful but unproductive calls).

## Validation

20 deterministic scenarios pass under Bun, including both modes, duplicate event
handling, error conversion, pre-execution multiline rejection, success reset,
stale-result rejection, a real local HTTP 409 at the fifth failure, no sixth host
execution, and recovery on a new user message. Provider strict TypeScript checks,
10 MCP checks and 18 capacity checks also pass. These regressions use no models.

Provider version 17 forces a listener replacement on plugin reload. The Windows
host shell bug remains outside the plugin; the mitigation prevents it from
causing the same unbounded failed-command chain through the bridged shell tool.

## Root cause (confirmed) and host fix — 2026-11-08

`cross-spawn` 7.0.6 resolves the command before spawning. For
`%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` its `resolveCommand` returns
`undefined` (the App Execution Alias is a reparse point; `fs.stat` on it returns
`EACCES`), so `parseNonShell` classifies it as needing a shell and rewrites the
call to `cmd.exe /d /s /c "pwsh ... ^" ... ^""`. That `cmd.exe` layer keeps only
the first physical line of a multiline argument.

Evidence:
- `resolveCommand(alias)` → `undefined`; `resolveCommand(real pwsh path)` → the path.
- `cross-spawn.sync(alias, ["-NoLogo","-NoProfile","-NonInteractive","-Command", "line1\nline2"])`
  prints only line 1.
- The same call with the real
  `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.9.0_x64__8wekyb3d8bbwe\pwsh.exe`
  prints both lines on Node and Bun; direct `spawnSync` also prints both.

Fix applied: global `opencode.json` sets `"shell"` to the real pwsh.exe path.
Live `shell` tool verification: two-line PowerShell and the previously failing
multiline `node -e` both complete. Backup:
`opencode.json.before-shell-fix-20261108`.

Caveats: the path is versioned; a PowerShell package update changes the
directory and requires updating `shell`. The plugin's Windows multiline refusal
is now controlled by `windowsMultilineShell` (default off), retained as a guard
for hosts whose shell still resolves through the alias. This does not patch
`cross-spawn`; it avoids the broken path by pointing at a resolvable executable.
