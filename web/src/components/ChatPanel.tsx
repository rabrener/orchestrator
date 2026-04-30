import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Send, Square } from "lucide-react";
import { ModePicker } from "./ModePicker.js";
import type {
  ChatMessage,
  ClaudeTodo,
  PendingPermission,
  PermissionMode,
  SessionMeta,
  Todo,
} from "../types.js";

const VimComposer = lazy(() =>
  import("./VimComposer.js").then((m) => ({ default: m.VimComposer })),
);

type RenderItem =
  | { kind: "message"; message: ChatMessage }
  | { kind: "tool-run"; id: string; tools: ChatMessage[] };

function groupMessages(messages: ChatMessage[]): RenderItem[] {
  const items: RenderItem[] = [];
  let run: ChatMessage[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    items.push({ kind: "tool-run", id: `run_${run[0].id}`, tools: run });
    run = [];
  };
  for (const m of messages) {
    // TodoWrite is rendered in its own dedicated panel above the chat log; skip
    // it here to avoid duplicating the same data as a noisy JSON tool card.
    if (m.role === "tool" && m.tool_name === "TodoWrite") continue;
    if (m.role === "tool") {
      run.push(m);
      continue;
    }
    flushRun();
    items.push({ kind: "message", message: m });
  }
  flushRun();
  return items;
}

interface Props {
  todo: Todo | null;
  session: SessionMeta | null;
  messages: ChatMessage[];
  composerRestore: { text: string; nonce: number } | null;
  onSendMessage: (text: string) => void;
  onSetMode: (mode: PermissionMode) => void;
  onResolvePermission: (perm: PendingPermission, allow: boolean) => void;
  onCodexReview: () => void;
  onComplete: () => void;
  onStop: () => void;
  onStartSession: () => void;
  onRenameTodo: (id: string, title: string) => void;
}

export function ChatPanel({
  todo,
  session,
  messages,
  composerRestore,
  onSendMessage,
  onSetMode,
  onResolvePermission,
  onCodexReview,
  onComplete,
  onStop,
  onStartSession,
  onRenameTodo,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const renderItems = useMemo(() => groupMessages(messages), [messages]);

  // Auto-scroll only when the user is already pinned to the bottom. If they've
  // scrolled up to read older messages, leave their viewport alone and surface
  // a "↓ N new" pill they can click to jump back down.
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const pinnedRef = useRef(pinnedToBottom);
  pinnedRef.current = pinnedToBottom;
  const prevMessageCountRef = useRef(messages.length);
  const todoIdRef = useRef<string | null>(todo?.id ?? null);

  // Reset pin state when switching todos and snap to bottom on first paint.
  useEffect(() => {
    const nextId = todo?.id ?? null;
    if (todoIdRef.current === nextId) return;
    todoIdRef.current = nextId;
    setPinnedToBottom(true);
    setUnreadCount(0);
    prevMessageCountRef.current = messages.length;
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [todo?.id, messages.length]);

  useEffect(() => {
    const grew = messages.length > prevMessageCountRef.current;
    if (!grew) {
      prevMessageCountRef.current = messages.length;
      return;
    }
    const delta = messages.length - prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;
    const last = messages[messages.length - 1];
    const userJustSent = last?.role === "user";

    if (pinnedRef.current || userJustSent) {
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
      if (userJustSent && !pinnedRef.current) setPinnedToBottom(true);
      if (unreadCount !== 0) setUnreadCount(0);
    } else {
      setUnreadCount((c) => c + delta);
    }
    // unreadCount intentionally excluded — we read it via setter form when
    // appending and via direct check when resetting; including it would
    // re-fire this effect on its own state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  const onChatScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 40;
    if (atBottom) {
      if (!pinnedRef.current) setPinnedToBottom(true);
      if (unreadCount !== 0) setUnreadCount(0);
    } else if (pinnedRef.current) {
      setPinnedToBottom(false);
    }
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setPinnedToBottom(true);
    setUnreadCount(0);
  };

  if (!todo) {
    return (
      <section className="pane chat-pane">
        <div className="chat-empty">
          <p>select a to-do to view its agent</p>
        </div>
      </section>
    );
  }

  return (
    <section className="pane chat-pane">
      <header className="chat-header">
        <div>
          <EditableTitle
            value={todo.title}
            onCommit={(next) => onRenameTodo(todo.id, next)}
          />
          {session && (
            <div className="chat-subhead">
              <span className={`status-pill ${session.status}`}>{session.status}</span>
              <span className="cwd">cwd: ~/Documents/jinni</span>
            </div>
          )}
        </div>
      </header>

      {!session && (
        <div className="chat-empty">
          <p>no agent for this to-do yet</p>
          <button className="btn-primary" onClick={onStartSession}>
            start agent
          </button>
        </div>
      )}

      {session && (
        <>
          {session.claude_todos && session.claude_todos.length > 0 && (
            <ClaudeTodoPanel todos={session.claude_todos} />
          )}
          <div className="chat-log-wrap">
            <div ref={scrollRef} className="chat-log" onScroll={onChatScroll}>
              {messages.length === 0 && (
                <div className="chat-hint">type a message below to kick off the agent</div>
              )}
              {renderItems.map((item) =>
                item.kind === "message" ? (
                  <MessageRow key={item.message.id} message={item.message} />
                ) : (
                  <ToolRunCard key={item.id} tools={item.tools} />
                ),
              )}
              {session.pending_permission && (
                <PermissionPrompt
                  perm={session.pending_permission}
                  onResolve={onResolvePermission}
                />
              )}
            </div>
            {!pinnedToBottom && unreadCount > 0 && (
              <button
                type="button"
                className="chat-jump-bottom"
                onClick={jumpToBottom}
                aria-label={`Jump to ${unreadCount} new ${unreadCount === 1 ? "message" : "messages"}`}
              >
                ↓ {unreadCount} new {unreadCount === 1 ? "message" : "messages"}
              </button>
            )}
          </div>

          <Composer
            onSend={onSendMessage}
            restore={composerRestore}
            isInFlight={session.status === "working" || session.status === "asking"}
            onStop={onStop}
          />

          <footer className="chat-footer">
            <ModePicker
              label="mode"
              value={session.permission_mode}
              onChange={onSetMode}
            />
            <button className="btn-secondary" onClick={onCodexReview}>
              ⚡ codex review
            </button>
            <button className="btn-primary" onClick={onComplete}>
              ✓ mark done
            </button>
          </footer>
        </>
      )}
    </section>
  );
}

function EditableTitle({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else setDraft(value);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="chat-title-edit"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
      />
    );
  }

  return (
    <h2
      className="chat-title"
      title="Click to rename"
      onClick={() => setEditing(true)}
    >
      {value}
    </h2>
  );
}

const Composer = memo(function Composer({
  onSend,
  restore,
  isInFlight,
  onStop,
}: {
  onSend: (text: string) => void;
  restore: { text: string; nonce: number } | null;
  isInFlight: boolean;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [vimMode, setVimMode] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const vimModeRef = useRef(vimMode);
  vimModeRef.current = vimMode;
  const isInFlightRef = useRef(isInFlight);
  isInFlightRef.current = isInFlight;
  const onStopRef = useRef(onStop);
  onStopRef.current = onStop;

  // Server pushes a "restore" payload after a user-initiated stop so the user
  // can edit and resend the interrupted message. Bail out of vim if needed,
  // and stomp on the textarea regardless of any in-progress draft — at the
  // moment of stop the user explicitly asked to recover that message.
  const lastRestoreNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!restore) return;
    if (lastRestoreNonce.current === restore.nonce) return;
    lastRestoreNonce.current = restore.nonce;
    setDraft(restore.text);
    if (vimModeRef.current) setVimMode(false);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [restore]);

  const autoSize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  useEffect(() => {
    if (!vimMode) autoSize();
  }, [draft, vimMode]);

  const submit = () => {
    if (isInFlight) return;
    const text = draftRef.current.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
    if (vimModeRef.current) setVimMode(false);
  };

  const onFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit();
  };

  const actionButton = isInFlight ? (
    <button
      type="button"
      onClick={onStop}
      aria-label="Stop"
      title="Stop (Esc)"
      className="composer-action stop"
    >
      <Square size={18} fill="currentColor" aria-hidden="true" />
    </button>
  ) : (
    <button
      type="submit"
      disabled={!draft.trim()}
      aria-label="Send"
      title="Send"
      className="composer-action send"
    >
      <Send size={18} aria-hidden="true" />
    </button>
  );

  const enterVim = () => {
    setVimMode(true);
  };

  // :wq / Ctrl+G-from-vim — buffer is already mirrored into draft via
  // VimComposer.onChange, so just leave vim and let the textarea show it.
  const acceptAndExit = () => setVimMode(false);

  // :q / :q! — VimComposer hands us the last :w snapshot (or the entry value
  // if :w was never run). Restore the textarea to that and exit.
  const discardAndExit = (restoreText: string) => {
    setDraft(restoreText);
    setVimMode(false);
  };

  // Ctrl+G enters vim mode. Inside vim use :wq / :q! to leave.
  // Esc stops the agent when in-flight (skipped in vim — that's vim's normal-mode key).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "g" || e.key === "G")) {
        if (vimModeRef.current) return;
        e.preventDefault();
        enterVim();
        return;
      }
      if (e.key === "Escape") {
        if (vimModeRef.current) return;
        if (!isInFlightRef.current) return;
        const ae = document.activeElement;
        // Don't hijack Esc from other inputs (e.g. the title rename field).
        if (ae instanceof HTMLInputElement) return;
        e.preventDefault();
        onStopRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // After leaving vim, return focus to the textarea so the user can keep
  // editing or hit Enter to send without an extra click.
  const wasInVimRef = useRef(false);
  useEffect(() => {
    if (wasInVimRef.current && !vimMode) {
      // Textarea just remounted; defer one frame so the ref is wired up.
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    }
    wasInVimRef.current = vimMode;
  }, [vimMode]);

  if (vimMode) {
    return (
      <Suspense fallback={<div className="chat-input vim-loading">loading vim editor…</div>}>
        <form className="chat-input chat-input-vim" onSubmit={onFormSubmit}>
          <VimComposer
            value={draft}
            onChange={setDraft}
            onAcceptAndExit={acceptAndExit}
            onDiscardAndExit={discardAndExit}
          />
          {actionButton}
        </form>
      </Suspense>
    );
  }

  return (
    <>
      <form className="chat-input" onSubmit={onFormSubmit}>
        <textarea
          ref={textareaRef}
          placeholder="message…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (isInFlight) return;
              submit();
            }
          }}
          rows={2}
        />
        {actionButton}
      </form>
      <div className="chat-input-hint">
        <kbd>Ctrl+G</kbd> for vim mode
      </div>
    </>
  );
});

const ClaudeTodoPanel = memo(
  function ClaudeTodoPanel({ todos }: { todos: ClaudeTodo[] }) {
    const [collapsed, setCollapsed] = useState(false);
    const counts = todos.reduce(
      (acc, t) => {
        acc[t.status] += 1;
        return acc;
      },
      { pending: 0, in_progress: 0, completed: 0 },
    );
    const total = todos.length;
    return (
      <div className="claude-todos">
        <button
          type="button"
          className="claude-todos-header"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
        >
          <span className="claude-todos-chevron">{collapsed ? "▸" : "▾"}</span>
          <span className="claude-todos-title">agent task list</span>
          <span className="claude-todos-progress">
            {counts.completed}/{total}
            {counts.in_progress > 0 ? ` · ${counts.in_progress} active` : ""}
          </span>
        </button>
        {!collapsed && (
          <ul className="claude-todos-list">
            {todos.map((t, i) => (
              <li key={`${i}_${t.content}`} className={`claude-todo ${t.status}`}>
                <span className="claude-todo-marker" aria-hidden="true">
                  {t.status === "completed" ? "☑" : t.status === "in_progress" ? "◧" : "☐"}
                </span>
                <span className="claude-todo-text">
                  {t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  },
  (a, b) => {
    if (a.todos === b.todos) return true;
    if (a.todos.length !== b.todos.length) return false;
    for (let i = 0; i < a.todos.length; i++) {
      if (
        a.todos[i].content !== b.todos[i].content ||
        a.todos[i].status !== b.todos[i].status
      ) {
        return false;
      }
    }
    return true;
  },
);

const RenderedMarkdown = memo(function RenderedMarkdown({ source }: { source: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>;
});

const MessageRow = memo(
  function MessageRow({ message }: { message: ChatMessage }) {
    const renderAsMarkdown = message.role === "assistant" || message.role === "system";
    return (
      <div className={`msg msg-${message.role}`}>
        <div className="msg-meta">
          {message.role}
          {message.tool_name ? `: ${message.tool_name}` : ""}
          {message.repo ? ` (${message.repo})` : ""}
        </div>
        {renderAsMarkdown ? (
          <div className="msg-md">
            <RenderedMarkdown source={message.text} />
          </div>
        ) : (
          <pre className="msg-text">{message.text}</pre>
        )}
      </div>
    );
  },
  (a, b) =>
    a.message.id === b.message.id &&
    a.message.text === b.message.text &&
    a.message.role === b.message.role &&
    a.message.tool_name === b.message.tool_name &&
    a.message.repo === b.message.repo,
);

const ToolRunCard = memo(
  function ToolRunCard({ tools }: { tools: ChatMessage[] }) {
    const [expanded, setExpanded] = useState(false);
    const lastTool = tools[tools.length - 1];
    const summary =
      tools.length === 1
        ? lastTool.tool_name ?? "tool"
        : `${lastTool.tool_name ?? "tool"} (+${tools.length - 1} more)`;
    return (
      <div className="msg msg-tool tool-run">
        <button
          type="button"
          className="tool-run-header"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span className="tool-run-chevron">{expanded ? "▾" : "▸"}</span>
          <span className="tool-run-icon">🔧</span>
          <span className="tool-run-summary">{summary}</span>
          <span className="tool-run-count">{tools.length} call{tools.length === 1 ? "" : "s"}</span>
        </button>
        {expanded && (
          <ol className="tool-run-list">
            {tools.map((t) => (
              <li key={t.id} className="tool-run-item">
                <div className="tool-run-item-name">{t.tool_name ?? "tool"}</div>
                <pre className="tool-run-item-input">{t.text}</pre>
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  },
  (a, b) =>
    a.tools.length === b.tools.length &&
    a.tools[0]?.id === b.tools[0]?.id &&
    a.tools[a.tools.length - 1]?.id === b.tools[b.tools.length - 1]?.id,
);

function PermissionPrompt({
  perm,
  onResolve,
}: {
  perm: PendingPermission;
  onResolve: (perm: PendingPermission, allow: boolean) => void;
}) {
  const [resolved, setResolved] = useState<"allow" | "deny" | null>(null);
  const handle = (allow: boolean) => {
    if (resolved) return;
    setResolved(allow ? "allow" : "deny");
    onResolve(perm, allow);
  };
  return (
    <div className="permission-prompt">
      <div className="permission-header">
        🔐 permission needed: <strong>{perm.tool}</strong>
      </div>
      <pre className="permission-input">{JSON.stringify(perm.input, null, 2)}</pre>
      <div className="permission-actions">
        <button
          className="btn-primary"
          disabled={resolved !== null}
          onClick={() => handle(true)}
        >
          {resolved === "allow" ? "allowed" : "allow"}
        </button>
        <button
          className="btn-secondary"
          disabled={resolved !== null}
          onClick={() => handle(false)}
        >
          {resolved === "deny" ? "denied" : "deny"}
        </button>
      </div>
    </div>
  );
}
