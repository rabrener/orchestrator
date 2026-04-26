import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { JINNI_ROOT } from "./paths.js";
import { appendMessage } from "./transcript.js";
import type { ChatMessage } from "./types.js";

const execFileAsync = promisify(execFile);

interface CodexEmitters {
  emitChunk: (todoId: string, repo: string, chunk: string) => void;
  emitMessage: (todoId: string, message: ChatMessage) => void;
}

async function findDirtySubrepos(): Promise<string[]> {
  const entries = await readdir(JINNI_ROOT, { withFileTypes: true });
  const candidates = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("jinni_"))
    .map((e) => join(JINNI_ROOT, e.name));

  const dirty: string[] = [];
  for (const dir of candidates) {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
        cwd: dir,
      });
      if (stdout.trim().length > 0) dirty.push(dir);
    } catch {
      // not a git repo or git failed — skip
    }
  }
  return dirty;
}

async function codexAvailable(): Promise<boolean> {
  try {
    await execFileAsync("which", ["codex"]);
    return true;
  } catch {
    return false;
  }
}

async function runCodexInRepo(
  todoId: string,
  repoPath: string,
  emitters: CodexEmitters,
): Promise<{ ok: boolean; exitCode: number | null }> {
  const repoName = repoPath.split("/").pop() ?? repoPath;
  return new Promise((resolve) => {
    const proc = spawn("codex", ["review", "--base", "HEAD"], {
      cwd: repoPath,
      env: process.env,
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      emitters.emitChunk(todoId, repoName, chunk.toString("utf8"));
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      emitters.emitChunk(todoId, repoName, chunk.toString("utf8"));
    });
    proc.on("error", (err) => {
      emitters.emitChunk(todoId, repoName, `\n[codex spawn error] ${err.message}\n`);
      resolve({ ok: false, exitCode: null });
    });
    proc.on("close", (code) => {
      resolve({ ok: code === 0, exitCode: code });
    });
  });
}

export async function runCodexReview(
  todoId: string,
  emitters: CodexEmitters,
): Promise<void> {
  const startMsg: ChatMessage = {
    id: `cdx_${nanoid(8)}`,
    role: "system",
    text: "⚡ codex review — scanning jinni_* subrepos for changes…",
    ts: new Date().toISOString(),
  };
  await appendMessage(todoId, startMsg);
  emitters.emitMessage(todoId, startMsg);

  const available = await codexAvailable();
  if (!available) {
    const errMsg: ChatMessage = {
      id: `cdx_${nanoid(8)}`,
      role: "system",
      text: "codex CLI not found on PATH. Install it (e.g. `npm install -g @openai/codex`) and retry.",
      ts: new Date().toISOString(),
    };
    await appendMessage(todoId, errMsg);
    emitters.emitMessage(todoId, errMsg);
    return;
  }

  const dirty = await findDirtySubrepos();
  if (dirty.length === 0) {
    const noneMsg: ChatMessage = {
      id: `cdx_${nanoid(8)}`,
      role: "system",
      text: "no dirty subrepos found — nothing to review.",
      ts: new Date().toISOString(),
    };
    await appendMessage(todoId, noneMsg);
    emitters.emitMessage(todoId, noneMsg);
    return;
  }

  const summaryStart: ChatMessage = {
    id: `cdx_${nanoid(8)}`,
    role: "system",
    text: `reviewing ${dirty.length} dirty repo(s): ${dirty.map((d) => d.split("/").pop()).join(", ")}`,
    ts: new Date().toISOString(),
  };
  await appendMessage(todoId, summaryStart);
  emitters.emitMessage(todoId, summaryStart);

  const results: Array<{ repo: string; ok: boolean; exitCode: number | null }> = [];
  for (const repoPath of dirty) {
    const repoName = repoPath.split("/").pop()!;
    const headerMsg: ChatMessage = {
      id: `cdx_${nanoid(8)}`,
      role: "codex",
      repo: repoName,
      text: `── ${repoName} ──\n`,
      ts: new Date().toISOString(),
    };
    await appendMessage(todoId, headerMsg);
    emitters.emitMessage(todoId, headerMsg);

    const result = await runCodexInRepo(todoId, repoPath, emitters);
    results.push({ repo: repoName, ...result });
  }

  const summary = results
    .map((r) => `  ${r.repo}: ${r.ok ? "✓" : `✗ (exit ${r.exitCode})`}`)
    .join("\n");
  const doneMsg: ChatMessage = {
    id: `cdx_${nanoid(8)}`,
    role: "system",
    text: `codex review complete:\n${summary}`,
    ts: new Date().toISOString(),
  };
  await appendMessage(todoId, doneMsg);
  emitters.emitMessage(todoId, doneMsg);
}
