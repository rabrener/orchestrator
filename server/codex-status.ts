import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CodexStatus {
  installed: boolean;
  version: string | null;
  error: string | null;
  checked_at: string;
}

const CACHE_MS = 5_000;
let cached: { status: CodexStatus; expiresAt: number } | null = null;

export function invalidateCodexStatus(): void {
  cached = null;
}

export async function probeCodex(force = false): Promise<CodexStatus> {
  if (!force && cached && Date.now() < cached.expiresAt) {
    return cached.status;
  }

  let status: CodexStatus;
  try {
    const { stdout } = await execFileAsync("codex", ["--version"], {
      timeout: 3_000,
    });
    // `codex --version` typically prints something like `codex 0.12.3` or just
    // a version. Take the last whitespace-separated token, which works for
    // either shape and avoids regex coupling to a specific output format.
    const trimmed = stdout.trim();
    const version = trimmed.length > 0 ? trimmed.split(/\s+/).pop() ?? null : null;
    status = {
      installed: true,
      version,
      error: null,
      checked_at: new Date().toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const notFound = msg.includes("ENOENT") || /not found/i.test(msg);
    status = {
      installed: false,
      version: null,
      error: notFound ? null : msg,
      checked_at: new Date().toISOString(),
    };
  }

  cached = { status, expiresAt: Date.now() + CACHE_MS };
  return status;
}
