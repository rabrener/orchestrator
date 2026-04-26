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
};

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
