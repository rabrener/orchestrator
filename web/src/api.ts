import type { ChatMessage, PermissionMode, SessionMeta, Todo, WsEvent } from "./types.js";

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
  completeTodo: (id: string) =>
    jsonFetch<{ todo: Todo }>(`/api/todos/${id}/complete`, { method: "POST" }).then(
      (r) => r.todo,
    ),

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
  sendMessage: (todoId: string, text: string) =>
    jsonFetch(`/api/sessions/${todoId}/message`, {
      method: "POST",
      body: JSON.stringify({ text }),
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
  stopSession: (todoId: string) =>
    jsonFetch(`/api/sessions/${todoId}/stop`, { method: "POST" }),

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

export interface Preferences {
  theme: Theme;
  font_size: FontSize;
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
