import type {
  ChatMessage,
  CodexStatus,
  FsListing,
  PermissionMode,
  SessionMeta,
  SlashCommand,
  Todo,
  WsEvent,
} from "./types.js";

export type { PermissionMode };

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(input, { ...init, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listTodos: () => jsonFetch<{ todos: Todo[] }>("/api/todos").then((r) => r.todos),
  addTodo: (title: string) =>
    jsonFetch<{ todo: Todo }>("/api/todos", {
      method: "POST",
      body: JSON.stringify({ title }),
    }).then((r) => r.todo),
  removeTodo: (id: string) => jsonFetch(`/api/todos/${id}`, { method: "DELETE" }),
  renameTodo: (id: string, title: string) =>
    jsonFetch<{ todo: Todo }>(`/api/todos/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }).then((r) => r.todo),
  setTodoCwd: (id: string, cwd: string | null) =>
    jsonFetch<{ todo: Todo }>(`/api/todos/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ cwd }),
    }).then((r) => r.todo),
  listDirectory: (path: string) =>
    jsonFetch<FsListing>(`/api/fs/list?path=${encodeURIComponent(path)}`),
  completeTodo: (id: string) =>
    jsonFetch<{ todo: Todo }>(`/api/todos/${id}/complete`, { method: "POST" }).then(
      (r) => r.todo,
    ),
  uncompleteTodo: (id: string) =>
    jsonFetch<{ todo: Todo }>(`/api/todos/${id}/uncomplete`, { method: "POST" }).then(
      (r) => r.todo,
    ),
  reorderTodos: (ids: string[]) =>
    jsonFetch<{ todos: Todo[] }>("/api/todos/reorder", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }).then((r) => r.todos),

  startSession: (todoId: string) =>
    jsonFetch<{ session: SessionMeta; messages?: ChatMessage[] }>(
      `/api/todos/${todoId}/session`,
      { method: "POST" },
    ),
  listSessions: () =>
    jsonFetch<{ sessions: SessionMeta[] }>("/api/sessions").then((r) => r.sessions),
  getSession: (todoId: string) =>
    jsonFetch<{ session: SessionMeta; messages: ChatMessage[] }>(
      `/api/sessions/${todoId}`,
    ),
  getTranscript: (todoId: string) =>
    jsonFetch<{ messages: ChatMessage[] }>(
      `/api/todos/${todoId}/transcript`,
    ).then((r) => r.messages),
  sendMessage: (todoId: string, text: string) =>
    jsonFetch(`/api/sessions/${todoId}/message`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  runShell: (todoId: string, command: string) =>
    jsonFetch(`/api/sessions/${todoId}/shell`, {
      method: "POST",
      body: JSON.stringify({ command }),
    }),
  setMode: (todoId: string, mode: PermissionMode) =>
    jsonFetch(`/api/sessions/${todoId}/mode`, {
      method: "POST",
      body: JSON.stringify({ mode }),
    }),
  resolvePermission: (todoId: string, requestId: string, allow: boolean) =>
    jsonFetch(`/api/sessions/${todoId}/permission`, {
      method: "POST",
      body: JSON.stringify({ request_id: requestId, allow }),
    }),
  codexReview: (todoId: string) =>
    jsonFetch(`/api/sessions/${todoId}/codex-review`, { method: "POST" }),
  getCodexStatus: (refresh = false) =>
    jsonFetch<CodexStatus>(
      `/api/integrations/codex${refresh ? "?refresh=1" : ""}`,
    ),
  stopSession: (todoId: string) =>
    jsonFetch(`/api/sessions/${todoId}/stop`, { method: "POST" }),

  listSlashCommands: () =>
    jsonFetch<{ commands: SlashCommand[] }>("/api/slash-commands").then((r) => r.commands),

  getPreferences: () =>
    jsonFetch<{ preferences: Preferences }>("/api/preferences").then((r) => r.preferences),
  updatePreferences: (input: Partial<Preferences>) =>
    jsonFetch<{ preferences: Preferences }>("/api/preferences", {
      method: "PUT",
      body: JSON.stringify(input),
    }).then((r) => r.preferences),
};

export const THEMES = [
  { id: "dark-soft", label: "Dark — Soft", group: "dark" },
  { id: "dark-warm", label: "Dark — Warm", group: "dark" },
  { id: "dark-high-contrast", label: "Dark — High Contrast", group: "dark" },
  { id: "light-soft", label: "Light — Soft", group: "light" },
  { id: "light-warm", label: "Light — Warm", group: "light" },
] as const;
export type Theme = (typeof THEMES)[number]["id"];

export const FONT_SIZES = [
  { id: "small", label: "Small" },
  { id: "medium", label: "Medium" },
  { id: "large", label: "Large" },
  { id: "x-large", label: "Extra Large" },
] as const;
export type FontSize = (typeof FONT_SIZES)[number]["id"];

export const PERMISSION_MODES: ReadonlyArray<{
  id: PermissionMode;
  label: string;
  description: string;
}> = [
  {
    id: "default",
    label: "Standard",
    description: "Asks before editing files, running shell commands, or other tool calls.",
  },
  {
    id: "acceptEdits",
    label: "Accept Edits",
    description: "Auto-approves file edits. Still asks for shell commands and other tools.",
  },
  {
    id: "plan",
    label: "Plan Only",
    description: "Agent analyzes and plans without executing any tools.",
  },
  {
    id: "auto",
    label: "Auto",
    description:
      "A safety classifier auto-approves safe tool calls and only asks you about risky ones.",
  },
  {
    id: "dontAsk",
    label: "Don't Ask",
    description:
      "Never prompts. Pre-approved tools run; anything else is denied immediately.",
  },
  {
    id: "bypassPermissions",
    label: "Dangerously Accept Permissions",
    description:
      "Auto-approves every tool call with no safety checks. Equivalent to the SDK's bypassPermissions mode — use with caution.",
  },
];

export interface Preferences {
  theme: Theme;
  font_size: FontSize;
  default_permission_mode: PermissionMode;
  default_cwd: string | null;
}

export function applyPreferences(prefs: Preferences): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", prefs.theme);
  root.setAttribute("data-font-size", prefs.font_size);
}

export function connectWs(onEvent: (e: WsEvent) => void): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: number | null = null;

  const connect = () => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${window.location.host}/ws`);
    socket.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(ev.data) as WsEvent;
        onEvent(data);
      } catch (err) {
        console.error("ws parse error", err);
      }
    });
    socket.addEventListener("close", () => {
      if (!closed) reconnectTimer = window.setTimeout(connect, 1000);
    });
    socket.addEventListener("error", () => socket?.close());
  };

  connect();
  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  };
}
