export type SessionStatus =
  | "working"
  | "asking"
  | "idle"
  | "done"
  | "error";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "dontAsk"
  | "auto";

export interface Todo {
  id: string;
  title: string;
  created_at: string;
  completed_at: string | null;
  session_id: string | null;
}

export interface PendingPermission {
  request_id: string;
  tool: string;
  input: unknown;
}

export interface ClaudeTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface SessionMeta {
  todo_id: string;
  session_id: string;
  status: SessionStatus;
  permission_mode: PermissionMode;
  cwd: string;
  pending_permission: PendingPermission | null;
  started_at: string;
  last_activity_at: string;
  claude_todos?: ClaudeTodo[];
  slash_commands?: string[];
  context_tokens?: number;
  context_window?: number;
  model?: string;
}

export interface SlashCommand {
  name: string;
  description: string;
  argument_hint?: string;
  source: "user-command" | "user-skill" | "project-command" | "project-skill";
  path: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system" | "codex";
  text: string;
  ts: string;
  tool_name?: string;
  repo?: string;
}

export type WsEvent =
  | { type: "todos.updated"; payload: Todo[] }
  | { type: "session.status"; payload: { todo_id: string; status: SessionStatus; meta?: SessionMeta } }
  | { type: "session.message"; payload: { todo_id: string; message: ChatMessage } }
  | { type: "session.permission_request"; payload: { todo_id: string; permission: PendingPermission } }
  | { type: "session.codex_output"; payload: { todo_id: string; repo: string; chunk: string } }
  | { type: "session.composer_restore"; payload: { todo_id: string; text: string } };
