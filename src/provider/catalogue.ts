/**
 * Live model catalogue for the agy provider.
 *
 * Why this exists: the provider used to hardcode tiers (`argon-4-lo`,
 * `claude-opus-5-5-hi`, ...). Those ids do not exist in agy's catalogue — the
 * real ones are `gemini-3.8-flash` / `claude-sonnet-4-6` / ... — and
 * `session/set_config_option` rejects an unknown id with `-32602 Unknown model
 * ID`. Nothing checked the error, so every selection silently ran the account's
 * default model instead.
 *
 * The catalogue is therefore *observed*, never assumed:
 *
 *   session/new -> configOptions[id=model].options   families + display names
 *                  models.availableModels            family + effort ids
 *                  configOptions[id=thought_level]   the account's effort order
 *
 * Efforts per family are confirmed by asking agy (`set_config_option`), because
 * the two listings disagree: `availableModels` advertises `claude-sonnet-4-6`
 * once with no suffix, yet the family rejects every `thought_level` value. Only
 * agy's reply settles it, and its rejection message names the model, so one
 * probe per family is enough.
 *
 * The last good observation is cached on disk so a cold start can offer models
 * before agy answers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One select option agy reported. */
export interface CatalogueOption {
  value: string;
  name?: string;
  description?: string;
}

/** One `configOptions` entry agy reported. */
export interface CatalogueConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: CatalogueOption[];
}

/** `session/new` result fields this module consumes. */
export interface SessionCatalogue {
  configOptions?: CatalogueConfigOption[] | null;
  models?: {
    availableModels?: { modelId: string; name?: string }[] | null;
    currentModelId?: string | null;
  } | null;
}

/** A model the picker may offer. */
export interface CatalogueModel {
  /** Family id handed to `set_config_option` as `model`. */
  id: string;
  /** Display name. */
  name: string;
  /**
   * Efforts agy accepts for this family. Empty means the id carries no
   * selector: a self-describing model such as `gpt-oss-120b-medium`.
   */
  efforts: string[];
}

/** Effort display names. */
const EFFORT_NAMES: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };

/** Effort suffixes agy appends to a family id in `availableModels`. */
const EFFORT_SUFFIXES = ["medium", "high", "low"] as const;

/** The effort order to assume when agy did not report one. */
const DEFAULT_EFFORT_ORDER = ["low", "medium", "high"];

/** Splits `gemini-3.8-flash-high` into family + effort. */
export function splitEffort(id: string): { family: string; effort?: string } {
  for (const effort of EFFORT_SUFFIXES) {
    const suffix = `-${effort}`;
    if (id.endsWith(suffix) && id.length > suffix.length) {
      return { family: id.slice(0, -suffix.length), effort };
    }
  }
  return { family: id };
}

/** The family display names agy reported, keyed by family id. */
function familyOptions(result: SessionCatalogue): CatalogueOption[] {
  const modelOption = (result.configOptions ?? []).find((o) => o?.id === "model");
  return (modelOption?.options ?? []).filter(
    (o): o is CatalogueOption => typeof o?.value === "string" && o.value.length > 0,
  );
}

/** The effort order agy reported. */
function effortOrder(result: SessionCatalogue): string[] {
  const reported =
    (result.configOptions ?? [])
      .find((o) => o?.id === "thought_level")
      ?.options?.map((o) => o.value)
      .filter((v): v is string => typeof v === "string" && v.length > 0) ?? [];
  return reported.length > 0 ? reported : DEFAULT_EFFORT_ORDER;
}

/**
 * Builds the picker catalogue from one `session/new` reply, without probing.
 *
 * `efforts` is left empty for every family: whether a family really accepts a
 * `thought_level` cannot be told from this reply (see `probeEfforts`). Callers
 * that cannot probe still get a usable list of families.
 *
 * @param result - the `session/new` reply.
 * @returns the families to offer, in agy's own order.
 */
export function catalogueFromSession(result: SessionCatalogue | null | undefined): CatalogueModel[] {
  if (!result) return [];

  const options = familyOptions(result);
  if (options.length > 0) {
    return options.map((opt) => ({
      id: opt.value,
      name: typeof opt.name === "string" && opt.name ? opt.name : opt.value,
      efforts: [],
    }));
  }

  // No `configOptions`: fall back to the raw ids, de-duplicated by family.
  const families = new Map<string, string>();
  for (const m of result.models?.availableModels ?? []) {
    if (typeof m?.modelId !== "string" || !m.modelId) continue;
    const { family } = splitEffort(m.modelId);
    if (!families.has(family)) families.set(family, family);
  }
  return [...families.values()].map((id) => ({ id, name: id, efforts: [] }));
}

/**
 * One `set_config_option` attempt, injected so probing is testable.
 * Must resolve to the reply's `configOptions`, or reject with agy's error.
 */
export type ConfigSetter = (
  configId: string,
  value: string,
) => Promise<{ configOptions?: CatalogueConfigOption[] | null } | null | undefined>;

/**
 * Asks agy which efforts each family accepts.
 *
 * `thought_level` is the only honest source: `availableModels` lists
 * `claude-sonnet-4-6` as if it were effort-selectable, but agy rejects every
 * level for it with `Thinking level "low" is not offered for model "..."`.
 * So for each family the first offered level is tried:
 *
 * - accepted  -> the family takes the whole order reported by agy;
 * - rejected  -> the family takes no level (a self-describing model).
 *
 * Every probe ends with the model selection restored, so probing never changes
 * what the caller's turn will run.
 *
 * @param models - families from `catalogueFromSession`.
 * @param order - the effort order agy reported.
 * @param set - one `set_config_option` call bound to a live session.
 * @param currentModel - currently selected family, restored at the end.
 * @returns the catalogue with `efforts` filled in.
 */
export async function probeEfforts(
  models: readonly CatalogueModel[],
  order: readonly string[],
  set: ConfigSetter,
  currentModel?: string,
): Promise<CatalogueModel[]> {
  const levels = order.length > 0 ? [...order] : DEFAULT_EFFORT_ORDER;
  const probeLevel = levels[0];
  const out: CatalogueModel[] = [];

  try {
    for (const model of models) {
      if (!probeLevel) {
        out.push({ ...model, efforts: [] });
        continue;
      }
      // Selecting the family first makes the rejection refer to it, not to
      // whatever model the session happened to be on.
      try {
        await set("model", model.id);
      } catch {
        // An unusable family stays listed but offers nothing; agy will say so
        // again if the user picks it.
        out.push({ ...model, efforts: [] });
        continue;
      }
      try {
        await set("thought_level", probeLevel);
        out.push({ ...model, efforts: levels });
      } catch {
        out.push({ ...model, efforts: [] });
      }
    }
  } finally {
    if (currentModel) {
      try {
        await set("model", currentModel);
      } catch {
        /* restoring is best effort; the caller re-applies its own selection */
      }
    }
  }

  return out;
}

/** Flattens a catalogue into the `family-effort` ids a turn may request. */
export function expandCatalogue(models: readonly CatalogueModel[]): string[] {
  const out: string[] = [];
  for (const m of models) {
    if (m.efforts.length === 0) {
      out.push(m.id);
      continue;
    }
    for (const effort of m.efforts) out.push(`${m.id}-${effort}`);
  }
  return out;
}

/** Where the last good catalogue is cached. */
export function catalogueCachePath(): string {
  return join(homedir(), ".config", "opencode", "agy", "catalogue.json");
}

/** Shape stored on disk. */
interface CacheFile {
  at: string;
  models: CatalogueModel[];
}

/** Reads the cached catalogue, or an empty list when there is none. */
export function readCatalogueCache(path = catalogueCachePath()): CatalogueModel[] {
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheFile>;
    if (!Array.isArray(parsed?.models)) return [];
    return parsed.models.filter(
      (m): m is CatalogueModel =>
        !!m && typeof m.id === "string" && m.id.length > 0 && Array.isArray(m.efforts),
    );
  } catch {
    return [];
  }
}

/** Writes the catalogue cache, best effort. */
export function writeCatalogueCache(models: readonly CatalogueModel[], path = catalogueCachePath()): void {
  if (models.length === 0) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const body: CacheFile = { at: new Date().toISOString(), models: [...models] };
    writeFileSync(path, JSON.stringify(body, null, 2), "utf8");
  } catch {
    /* a read-only config dir only costs a slower cold start */
  }
}

/** Human label for one family + effort. */
export function modelLabel(model: CatalogueModel, effort?: string): string {
  if (!effort) return model.name;
  const pretty = EFFORT_NAMES[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
  return `${model.name} (${pretty})`;
}

/**
 * Validates a requested selection against the catalogue.
 *
 * Returns the family and optional effort to send to agy, or null when the id is
 * not offered — the caller must then fall back to a known-good default instead
 * of sending an id agy will reject.
 *
 * Accepts the flat `family-effort` form the OpenAI `model` field carries, and
 * the bare family (which keeps agy's current effort).
 *
 * @param catalogue - models from `catalogueFromSession` / `probeEfforts`.
 * @param requested - the id the caller asked for.
 */
export function resolveSelection(
  catalogue: readonly CatalogueModel[],
  requested: string | undefined,
): { model: string; effort?: string } | null {
  if (!requested) return null;
  const bare = requested.includes("/") ? requested.slice(requested.indexOf("/") + 1) : requested;

  for (const m of catalogue) {
    if (m.id === bare) return { model: m.id };
  }
  for (const m of catalogue) {
    for (const effort of m.efforts) {
      if (`${m.id}-${effort}` === bare) return { model: m.id, effort };
    }
  }
  return null;
}
