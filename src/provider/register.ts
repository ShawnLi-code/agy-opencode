/**
 * Registers the local agy bridge as an opencode provider so its models appear
 * in the model picker.
 *
 * The model list is no longer hardcoded. It is whatever the account's live
 * catalogue reports (see `catalogue.ts`), because agy rejects ids it does not
 * know and this provider used to advertise thirteen that never existed.
 */

import { modelLabel, type CatalogueModel } from "./catalogue";

export const PROVIDER_ID = "agy-cli";
export const PROVIDER_NAME = "Antigravity (CLI)";

const PACKAGE = "@opencode/ai/providers/openai-compatible";

export interface ProviderInfo {
  id: string;
  name: string;
  /** `auto` only activates when a credential exists; the bridge has none. */
  activation: "enabled";
  package: string;
  settings: { baseURL: string; apiKey: string };
}

/**
 * The bridge ignores auth, but the openai-compatible adapter and the settings UI
 * treat a provider without an API key as unconfigured, so a local placeholder is
 * required for the provider to be listed alongside the others.
 */
const LOCAL_KEY = "agy-cli-local";

/** Context agy allows without any unlock; the physical window is larger. */
const LOCKED_CONTEXT_WINDOW = 256_000;
/** Output budget agy reports for every family. */
const MAX_OUTPUT_TOKENS = 65_536;

export function providerInfo(baseURL: string): ProviderInfo {
  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    activation: "enabled",
    package: PACKAGE,
    settings: { baseURL: `${baseURL}/v1`, apiKey: LOCAL_KEY },
  };
}

/**
 * One picker entry per model agy actually offers, expanded per effort.
 *
 * `limit.context` reports the window agy really enforces (256K), not the 1M the
 * model is physically capable of: over-reporting makes opencode send context the
 * CLI then truncates or rejects.
 *
 * @param baseURL - the bridge origin, without `/v1`.
 * @param models - the live catalogue; empty means discovery has not run yet.
 */
export function modelInfos(
  baseURL: string,
  models: readonly CatalogueModel[] = [],
  contextWindow = LOCKED_CONTEXT_WINDOW,
): any[] {
  const released = Date.now();
  const rows: any[] = [];

  for (const model of models) {
    const variants: (string | undefined)[] = model.efforts.length > 0 ? [...model.efforts] : [undefined];
    for (const effort of variants) {
      const id = effort ? `${model.id}-${effort}` : model.id;
      rows.push({
        id,
        modelID: id,
        providerID: PROVIDER_ID,
        type: "chat",
        // One family per picker entry. OpenCode's default visibility keeps
        // only the newest model per family; a shared family hid Low/High and
        // left just Medium. Each effort must be its own family.
        family: id,
        name: modelLabel(model, effort),
        package: PACKAGE,
        settings: {
          baseURL: `${baseURL}/v1`,
          provider: PROVIDER_ID,
          apiKey: LOCAL_KEY,
        },
        capabilities: {
          tools: true,
          input: ["text"],
          output: ["text"],
          // The adapter ignores temperature: agy has no such knob.
          temperature: false,
        },
        variants: [],
        time: { released },
        cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
        status: "active",
        enabled: true,
        limit: { context: contextWindow, output: MAX_OUTPUT_TOKENS },
      });
    }
  }

  return rows;
}

/**
 * Adds the provider on first run and updates it on reload. `transform` may run
 * more than once per process (hot reload), so both paths are covered.
 */
export interface RegisterDiag {
  outcome: "added" | "updated";
  before: number;
  after: number;
  foundExisting: boolean;
  modelCount: number;
  error?: string;
}

export async function registerProvider(
  ctx: any,
  baseURL: string,
  catalogue: readonly CatalogueModel[] = [],
  contextWindow = LOCKED_CONTEXT_WINDOW,
): Promise<RegisterDiag> {
  const info = providerInfo(baseURL);
  const models = modelInfos(baseURL, catalogue, contextWindow);
  const diag: RegisterDiag = {
    outcome: "added",
    before: -1,
    after: -1,
    foundExisting: false,
    modelCount: models.length,
  };

  const apply = (editor: any) => {
    try {
      const before = typeof editor.list === "function" ? editor.list() : [];
      diag.before = Array.isArray(before) ? before.length : -1;

      // `editor.get` can miss a provider added by a previous plugin instance
      // after a hot reload, which made every setup call `add` again. The
      // picker then kept reading the first record (and its older model list).
      // Fall back to the provider list and update that record in place.
      const list = Array.isArray(before) ? before : [];
      const fromList = list.find((row: any) => {
        const id = row?.id ?? row?.provider?.id ?? row?.info?.id;
        return id === PROVIDER_ID;
      });
      const existing =
        (typeof editor.get === "function" ? editor.get(PROVIDER_ID) : undefined) ?? fromList;
      diag.foundExisting = !!existing;

      if (existing) {
        diag.outcome = "updated";
        editor.update(PROVIDER_ID, (draft: any) => {
          draft.name = info.name;
          draft.activation = info.activation;
          draft.package = info.package;
          draft.settings = { ...info.settings };
          // Standalone provider: an integrationID with no matching integration
          // makes the picker treat it as unconfigured and hide its models.
          delete draft.integrationID;
        });
        // Only overwrite the model list when the catalogue is known: an empty
        // discovery must not wipe models the user can currently pick.
        if (models.length > 0) editor.models.set(PROVIDER_ID, models);
      } else {
        editor.add({ info, models });
      }

      const after = typeof editor.list === "function" ? editor.list() : [];
      diag.after = Array.isArray(after) ? after.length : -1;
    } catch (err: any) {
      diag.error = String(err?.message ?? err).slice(0, 300);
      throw err;
    }
  };

  await ctx.provider.transform(apply);
  return diag;
}
