import { useState } from "react";
import { Plus } from "lucide-react";
import type { SessionMeta, Todo } from "../types.js";

interface Props {
  todos: Todo[];
  sessions: Record<string, SessionMeta>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: (title: string) => void;
  onRemove: (id: string) => void;
  onComplete: (id: string) => void;
  onStartSession: (id: string) => void;
}

export function TodoList({
  todos,
  sessions,
  selectedId,
  onSelect,
  onAdd,
  onRemove,
  onComplete,
  onStartSession,
}: Props) {
  const [draft, setDraft] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const title = draft.trim();
    if (!title) return;
    onAdd(title);
    setDraft("");
  };

  const active = todos.filter((t) => !t.completed_at);
  const done = todos.filter((t) => t.completed_at);

  return (
    <aside className="pane todo-pane">
      <h2>Today</h2>
      <form className="todo-form" onSubmit={submit}>
        <input
          type="text"
          placeholder="add a to-do…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          aria-label="Add to-do"
          title="Add to-do"
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </form>
      <ul className="todo-list">
        {active.length === 0 && <li className="empty">nothing yet — add one above</li>}
        {active.map((t) => {
          const session = sessions[t.id];
          const hasAgent = !!session;
          return (
            <li
              key={t.id}
              className={`todo-item ${selectedId === t.id ? "selected" : ""}`}
              onClick={() => onSelect(t.id)}
            >
              <button
                className="todo-check"
                title="mark done"
                onClick={(e) => {
                  e.stopPropagation();
                  onComplete(t.id);
                }}
              >
                ☐
              </button>
              <span className="todo-title">{t.title}</span>
              {hasAgent ? (
                <span className="todo-action active">▶ active</span>
              ) : (
                <button
                  className="todo-action start"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStartSession(t.id);
                  }}
                >
                  ▶ start
                </button>
              )}
              <button
                className="todo-remove"
                title="remove"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(t.id);
                }}
              >
                ×
              </button>
            </li>
          );
        })}
        {done.length > 0 && (
          <>
            <li className="divider">done today</li>
            {done.map((t) => (
              <li key={t.id} className="todo-item completed">
                <span className="todo-check">☑</span>
                <span className="todo-title">{t.title}</span>
              </li>
            ))}
          </>
        )}
      </ul>
    </aside>
  );
}
