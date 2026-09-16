import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  cwd?: string;
}

/**
 * execFile (not exec) so arguments are never passed through a shell: container
 * names and connector names arrive from tool input and must not be able to
 * inject shell syntax.
 */
export function run(
  command: string,
  args: string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  const { timeoutMs = 15_000, maxBuffer = 32 * 1024 * 1024, cwd } = options;

  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer, cwd, encoding: "utf8" },
      (error, stdout, stderr) => {
        const killed = Boolean(error && (error as any).killed);
        resolve({
          code: error ? ((error as any).code ?? 1) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          timedOut: killed,
        });
      }
    );
  });
}
