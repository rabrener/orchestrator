import { useState } from "react";
import { Plus } from "lucide-react";
import type { SessionMeta, SessionStatus, Todo } from "../types.js";

interface Props {
  todos: Todo[];
  sessions: Record<string, SessionMeta>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: (title: string) => void;
  onRemove: (id: string) => void;
  onComplete: (id: string) => void;
  onStartSession: (id: string) => void;
  onReorder: (orderedActiveIds: string[]) => void;
}

type DropEdge = "top" | "bottom";

const STATUS_LABEL: Record<SessionStatus, string> = {
  working: "working",
  asking: "needs you",
  idle: "idle",
  done: "done",
  error: "error",
};

export function TodoList({
  todos,
  sessions,
  selectedId,
  onSelect,
  onAdd,
  onRemove,
  onComplete,
  onStartSession,
  onReorder,
}: Props) {
  const [draft, setDraft] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<
    { id: string; edge: DropEdge } | null
  >(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const title = draft.trim();
    if (!title) return;
    onAdd(title);
    setDraft("");
  };

  const active = todos.filter((t) => !t.completed_at);
  const withAgent = active.filter((t) => sessions[t.id]);
  const withoutAgent = active.filter((t) => !sessions[t.id]);
  const done = todos.filter((t) => t.completed_at);

  const sectionOf = (id: string): "with" | "without" =>
    sessions[id] ? "with" : "without";

  const handleDragOver = (e: React.DragEvent<HTMLLIElement>, id: string) => {
    if (!dragId) return;
    // Restrict drops to within the same section so the visual grouping
    // stays consistent with agent state.
    if (sectionOf(dragId) !== sectionOf(id)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const edge: DropEdge =
      e.clientY < rect.top + rect.height / 2 ? "top" : "bottom";
    if (dropTarget?.id !== id || dropTarget.edge !== edge) {
      setDropTarget({ id, edge });
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLLIElement>, targetId: string) => {
    e.preventDefault();
    if (!dragId || dragId === targetId || sectionOf(dragId) !== sectionOf(targetId)) {
      setDragId(null);
      setDropTarget(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const edge: DropEdge =
      e.clientY < rect.top + rect.height / 2 ? "top" : "bottom";
    const section = sectionOf(dragId);
    const sectionIds = (section === "with" ? withAgent : withoutAgent)
      .map((t) => t.id)
      .filter((id) => id !== dragId);
    const otherSectionIds = (section === "with" ? withoutAgent : withAgent).map(
      (t) => t.id,
    );
    const targetIdx = sectionIds.indexOf(targetId);
    const insertAt = edge === "top" ? targetIdx : targetIdx + 1;
    sectionIds.splice(insertAt, 0, dragId);

    // Concat: with-agent always renders before without-agent so send the
    // combined active order in that visual sequence.
    const newOrdered =
      section === "with"
        ? [...sectionIds, ...otherSectionIds]
        : [...otherSectionIds, ...sectionIds];

    setDragId(null);
    setDropTarget(null);
    const original = [
      ...withAgent.map((t) => t.id),
      ...withoutAgent.map((t) => t.id),
    ];
    if (
      newOrdered.length !== original.length ||
      newOrdered.some((v, i) => v !== original[i])
    ) {
      onReorder(newOrdered);
    }
  };

  const renderRow = (t: Todo) => {
    const session = sessions[t.id];
    const isDragging = dragId === t.id;
    const isDropTop = dropTarget?.id === t.id && dropTarget.edge === "top";
    const isDropBottom = dropTarget?.id === t.id && dropTarget.edge === "bottom";
    const cls = [
      "todo-item",
      selectedId === t.id ? "selected" : "",
      isDragging ? "dragging" : "",
      isDropTop ? "drop-above" : "",
      isDropBottom ? "drop-below" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <li
        key={t.id}
        className={cls}
        onClick={() => onSelect(t.id)}
        draggable
        onDragStart={(e) => {
          setDragId(t.id);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", t.id);
        }}
        onDragEnd={() => {
          setDragId(null);
          setDropTarget(null);
        }}
        onDragOver={(e) => handleDragOver(e, t.id)}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            if (dropTarget?.id === t.id) setDropTarget(null);
          }
        }}
        onDrop={(e) => handleDrop(e, t.id)}
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
        {session ? (
          session.codex_review_active ? (
            <span
              className="status-pill reviewing"
              title={`agent: ${session.status} · codex review running`}
            >
              reviewing
            </span>
          ) : (
            <span
              className={`status-pill ${session.status}`}
              title={`agent: ${session.status}`}
            >
              {STATUS_LABEL[session.status]}
            </span>
          )
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
  };

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
        {active.length === 0 && (
          <li className="empty">nothing yet — add one above</li>
        )}
        {withAgent.map(renderRow)}
        {withoutAgent.length > 0 && (
          <>
            {withAgent.length > 0 && <li className="divider">not started</li>}
            {withoutAgent.map(renderRow)}
          </>
        )}
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
