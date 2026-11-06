/**
 * Account model + on-disk state shared by the server half (Bun) and the GUI
 * main process (Node/Electron). No GUI imports here on purpose.
 *
 * Isolation model (same idea the DeepSeek Harness uses): every extra account
 * gets its own HOME directory, and `agy` is spawned with USERPROFILE / HOME /
 * APPDATA / LOCALAPPDATA pointed into it. `agy` reads its OAuth token from
 * `<home>/.gemini/antigravity-cli/antigravity-oauth-token`, so each account
 * keeps its own credentials without touching the real system profile.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface UsageRow {
  group: string;
  label: string;
  /** Remaining fraction as a percentage, 0-100. */
  percent: number;
  /** ISO timestamp when this window resets. */
  resetAt: string;
}

export interface Account {
  id: string;
  alias: string;
  /** Absolute HOME for this account. Empty string = the system account. */
  home: string;
  enabled: boolean;
  createdAt: number;
  /** Capability probe cache. */
  argon?: boolean;
  claude?: boolean;
  flash?: boolean;
  models?: string[];
  checkedAt?: number;
  error?: string;
  /** Local usage stats (no network involved). */
  calls?: number;
  failures?: number;
  lastUsedAt?: number;
  lastError?: string;
  /** Epoch ms until which this account is skipped by routing. */
  cooldownUntil?: number;
  /** Last quota reading from the official CLI `/usage` command. */
  usage?: UsageRow[];
  usageCheckedAt?: number;
  /** Why the last quota read failed (timeout, CLI error, ...). */
  usageError?: string;
  /** Google account email, decoded from the CLI's own id_token (no network). */
  email?: string;
  /** Display name from the id_token, when present. */
  name?: string;
}

/** How the next account is chosen when several are enabled. */
export type Routing = "active" | "sequential" | "roundrobin";

export interface AccountsFile {
  version: 1;
  /** Account used when the tool does not name one. */
  activeAccountId: string;
  /** Fallback tier when the caller does not pass one. */
  defaultTier: string;
  /** Account selection strategy. */
  routing: Routing;
  /** How long an account rests after a quota/auth failure. */
  cooldownMs: number;
  accounts: Account[];
}

export const SYSTEM_ACCOUNT_ID = "system";

const DEFAULT_FILE: AccountsFile = {
  version: 1,
  activeAccountId: SYSTEM_ACCOUNT_ID,
  defaultTier: "argon-4-lo",
  routing: "active",
  cooldownMs: 15 * 60 * 1000,
  accounts: [
    {
      id: SYSTEM_ACCOUNT_ID,
      alias: "系统账号（agy 已登录）",
      home: "",
      enabled: true,
      createdAt: 0,
    },
  ],
};

/** `~/.config/opencode/agy` on every platform, matching OpenCode's config dir. */
export function stateDir(): string {
  return join(homedir(), ".config", "opencode", "agy");
}

export function accountsFile(): string {
  return join(stateDir(), "accounts.json");
}

export function accountHome(id: string): string {
  return join(stateDir(), "accounts", id);
}

export function loadAccounts(): AccountsFile {
  const file = accountsFile();
  try {
    if (!existsSync(file)) {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(file, JSON.stringify(DEFAULT_FILE, null, 2), "utf8");
      return structuredClone(DEFAULT_FILE);
    }
    const parsed = JSON.parse(readFileSync(file, "utf8")) as AccountsFile;
    if (!parsed || !Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
      return structuredClone(DEFAULT_FILE);
    }
    return {
      version: 1,
      activeAccountId: parsed.activeAccountId ?? SYSTEM_ACCOUNT_ID,
      defaultTier: parsed.defaultTier ?? "argon-4-lo",
      routing: parsed.routing ?? "active",
      cooldownMs: typeof parsed.cooldownMs === "number" ? parsed.cooldownMs : 15 * 60 * 1000,
      accounts: parsed.accounts,
    };
  } catch {
    return structuredClone(DEFAULT_FILE);
  }
}

export function saveAccounts(data: AccountsFile): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(accountsFile(), JSON.stringify(data, null, 2), "utf8");
}

/** True while the account is resting after a quota/auth failure. */
export function inCooldown(account: Account, now = Date.now()): boolean {
  return typeof account.cooldownUntil === "number" && account.cooldownUntil > now;
}

/**
 * Chooses the account for the next run.
 *
 * - `active`: the selected account, falling back to the first enabled one.
 * - `sequential`: the first enabled account, in list order.
 * - `roundrobin`: the enabled account that has waited longest since its last run.
 *
 * Accounts in cooldown are skipped. If every account is cooling down, the one
 * whose cooldown ends soonest is used rather than failing the call.
 */
export function pickAccount(data: AccountsFile = loadAccounts(), now = Date.now()): Account {
  const enabled = data.accounts.filter((a) => a.enabled);
  const pool = enabled.length > 0 ? enabled : data.accounts;
  const ready = pool.filter((a) => !inCooldown(a, now));

  if (ready.length === 0) {
    return [...pool].sort((a, b) => (a.cooldownUntil ?? 0) - (b.cooldownUntil ?? 0))[0];
  }

  if (data.routing === "sequential") return ready[0];

  if (data.routing === "roundrobin") {
    return [...ready].sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))[0];
  }

  const active = ready.find((a) => a.id === data.activeAccountId);
  return active ?? ready[0];
}

/** Backwards-compatible alias. */
export function resolveActiveAccount(data: AccountsFile = loadAccounts()): Account {
  return pickAccount(data);
}

/** Error codes that mean "this account is out of budget right now". */
const COOLDOWN_CODES = new Set(["QUOTA_EXHAUSTED", "AUTH_REQUIRED"]);

/**
 * Records the outcome of one run: usage counters, last activity, and a
 * cooldown when the failure is account-wide (quota or auth). Timeouts and
 * model-not-found are not account failures, so they do not rest the account.
 */
export function recordResult(
  id: string,
  outcome: { ok: boolean; ms: number; code?: string; message?: string },
): void {
  const data = loadAccounts();
  const acc = data.accounts.find((a) => a.id === id);
  if (!acc) return;

  acc.calls = (acc.calls ?? 0) + 1;
  acc.lastUsedAt = Date.now();
  if (!outcome.ok) {
    acc.failures = (acc.failures ?? 0) + 1;
    acc.lastError = outcome.code ?? "UNEXPECTED";
    if (outcome.code && COOLDOWN_CODES.has(outcome.code)) {
      acc.cooldownUntil = Date.now() + data.cooldownMs;
    }
  }
  saveAccounts(data);
}

/**
 * Environment overrides for spawning `agy` as `account`.
 * Returns an empty object for the system account.
 */
export function accountEnv(account: Account): Record<string, string> {
  if (!account.home) return {};
  return {
    HOME: account.home,
    USERPROFILE: account.home,
    APPDATA: join(account.home, "AppData", "Roaming"),
    LOCALAPPDATA: join(account.home, "AppData", "Local"),
  };
}

/** Where the official CLI keeps this account's OAuth token. */
export function accountTokenPath(account: Account): string {
  const base = account.home || homedir();
  return join(base, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

export interface AccountIdentity {
  email?: string;
  name?: string;
  /** A token file exists and carries an access token. */
  loggedIn: boolean;
  /** The token's own expiry is in the past. */
  expired?: boolean;
}

/** Decodes a JWT payload without verifying it — the token is the CLI's own. */
function jwtPayload(token: unknown): Record<string, any> | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reads the account's identity from the CLI's own token file. Local file read
 * only: no network, no token reuse, nothing printed.
 */
export function readIdentity(account: Account): AccountIdentity {
  const file = accountTokenPath(account);
  if (!existsSync(file)) return { loggedIn: false };
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as any;
    const access = data?.token?.access_token;
    const payload = jwtPayload(data?.id_token) ?? jwtPayload(access);
    const expiry = typeof data?.token?.expiry === "string" ? Date.parse(data.token.expiry) : NaN;
    return {
      email: typeof payload?.email === "string" ? payload.email : undefined,
      name: typeof payload?.name === "string" ? payload.name : undefined,
      loggedIn: typeof access === "string" && access.length > 0,
      expired: Number.isFinite(expiry) ? expiry < Date.now() : undefined,
    };
  } catch {
    return { loggedIn: false };
  }
}

export interface ProbeResult {
  ok: boolean;
  models: string[];
  argon: boolean;
  claude: boolean;
  flash: boolean;
  error?: string;
}

/**
 * Kills the CLI and anything it spawned. `shell: true` means the direct child is
 * a shell on Windows, so `child.kill()` alone leaves `agy` running.
 */
function killTree(child: { pid?: number; kill: (signal?: any) => boolean }, signal?: any): void {
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      /* fall through to kill() */
    }
  }
  try {
    child.kill(signal ?? "SIGKILL");
  } catch {}
}

/** Runs `agy models` under an account and derives what it can actually use. */
export function probeAccount(account: Account, timeoutMs = 90_000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const env = { ...process.env, ...accountEnv(account) } as Record<string, string>;
    let out = "";
    let err = "";
    let done = false;
    const finish = (r: ProbeResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };

    let child;
    try {
      child = spawn("agy", ["models"], { env, shell: true, windowsHide: true });
    } catch (e: any) {
      finish({ ok: false, models: [], argon: false, claude: false, flash: false, error: String(e?.message ?? e) });
      return;
    }

    const timer = setTimeout(() => {
      killTree(child);
      finish({ ok: false, models: [], argon: false, claude: false, flash: false, error: "TIMEOUT" });
    }, timeoutMs);

    child.stdout?.on("data", (b) => (out += String(b)));
    child.stderr?.on("data", (b) => (err += String(b)));
    child.on("error", (e: any) => {
      clearTimeout(timer);
      finish({ ok: false, models: [], argon: false, claude: false, flash: false, error: String(e?.message ?? e) });
    });
    child.on("close", () => {
      clearTimeout(timer);
      const models = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^[a-z0-9][a-z0-9.\-]*\t/i.test(l))
        .map((l) => l.split("\t")[0].trim());
      if (models.length === 0) {
        finish({
          ok: false,
          models: [],
          argon: false,
          claude: false,
          flash: false,
          error: (err || out).trim().slice(0, 300) || "EMPTY",
        });
        return;
      }
      finish({
        ok: true,
        models,
        argon: models.some((m) => m.startsWith("gemini-4-argon")),
        claude: models.some((m) => m.startsWith("claude-")),
        flash: models.some((m) => m.startsWith("gemini-3.8-flash")),
      });
    });
  });
}

/**
 * Reads this account's remaining quota through the official CLI command
 * `agy --print=/usage`. This is the sanctioned path: it runs the real CLI, so
 * it is the same request the app itself makes — no token reuse, no direct
 * Cloud Code Assist calls.
 *
 * The command prints tab-separated rows:
 *   Gemini Models \t Weekly Limit Remaining \t 71% \t 2026-11-08T05:46:37Z
 */
export function fetchUsage(account: Account, timeoutMs = 30_000): Promise<UsageRow[]> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...accountEnv(account) } as Record<string, string>;
    let out = "";
    let err = "";
    let done = false;

    let child;
    try {
      child = spawn("agy", ["--print=/usage"], { env, shell: true, windowsHide: true });
    } catch (e: any) {
      reject(e);
      return;
    }

    const timer = setTimeout(() => {
      killTree(child);
      if (!done) {
        done = true;
        reject(new Error("usage TIMEOUT"));
      }
    }, timeoutMs);

    child.stdout?.on("data", (b) => (out += String(b)));
    child.stderr?.on("data", (b) => (err += String(b)));
    child.on("error", (e: any) => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        reject(e);
      }
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (done) return;
      done = true;

      const rows = out
        .split(/\r?\n/)
        .map((l) => l.split("\t").map((c) => c.trim()))
        .filter((c) => c.length >= 4 && /^\d+%$/.test(c[2]))
        .map((c) => ({
          group: c[0],
          label: c[1],
          percent: Number(c[2].replace("%", "")),
          resetAt: c[3],
        }));

      if (rows.length === 0) {
        reject(new Error((err || out).trim().slice(0, 300) || "usage EMPTY"));
        return;
      }
      resolve(rows);
    });
  });
}

/** Creates a fresh account with an isolated HOME. Login is a separate step. */
export function createAccount(alias: string): Account {
  const id = `acc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const home = accountHome(id);
  mkdirSync(join(home, ".gemini"), { recursive: true });
  mkdirSync(join(home, "AppData", "Roaming"), { recursive: true });
  mkdirSync(join(home, "AppData", "Local"), { recursive: true });

  const data = loadAccounts();
  const account: Account = {
    id,
    alias: alias.trim() || `账号 ${data.accounts.length + 1}`,
    home,
    enabled: true,
    createdAt: Date.now(),
  };
  data.accounts.push(account);
  saveAccounts(data);
  return account;
}

export function removeAccount(id: string, purgeHome = false): boolean {
  if (id === SYSTEM_ACCOUNT_ID) return false;
  const data = loadAccounts();
  const target = data.accounts.find((a) => a.id === id);
  if (!target) return false;
  data.accounts = data.accounts.filter((a) => a.id !== id);
  if (data.activeAccountId === id) data.activeAccountId = SYSTEM_ACCOUNT_ID;
  saveAccounts(data);
  if (purgeHome && target.home) {
    try {
      rmSync(target.home, { recursive: true, force: true });
    } catch {}
  }
  return true;
}
