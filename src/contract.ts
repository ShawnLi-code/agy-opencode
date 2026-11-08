/**
 * The IPC contract between the plugin's GUI (renderer) and its main process.
 *
 * The renderer cannot touch the filesystem, so every account operation goes
 * through the main process, which owns `~/.config/opencode/agy/accounts.json`
 * and can spawn `agy models` to probe an account.
 */

import { Ipc } from "@opencode/plugin/gui";
import * as Effect from "effect";

export const UsageRowSchema = Effect.Schema.Struct({
  group: Effect.Schema.String,
  label: Effect.Schema.String,
  percent: Effect.Schema.Number,
  resetAt: Effect.Schema.String,
});

export const AccountSchema = Effect.Schema.Struct({
  id: Effect.Schema.String,
  alias: Effect.Schema.String,
  home: Effect.Schema.String,
  enabled: Effect.Schema.Boolean,
  createdAt: Effect.Schema.Number,
  argon: Effect.Schema.optional(Effect.Schema.Boolean),
  claude: Effect.Schema.optional(Effect.Schema.Boolean),
  flash: Effect.Schema.optional(Effect.Schema.Boolean),
  models: Effect.Schema.optional(Effect.Schema.Array(Effect.Schema.String)),
  checkedAt: Effect.Schema.optional(Effect.Schema.Number),
  error: Effect.Schema.optional(Effect.Schema.String),
  calls: Effect.Schema.optional(Effect.Schema.Number),
  failures: Effect.Schema.optional(Effect.Schema.Number),
  lastUsedAt: Effect.Schema.optional(Effect.Schema.Number),
  lastError: Effect.Schema.optional(Effect.Schema.String),
  cooldownUntil: Effect.Schema.optional(Effect.Schema.Number),
  usage: Effect.Schema.optional(Effect.Schema.Array(UsageRowSchema)),
  usageCheckedAt: Effect.Schema.optional(Effect.Schema.Number),
  usageError: Effect.Schema.optional(Effect.Schema.String),
  email: Effect.Schema.optional(Effect.Schema.String),
  name: Effect.Schema.optional(Effect.Schema.String),
});

export const StateSchema = Effect.Schema.Struct({
  activeAccountId: Effect.Schema.String,
  defaultTier: Effect.Schema.String,
  routing: Effect.Schema.String,
  cooldownMs: Effect.Schema.Number,
  agentMode: Effect.Schema.String,
  autoApproveNative: Effect.Schema.Boolean,
  acpIdleMinutes: Effect.Schema.Number,
  acpMaxSessions: Effect.Schema.Number,
  /** Context window advertised to opencode; 256K official, 983,040 with the binary patch. */
  contextWindow: Effect.Schema.Number,
  nextAccountId: Effect.Schema.String,
  accounts: Effect.Schema.Array(AccountSchema),
});

export type AccountState = typeof StateSchema.Type;

export const AgyAccounts = Ipc.define({
  id: "agy-opencode.accounts",
  methods: {
    /** Current state: accounts plus the selected defaults. */
    read: { output: StateSchema },
    /** Create a new account with an isolated HOME. */
    add: { input: Effect.Schema.Struct({ alias: Effect.Schema.String }), output: AccountSchema },
    /** Delete an account entry (optionally its HOME directory). */
    remove: {
      input: Effect.Schema.Struct({ id: Effect.Schema.String, purgeHome: Effect.Schema.optional(Effect.Schema.Boolean) }),
      output: Effect.Schema.Boolean,
    },
    /** Run `agy models` as this account and cache what it can use. */
    probe: { input: Effect.Schema.Struct({ id: Effect.Schema.String }), output: AccountSchema },
    /** Read remaining quota via the official `agy --print=/usage` command. */
    usage: { input: Effect.Schema.Struct({ id: Effect.Schema.String }), output: AccountSchema },
    /** Pick the account the tool uses by default. */
    setActive: { input: Effect.Schema.Struct({ id: Effect.Schema.String }), output: Effect.Schema.Boolean },
    /** Pick the tier used when a call does not specify one. */
    setDefaultTier: { input: Effect.Schema.Struct({ tier: Effect.Schema.String }), output: Effect.Schema.Boolean },
    /** Pick how the next account is chosen: active / sequential / roundrobin. */
    setRouting: { input: Effect.Schema.Struct({ routing: Effect.Schema.String }), output: Effect.Schema.Boolean },
    setAgentMode: { input: Effect.Schema.Struct({ mode: Effect.Schema.String }), output: Effect.Schema.Boolean },
    /** How long an account rests after a quota/auth failure, in minutes. */
    setCooldown: { input: Effect.Schema.Struct({ minutes: Effect.Schema.Number }), output: Effect.Schema.Boolean },
    /** Idle/min-open limits for the ACP worker pool. */
    setAcpLimits: {
      input: Effect.Schema.Struct({
        idleMinutes: Effect.Schema.Number,
        maxSessions: Effect.Schema.Number,
      }),
      output: Effect.Schema.Boolean,
    },
    /** Context window advertised to opencode (256K official / 983,040 patched). */
    setContextWindow: {
      input: Effect.Schema.Struct({ tokens: Effect.Schema.Number }),
      output: Effect.Schema.Boolean,
    },
    /** Clear a cooldown so the account is used again immediately. */
    clearCooldown: { input: Effect.Schema.Struct({ id: Effect.Schema.String }), output: Effect.Schema.Boolean },
    /** Reset the local usage counters for an account. */
    resetUsage: { input: Effect.Schema.Struct({ id: Effect.Schema.String }), output: Effect.Schema.Boolean },
    /**
     * Start Google sign-in for an account. Returns the OAuth URL the CLI prints;
     * no browser is launched, so the user can open it in whichever browser is
     * already signed in.
     */
    login: {
      input: Effect.Schema.Struct({ id: Effect.Schema.String }),
      output: Effect.Schema.Struct({ url: Effect.Schema.String }),
    },
    /** Hand the pasted authorization code (or redirect URL) back to the CLI. */
    loginCode: {
      input: Effect.Schema.Struct({ id: Effect.Schema.String, code: Effect.Schema.String }),
      output: Effect.Schema.Struct({
        ok: Effect.Schema.Boolean,
        email: Effect.Schema.optional(Effect.Schema.String),
        error: Effect.Schema.optional(Effect.Schema.String),
      }),
    },
    /** Abandon an in-flight sign-in and stop the waiting CLI process. */
    loginCancel: { input: Effect.Schema.Struct({ id: Effect.Schema.String }), output: Effect.Schema.Boolean },
  },
});
