/**
 * Writes the agy-cli provider into the user's OpenCode config.
 *
 * Why the config and not the plugin API: opencode 2.2.5's model picker only
 * lists providers that come from configuration (like `magpie` in this setup),
 * while `ctx.provider.transform` registrations are visible to the model API but
 * not to the picker.
 *
 * Comma ownership: the managed region owns its own trailing comma. A comma left
 * outside the markers, as a naive insertion leaves it, becomes a trailing comma
 * if the block ever ends up last (or the neighbour is removed) and invalidates
 * the whole config — which would silently drop every model. `render()` therefore
 * decides the comma from what follows the region, and replacement consumes any
 * existing separator first.
 *
 * Every write backs the file up and is idempotent: running it twice changes
 * nothing the second time.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ALL_TIERS, TIER_LABEL } from "../tiers";

const MARK_START = "// >>> agy-opencode provider (managed) >>>";
const MARK_END = "// <<< agy-opencode provider (managed) <<<";

const PROVIDER_ID = "agy-cli";

export function defaultConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.jsonc");
}

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

function render(port: number, comma: boolean): string {
  const models = ALL_TIERS.map(
    (t) => `    ${JSON.stringify(t)}: { "name": ${JSON.stringify(TIER_LABEL[t])} }`,
  ).join(",\n");

  const body = [
    `"${PROVIDER_ID}": {`,
    `  "npm": "@ai-sdk/openai-compatible",`,
    `  "name": "Antigravity (CLI)",`,
    `  "options": {`,
    `    "baseURL": "http://127.0.0.1:${port}/v1",`,
    `    "apiKey": "agy-cli-local",`,
    `    "timeout": 0,`,
    `    "headerTimeout": 0,`,
    `    "chunkTimeout": 0`,
    `  },`,
    `  "models": {`,
    models,
    `  }`,
    `}${comma ? "," : ""}`,
  ].join("\n");

  return `${MARK_START}\n${body}\n${MARK_END}`;
}

export interface EnsureResult {
  changed: boolean;
  path: string;
  error?: string;
  action?: "inserted" | "replaced" | "unchanged";
}

/** Reads the port recorded in the managed block, so a restart binds the same one. */
export function readProviderPort(path = defaultConfigPath()): number | null {
  try {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    const start = text.indexOf(MARK_START);
    if (start < 0) return null;
    const end = text.indexOf(MARK_END, start);
    const region = end > start ? text.slice(start, end) : text.slice(start);
    const m = region.match(/http:\/\/127\.0\.0\.1:(\d+)\/v1/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Ensures the provider block exists and points at `port`.
 * `path` is injectable so the logic can be exercised against a copy first.
 */
export function ensureProviderConfig(port: number, path = defaultConfigPath()): EnsureResult {
  try {
    if (!existsSync(path)) return { changed: false, path, error: "config not found" };

    const original = readFileSync(path, "utf8");
    const start = original.indexOf(MARK_START);

    if (start >= 0) {
      const end = original.indexOf(MARK_END, start);
      if (end > start) {
        const regionEnd = end + MARK_END.length;
        const before = original.slice(0, start);
        const rawSuffix = original.slice(regionEnd);
        // The separator comma belongs to whichever side writes it; consume any
        // comma sitting between the region and the next member, then keep a
        // newline boundary so the marker never glues onto `}` or a key.
        const noComma = consumeLeadingComma(rawSuffix);
        const suffix = /^[\r\n]/.test(noComma) ? noComma : `\n${noComma}`;
        const wanted = render(port, needsComma(suffix));
        const current = original.slice(start, regionEnd);

        if (wanted === current) return { changed: false, path, action: "unchanged" };

        copyFileSync(path, `${path}.bak-agy-${Date.now()}`);
        writeFileSync(path, `${before}${wanted}${suffix}`, "utf8");
        return { changed: true, path, action: "replaced" };
      }
    }

    // First run: insert right after the opening brace of the `provider` object.
    const anchor = original.indexOf(`"provider"`);
    if (anchor < 0) return { changed: false, path, error: "no provider key" };
    const brace = original.indexOf("{", anchor);
    if (brace < 0) return { changed: false, path, error: "no provider object" };

    const afterBrace = original.slice(brace + 1);
    const wanted = render(port, needsComma(afterBrace));
    const sep = /^[\r\n]/.test(afterBrace) ? "" : "\n";
    const next = `${original.slice(0, brace + 1)}\n    ${wanted}${sep}${afterBrace}`;

    copyFileSync(path, `${path}.bak-agy-${Date.now()}`);
    writeFileSync(path, next, "utf8");
    return { changed: true, path, action: "inserted" };
  } catch (err: any) {
    return { changed: false, path, error: String(err?.message ?? err).slice(0, 200) };
  }
}
