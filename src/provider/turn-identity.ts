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
}
