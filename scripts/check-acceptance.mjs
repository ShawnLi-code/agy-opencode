/** One bounded, fail-fast acceptance run. Add --live to use real model quota. */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const live = process.argv.includes("--live");
const dir = mkdtempSync(join(tmpdir(), "agy-acceptance-"));
const bun = typeof Bun !== "undefined" ? process.execPath : "bun";
const steps = [
  ["turns-node", "node", ["scripts/check-turn-regressions.mjs"], 30_000],
  ["turns-bun", bun, ["scripts/check-turn-regressions.mjs"], 30_000],
  ["protocol", "node", ["scripts/provider-check.mjs"], 30_000],
  ["mcp", bun, ["scripts/check-mcp-bridge.mjs"], 30_000],
  ["capacity", bun, ["scripts/check-provider-capacity.mjs"], 30_000],
  ["models", bun, ["scripts/check-models.mjs"], 30_000],
  ["provider-types", "node", ["node_modules/typescript/bin/tsc", "--noEmit", "--target", "ESNext", "--module", "ESNext", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--types", "node", "src/provider/acp.ts", "src/provider/server.ts", "src/provider/tool-bridge.ts"], 30_000],
  ...(live ? [
    ["live-native-mirror", bun, ["scripts/check-acp-native.mjs"], 100_000],
    ["live-turns", bun, ["scripts/check-turn-live.mjs"], 140_000],
    ["live-stop", bun, ["scripts/check-stop-live.mjs"], 110_000],
    ["live-failure-recovery", bun, ["scripts/check-failure-live.mjs"], 200_000],
  ] : []),
];
const report = { startedAt: new Date().toISOString(), live, directory: process.cwd(), results: [] };
const resultFile = join(dir, "results.json");
for (const [name, command, args, timeout] of steps) {
  const began = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { child.kill(); }
      } else child.kill("SIGKILL");
    }, timeout);
    child.once("error", (error) => { clearTimeout(timer); resolve({ code: -1, output: output + String(error), timedOut }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, output, timedOut }); });
  });
  const log = join(dir, `${name}.log`);
  writeFileSync(log, result.output, "utf8");
  const pass = result.code === 0 && !result.timedOut;
  report.results.push({ name, pass, code: result.code, timedOut: result.timedOut, durationMs: Date.now() - began, log });
  writeFileSync(resultFile, JSON.stringify(report, null, 2), "utf8");
  console.log(`${pass ? "PASS" : "FAIL"} ${name} (${Date.now() - began}ms)`);
  if (!pass) {
    console.error(result.output.slice(-5000));
    console.error(`RESULT: FAIL — ${resultFile}`);
    process.exit(1);
  }
}
report.finishedAt = new Date().toISOString();
report.pass = true;
writeFileSync(resultFile, JSON.stringify(report, null, 2), "utf8");
console.log(`RESULT: PASS (${steps.length}/${steps.length} suites) — ${resultFile}`);
