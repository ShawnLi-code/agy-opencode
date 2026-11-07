/**
 * Converts an OpenAI-shaped chat request into the single text prompt that
 * `agy --print` accepts, and the reply back into OpenAI tool calls.
 *
 * `agy` is a stateless CLI here: every request carries the whole conversation,
 * so the whole history is re-serialised each turn. That is the price of not
 * maintaining a session id, and it keeps the adapter free of state.
 */

export interface OpenAITool {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
  };
  name?: string;
  description?: string;
  parameters?: unknown;
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<{ type?: string; text?: string }> | null;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON string, as OpenAI expects. */
  arguments: string;
}

export interface ParsedReply {
  content: string;
  toolCalls: ToolCall[];
}

const PROTOCOL = `You are being used as the model behind an API. Your answer MUST be exactly one JSON object and nothing else — no prose before or after, no markdown fences.

Two allowed shapes:

1. To answer without using a tool:
{"content":"<the full answer the user reads>"}

2. To use one or more tools:
{"tool_calls":[{"name":"<tool name>","arguments":{<arguments object>}}]}

Rules:
- Emit shape 2 whenever the task requires reading files, running commands, editing code or any other tool. Never describe a tool call in prose instead of emitting it.
- Arguments must match the tool's JSON Schema. Use {} when the tool takes no arguments.
- You may emit several tool calls in one array when they are independent.
- After the tool results come back, continue the task or answer with shape 1.
- Keep "content" plain text. It is shown to the user verbatim.`;

function textOf(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function normaliseTools(tools: readonly OpenAITool[] | undefined): string {
  if (!tools || tools.length === 0) return "";
  const compact = tools.map((t) => {
    const fn = t.function ?? t;
    return {
      name: fn?.name ?? "unknown",
      description: fn?.description ?? "",
      parameters: fn?.parameters ?? { type: "object", properties: {} },
    };
  });
  return JSON.stringify(compact, null, 1);
}

/**
 * Instructions for an ACP turn.
 *
 * The JSON envelope only exists so a tool call can be expressed. When the caller
 * offers no tools there is nothing to encode, and forcing an envelope makes the
 * model escape every quote in its answer — slow, and easy to get wrong (an SVG
 * comes back as `<svg xmlns=\"...\">`). So plain chat turns are told to answer
 * directly, and the parser treats the reply as text.
 */
export function protocolPreamble(tools?: readonly OpenAITool[]): string {
  const block = normaliseTools(tools);
  if (!block) return "";
  return `${PROTOCOL}\n\nTOOLS (JSON Schema):\n${block}`;
}

/**
 * Renders the whole conversation plus the tool catalogue into one prompt.
 * The protocol block is appended last so it stays closest to the model's reply.
 */
export function buildPrompt(messages: readonly OpenAIMessage[], tools?: readonly OpenAITool[]): string {
  const systems: string[] = [];
  const turns: string[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      const t = textOf(m.content);
      if (t) systems.push(t);
      continue;
    }

    if (m.role === "user") {
      turns.push(`USER:\n${textOf(m.content)}`);
      continue;
    }

    if (m.role === "assistant") {
      const calls = m.tool_calls ?? [];
      const text = textOf(m.content);
      if (text) turns.push(`ASSISTANT:\n${text}`);
      if (calls.length > 0) {
        const payload = calls.map((c) => ({
          name: c.function?.name ?? (c as { name?: string }).name ?? "unknown",
          arguments: safeJson(c.function?.arguments),
        }));
        turns.push(`ASSISTANT TOOL CALLS:\n${JSON.stringify({ tool_calls: payload }, null, 1)}`);
      }
      if (!text && calls.length === 0) turns.push("ASSISTANT:\n(empty)");
      continue;
    }

    if (m.role === "tool") {
      const label = m.name ? `${m.name}` : "tool";
      turns.push(`TOOL RESULT (${label}):\n${textOf(m.content)}`);
    }
  }

  const parts: string[] = [];
  if (systems.length > 0) parts.push(`SYSTEM:\n${systems.join("\n\n")}`);

  const toolBlock = normaliseTools(tools);
  if (toolBlock) {
    parts.push(`TOOLS (JSON Schema):\n${toolBlock}`);
  }

  parts.push(`CONVERSATION:\n${turns.join("\n\n")}`);
  parts.push(PROTOCOL);

  return parts.join("\n\n---\n\n");
}

function safeJson(v: unknown): unknown {
  if (typeof v !== "string") return v ?? {};
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
}

/** Strips ```json fences and leading/trailing noise. */
function unfence(text: string): string {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();
  return t;
}

/** Last balanced {...} block in the text, for replies that wrap the JSON in prose. */
function lastJsonObject(text: string): string | null {
  const end = text.lastIndexOf("}");
  if (end < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "}") depth++;
    else if (ch === "{") {
      depth--;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return null;
}

let callSeq = 0;

/**
 * Reads the adapter protocol out of agy's reply.
 *
 * Falls back to treating the whole reply as plain content: a model that ignored
 * the format should still produce a usable answer rather than an error.
 */
export function parseReply(raw: string): ParsedReply {
  const text = unfence(raw ?? "");

  const candidates: string[] = [text];
  const block = lastJsonObject(text);
  if (block && block !== text) candidates.push(block);

  for (const candidate of candidates) {
    let parsed: any;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    // A bare JSON string (`"<svg ...>"`) is a plain answer that happened to be
    // encoded, not a protocol object. Unwrap it instead of returning the raw
    // escaped text.
    if (typeof parsed === "string") {
      return { content: parsed, toolCalls: [] };
    }
    if (!parsed || typeof parsed !== "object") continue;

    if (Array.isArray(parsed.tool_calls)) {
      const toolCalls: ToolCall[] = parsed.tool_calls
        .map((c: any) => {
          const name = c?.name ?? c?.function?.name;
          if (typeof name !== "string" || !name) return null;
          const args = c?.arguments ?? c?.function?.arguments ?? {};
          return {
            id: `call_agy_${Date.now().toString(36)}_${++callSeq}`,
            name,
            arguments: typeof args === "string" ? args : JSON.stringify(args),
          } as ToolCall;
        })
        .filter(Boolean) as ToolCall[];

      if (toolCalls.length > 0) {
        const content = typeof parsed.content === "string" ? parsed.content : "";
        return { content, toolCalls };
      }
    }

    if (typeof parsed.content === "string") {
      return { content: parsed.content, toolCalls: [] };
    }
  }

  return { content: text, toolCalls: [] };
}
