/** Stable per-session/per-user-message identity across tool spans and compaction. */
export async function registerTurnIdentity(ctx: any): Promise<void> {
  if (typeof ctx?.session?.hook !== "function") return;
  const latest = new Map<string, string>();
  await ctx.session.hook("prompt", (event: any) => {
    latest.set(event.sessionID, event.messageID);
    if (latest.size > 1024) latest.delete(latest.keys().next().value!);
  });
  await ctx.session.hook("model.request", (event: any) => {
    event.headers["x-agy-session-id"] = event.sessionID;
    event.headers["x-agy-request-kind"] = event.kind ?? "primary";
    const turn = latest.get(event.sessionID);
    if (turn) event.headers["x-agy-turn-id"] = turn;
  }, { providerID: "agy-cli" });
  // These are intentional, terminal task-budget decisions, not transient API
  // failures. Retrying the same turn only repeats the same stop and may keep
  // OpenCode's UI stuck in its retry loop. Other providers/errors are untouched.
  await ctx.session.hook("retry", (event: any) => {
    if (event?.model?.providerID !== "agy-cli") return;
    const message = typeof event?.error?.message === "string" ? event.error.message : "";
    if (/\b(?:AGY_TURN_TIME_LIMIT|AGY_TOOL_CALL_LIMIT|AGY_NO_PROGRESS|AGY_TOOL_FAILURE_LIMIT)\b/.test(message)) {
      event.decision = { retry: false };
    }
  }, { providerID: "agy-cli" });
}
