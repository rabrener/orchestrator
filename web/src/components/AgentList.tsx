import type { SessionMeta, SessionStatus, Todo } from "../types.js";

interface Props {
  todos: Todo[];
  sessions: Record<string, SessionMeta>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const STATUS_PRIORITY: Record<SessionStatus, number> = {
  asking: 0,
  working: 1,
  idle: 2,
  error: 3,
  done: 4,
};

const STATUS_LABEL: Record<SessionStatus, string> = {
  working: "working",
  asking: "needs you",
  idle: "idle",
  done: "done",
  error: "error",
};

export function AgentList({ todos, sessions, selectedId, onSelect }: Props) {
  const withAgent = todos
    .filter((t) => !t.completed_at && sessions[t.id])
    .sort((a, b) => {
      const sa = sessions[a.id]!.status;
      const sb = sessions[b.id]!.status;
      return STATUS_PRIORITY[sa] - STATUS_PRIORITY[sb];
    });

  const withoutAgent = todos.filter((t) => !t.completed_at && !sessions[t.id]);

  return (
    <aside className="pane agent-pane">
      <h2>Agents</h2>
      <ul className="agent-list">
        {withAgent.length === 0 && (
          <li className="empty">no agents running</li>
        )}
        {withAgent.map((t) => {
          const s = sessions[t.id]!;
          return (
            <li
              key={t.id}
              className={`agent-item ${selectedId === t.id ? "selected" : ""}`}
              onClick={() => onSelect(t.id)}
            >
              <span className={`status-pill ${s.status}`}>
                {STATUS_LABEL[s.status]}
              </span>
              <span className="agent-title">{t.title}</span>
              <span className="agent-mode">{s.permission_mode}</span>
            </li>
          );
        })}
        {withoutAgent.length > 0 && (
          <>
            <li className="divider">no agent yet</li>
            {withoutAgent.map((t) => (
              <li
                key={t.id}
                className={`agent-item idle-todo ${selectedId === t.id ? "selected" : ""}`}
                onClick={() => onSelect(t.id)}
              >
                <span className="status-pill no-agent">—</span>
                <span className="agent-title">{t.title}</span>
              </li>
            ))}
          </>
        )}
      </ul>
    </aside>
  );
}
