import { describe, expect, test } from "bun:test";
import { runAgy, type SpawnFn } from "../src/agy-runner";

function fake(output: string, captured: { argv?: string[]; input?: string }): SpawnFn {
  return ((argv: string[]) => {
    captured.argv = argv;
    const bytes = new TextEncoder().encode(output);
    const stdout = new ReadableStream<Uint8Array>({ start(c) {
      for (let i = 0; i < bytes.length; i += 13) c.enqueue(bytes.subarray(i, i + 13));
      c.close();
    } });
    const stderr = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    return { stdin: { write(data: string) { captured.input = data; }, end() {} }, stdout, stderr, exited: Promise.resolve(0), kill() {} };
  }) as unknown as SpawnFn;
}

describe("Windows long prompt transport", () => {
  test.skipIf(process.platform !== "win32")("sends long Unicode content via stdin and returns only the final response", async () => {
    const prompt = "测试\\\"".repeat(9000);
    const captured: { argv?: string[]; input?: string } = {};
    const stream = [
      JSON.stringify({ event: "init", init: { model: "test" } }),
      JSON.stringify({ event: "step_update", step_update: { text_delta: "partial" } }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "完成 OK" } }),
    ].join("\n") + "\n";
    const result = await runAgy({ prompt }, fake(stream, captured));
    expect(captured.argv).toContain("stream-json");
    expect(captured.argv).not.toContain(prompt);
    expect(JSON.parse(captured.input!).message.content).toBe(prompt);
    expect(result.stdout).toBe("完成 OK");
  });

  test.skipIf(process.platform !== "win32")("rejects an incomplete stream rather than returning protocol events", async () => {
    await expect(runAgy({ prompt: "x".repeat(40_000) }, fake('{"event":"init"}\n', {}))).rejects.toMatchObject({ code: "AGY_FAILED" });
  });

  test("keeps short prompts on the ordinary print path", async () => {
    const captured: { argv?: string[]; input?: string } = {};
    const result = await runAgy({ prompt: "short" }, fake("OK", captured));
    expect(captured.argv).toContain("-p");
    expect(captured.argv).toContain("short");
    expect(result.stdout).toBe("OK");
  });
});
