# Turn regression notes — 2026-11-08

## Incident evidence

The interrupted last turn of the reported conversation contained 226 tool calls
over approximately 41 minutes. 223 shell outputs explicitly reported exit code 1.
Most attempts repeatedly converted local files between JSON and plain text. This
was not a successful regression run, nor proof of an upstream infinite loop.
No per-turn token usage was recorded for that turn; zero/missing values must not
be interpreted as free usage. No new plugin source changes were left by it.

## Defects addressed

- Bridged results were previously matched to pending calls by array position.
  Full-history HTTP requests could therefore supply an earlier result to a newer
  call. Results now require an exact call ID; stale/duplicate IDs are ignored.
- New user turns could enter pending replay / in-flight branches before the new
  input was examined. Interrupted or edited tasks are now superseded, cancelled,
  and bootstrapped cleanly, retaining the caller-visible conversation history.
- First entry into agy flattened old user requests without ordered assistant
  answers. Bootstrap now includes role-labelled context and a distinct current task.
- Client disconnection did not cancel ACP work. Cancellation now notifies ACP,
  closes the relevant session, detaches listeners and prevents late old completion
  from deleting a newer session. Other conversations are not deliberately stopped.
- A standalone reproduction on Bun 1.3.14 showed its `node:http` shim failing to
  emit response/socket disconnect events while a response was still running.
  The provider now uses documented Bun Request.signal for that runtime; Node's
  native transport remains unchanged.

## Tests

- `npm run check:turns`: deterministic mock ACP plus real local HTTP tests,
  runnable with both Node and Bun. No account or model quota.
- `bun scripts/check-mcp-bridge.mjs`: argument conversion and MCP HTTP path.
- `bun scripts/check-provider-capacity.mjs`: same-model bounded capacity retries.
- `npm run check:turns-live`: 3 logical real agy prompts, at most 5 HTTP requests,
  120-second total request deadline; always closes its own workers.
- `npm run check:stop-live`: 2 real streaming prompts, interrupted after content
  arrives; 90-second total request deadline, no retries, no file-writing tools.

Targeted strict TypeScript checking of the changed provider modules passes with
Node type definitions. The repository-wide `npm run typecheck` is blocked by
missing Bun types; overriding that setting also exposes pre-existing GUI/JSX
configuration and plugin GUI typing errors. Those unrelated files were not fixed.

## Modes and consumption

Both modes use the official agy process and the selected account's upstream quota.
Neither needs a second LLM merely to bridge or display a tool result.

Native executes agy's tools and mirrors completed output into OpenCode, without
running the command again. OpenCode approval/sandbox rules do not govern those
native actions; native permissions are automatically approved by default.

Bridged disables agy's built-in tools and exposes OpenCode tools over local MCP.
The tool execution and approvals belong to OpenCode; MCP adds local round trips,
not inherently a second model inference per HTTP request.

Compared with direct agy, the plugin adds OpenCode instructions/tool schemas and
transcript conversion. Account-specific HOME, working directory, MCP/skill setup
and permission policies may differ from the user's interactive terminal. Rebuilt
sessions and print fallback can resend history; compaction/retries and failed
model tool loops can increase upstream consumption. Cancellation cannot refund
tokens already generated or undo tool side effects. Quota is not reliably inferred
from OpenCode's local dollar counter or from missing usage on parked tool calls.

These tests do not guarantee arbitrary model behavior, eliminate all tool loops,
or roll back commands/files already executed before a stop.

## Verification results

- Node and Bun: 15/15 deterministic lifecycle/HTTP scenarios passed.
- MCP checks: 10/10 passed; capacity retry checks: 18/18 passed.
- Real agy: native follow-up after Medium → High effort switch retained OTTER49;
  bridged second tool used FIRST_83Q from the first result and final answer used
  FINAL_61Z from the second result. This was 3 logical prompts / 5 HTTP requests.
- Real Bun-hosted cancellation: both native and bridged streaming tasks were
  interrupted after actual content arrived; their session records were removed
  and test workers were shut down. The measured 1–14 ms is local record invalidation,
  not a guarantee about upstream billing cessation or remote cancellation latency.
- The first real shutdown test exposed an unhandled stdin EPIPE race. Pipe errors
  now reject pending ACP RPCs rather than crashing the host; shutdown waits for
  queued session-close operations. The repeated bounded stop test exited cleanly.
- Provider server version is now 16, so hot reload replaces an older listener
  rather than serving requests through the previous version's closures.
