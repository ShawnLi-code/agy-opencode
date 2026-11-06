/**
 * Writes the agy-cli provider into the user's OpenCode config.
 *
 * Why the config and not the plugin API: opencode 2.2.x's model picker only
 * lists providers that come from configuration, while `ctx.provider.transform`
 * registrations are visible to the model API but not to the picker.
 *
 * Value constraints (opencode 2.2.5, verified against `opencode debug config`):
 * `timeout` / `headerTimeout` / `chunkTimeout` accept a positive integer or
 * nothing at all. `0` and `false` are both rejected, and a rejected value makes
 * the host drop the whole `agy-cli` provider — which is exactly how the models
 * disappeared from the picker. The values below are milliseconds (15 minutes),
 * large enough that a slow `agy` turn is never cut off.
 *
 * Comma ownership: the managed region owns its own trailing comma. A comma left
 * outside the markers, as a naive insertion leaves it, becomes a trailing comma
 * if the block ever ends up last (or the neighbour is removed) and invalidates
 * the whole config — which would silently drop every model. `render()` therefore
 * decides the comma from what follows the region, and replacement consumes any
 * existing separator first.
 *
 * Both `opencode.json` and `opencode.jsonc` are supported: the JSONC-only
 * managed markers are skipped for a plain `.json` file, where comments would
 * make the document unparsable.
 *
 * Every write backs the file up and is idempotent: running it twice changes
 * nothing the second time.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ALL_TIERS, TIER_LABEL } from "../tiers";

const MARK_START = "// >>> agy-opencode provider (managed) >>>";
const MARK_END = "// <<< agy-opencode provider (managed) <<<";

const PROVIDER_ID = "agy-cli";

/** 15 minutes: long enough for any agy turn, valid for opencode 2.2.x. */
const REQUEST_TIMEOUT_MS = 900_000;

/** `~/.config/opencode/opencode.json` (or `.jsonc`), never both at once. */
export function defaultConfigPath(): string {
  const explicit = process.env.OPENCODE_CONFIG;
  if (explicit) return explicit;

  const jsonc = join(homedir(), ".config", "opencode", "opencode.jsonc");
  if (existsSync(jsonc)) return jsonc;
  return join(homedir(), ".config", "opencode", "opencode.json");
}

const isJsonc = (path: string): boolean => path.toLowerCase().endsWith(".jsonc");

/** Skips whitespace and comments; returns the index of the next significant char. */
function skipTrivia(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}

/** `i` points at the opening quote; returns the index just past the closing one. */
function readStringLiteral(text: string, i: number): number {
  i++;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === '"') return i + 1;
    i++;
  }
  return i;
}

/** End of the value starting at `start` (exclusive), stopping at `,` or the closing brace. */
function valueEnd(text: string, start: number): number {
  let i = start;
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      i = readStringLiteral(text, i);
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === "{" || c === "[") {
      depth++;
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    if (c === "," && depth === 0) return i;
    i++;
  }
  return i;
}

/** Finds `key` directly inside the object at `openBrace` and returns its value range. */
function findMember(
  text: string,
  openBrace: number,
  key: string,
): { valueStart: number; valueEnd: number } | null {
  let i = openBrace + 1;
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = readStringLiteral(text, i);
      if (depth === 0) {
        const after = skipTrivia(text, end);
        if (text[after] === ":") {
          const valueStart = skipTrivia(text, after + 1);
          const endOfValue = valueEnd(text, valueStart);
          let name = "";
          try {
            name = JSON.parse(text.slice(i, end)) as string;
          } catch {
            name = text.slice(i + 1, end - 1);
          }
          if (name === key) return { valueStart, valueEnd: endOfValue };
          i = endOfValue;
          continue;
        }
      }
      i = end;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (depth === 0) return null;
      depth--;
    }
    i++;
  }
  return null;
}

/** True when another member follows, so this region needs a trailing comma. */
function needsComma(text: string): boolean {
  const i = skipTrivia(text, 0);
  return i < text.length && text[i] !== "}";
}

/** Drops a separator comma that sits between the region and the next member. */
function consumeLeadingComma(text: string): string {
  const i = skipTrivia(text, 0);
  if (text[i] !== ",") return text;
  return text.slice(0, i) + text.slice(i + 1);
}

/** Keeps a key the user already set, so a repair never rotates a credential. */
function apiKeyOf(valueText: string): string | null {
  const m = valueText.match(/"apiKey"\s*:\s*("(?:[^"\\]|\\.)*")/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as string;
  } catch {
    return null;
  }
}

/** The provider object itself, without its key or any separator. */
function providerValue(port: number, apiKey = "agy-cli-local"): string {
  const models = ALL_TIERS.map(
    (t) => `    ${JSON.stringify(t)}: { "name": ${JSON.stringify(TIER_LABEL[t])} }`,
  ).join(",\n");

  return [
    `{`,
    `  "npm": "@ai-sdk/openai-compatible",`,
    `  "name": "Antigravity (CLI)",`,
    `  "options": {`,
    `    "baseURL": "http://127.0.0.1:${port}/v1",`,
    `    "apiKey": ${JSON.stringify(apiKey)},`,
    `    "timeout": ${REQUEST_TIMEOUT_MS},`,
    `    "headerTimeout": ${REQUEST_TIMEOUT_MS},`,
    `    "chunkTimeout": ${REQUEST_TIMEOUT_MS}`,
    `  },`,
    `  "models": {`,
    models,
    `  }`,
    `}`,
  ].join("\n");
}

function renderMember(port: number, comma: boolean, apiKey?: string): string {
  return `"${PROVIDER_ID}": ${providerValue(port, apiKey)}${comma ? "," : ""}`;
}

function renderManaged(port: number, comma: boolean, apiKey?: string): string {
  return `${MARK_START}\n${renderMember(port, comma, apiKey)}\n${MARK_END}`;
}

export interface EnsureResult {
  changed: boolean;
  path: string;
  error?: string;
  action?: "inserted" | "replaced" | "unchanged";
}

/** Reads the port recorded for agy-cli, so a restart binds the same one. */
export function readProviderPort(path = defaultConfigPath()): number | null {
  try {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    const root = skipTrivia(text, 0);
    if (text[root] !== "{") return null;
    const provider = findMember(text, root, "provider");
    if (!provider) return null;
    const brace = skipTrivia(text, provider.valueStart);
    if (text[brace] !== "{") return null;
    const member = findMember(text, brace, PROVIDER_ID);
    const region = member
      ? text.slice(member.valueStart, member.valueEnd)
      : text.slice(provider.valueStart, provider.valueEnd);
    const m = region.match(/http:\/\/127\.0\.0\.1:(\d+)\/v1/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Ensures the provider block exists, points at `port`, and uses values the host
 * accepts. `path` is injectable so the logic can be exercised against a copy.
 */
export function ensureProviderConfig(port: number, path = defaultConfigPath()): EnsureResult {
  try {
    if (!existsSync(path)) return { changed: false, path, error: "config not found" };

    const original = readFileSync(path, "utf8");
    const jsonc = isJsonc(path);

    const root = skipTrivia(original, 0);
    if (original[root] !== "{") return { changed: false, path, error: "config is not an object" };

    const provider = findMember(original, root, "provider");
    if (!provider) return { changed: false, path, error: "no provider key" };

    const brace = skipTrivia(original, provider.valueStart);
    if (original[brace] !== "{") return { changed: false, path, error: "provider is not an object" };

    // 1) A managed region from an earlier run: rewrite it in place.
    if (jsonc) {
      const start = original.indexOf(MARK_START);
      if (start >= 0) {
        const end = original.indexOf(MARK_END, start);
        if (end > start) {
          const regionEnd = end + MARK_END.length;
          const before = original.slice(0, start);
          const rawSuffix = original.slice(regionEnd);
          const noComma = consumeLeadingComma(rawSuffix);
          const suffix = /^[\r\n]/.test(noComma) ? noComma : `\n${noComma}`;
          const current = original.slice(start, regionEnd);
          const wanted = renderManaged(port, needsComma(suffix), apiKeyOf(current) ?? undefined);
          if (wanted === current) return { changed: false, path, action: "unchanged" };

          copyFileSync(path, `${path}.bak-agy-${Date.now()}`);
          writeFileSync(path, `${before}${wanted}${suffix}`, "utf8");
          return { changed: true, path, action: "replaced" };
        }
      }
    }

    // 2) An unmanaged `"agy-cli"` member (hand-written, or from the README).
    const member = findMember(original, brace, PROVIDER_ID);
    if (member) {
      const current = original.slice(member.valueStart, member.valueEnd).replace(/\s+$/, "");
      const wanted = providerValue(port, apiKeyOf(current) ?? undefined);
      if (current === wanted) return { changed: false, path, action: "unchanged" };

      const next =
        original.slice(0, member.valueStart) + wanted + original.slice(member.valueStart + current.length);
      if (next === original) return { changed: false, path, action: "unchanged" };

      copyFileSync(path, `${path}.bak-agy-${Date.now()}`);
      writeFileSync(path, next, "utf8");
      return { changed: true, path, action: "replaced" };
    }

    // 3) First run: insert right after the opening brace of the `provider` object.
    const afterBrace = original.slice(brace + 1);
    const comma = needsComma(afterBrace);
    const memberText = renderMember(port, comma);
    const wanted = jsonc ? `${MARK_START}\n${memberText}\n${MARK_END}` : memberText;
    const sep = /^[\r\n]/.test(afterBrace) ? "" : "\n";
    const next = `${original.slice(0, brace + 1)}\n    ${wanted}${sep}${afterBrace}`;

    copyFileSync(path, `${path}.bak-agy-${Date.now()}`);
    writeFileSync(path, next, "utf8");
    return { changed: true, path, action: "inserted" };
  } catch (err: any) {
    return { changed: false, path, error: String(err?.message ?? err).slice(0, 200) };
  }
}
