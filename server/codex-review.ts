import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { WORKSPACE_ROOT } from "./paths.js";
import { appendMessage, readTranscript } from "./transcript.js";
import { probeCodex } from "./codex-status.js";
import { distillContext } from "./codex-context.js";
import { listTodos } from "./store.js";
import { sessionManager } from "./session-manager.js";
import type { ChatMessage } from "./types.js";

const execFileAsync = promisify(execFile);

interface CodexEmitters {
  emitMessage: (todoId: string, message: ChatMessage) => void;
}

async function findDirtySubrepos(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  // Any immediate child directory is a candidate. Non-git dirs and bare
  // directories will fail `git status --porcelain` below and get filtered out,
  // so no need for a name-prefix allowlist.
  const candidates = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => join(rootDir, e.name));

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

// Tools that mutate files. We use these to determine which subrepos the agent
// actually touched in this session, so we can scope the review to relevant
// repos and skip ones that just happen to be dirty from prior work.
const MUTATING_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

// Map an absolute file path back to a workspace subrepo, returning the repo
// name (the immediate child of rootDir) or null if the path doesn't live
// under the active session's root.
function repoForPath(filePath: string, rootDir: string): string | null {
  if (!filePath.startsWith(rootDir + "/")) return null;
  const rel = filePath.slice(rootDir.length + 1);
  const firstSeg = rel.split("/")[0];
  return firstSeg || null;
}

interface TouchedReposResult {
  repos: Set<string>;
  hadToolEvidence: boolean;
}

function extractTouchedRepos(messages: ChatMessage[], rootDir: string): TouchedReposResult {
  const repos = new Set<string>();
  let hadToolEvidence = false;
  for (const m of messages) {
    if (m.role !== "tool" || !m.tool_name) continue;
    hadToolEvidence = true;
    if (!MUTATING_TOOLS.has(m.tool_name)) continue;
    try {
      const input = JSON.parse(m.text) as { file_path?: unknown };
      if (typeof input.file_path === "string") {
        const repo = repoForPath(input.file_path, rootDir);
        if (repo) repos.add(repo);
      }
    } catch {
      // Tool input wasn't valid JSON — skip silently.
    }
  }
  return { repos, hadToolEvidence };
}

interface CodexRunResult {
  ok: boolean;
  exitCode: number | null;
  finalMessage: string | null;
  errorTail: string | null;
}

async function runCodexInRepo(
  repoPath: string,
  brief: string,
): Promise<CodexRunResult> {
  const repoName = repoPath.split("/").pop() ?? repoPath;
  // The codex CLI rejects `[PROMPT]` combined with any scope flag (--base /
  // --uncommitted / --commit), so when we want to pass a brief we have to
  // describe the scope inside the prompt and let the agent run `git` itself.
  const prompt = `Review the working-tree changes in this repository — staged, unstaged, and untracked files vs. HEAD. Run \`git status\` and \`git diff\` (and \`git diff --cached\`) to see what changed.

The following brief describes the developer's intent behind this change. Use it to judge whether the diff actually meets the goal — not just whether the code is locally correct. Flag deviations from the stated focus, and don't flag anything listed as out-of-scope.

${brief}`;

  // Capture the final review to a tmp file via --output-last-message instead
  // of streaming the entire agent transcript (tool calls, file reads, internal
  // reasoning) to chat. The user only wants the verdict, not the work log.
  const dir = await mkdtemp(join(tmpdir(), `codex-review-${repoName}-`));
  const outFile = join(dir, "final.md");
  let stderrBuf = "";

  try {
    const result = await new Promise<{ ok: boolean; exitCode: number | null }>(
      (resolve) => {
        const proc = spawn(
          "codex",
          ["exec", "review", "--output-last-message", outFile, prompt],
          { cwd: repoPath, env: process.env },
        );
        // Drain stdout — required so the pipe doesn't fill and block the child
        // — but discard the bytes; the final message is read from outFile.
        proc.stdout.on("data", () => {});
        proc.stderr.on("data", (chunk: Buffer) => {
          stderrBuf += chunk.toString("utf8");
        });
        proc.on("error", (err) => {
          stderrBuf += `\n[codex spawn error] ${err.message}\n`;
          resolve({ ok: false, exitCode: null });
        });
        proc.on("close", (code) => {
          resolve({ ok: code === 0, exitCode: code });
        });
      },
    );

    let finalMessage: string | null = null;
    try {
      const raw = (await readFile(outFile, "utf8")).trim();
      finalMessage = raw.length > 0 ? raw : null;
    } catch {
      // outFile may not exist if codex bailed before producing a final message.
      finalMessage = null;
    }

    return {
      ok: result.ok,
      exitCode: result.exitCode,
      finalMessage,
      errorTail: stderrBuf.trim().length > 0 ? tail(stderrBuf, 40) : null,
    };
  } finally {
    // Best-effort cleanup of the tmpdir.
    void rm(dir, { recursive: true, force: true });
  }
}

function tail(s: string, lines: number): string {
  const arr = s.split("\n");
  return arr.slice(Math.max(0, arr.length - lines)).join("\n");
}

export async function runCodexReview(
  todoId: string,
  emitters: CodexEmitters,
): Promise<void> {
  const startMsg: ChatMessage = {
    id: `cdx_${nanoid(8)}`,
    role: "system",
    text: "⚡ codex review — scanning workspace subrepos for changes…",
    ts: new Date().toISOString(),
  };
  await appendMessage(todoId, startMsg);
  emitters.emitMessage(todoId, startMsg);

  const status = await probeCodex();
  if (!status.installed) {
    const errMsg: ChatMessage = {
      id: `cdx_${nanoid(8)}`,
      role: "system",
      text: "codex CLI is not configured. Open the **codex: setup** chip next to this button for install + auth steps.",
      ts: new Date().toISOString(),
    };
    await appendMessage(todoId, errMsg);
    emitters.emitMessage(todoId, errMsg);
    return;
  }

  // From here on we're committed to running codex (or distilling/scoping).
  // Flip the session flag so the UI shows REVIEWING; finally{} below clears
  // it on every exit path, including thrown errors and early returns.
  sessionManager.setCodexReviewActive(todoId, true);
  try {
    // Scan the active session's cwd, not the global workspace root — the user
    // may have pointed this todo at a different directory.
    const rootDir = sessionManager.get(todoId)?.cwd ?? WORKSPACE_ROOT;
    return await runCodexReviewInner(todoId, emitters, rootDir);
  } finally {
    sessionManager.setCodexReviewActive(todoId, false);
  }
}

async function runCodexReviewInner(
  todoId: string,
  emitters: CodexEmitters,
  rootDir: string,
): Promise<void> {

  const dirty = await findDirtySubrepos(rootDir);
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

  // Scope the review to repos this task actually touched (via Edit/Write/etc.
  // tool calls). A repo that's dirty from prior unrelated work shouldn't be
  // reviewed under the brief for *this* task.
  const transcript = await readTranscript(todoId);
  const { repos: touched, hadToolEvidence } = extractTouchedRepos(transcript, rootDir);

  let scoped: string[];
  let scopeNote: string;
  if (!hadToolEvidence) {
    // Empty session, or no tool calls captured — fall back to all dirty repos
    // rather than skip everything. Better to over-review than silently drop.
    scoped = dirty;
    scopeNote = `reviewing ${dirty.length} dirty repo(s): ${dirty.map((d) => d.split("/").pop()).join(", ")} (no in-task tool evidence — reviewing all dirty repos)`;
  } else {
    scoped = dirty.filter((d) => touched.has(d.split("/").pop()!));
    if (scoped.length === 0) {
      const skipMsg: ChatMessage = {
        id: `cdx_${nanoid(8)}`,
        role: "system",
        text: `dirty repo(s) ${dirty.map((d) => d.split("/").pop()).join(", ")} were not touched in this task — nothing to review.`,
        ts: new Date().toISOString(),
      };
      await appendMessage(todoId, skipMsg);
      emitters.emitMessage(todoId, skipMsg);
      return;
    }
    const skipped = dirty
      .map((d) => d.split("/").pop()!)
      .filter((n) => !touched.has(n));
    const skippedNote =
      skipped.length > 0 ? ` (skipped ${skipped.join(", ")} — dirty but unrelated to this task)` : "";
    scopeNote = `reviewing ${scoped.length} repo(s) touched in this task: ${scoped.map((d) => d.split("/").pop()).join(", ")}${skippedNote}`;
  }

  const summaryStart: ChatMessage = {
    id: `cdx_${nanoid(8)}`,
    role: "system",
    text: scopeNote,
    ts: new Date().toISOString(),
  };
  await appendMessage(todoId, summaryStart);
  emitters.emitMessage(todoId, summaryStart);

  // Distill a context brief from the chat transcript so codex reviews the diff
  // against the user's stated intent, not just the diff in isolation.
  const todos = await listTodos();
  const todoTitle = todos.find((t) => t.id === todoId)?.title ?? "(unknown task)";
  const distillStart = Date.now();
  const { brief, distilled, error: distillError } = await distillContext(
    todoTitle,
    transcript,
  );
  const distillMs = Date.now() - distillStart;

  const briefHeader = distilled
    ? `📋 review brief (distilled in ${distillMs}ms):`
    : `📋 review brief (fallback — distillation skipped${distillError ? `: ${distillError}` : ""}):`;
  const briefMsg: ChatMessage = {
    id: `cdx_${nanoid(8)}`,
    role: "system",
    text: `${briefHeader}\n\n${brief}`,
    ts: new Date().toISOString(),
  };
  await appendMessage(todoId, briefMsg);
  emitters.emitMessage(todoId, briefMsg);

  const results: Array<{ repo: string; ok: boolean; exitCode: number | null }> = [];
  for (const repoPath of scoped) {
    const repoName = repoPath.split("/").pop()!;
    // "Now reviewing X" indicator. Codex review takes a while; without this
    // the chat would freeze for ~60s per repo with no signal.
    const headerMsg: ChatMessage = {
      id: `cdx_${nanoid(8)}`,
      role: "system",
      text: `⏳ reviewing ${repoName}…`,
      ts: new Date().toISOString(),
    };
    await appendMessage(todoId, headerMsg);
    emitters.emitMessage(todoId, headerMsg);

    const result = await runCodexInRepo(repoPath, brief);
    results.push({ repo: repoName, ok: result.ok, exitCode: result.exitCode });

    if (result.finalMessage) {
      const reviewMsg: ChatMessage = {
        id: `cdx_${nanoid(8)}`,
        role: "codex",
        repo: repoName,
        text: result.finalMessage,
        ts: new Date().toISOString(),
      };
      await appendMessage(todoId, reviewMsg);
      emitters.emitMessage(todoId, reviewMsg);
    } else if (!result.ok) {
      const errMsg: ChatMessage = {
        id: `cdx_${nanoid(8)}`,
        role: "system",
        text: `codex review failed for ${repoName} (exit ${result.exitCode ?? "?"})${result.errorTail ? `:\n\n\`\`\`\n${result.errorTail}\n\`\`\`` : ""}`,
        ts: new Date().toISOString(),
      };
      await appendMessage(todoId, errMsg);
      emitters.emitMessage(todoId, errMsg);
    } else {
      // Exit 0 but no final-message file — shouldn't normally happen.
      const noopMsg: ChatMessage = {
        id: `cdx_${nanoid(8)}`,
        role: "system",
        text: `codex review for ${repoName} produced no final message.`,
        ts: new Date().toISOString(),
      };
      await appendMessage(todoId, noopMsg);
      emitters.emitMessage(todoId, noopMsg);
    }
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
