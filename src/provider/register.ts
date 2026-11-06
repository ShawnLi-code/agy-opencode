/**
 * Registers the local agy bridge as an opencode provider so its models appear
 * in the model picker.
 *
 * The provider record shape below mirrors what the host already holds for
 * built-in providers (`@opencode/ai/providers/openai-compatible` + a baseURL),
 * so opencode talks to our server exactly as it talks to any OpenAI-compatible
 * endpoint.
 */

import { ALL_TIERS, TIER_LABEL } from "../tiers";

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

export function providerInfo(baseURL: string): ProviderInfo {
  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    activation: "enabled",
    package: PACKAGE,
    settings: { baseURL: `${baseURL}/v1`, apiKey: LOCAL_KEY },
  };
}

export function modelInfos(baseURL: string): any[] {
  const released = Date.now();
  return ALL_TIERS.map((tier) => ({
    id: tier,
    modelID: tier,
    providerID: PROVIDER_ID,
    type: "chat",
    family: "Antigravity",
    name: TIER_LABEL[tier] ?? tier,
    package: PACKAGE,
    settings: { baseURL: `${baseURL}/v1`, provider: PROVIDER_ID, apiKey: LOCAL_KEY },
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
    limit: { context: 1048576, input: 1000000, output: 65536 },
  }));
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
  error?: string;
}

export async function registerProvider(ctx: any, baseURL: string): Promise<RegisterDiag> {
  const info = providerInfo(baseURL);
  const models = modelInfos(baseURL);
  const diag: RegisterDiag = { outcome: "added", before: -1, after: -1, foundExisting: false };

  const apply = (editor: any) => {
    try {
      const before = typeof editor.list === "function" ? editor.list() : [];
      diag.before = Array.isArray(before) ? before.length : -1;

      const existing = typeof editor.get === "function" ? editor.get(PROVIDER_ID) : undefined;
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
        editor.models.set(PROVIDER_ID, models);
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
