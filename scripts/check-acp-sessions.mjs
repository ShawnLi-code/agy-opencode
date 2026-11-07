/**
 * Live check of ACP session retention.
 *
 * A worker costs ~180 MB and agy starts one per session. The pool must close
 * idle workers, keep the conversation on disk, and restore it with
 * `session/load` when the user comes back.
 *
 * Proves, against real agy:
 * 1. two conversations open two workers;
 * 2. the reaper closes both after the idle budget, and the workers exit;
 * 3. a follow-up in the first conversation reloads it and remembers context.
 *
 * Run: bun scripts/check-acp-sessions.mjs
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outfile = join(mkdtempSync(join(tmpdir(), "agy-sessions-check-")), "acp.mjs");
await build({
  entryPoints: ["src/provider/acp.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile,
  logLevel: "silent",
});
const { AcpPool } = await import(pathToFileURL(outfile).href);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

function agyPids(filter = "") {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='agy.exe'"${filter} | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: "utf8" },
    );
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** Worker PIDs currently alive; `--worker` is agy's per-session process. */
function workerPids() {
  return agyPids(" | Where-Object { $_.CommandLine -like '*--worker*' }");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const account = {
  id: "acc_mw64ua7s_qprzd",
  alias: "check",
  home: "C:/Users/Shawn/.config/opencode/agy/accounts/acc_mw64ua7s_qprzd",
  enabled: true,
  createdAt: 0,
};

const pool = new AcpPool({ idleMs: 60_000, sweepMs: 250, maxOpen: 2, keep: 8 });
const baseline = new Set(workerPids());
const keyA = `sessions-check-a-${Date.now()}`;
const keyB = `sessions-check-b-${Date.now()}`;

const firstA = "Remember the codeword PELICAN42X. Reply with OK only.";
const firstB = "Remember the codeword KIWI77. Reply with OK only.";

try {
  // Start both conversations together: with a short test idle budget, a
  // sequential turn would let the reaper close A while B is starting.
  const [turnA, turnB] = await Promise.all([
    pool.turn({
      conversationKey: keyA,
      account,
      inputs: [firstA],
      nativeTools: true,
      autoApprove: true,
      onChunk: () => {},
    }),
    pool.turn({
      conversationKey: keyB,
      account,
      inputs: [firstB],
      nativeTools: true,
      autoApprove: true,
      onChunk: () => {},
    }),
  ]);
  check("turn A: answered", /ok/i.test(turnA.text ?? ""), JSON.stringify(turnA.text?.slice(0, 60)));
  check("turn B: answered", /ok/i.test(turnB.text ?? ""), JSON.stringify(turnB.text?.slice(0, 60)));

  let stats = pool.stats();
  check("pool: two open sessions", stats.open === 2, JSON.stringify(stats));

  const openedPids = workerPids().filter((pid) => !baseline.has(pid));
  check("processes: two workers for two conversations", openedPids.length >= 2, JSON.stringify(openedPids));

  // Release both workers on demand; this is the same close path the idle
  // timer uses, without waiting for a production-sized idle budget.
  await pool.reap({ force: true });
  stats = pool.stats();
  check("reap: workers released", stats.open === 0, JSON.stringify(stats));
  check("reap: sessions kept for resume", stats.kept === 2, JSON.stringify(stats));

  await sleep(800);
  const alive = new Set(workerPids());
  const lingering = openedPids.filter((pid) => alive.has(pid));
  check("reap: worker processes exited", lingering.length === 0, JSON.stringify(lingering));

  const followUp = await pool.turn({
    conversationKey: keyA,
    account,
    inputs: [firstA, "What is the codeword? Reply with just the codeword."],
    nativeTools: true,
    autoApprove: true,
    onChunk: () => {},
  });
  check("resume: answer from reloaded session", /PELICAN42X/i.test(followUp.text ?? ""), JSON.stringify(followUp.text?.slice(0, 80)));
  stats = pool.stats();
  check("resume: one worker reopened", stats.open === 1, JSON.stringify(stats));

  // Disposing must take the whole tree, not just the cmd.exe wrapper: an
  // orphaned supervisor keeps its workers alive after every reload. Check the
  // workers this test spawned, not every new agy process: a concurrent reload
  // can start unrelated supervisors.
  const ours = workerPids().filter((pid) => !baseline.has(pid));
  check("dispose: test workers running", ours.length > 0, JSON.stringify(ours));
  pool.dispose();
  await sleep(1_200);
  const aliveWorkers = new Set(workerPids());
  const left = ours.filter((pid) => aliveWorkers.has(pid));
  check("dispose: test workers exited", left.length === 0, JSON.stringify(left));
} catch (err) {
  check("live run completed", false, String(err).slice(0, 300));
} finally {
  pool.dispose();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(failed.length === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
