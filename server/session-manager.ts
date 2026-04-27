import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { nanoid } from "nanoid";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { JINNI_ROOT } from "./paths.js";
import { InputQueue } from "./input-queue.js";
import { appendMessage, readTranscript } from "./transcript.js";
import { archiveSession, listAllMetas, readMeta, writeMeta } from "./session-meta.js";
import { readPreferences } from "./preferences.js";
import { listTodos, setTodoSessionId } from "./store.js";
import type {
  ChatMessage,
  PendingPermission,
  PermissionMode,
  SessionMeta,
  SessionStatus,
} from "./types.js";

const ALLOWED_READ_TOOLS = ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "TodoWrite"];

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
      };
      console.log(`[session ${this.todoId}] sdk msg:`, anyMsg.type, anyMsg.subtype ?? "");

      if (anyMsg.type === "system" && anyMsg.subtype === "init" && anyMsg.session_id) {
        this.sessionId = anyMsg.session_id;
        await setTodoSessionId(this.todoId, this.sessionId);
        await this.persistMeta();
        continue;
      }

      if (anyMsg.type === "assistant") {
        this.setStatus("working", listener);
        const content = (anyMsg.message as { content?: unknown[] })?.content ?? [];
        for (const block of content) {
          const b = block as { type: string; text?: string; name?: string; input?: unknown };
          if (b.type === "text" && b.text) {
            const cm = this.makeMessage("assistant", b.text);
            await appendMessage(this.todoId, cm);
            listener.onMessage(this.todoId, cm);
          } else if (b.type === "tool_use") {
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
    };
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
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId || "",
    } as SDKUserMessage);
    this.setStatus("working", listener);
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

  async start(todoId: string, taskTitle: string, resumeSessionId?: string): Promise<ActiveSession> {
    if (this.sessions.has(todoId)) {
      return this.sessions.get(todoId)!;
    }
    if (!this.listener) throw new Error("listener not configured");
    const existingMeta = await readMeta(todoId);
    const prefs = await readPreferences().catch(() => null);
    const mode: PermissionMode =
      existingMeta?.permission_mode ?? prefs?.default_permission_mode ?? "default";
    const session = new ActiveSession(todoId, JINNI_ROOT, taskTitle, mode);
    if (resumeSessionId) session.sessionId = resumeSessionId;
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
    const titleById = new Map(todos.map((t) => [t.id, t.title] as const));
    for (const meta of metas) {
      if (meta.status === "done" || meta.status === "error") continue;
      if (this.sessions.has(meta.todo_id)) continue;
      try {
        await this.start(meta.todo_id, titleById.get(meta.todo_id) ?? "", meta.session_id);
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
