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
  cwd?: string | null;
}

export interface FsListing {
  path: string;
  parent: string | null;
  home: string;
  entries: Array<{ name: string; path: string; is_dir: boolean }>;
}

// Legacy single-purpose permission shape — still emitted in SessionMeta for
// back-compat. New UI code should consume `pending_interaction` instead.
export interface PendingPermission {
  request_id: string;
  tool: string;
  input: unknown;
}

export type SuggestedPermissionUpdate = Record<string, unknown>;

export interface AskUserQuestionOption {
  label: string;
  description: string;
  preview?: string;
}
export interface AskUserQuestion {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
}
export interface PlanAllowedPrompt {
  tool: "Bash";
  prompt: string;
}

export type PendingInteraction =
  | {
      kind: "tool_permission";
      id: string;
      tool_use_id?: string;
      tool: string;
      input: unknown;
      title?: string;
      display_name?: string;
      description?: string;
      blocked_path?: string;
      decision_reason?: string;
      suggestions?: SuggestedPermissionUpdate[];
    }
  | {
      kind: "question";
      id: string;
      tool_use_id?: string;
      questions: AskUserQuestion[];
    }
  | {
      kind: "plan_approval";
      id: string;
      tool_use_id?: string;
      plan_markdown: string;
      allowed_prompts: PlanAllowedPrompt[];
    }
  | {
      kind: "elicitation";
      id: string;
      server_name: string;
      message: string;
      mode: "form" | "url";
      url?: string;
      schema?: Record<string, unknown>;
      title?: string;
      display_name?: string;
      description?: string;
    };

export type InteractionResponse =
  | {
      kind: "tool_permission";
      allow: boolean;
      updated_input?: Record<string, unknown>;
      updated_permissions?: SuggestedPermissionUpdate[];
      interrupt_on_deny?: boolean;
      message?: string;
    }
  | {
      kind: "question";
      answers: Record<string, string>;
      annotations?: Record<string, { notes?: string; preview?: string }>;
    }
  | {
      kind: "plan_approval";
      allow: boolean;
      allowed_prompts?: PlanAllowedPrompt[];
      message?: string;
    }
  | {
      kind: "elicitation";
      action: "accept" | "decline" | "cancel";
      content?: Record<string, unknown>;
    };

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
  pending_interaction?: PendingInteraction | null;
  started_at: string;
  last_activity_at: string;
  claude_todos?: ClaudeTodo[];
  slash_commands?: string[];
  context_tokens?: number;
  context_window?: number;
  model?: string;
  codex_review_active?: boolean;
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
  role: "user" | "assistant" | "tool" | "system" | "codex" | "shell";
  text: string;
  ts: string;
  tool_name?: string;
  repo?: string;
}

export interface CodexStatus {
  installed: boolean;
  version: string | null;
  error: string | null;
  checked_at: string;
}

export type WsEvent =
  | { type: "todos.updated"; payload: Todo[] }
  | { type: "session.status"; payload: { todo_id: string; status: SessionStatus; meta?: SessionMeta } }
  | { type: "session.message"; payload: { todo_id: string; message: ChatMessage } }
  | {
      type: "session.interaction_request";
      payload: { todo_id: string; interaction: PendingInteraction };
    }
  | { type: "session.composer_restore"; payload: { todo_id: string; text: string } };
