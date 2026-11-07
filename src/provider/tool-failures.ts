/** Hard stop for repeated explicit tool failures, not a limit on useful work. */
export const CONSECUTIVE_TOOL_FAILURE_LIMIT = 5;

export function isCommandTool(name: string): boolean {
  return /^(?:shell|bash|powershell|run_command|terminal|execute)$/i.test(name);
}

export function toolFailureMessage(tool: string, count: number): string {
  return `AGY_TOOL_FAILURE_LIMIT: ${tool} 连续失败 ${count} 次，已停止本轮，避免无效重试消耗额度。请先检查失败原因，再发送新消息重试。`;
}

/** Only explicit execution-status markers; ordinary prose mentioning errors is not failure. */
export function hasFailedToolOutput(text: string): boolean {
  return /(?:^|\n)\s*Exited with code (?!0(?:\s|$))-?\d+\s*$/im.test(text) ||
    /(?:^|\n)\s*Tool execution (?:interrupted|failed)\s*$/im.test(text);
}
