/**
 * Turns agy's own tool activity into something opencode can display.
 *
 * In `native` mode agy executes its tools itself (`read_file`, `run_command`,
 * ...), exactly as it does in a terminal. opencode is not asked to run
 * anything, so the OpenAI contract's `tool_calls` field is the wrong channel —
 * sending one would make opencode try to execute a tool whose work agy has
 * already done.
 *
 * ACP reports the activity separately from the message text:
 *
 *   session/update { sessionUpdate: "tool_call",        ... status: in_progress }
 *   session/update { sessionUpdate: "tool_call_update", ... status: completed }
 *
 * So the interesting fields (`name`, `args`, `title`, `kind`, `locations`,
 * `status`) are re-rendered as short markers inside the assistant text. That
 * keeps one channel (content) and still shows the user what ran, in order,
 * without inventing a tool call the caller must answer.
 *
 * The rendering is deliberately compact and greppable: a single leading glyph
 * per event, so a UI can style it and a log stays readable.
 */

/** One ACP `tool_call` / `tool_call_update` payload. */
export interface AcpToolCallEvent {
  sessionUpdate: string;
  toolCallId?: string;
  name?: string;
  title?: string;
  kind?: string;
  status?: string;
  args?: Record<string, unknown>;
  rawInput?: Record<string, unknown>;
  locations?: { path?: string }[];
  content?: unknown;
}

/** Rendered markers, keyed by what happened. */
const GLYPH = {
  start: "▸",
  done: "✓",
  failed: "✗",
  pending: "·",
} as const;

/**
 * Best-effort one-line argument summary.
 *
 * agy's argument keys differ per tool and are capitalised (`Path`, `Command`),
 * so the summary prefers the values that actually identify the action instead
 * of dumping JSON at the user.
 */
export function summariseArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const pick = ["Path", "path", "Command", "command", "Pattern", "pattern", "Query", "query", "Url", "url"];
  for (const key of pick) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      return value.length > 120 ? value.slice(0, 117) + "..." : value;
    }
  }
  const first = Object.values(args).find((v) => typeof v === "string" && v.length > 0);
  return typeof first === "string" ? (first.length > 120 ? first.slice(0, 117) + "..." : first) : "";
}

/**
 * Renders one tool event as a display marker.
 *
 * Returns an empty string for events this provider does not surface
 * (`tool_call_update` carrying only a status change with nothing new to say),
 * so callers can emit unconditionally.
 *
 * @param event - the ACP update.
 * @returns a line of display text, possibly empty.
 */
export function renderToolEvent(event: AcpToolCallEvent): string {
  const status = typeof event.status === "string" ? event.status : undefined;
  const label = typeof event.title === "string" && event.title ? event.title : event.name ?? "tool";
  const detail = summariseArgs(event.args ?? event.rawInput);

  const heading = detail && !label.includes(detail) ? `${label} — ${detail}` : label;

  if (event.sessionUpdate === "tool_call") {
    return `\n\n- ${GLYPH.start} ${heading}\n\n`;
  }

  if (event.sessionUpdate !== "tool_call_update") return "";

  // Most updates repeat the title and arguments. Only surface failures; a
  // successful completion needs no second copy of the original action.
  if (status === "failed") return `\n\n- ${GLYPH.failed} 工具执行失败：${heading}\n\n`;
  return "";
}

/**
 * Whether agy is asking for permission on one of its own tools.
 *
 * In `native` mode these must be approved or the turn stalls: ACP has no
 * "deny and continue" outcome, so a refusal ends the prompt. `autoApprove`
 * reflects the user's setting; when off, the caller surfaces the request rather
 * than answering it.
 */
export interface NativePermissionRequest {
  sessionId: string;
  toolCall?: { toolCallId?: string; title?: string; kind?: string };
  options: { optionId: string; name?: string; kind: string }[];
}

/**
 * Picks the option that lets the tool run.
 *
 * agy offers differently-named outcomes per request (`allow_once`,
 * `allow_always`, `reject_once`, ...) and the ids are not stable, so the choice
 * is made from `kind` rather than a hardcoded id.
 *
 * @param request - the permission request.
 * @returns the option id to select, or null when nothing allows.
 */
export function allowOption(request: NativePermissionRequest): string | null {
  const options = request?.options ?? [];
  const allow = options.find((o) => /allow|approve|accept|yes/i.test(String(o?.kind ?? "")));
  if (allow?.optionId) return allow.optionId;
  const byName = options.find((o) => /allow|approve|accept/i.test(String(o?.name ?? "")));
  return byName?.optionId ?? null;
}
