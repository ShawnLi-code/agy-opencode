/**
 * Recorded agy tool steps, replayed by OpenCode as real tool calls.
 *
 * In native mode agy executes the tool itself. The provider therefore cannot
 * ask OpenCode to run it again; it only needs OpenCode's UI to show what
 * happened. This store keeps the already-produced output and the `agy_tool`
 * mirror returns it. Entries are deliberately short-lived: a replayed session
 * that outlives the process gets a clear degraded notice instead of a
 * duplicated command.
 *
 * Held on globalThis so a hot reload reuses one map instead of creating a
 * second one that the provider cannot see.
 */

export interface NativeReplay {
  id: string;
  toolCallId: string;
  tool: string;
  title?: string;
  input: Record<string, unknown>;
  output: string;
  exitCode?: number;
  error?: string;
  createdAt: number;
}

export interface RecordedReplay {
  id: string;
  call: { id: string; name: string; arguments: string };
}

/**
 * The few fields a card needs to identify the action. Full write payloads are
 * deliberately left out: the recorded output is the result, and a 100 KB file
 * body in the call arguments would bloat every session record.
 */
const CARD_INPUT_KEYS = [
  "CommandLine", "command_line", "Command", "command", "Cmd", "cmd",
  "AbsolutePath", "absolute_path", "Path", "path",
  "TargetFile", "target_file", "File", "file",
  "Query", "query", "Pattern", "pattern",
  "Url", "url", "DirectoryPath", "directory_path",
];

export function compactToolInput(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const key of CARD_INPUT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") out[key] = value.slice(0, 500);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

interface Store {
  entries: Map<string, NativeReplay>;
  seq: number;
}

const STORE_KEY = Symbol.for("agy-opencode.native-replays");
const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 500;

function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  let s = g[STORE_KEY];
  if (!s) {
    s = { entries: new Map(), seq: 0 };
    g[STORE_KEY] = s;
  }
  return s;
}

function sweep(s: Store, now = Date.now()): void {
  for (const [id, entry] of s.entries) {
    if (now - entry.createdAt > TTL_MS) s.entries.delete(id);
  }
  while (s.entries.size > MAX_ENTRIES) {
    const oldest = s.entries.keys().next().value;
    if (oldest === undefined) break;
    s.entries.delete(oldest);
  }
}

/**
 * Stores one completed tool step and returns the OpenAI tool call that will
 * replay it. The call id is stable for this step so a retry cannot mint a
 * second card for the same activity.
 */
export function recordNativeReplay(input: {
  toolCallId: string;
  tool: string;
  title?: string | undefined;
  input?: Record<string, unknown> | undefined;
  output: string;
  exitCode?: number | undefined;
  error?: string | undefined;
  /**
   * How the caller can reach the mirror. Code Mode exposes only `execute`;
   * direct native mode exposes `agy_tool` itself.
   */
  wrapper?: "direct" | "code" | undefined;
}): RecordedReplay {
  const s = store();
  sweep(s);
  s.seq += 1;
  const id = `replay_${Date.now().toString(36)}_${s.seq.toString(36)}`;
  const entry: NativeReplay = {
    id,
    toolCallId: input.toolCallId,
    tool: input.tool || "tool",
    input: input.input ?? {},
    output: input.output,
    createdAt: Date.now(),
    ...(input.title ? { title: input.title } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
  s.entries.set(id, entry);
  const wrapper = input.wrapper ?? "direct";
  const cardInput = compactToolInput(entry.input);
  // `tool` and `input` exist for the card title/arguments; the executor only
  // reads `id` and returns the recorded output.
  const payload = {
    id,
    tool: entry.tool,
    ...(entry.title ? { title: entry.title } : {}),
    input: cardInput,
  };
  const brief =
    (typeof cardInput.CommandLine === "string" && cardInput.CommandLine) ||
    (typeof cardInput.command === "string" && cardInput.command) ||
    (typeof cardInput.Path === "string" && cardInput.Path) ||
    (typeof cardInput.path === "string" && cardInput.path) ||
    entry.title ||
    entry.tool;
  const call =
    wrapper === "code"
      ? {
          id: `call_${id}`,
          name: "execute",
          arguments: JSON.stringify({
            code: `return await tools['agy_tool'](${JSON.stringify(payload)})`,
            description: `${entry.tool}: ${brief}`,
          }),
        }
      : {
          id: `call_${id}`,
          name: "agy_tool",
          arguments: JSON.stringify(payload),
        };
  return { id, call };
}

/** Reads one replay without consuming it, so a UI retry still works. */
export function readNativeReplay(id: string): NativeReplay | undefined {
  if (typeof id !== "string" || id === "") return undefined;
  const s = store();
  sweep(s);
  return s.entries.get(id);
}

/**
 * The exact result `agy_tool` returns. Kept here so the replay contract can be
 * tested without booting the plugin's tool registry.
 */
export function replayToolResult(id: string): {
  content: string;
  metadata: Record<string, unknown>;
} {
  const record = readNativeReplay(id);
  if (!record) {
    return {
      content:
        "This agy tool step already executed, but its recorded output is no longer held by the bridge. " +
        "Do not investigate the bridge; re-run the same operation only if the output is still needed.",
      metadata: { error: true, code: "REPLAY_EXPIRED", tool: "agy_tool" },
    };
  }
  const body = record.output.trim() !== "" ? record.output : "(no output)";
  return {
    content: body,
    metadata: {
      tool: record.tool,
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      ...(record.error ? { error: true, message: record.error } : {}),
    },
  };
}

/** Diagnostics/tests. */
export function nativeReplayCount(): number {
  return store().entries.size;
}
