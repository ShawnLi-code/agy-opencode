import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupV2Plugin } from "./agy-v2";
import { startProvider, type ProviderServer } from "./provider/server";
import { runTier } from "./provider/run";
import { registerProvider, PROVIDER_ID } from "./provider/register";
import { ensureProviderConfig, readProviderPort, type EnsureResult } from "./provider/config-write";

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

async function ensureServer(): Promise<ProviderServer> {
  const g = globalThis as any;

  // Reuse the live bridge across hot reloads. Closing it and rebinding the port
  // fails (the old listener still holds it), and losing the bridge also loses
  // the provider registration — which is exactly how the models disappeared.
  if (g[SERVER_KEY]) return g[SERVER_KEY] as ProviderServer;

  g[SERVER_KEY] = await startProvider({
    // Bind the port the config already points at, so a restart cannot leave the
    // provider block pointing at a dead port.
    port: readProviderPort() ?? undefined,
    transport: "acp",
    run: (tier, prompt) => runTier(tier, prompt, { timeout: "10m" }),
  });
  g[TRANSPORT_KEY] = "acp";
  return g[SERVER_KEY] as ProviderServer;
}

export default {
  id: "agy-opencode",
  async setup(ctx: any) {
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

    if (bridge && typeof ctx?.provider?.transform === "function") {
      try {
        diag = await registerProvider(ctx, bridge.url);
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
    });

    return setupV2Plugin(ctx);
  },
};

// touch 498524462
// touch 1003220064
// touch 173908268
// touch 1087515646
