import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupV2Plugin } from "./agy-v2";
import { startProvider, type ProviderServer } from "./provider/server";
import { runTier } from "./provider/run";
import { registerProvider, PROVIDER_ID } from "./provider/register";
import { ensureProviderConfig, readProviderPort, type EnsureResult } from "./provider/config-write";
import { acpPool } from "./provider/acp";
import { loadAccounts, pickAccount } from "./accounts";
import { settingsFromEnv } from "./provider/settings";
import { registerTurnIdentity } from "./provider/turn-identity";

/**
 * agy-opencode - server half.
 *
 * Two jobs:
 * 1. Register the `agy` tool (delegation) and `/agy` command.
 * 2. Run a local OpenAI-compatible bridge to the official `agy` binary and
 *    expose it as the "Antigravity (CLI)" provider, so its models are
 *    selectable as the main model.
 *
 * Contract note (opencode 2.x): the default export MUST be a plain object
 * carrying `id` and a `setup` (or `effect`) function.
 */

/** Held on globalThis so hot reloads reuse one listener instead of leaking ports. */
const SERVER_KEY = Symbol.for("agy-opencode.provider.server");
const TRANSPORT_KEY = Symbol.for("agy-opencode.provider.transport");
const VERSION_KEY = Symbol.for("agy-opencode.provider.version");
/**
 * Bumped whenever the bridge's wire behavior changes. A hot reload keeps the
 * old listener on the port, so without this the plugin would register new
 * tools while requests still hit the previous module's server.
 */
const SERVER_VERSION = 21;

function probe(patch: Record<string, unknown>): void {
  try {
    writeFileSync(
      join(tmpdir(), "agy-provider-state.json"),
      JSON.stringify({ at: new Date().toISOString(), ...patch }, null, 2),
      "utf8",
    );
  } catch {
    /* diagnostics only */
  }
}

/**
 * The account discovery probes with.
 *
 * Same routing as a real turn, so the catalogue describes the account the
 * user will actually run on. Falls back to the system account when the store
 * is unreadable, which is also what `pickAccount` would do.
 */
function resolveAccountForDiscovery() {
  try {
    return pickAccount(loadAccounts());
  } catch {
    return { id: "system", alias: "system", home: "", enabled: true, createdAt: 0 } as any;
  }
}

async function ensureServer(): Promise<ProviderServer> {
  const g = globalThis as any;

  // Reuse only a bridge built by this module version. An older one is closed
  // first: reusing it meant the model picker showed new tools while requests
  // still ran the previous server code.
  if (g[SERVER_KEY] && g[VERSION_KEY] === SERVER_VERSION) return g[SERVER_KEY] as ProviderServer;
  if (g[SERVER_KEY]) {
    try {
      await (g[SERVER_KEY] as ProviderServer).close();
    } catch (err: any) {
      console.warn("[agy-opencode] old bridge close failed:", String(err?.message ?? err));
    }
    g[SERVER_KEY] = null;
  }

  g[SERVER_KEY] = await startProvider({
    // Bind the port the config already points at, so a restart cannot leave the
    // provider block pointing at a dead port.
    port: readProviderPort() ?? undefined,
    transport: "acp",
    run: (tier, prompt) => runTier(tier, prompt, { timeout: "10m" }),
  });
  g[TRANSPORT_KEY] = "acp";
  g[VERSION_KEY] = SERVER_VERSION;
  return g[SERVER_KEY] as ProviderServer;
}

export default {
  id: "agy-opencode",
  async setup(ctx: any) {
    // Read once: the mode decides which agy agent to spawn, and a running
    // prompt cannot change agent mid-conversation anyway.
    const settings = settingsFromEnv();
    await registerTurnIdentity(ctx);

    // Start the bridge first: the provider record needs its URL.
    let bridge: ProviderServer | null = null;
    let startedError: string | null = null;
    try {
      bridge = await ensureServer();
    } catch (err: any) {
      startedError = String(err?.message ?? err);
    }

    let registered: string | null = null;
    let registerError: string | null = null;
    let diag: any = null;
    let reloadError: string | null = null;

    // The picker reads providers from config. The plugin repairs that block so
    // it always points at the live port and uses values the host accepts
    // (`timeout: 0` used to make opencode drop the whole provider). The write is
    // idempotent, backs the file up, and is skipped when nothing changed.
    let configEnsure: EnsureResult | null = null;
    if (bridge) {
      try {
        configEnsure = ensureProviderConfig(bridge.port);
      } catch (err: any) {
        configEnsure = { changed: false, path: "unknown", error: String(err?.message ?? err).slice(0, 200) };
      }
    }

    // Nothing else in this plugin writes the user's config: the bridge only
    // reads the port recorded there, and this block keeps it valid.
    const configuredPort = readProviderPort();

    // Discovery has to happen before registration: the picker is built from
    // the catalogue, and hardcoding model ids is what made every selection
    // silently run the account default.
    let catalogueSize = 0;
    let discoverError: string | null = null;
    if (bridge) {
      try {
        const models = await bridge.pool.discover(resolveAccountForDiscovery());
        catalogueSize = models.length;
        if (models.length) configEnsure = ensureProviderConfig(bridge.port);
      } catch (err: any) {
        discoverError = String(err?.message ?? err).slice(0, 200);
      }
    }

    if (bridge && typeof ctx?.provider?.transform === "function") {
      try {
        diag = await registerProvider(ctx, bridge.url, bridge.pool.models(), settings.contextWindow);
        registered = diag?.outcome ?? null;
      } catch (err: any) {
        registerError = String(err?.message ?? err).slice(0, 400);
      }
      try {
        if (typeof ctx.provider.reload === "function") await ctx.provider.reload();
      } catch (err: any) {
        reloadError = String(err?.message ?? err).slice(0, 200);
      }
    }

    let published: any = null;
    try {
      const list = await ctx.provider.list();
      const rows = (list?.data ?? []) as any[];
      published = {
        total: rows.length,
        ids: rows.map((r: any) => r?.id ?? r?.provider?.id ?? null).slice(0, 10),
        hasAgy: rows.some((r: any) => (r?.id ?? r?.provider?.id) === PROVIDER_ID),
        sampleKeys: rows[0] ? Object.keys(rows[0]) : null,
      };
    } catch (err: any) {
      published = { error: String(err?.message ?? err) };
    }

    probe({
      bridge: bridge ? bridge.url : null,
      configuredPort,
      configEnsure,
      bridgeError: startedError,
      registered,
      registerError,
      reloadError,
      diag,
      published,
      providerID: PROVIDER_ID,
      hasProviderTransform: typeof ctx?.provider?.transform,
      agentMode: settings.agentMode,
      contextWindow: settings.contextWindow,
    });

    return setupV2Plugin(ctx);
  },
};

// touch 498524462
// touch 1003220064
// touch 173908268
// touch 1087515646
