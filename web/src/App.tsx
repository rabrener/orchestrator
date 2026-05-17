import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Settings } from "lucide-react";
import { api, applyPreferences, connectWs, type Preferences } from "./api.js";
import { TodoList } from "./components/TodoList.js";
import { ChatPanel } from "./components/ChatPanel.js";
import { ResizeHandle, usePersistedWidth } from "./components/ResizeHandle.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import {
  getPermissionState,
  notify,
  requestPermission,
  shouldNotifyOnStatusChange,
  type NotificationPermissionState,
} from "./notifications.js";
import type {
  ChatMessage,
  InteractionResponse,
  PendingInteraction,
  PermissionMode,
  SessionMeta,
  SlashCommand,
  Todo,
  WsEvent,
} from "./types.js";

export function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [sessions, setSessions] = useState<Record<string, SessionMeta>>({});
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [composerRestores, setComposerRestores] = useState<
    Record<string, { text: string; nonce: number }>
  >({});
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [notifPermission, setNotifPermission] =
    useState<NotificationPermissionState>(getPermissionState());
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const wsConnectedRef = useRef(false);
  const todosRef = useRef<Todo[]>([]);
  const prevStatusRef = useRef<Record<string, string>>({});

  const [todoPaneWidth, adjustTodoPaneWidth] = usePersistedWidth(
    "ui.todoPaneWidth",
    320,
    220,
    700,
  );

  useEffect(() => {
    todosRef.current = todos;
  }, [todos]);

  const handleEvent = useCallback((e: WsEvent) => {
    if (!wsConnectedRef.current) {
      wsConnectedRef.current = true;
      setWsConnected(true);
    }
    if (e.type === "todos.updated") {
      setTodos(e.payload);
    } else if (e.type === "session.status") {
      const prevStatus = prevStatusRef.current[e.payload.todo_id];
      if (shouldNotifyOnStatusChange(prevStatus as never, e.payload.status)) {
        const todo = todosRef.current.find((t) => t.id === e.payload.todo_id);
        const title = todo?.title ?? "agent";
        notify({
          title:
            e.payload.status === "asking" ? `❓ ${title}` : `✓ ${title} (idle)`,
          body:
            e.payload.status === "asking"
              ? "agent is asking for permission or input"
              : "agent finished its turn",
          tag: `session-${e.payload.todo_id}`,
          onClick: () => setSelectedTodoId(e.payload.todo_id),
        });
      }
      prevStatusRef.current[e.payload.todo_id] = e.payload.status;
      setSessions((prev) => {
        const cur = prev[e.payload.todo_id];
        const next =
          e.payload.meta ?? (cur ? { ...cur, status: e.payload.status } : null);
        if (!next) return prev;
        return { ...prev, [e.payload.todo_id]: next };
      });
    } else if (e.type === "session.message") {
      setMessages((prev) => {
        const list = prev[e.payload.todo_id] ?? [];
        return { ...prev, [e.payload.todo_id]: [...list, e.payload.message] };
      });
    } else if (e.type === "session.interaction_request") {
      setSessions((prev) => {
        const cur = prev[e.payload.todo_id];
        if (!cur) return prev;
        const interaction = e.payload.interaction;
        const legacyPerm =
          interaction.kind === "tool_permission"
            ? {
                request_id: interaction.id,
                tool: interaction.tool,
                input: interaction.input,
              }
            : null;
        return {
          ...prev,
          [e.payload.todo_id]: {
            ...cur,
            status: "asking",
            pending_interaction: interaction,
            pending_permission: legacyPerm,
          },
        };
      });
    } else if (e.type === "session.composer_restore") {
      setComposerRestores((prev) => {
        const cur = prev[e.payload.todo_id];
        return {
          ...prev,
          [e.payload.todo_id]: {
            text: e.payload.text,
            nonce: (cur?.nonce ?? 0) + 1,
          },
        };
      });
    }
  }, []);

  useEffect(() => {
    api
      .getPreferences()
      .then((prefs) => {
        applyPreferences(prefs);
        setPreferences(prefs);
      })
      .catch(() => undefined);
    api
      .listTodos()
      .then(setTodos)
      .catch((err) => setError(String(err)));
    api
      .listSlashCommands()
      .then(setSlashCommands)
      .catch(() => undefined);
    api
      .listSessions()
      .then(async (list) => {
        setSessions(Object.fromEntries(list.map((s) => [s.todo_id, s])));
        const transcripts = await Promise.all(
          list.map((s) =>
            api
              .getSession(s.todo_id)
              .then((r) => [s.todo_id, r.messages] as const)
              .catch(() => [s.todo_id, []] as const),
          ),
        );
        setMessages(Object.fromEntries(transcripts));
      })
      .catch(() => undefined);
    return connectWs(handleEvent);
  }, [handleEvent]);

  // Lazy-load transcripts for todos that weren't part of listSessions on boot
  // — e.g. completed (or un-completed) todos whose live session is closed but
  // whose sessions/<id>/transcript.jsonl is still on disk.
  useEffect(() => {
    if (!selectedTodoId) return;
    if (messages[selectedTodoId] !== undefined) return;
    let cancelled = false;
    api
      .getTranscript(selectedTodoId)
      .then((msgs) => {
        if (cancelled) return;
        setMessages((prev) =>
          prev[selectedTodoId] !== undefined
            ? prev
            : { ...prev, [selectedTodoId]: msgs },
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedTodoId, messages]);

  const selectedTodo = useMemo(
    () => todos.find((t) => t.id === selectedTodoId) ?? null,
    [todos, selectedTodoId],
  );
  const selectedSession = selectedTodoId
    ? (sessions[selectedTodoId] ?? null)
    : null;
  const selectedMessages = selectedTodoId
    ? (messages[selectedTodoId] ?? [])
    : [];
  const selectedComposerRestore = selectedTodoId
    ? (composerRestores[selectedTodoId] ?? null)
    : null;

  const onAddTodo = async (title: string) => {
    try {
      await api.addTodo(title);
    } catch (err) {
      setError(String(err));
    }
  };

  const onRemoveTodo = async (id: string) => {
    try {
      await api.removeTodo(id);
      if (selectedTodoId === id) setSelectedTodoId(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const onRenameTodo = async (id: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setTodos((prev) =>
      prev.map((t) => (t.id === id ? { ...t, title: trimmed } : t)),
    );
    try {
      await api.renameTodo(id, trimmed);
    } catch (err) {
      setError(String(err));
      api
        .listTodos()
        .then(setTodos)
        .catch(() => undefined);
    }
  };

  const onSetTodoCwd = async (id: string, cwd: string | null) => {
    const prev = todos;
    setTodos((current) =>
      current.map((t) => (t.id === id ? { ...t, cwd } : t)),
    );
    try {
      await api.setTodoCwd(id, cwd);
    } catch (err) {
      setError(String(err));
      setTodos(prev);
      throw err;
    }
  };

  const onCompleteTodo = async (id: string) => {
    try {
      await api.completeTodo(id);
      if (selectedTodoId === id) setSelectedTodoId(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const onUncompleteTodo = async (id: string) => {
    try {
      await api.uncompleteTodo(id);
    } catch (err) {
      setError(String(err));
    }
  };

  const onReorderTodos = async (orderedActiveIds: string[]) => {
    // Optimistic: reorder active todos in-place, keep completed where they are.
    const prevTodos = todos;
    const byId = new Map(todos.map((t) => [t.id, t]));
    const seen = new Set<string>();
    const next: Todo[] = [];
    for (const id of orderedActiveIds) {
      const t = byId.get(id);
      if (t && !seen.has(id)) {
        next.push(t);
        seen.add(id);
      }
    }
    for (const t of todos) if (!seen.has(t.id)) next.push(t);
    setTodos(next);
    try {
      await api.reorderTodos(orderedActiveIds);
    } catch (err) {
      setError(String(err));
      setTodos(prevTodos);
    }
  };

  const onStartSession = async (id: string) => {
    try {
      const result = await api.startSession(id);
      setSessions((prev) => ({ ...prev, [id]: result.session }));
      if (result.messages) {
        setMessages((prev) => ({ ...prev, [id]: result.messages! }));
      }
      setSelectedTodoId(id);
    } catch (err) {
      setError(String(err));
    }
  };

  const onSendMessage = async (text: string) => {
    if (!selectedTodoId) return;
    const optimistic: ChatMessage = {
      id: `local_${Date.now()}`,
      role: "user",
      text,
      ts: new Date().toISOString(),
    };
    setMessages((prev) => ({
      ...prev,
      [selectedTodoId]: [...(prev[selectedTodoId] ?? []), optimistic],
    }));
    try {
      await api.sendMessage(selectedTodoId, text);
    } catch (err) {
      setError(String(err));
    }
  };

  const onRunShell = async (command: string) => {
    if (!selectedTodoId) return;
    try {
      await api.runShell(selectedTodoId, command);
    } catch (err) {
      setError(String(err));
    }
  };

  const onSetMode = async (mode: PermissionMode) => {
    if (!selectedTodoId) return;
    try {
      await api.setMode(selectedTodoId, mode);
    } catch (err) {
      setError(String(err));
    }
  };

  const onResolveInteraction = async (
    interaction: PendingInteraction,
    response: InteractionResponse,
  ) => {
    if (!selectedTodoId) return;
    try {
      await api.resolveInteraction(selectedTodoId, interaction.id, response);
    } catch (err) {
      setError(String(err));
    }
  };

  const onCodexReview = async (prompt?: string) => {
    if (!selectedTodoId) return;
    try {
      await api.codexReview(selectedTodoId, prompt);
    } catch (err) {
      setError(String(err));
    }
  };

  const onStopSession = async () => {
    if (!selectedTodoId) return;
    try {
      await api.stopSession(selectedTodoId);
    } catch (err) {
      setError(String(err));
    }
  };

  const onEnableNotifications = async () => {
    const result = await requestPermission();
    setNotifPermission(result);
  };

  const onPrefsChange = async (next: Preferences) => {
    setPreferences(next);
    try {
      await api.updatePreferences(next);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Orchestrator</h1>
        <span className={`ws-indicator ${wsConnected ? "ok" : "off"}`}>
          {wsConnected ? "● live" : "○ offline"}
        </span>
        {notifPermission === "default" && (
          <button className="notif-banner" onClick={onEnableNotifications}>
            🔔 enable desktop notifications
          </button>
        )}
        {error && (
          <span className="error-banner" onClick={() => setError(null)}>
            {error} (click to dismiss)
          </span>
        )}
        <button
          className="settings-btn"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
          title="Settings"
        >
          <Settings size={16} aria-hidden="true" />
        </button>
      </header>
      {settingsOpen && preferences && (
        <SettingsPanel
          preferences={preferences}
          onChange={onPrefsChange}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <div
        className="app-body"
        style={{
          gridTemplateColumns: `${todoPaneWidth}px 4px minmax(0, 1fr)`,
        }}
      >
        <TodoList
          todos={todos}
          sessions={sessions}
          selectedId={selectedTodoId}
          onSelect={setSelectedTodoId}
          onAdd={onAddTodo}
          onRemove={onRemoveTodo}
          onComplete={onCompleteTodo}
          onUncomplete={onUncompleteTodo}
          onStartSession={onStartSession}
          onReorder={onReorderTodos}
        />
        <ResizeHandle onDelta={adjustTodoPaneWidth} ariaLabel="Resize todo pane" />
        <ChatPanel
          todo={selectedTodo}
          session={selectedSession}
          messages={selectedMessages}
          composerRestore={selectedComposerRestore}
          slashCommands={slashCommands}
          onSendMessage={onSendMessage}
          onRunShell={onRunShell}
          onSetMode={onSetMode}
          onResolveInteraction={onResolveInteraction}
          onCodexReview={onCodexReview}
          onComplete={() => selectedTodo && onCompleteTodo(selectedTodo.id)}
          onStop={onStopSession}
          onStartSession={() => selectedTodo && onStartSession(selectedTodo.id)}
          onRenameTodo={onRenameTodo}
          onSetTodoCwd={onSetTodoCwd}
        />
      </div>
    </div>
  );
}
