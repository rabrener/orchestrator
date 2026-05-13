import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { nanoid } from "nanoid";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "./paths.js";
import { InputQueue } from "./input-queue.js";
import { appendMessage, readTranscript } from "./transcript.js";
import { archiveSession, listAllMetas, readMeta, writeMeta } from "./session-meta.js";
import { readPreferences, resolvePreferredCwd } from "./preferences.js";
import { listTodos, setTodoSessionId } from "./store.js";
import { stat } from "node:fs/promises";
import type {
  ChatMessage,
  ClaudeTodo,
  PendingPermission,
  PermissionMode,
  SessionMeta,
  SessionStatus,
} from "./types.js";

const ALLOWED_READ_TOOLS = ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "TodoWrite"];

// Pick the right context-window ceiling for a given model id. The SDK doesn't
// expose this directly, so we infer from the model string:
// - explicit `[1m]` tag (e.g. `claude-opus-4-7[1m]`) → 1M-token variant
// - everything else falls back to the standard 200K window
// New model families should be added here as they ship.
function contextWindowForModel(model: string): number {
  if (!model) return 200_000;
  if (/\[1m\]/i.test(model) || /-1m\b/i.test(model)) return 1_000_000;
  return 200_000;
}

function parseClaudeTodos(input: unknown): ClaudeTodo[] | null {
  if (!input || typeof input !== "object") return null;
  const arr = (input as { todos?: unknown }).todos;
  if (!Array.isArray(arr)) return null;
  const out: ClaudeTodo[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { content?: unknown; status?: unknown; activeForm?: unknown };
    if (typeof r.content !== "string") continue;
    if (
      r.status !== "pending" &&
      r.status !== "in_progress" &&
      r.status !== "completed"
    ) {
      continue;
    }
    out.push({
      content: r.content,
      status: r.status,
      activeForm: typeof r.activeForm === "string" ? r.activeForm : undefined,
    });
  }
  return out;
}

// The SDK's bundled native-binary resolution mis-detects glibc as musl on some
// distros, so point it at the system `claude` CLI (the one `claude login`
// configured). Override with CLAUDE_CODE_EXECUTABLE if needed.
function resolveClaudeExecutable(): string | undefined {
  const explicit = process.env.CLAUDE_CODE_EXECUTABLE;
  if (explicit && existsSync(explicit)) return explicit;
  const localBin = join(homedir(), ".local", "bin", "claude");
  if (existsSync(localBin)) return localBin;
  return undefined;
}
const CLAUDE_EXECUTABLE = resolveClaudeExecutable();
if (CLAUDE_EXECUTABLE) {
  console.log(`[orchestrator-ui] using claude executable: ${CLAUDE_EXECUTABLE}`);
} else {
  console.warn(
    "[orchestrator-ui] no claude executable found on PATH or in ~/.local/bin; falling back to SDK bundled binary",
  );
}

async function isUsableDir(p: string | null | undefined): Promise<boolean> {
  if (!p) return false;
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

// Per-todo override beats the prefs default beats the cwd remembered from the
// last session (resume) beats WORKSPACE_ROOT. Each candidate is stat()'d so a
// stale path falls through cleanly instead of crashing the SDK at spawn time.
async function resolveSessionCwd(
  todoCwd: string | null,
  prefs: { default_cwd: string | null } | null,
  metaCwd: string | null,
): Promise<string> {
  if (await isUsableDir(todoCwd)) return todoCwd as string;
  if (prefs && (await isUsableDir(prefs.default_cwd))) return prefs.default_cwd as string;
  if (await isUsableDir(metaCwd)) return metaCwd as string;
  if (prefs) return resolvePreferredCwd(prefs as Parameters<typeof resolvePreferredCwd>[0]);
  return WORKSPACE_ROOT;
}

type Listener = {
  onStatus: (todoId: string, status: SessionStatus, meta: SessionMeta) => void;
  onMessage: (todoId: string, message: ChatMessage) => void;
  onPermissionRequest: (todoId: string, permission: PendingPermission) => void;
  onComposerRestore: (todoId: string, text: string) => void;
};

class ActiveSession {
  todoId: string;
  taskTitle: string;
  sessionId = "";
  status: SessionStatus = "idle";
  permissionMode: PermissionMode = "default";
  cwd: string;
  pendingPermission: PendingPermission | null = null;
  startedAt = new Date().toISOString();
  lastActivityAt = this.startedAt;

  // Set true the moment a user-initiated stop begins, so the consume loop can
  // distinguish an SDK abort error from a genuine failure.
  stopping = false;
  // Captures the most recent user message so the UI can repaste it into the
  // composer if that turn is interrupted.
  lastUserText = "";
  // Mirror of the agent's internal TodoWrite list (Claude Code's own task
  // tracker). Updated whenever the agent calls TodoWrite. Surfaced to the UI
  // via SessionMeta.claude_todos.
  claudeTodos: ClaudeTodo[] = [];
  // Slash commands the SDK reports as runnable for this session, captured from
  // the `system/init` message. Names only — the UI joins these with filesystem
  // metadata (description / argument-hint) for autocomplete.
  slashCommands: string[] = [];
  // Model id reported by `system/init`, plus the effective context size of the
  // most recent turn. The SDK doesn't auto-compact — when contextTokens nears
  // contextWindow the next turn will fail with a context-length error, so the
  // UI exposes both as a meter that prompts the user to start a fresh session.
  model = "";
  contextTokens = 0;
  contextWindow = 0;
  // True while a codex review is in flight for this todo. Independent of the
  // SDK status — the agent can be idle while codex is mid-review. The UI
  // surfaces this as a "REVIEWING" pill that overrides the regular status.
  codexReviewActive = false;
  // Per-repo codex review outputs captured during the most recent review run.
  // Drained into the next user message sent to the agent so the SDK has the
  // analysis as context (codex runs out-of-band — the agent doesn't see those
  // messages on its own). Cleared after consumption; ephemeral by design.
  pendingCodexReviews: Array<{ repo: string; text: string }> = [];
  // True while the SDK iterator is being consumed. After a stop, the SDK
  // iterator throws and this flips false — the next sendUserMessage respawns
  // the query on the same conversation thread.
  private isLoopActive = false;

  private inputQueue: InputQueue<SDKUserMessage>;
  private q: Query | null = null;
  private permissionResolvers = new Map<string, (allow: boolean) => void>();
  private loopPromise: Promise<void> | null = null;

  constructor(todoId: string, cwd: string, taskTitle: string, mode: PermissionMode = "default") {
    this.todoId = todoId;
    this.taskTitle = taskTitle;
    this.cwd = cwd;
    this.permissionMode = mode;
    this.inputQueue = new InputQueue<SDKUserMessage>();
  }

  start(listener: Listener, resumeSessionId?: string): void {
    const systemPrompt: { type: "preset"; preset: "claude_code"; append?: string } = {
      type: "preset",
      preset: "claude_code",
    };
    if (this.taskTitle) {
      systemPrompt.append = `This session is dedicated to the following task from the orchestrator todo list: "${this.taskTitle}"`;
    }
    this.q = query({
      prompt: this.inputQueue,
      options: {
        cwd: this.cwd,
        resume: resumeSessionId,
        permissionMode: this.permissionMode,
        allowedTools: ALLOWED_READ_TOOLS,
        systemPrompt,
        // Required gate so users can opt into 'bypassPermissions' via the dropdown.
        // Does not auto-enable bypass — only permits the mode switch.
        allowDangerouslySkipPermissions: true,
        ...(CLAUDE_EXECUTABLE ? { pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE } : {}),
        canUseTool: async (toolName, input) => {
          const requestId = `perm_${nanoid(8)}`;
          const perm: PendingPermission = { request_id: requestId, tool: toolName, input };
          this.pendingPermission = perm;
          this.setStatus("asking", listener);
          listener.onPermissionRequest(this.todoId, perm);
          const allow = await new Promise<boolean>((resolve) => {
            this.permissionResolvers.set(requestId, resolve);
          });
          this.pendingPermission = null;
          if (allow) {
            return { behavior: "allow", updatedInput: input };
          }
          return { behavior: "deny", message: "denied by user" };
        },
      },
    });
    this.isLoopActive = true;
    this.loopPromise = this.consume(listener)
      .catch((err) => {
        // close() shuts the input queue which terminates the SDK iterator —
        // a soft stop via q.interrupt() alone does NOT throw here.
        if (this.stopping) return;
        console.error(`session ${this.todoId} loop error`, err);
        this.setStatus("error", listener);
        listener.onMessage(this.todoId, this.makeMessage("system", `[error] ${String(err)}`));
      })
      .finally(() => {
        this.isLoopActive = false;
      });
  }

  private async consume(listener: Listener): Promise<void> {
    if (!this.q) return;
    for await (const msg of this.q) {
      this.lastActivityAt = new Date().toISOString();
      const anyMsg = msg as {
        type: string;
        subtype?: string;
        session_id?: string;
        message?: unknown;
        result?: unknown;
        is_error?: boolean;
        slash_commands?: unknown;
        model?: unknown;
      };
      console.log(`[session ${this.todoId}] sdk msg:`, anyMsg.type, anyMsg.subtype ?? "");

      if (anyMsg.type === "system" && anyMsg.subtype === "init" && anyMsg.session_id) {
        this.sessionId = anyMsg.session_id;
        if (Array.isArray(anyMsg.slash_commands)) {
          this.slashCommands = anyMsg.slash_commands.filter(
            (x): x is string => typeof x === "string",
          );
        }
        if (typeof anyMsg.model === "string") {
          this.model = anyMsg.model;
          this.contextWindow = contextWindowForModel(anyMsg.model);
        }
        this.setStatus(this.status, listener);
        await setTodoSessionId(this.todoId, this.sessionId);
        await this.persistMeta();
        continue;
      }

      if (anyMsg.type === "assistant") {
        this.setStatus("working", listener);
        const message = anyMsg.message as {
          content?: unknown[];
          usage?: {
            input_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
        } | undefined;
        // Effective context = uncached input + cache-creation + cache-read.
        // All three count against the model's window for this turn; only the
        // mix of cached vs. uncached affects cost.
        const usage = message?.usage;
        if (usage) {
          const tokens =
            (usage.input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0);
          if (tokens > 0) this.contextTokens = tokens;
        }
        const content = message?.content ?? [];
        for (const block of content) {
          const b = block as { type: string; text?: string; name?: string; input?: unknown };
          if (b.type === "text" && b.text) {
            const cm = this.makeMessage("assistant", b.text);
            await appendMessage(this.todoId, cm);
            listener.onMessage(this.todoId, cm);
          } else if (b.type === "tool_use") {
            if (b.name === "TodoWrite") {
              const next = parseClaudeTodos(b.input);
              if (next) {
                this.claudeTodos = next;
                this.setStatus(this.status, listener);
              }
            }
            const cm = this.makeMessage(
              "tool",
              typeof b.input === "string" ? b.input : JSON.stringify(b.input, null, 2),
              b.name,
            );
            await appendMessage(this.todoId, cm);
            listener.onMessage(this.todoId, cm);
          } else if (b.type === "thinking") {
            // Skip thinking blocks for now to avoid noise
          }
        }
        continue;
      }

      if (anyMsg.type === "result") {
        if (anyMsg.session_id && !this.sessionId) {
          this.sessionId = anyMsg.session_id;
          await setTodoSessionId(this.todoId, this.sessionId);
        }
        const isError = anyMsg.is_error === true || (anyMsg.subtype && anyMsg.subtype !== "success");
        if (isError) {
          if (this.stopping) {
            // User clicked Stop. The SDK aborts its in-flight request and
            // surfaces it as `error_during_execution`; that's expected, not
            // an error to surface.
            const cm = this.makeMessage("system", "⏹ stopped — agent was interrupted");
            await appendMessage(this.todoId, cm);
            listener.onMessage(this.todoId, cm);
            this.setStatus("idle", listener);
          } else {
            const detail = typeof anyMsg.result === "string" ? anyMsg.result : JSON.stringify(anyMsg.result);
            console.error(`[session ${this.todoId}] sdk result error:`, anyMsg.subtype, detail);
            const cm = this.makeMessage(
              "system",
              `[sdk error: ${anyMsg.subtype ?? "unknown"}] ${detail ?? ""}`,
            );
            await appendMessage(this.todoId, cm);
            listener.onMessage(this.todoId, cm);
            this.setStatus("error", listener);
          }
        } else {
          // Clean turn finish — that user input was fully processed, so don't
          // offer to repaste it on a future stop.
          this.lastUserText = "";
          this.setStatus("idle", listener);
        }
        await this.persistMeta();
        continue;
      }
    }
    this.setStatus("idle", listener);
  }

  private makeMessage(
    role: ChatMessage["role"],
    text: string,
    toolName?: string,
  ): ChatMessage {
    return {
      id: `m_${nanoid(10)}`,
      role,
      text,
      ts: new Date().toISOString(),
      tool_name: toolName,
    };
  }

  private setStatus(status: SessionStatus, listener: Listener): void {
    this.status = status;
    void this.persistMeta();
    listener.onStatus(this.todoId, status, this.snapshot());
  }

  snapshot(): SessionMeta {
    return {
      todo_id: this.todoId,
      session_id: this.sessionId,
      status: this.status,
      permission_mode: this.permissionMode,
      cwd: this.cwd,
      pending_permission: this.pendingPermission,
      started_at: this.startedAt,
      last_activity_at: this.lastActivityAt,
      claude_todos: this.claudeTodos.length ? this.claudeTodos : undefined,
      slash_commands: this.slashCommands.length ? this.slashCommands : undefined,
      context_tokens: this.contextTokens || undefined,
      context_window: this.contextWindow || undefined,
      model: this.model || undefined,
      codex_review_active: this.codexReviewActive || undefined,
    };
  }

  setCodexReviewActive(active: boolean, listener: Listener): void {
    if (this.codexReviewActive === active) return;
    this.codexReviewActive = active;
    // Reuse the regular status broadcast — it carries the full snapshot, so
    // the new flag rides along without a new event type.
    listener.onStatus(this.todoId, this.status, this.snapshot());
  }

  private async persistMeta(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await writeMeta(this.snapshot());
    } catch (err) {
      console.error("persistMeta failed", err);
    }
  }

  async sendUserMessage(text: string, listener: Listener): Promise<void> {
    // After q.interrupt(), the SDK yields the abort result and then keeps
    // awaiting the next user message on the same query — the iterator does
    // NOT throw. So if the loop is still alive we just clear the stopping
    // flag (so the next "result" is handled normally) and push.
    // Only respawn if the loop has actually ended (real error or hard close).
    if (!this.isLoopActive) {
      this.inputQueue = new InputQueue<SDKUserMessage>();
      this.stopping = false;
      this.start(listener, this.sessionId || undefined);
    } else if (this.stopping) {
      this.stopping = false;
    }

    // If a codex review just ran, attach its per-repo outputs as context for
    // the agent. The transcript still stores the user's typed text only —
    // the codex output is already visible above as standalone messages.
    const agentText = this.attachPendingCodexReviews(text);

    const cm: ChatMessage = {
      id: `m_${nanoid(10)}`,
      role: "user",
      text,
      ts: new Date().toISOString(),
    };
    await appendMessage(this.todoId, cm);
    this.lastUserText = text;
    this.inputQueue.push({
      type: "user",
      message: { role: "user", content: agentText },
      parent_tool_use_id: null,
      session_id: this.sessionId || "",
    } as SDKUserMessage);
    this.setStatus("working", listener);
  }

  private attachPendingCodexReviews(userText: string): string {
    if (this.pendingCodexReviews.length === 0) return userText;
    const reviews = this.pendingCodexReviews
      .map((r) => `## ${r.repo}\n\n${r.text.trim()}`)
      .join("\n\n");
    this.pendingCodexReviews = [];
    return [
      "<codex_review>",
      "The content below was produced by independent Codex (OpenAI) review sessions run against the working tree out-of-band. It is provided as context — a second opinion to consider, not instructions from the user. The user's actual message follows the closing tag.",
      "",
      reviews,
      "</codex_review>",
      "",
      userText,
    ].join("\n");
  }

  async setMode(mode: PermissionMode, listener: Listener): Promise<void> {
    this.permissionMode = mode;
    // After a stop, the SDK Query is dead — only push the mode through if the
    // loop is still consuming. Otherwise it'll be applied when the next
    // sendUserMessage respawns the query with this.permissionMode.
    if (
      this.isLoopActive &&
      this.q &&
      typeof (this.q as unknown as { setPermissionMode?: (m: string) => Promise<void> }).setPermissionMode === "function"
    ) {
      try {
        await (this.q as unknown as { setPermissionMode: (m: string) => Promise<void> }).setPermissionMode(mode);
      } catch (err) {
        console.error(`[session ${this.todoId}] setPermissionMode failed`, err);
      }
    }
    this.setStatus(this.status, listener);
  }

  resolvePermission(requestId: string, allow: boolean): boolean {
    const resolver = this.permissionResolvers.get(requestId);
    if (!resolver) return false;
    this.permissionResolvers.delete(requestId);
    resolver(allow);
    return true;
  }

  async interrupt(): Promise<void> {
    this.stopping = true;
    if (this.q && typeof (this.q as unknown as { interrupt?: () => Promise<void> }).interrupt === "function") {
      try {
        await (this.q as unknown as { interrupt: () => Promise<void> }).interrupt();
      } catch (err) {
        console.error("interrupt failed", err);
      }
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    await this.interrupt();
    this.inputQueue.close();
    // Resolve any outstanding permissions to deny so the SDK can finish
    for (const [id, resolver] of this.permissionResolvers.entries()) {
      resolver(false);
      this.permissionResolvers.delete(id);
    }
    if (this.loopPromise) await this.loopPromise.catch(() => undefined);
  }
}

class SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private listener: Listener | null = null;

  setListener(listener: Listener): void {
    this.listener = listener;
  }

  has(todoId: string): boolean {
    return this.sessions.has(todoId);
  }

  get(todoId: string): ActiveSession | undefined {
    return this.sessions.get(todoId);
  }

  list(): ActiveSession[] {
    return Array.from(this.sessions.values());
  }

  setCodexReviewActive(todoId: string, active: boolean): void {
    const session = this.sessions.get(todoId);
    if (!session || !this.listener) return;
    session.setCodexReviewActive(active, this.listener);
  }

  queueCodexReview(todoId: string, repo: string, text: string): void {
    const session = this.sessions.get(todoId);
    if (!session) return;
    session.pendingCodexReviews.push({ repo, text });
  }

  async start(
    todoId: string,
    taskTitle: string,
    resumeSessionId?: string,
    todoCwd?: string | null,
  ): Promise<ActiveSession> {
    if (this.sessions.has(todoId)) {
      return this.sessions.get(todoId)!;
    }
    if (!this.listener) throw new Error("listener not configured");
    const existingMeta = await readMeta(todoId);
    const prefs = await readPreferences().catch(() => null);
    const mode: PermissionMode =
      existingMeta?.permission_mode ?? prefs?.default_permission_mode ?? "default";

    // Resolve cwd: per-todo override → preferred default → meta (resume) →
    // workspace root. The meta cwd is only used as a fallback for resume so a
    // user-set per-todo cwd can override it on the next start.
    const cwd = await resolveSessionCwd(todoCwd ?? null, prefs, existingMeta?.cwd ?? null);

    const session = new ActiveSession(todoId, cwd, taskTitle, mode);
    if (resumeSessionId) session.sessionId = resumeSessionId;
    if (existingMeta?.claude_todos) session.claudeTodos = existingMeta.claude_todos;
    if (existingMeta?.context_tokens) session.contextTokens = existingMeta.context_tokens;
    if (existingMeta?.context_window) session.contextWindow = existingMeta.context_window;
    if (existingMeta?.model) session.model = existingMeta.model;
    this.sessions.set(todoId, session);
    session.start(this.listener, resumeSessionId);
    return session;
  }

  async stop(
    todoId: string,
    opts: { archive?: boolean; keepAlive?: boolean } = {},
  ): Promise<void> {
    const session = this.sessions.get(todoId);
    let restoreText = "";
    if (session) {
      restoreText = session.lastUserText;
      // The text has been "consumed" — don't re-restore on a subsequent stop.
      session.lastUserText = "";
      if (opts.keepAlive && !opts.archive) {
        // Soft stop — interrupt the in-flight turn but keep the session in
        // the manager map so further /message calls can queue a new turn on
        // the same SDK query.
        await session.interrupt();
      } else {
        await session.close();
        this.sessions.delete(todoId);
      }
    }
    if (opts.archive) {
      await archiveSession(todoId);
    }
    // Only repaste for a soft stop — destroy/archive shouldn't repopulate
    // a composer the user no longer has access to.
    if (restoreText && opts.keepAlive && !opts.archive && this.listener) {
      this.listener.onComposerRestore(todoId, restoreText);
    }
  }

  async resumeAll(): Promise<void> {
    const [metas, todos] = await Promise.all([listAllMetas(), listTodos()]);
    const todoById = new Map(todos.map((t) => [t.id, t] as const));
    for (const meta of metas) {
      if (meta.status === "done" || meta.status === "error") continue;
      if (this.sessions.has(meta.todo_id)) continue;
      const todo = todoById.get(meta.todo_id);
      // A completed todo keeps its sessions/<id>/ dir so its transcript can be
      // retrieved after un-completing — but the session itself should stay
      // closed until the user explicitly hits "▶ start" again.
      if (todo?.completed_at) continue;
      try {
        await this.start(
          meta.todo_id,
          todo?.title ?? "",
          meta.session_id,
          todo?.cwd ?? null,
        );
      } catch (err) {
        console.error(`resume failed for ${meta.todo_id}`, err);
      }
    }
  }

  async getTranscript(todoId: string): Promise<ChatMessage[]> {
    return readTranscript(todoId);
  }
}

export const sessionManager = new SessionManager();
