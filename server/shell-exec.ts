import { spawn } from "node:child_process";

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface ShellResult {
  output: string;
  exit_code: number | null;
  signal: string | null;
  truncated: boolean;
  timed_out: boolean;
  duration_ms: number;
}

// Strip ANSI escape sequences so colored CLI output renders cleanly in the
// chat <pre>. Covers CSI (colors, cursor moves) and OSC (titles) — anything
// fancier is rare enough to leave as visible bytes.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function runShell(command: string, cwd: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("sh", ["-c", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let bytes = 0;
    let truncated = false;
    const chunks: Buffer[] = [];
    const onData = (buf: Buffer) => {
      if (truncated) return;
      const remaining = MAX_OUTPUT_BYTES - bytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (buf.length > remaining) {
        chunks.push(buf.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        try {
          child.kill("SIGTERM");
        } catch {}
        return;
      }
      chunks.push(buf);
      bytes += buf.length;
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 2000);
    }, TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        output: `failed to spawn shell: ${err.message}`,
        exit_code: null,
        signal: null,
        truncated: false,
        timed_out: false,
        duration_ms: Date.now() - startedAt,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const output = stripAnsi(raw);
      resolve({
        output,
        exit_code: code,
        signal: signal,
        truncated,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
      });
    });
  });
}
