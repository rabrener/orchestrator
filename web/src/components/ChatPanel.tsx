import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ModePicker } from "./ModePicker.js";
import type {
  ChatMessage,
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

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
          <div ref={scrollRef} className="chat-log">
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

          <Composer onSend={onSendMessage} />

          <footer className="chat-footer">
            <ModePicker
              label="mode"
              value={session.permission_mode}
              onChange={onSetMode}
            />
            <button className="btn-secondary" onClick={onCodexReview}>
              ⚡ codex review
            </button>
            <button className="btn-secondary" onClick={onStop}>
              ⏹ stop
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

const Composer = memo(function Composer({ onSend }: { onSend: (text: string) => void }) {
  const [draft, setDraft] = useState("");
  const [vimMode, setVimMode] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Snapshot of the chat input value at the moment vim mode was entered, so
  // :q! / :q-when-empty can restore it cleanly.
  const preVimDraftRef = useRef("");
  const vimModeRef = useRef(vimMode);
  vimModeRef.current = vimMode;

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

  const enterVim = () => {
    preVimDraftRef.current = draftRef.current;
    setVimMode(true);
  };

  // :wq / Ctrl+G-from-vim — buffer is already mirrored into draft via
  // VimComposer.onChange, so just leave vim and let the textarea show it.
  const acceptAndExit = () => setVimMode(false);

  // :q! — restore the textarea to whatever it held before vim was entered.
  const discardAndExit = () => {
    setDraft(preVimDraftRef.current);
    setVimMode(false);
  };

  // Ctrl+G enters vim mode. Inside vim use :wq / :q! to leave.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "g" || e.key === "G")) {
        if (vimModeRef.current) return;
        e.preventDefault();
        enterVim();
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
          <button type="submit" disabled={!draft.trim()}>
            send
          </button>
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
              submit();
            }
          }}
          rows={2}
        />
        <button type="submit" disabled={!draft.trim()}>
          send
        </button>
      </form>
      <div className="chat-input-hint">
        <kbd>Ctrl+G</kbd> for vim mode
      </div>
    </>
  );
});

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
