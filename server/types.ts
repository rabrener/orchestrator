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
  // Per-task cwd override. When set, new sessions for this todo run here
  // instead of the preferences default. Changes only apply to sessions
  // started after the change — a running session keeps the cwd it was
  // launched with.
  cwd?: string | null;
}

export interface TodayFile {
  date: string;
  todos: Todo[];
}

// Legacy shape kept for back-compat with persisted SessionMeta written before
// the discriminated-union refactor. New code should branch on PendingInteraction.
export interface PendingPermission {
  request_id: string;
  tool: string;
  input: unknown;
}

// One of the SDK's PermissionUpdate variants — kept structurally typed so we
// can pass `suggestions` through to the UI and back without re-shaping. The
// SDK's PermissionUpdate is a union and we don't need to discriminate it here;
// the UI surfaces them as opaque "always allow" chips.
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
  started_at: string;
  last_activity_at: string;
  // Active interactive request blocking the session (tool permission, question,
  // plan approval, MCP elicitation). When set, the UI renders the appropriate
  // form. `pending_permission` above is retained for back-compat with persisted
  // metas written before this refactor — new code should read this field.
  pending_interaction?: PendingInteraction | null;
  claude_todos?: ClaudeTodo[];
  // Slash command names the SDK reports as runnable for this session
  // (from system/init). Names only; metadata comes from the discovery endpoint.
  slash_commands?: string[];
  // Effective context size of the last turn (input + cache_creation + cache_read).
  // Undefined until the first assistant message lands. The Agent SDK does NOT
  // auto-compact, so when this nears `context_window` the next turn will error —
  // the UI uses these to render a meter and prompt the user to start fresh.
  context_tokens?: number;
  context_window?: number;
  model?: string;
  // True while a codex review is currently running for this todo. The agent's
  // SDK status is independent — codex runs out-of-band — so the UI uses this
  // flag to override the status pill with a "REVIEWING" indicator.
  codex_review_active?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system" | "codex" | "shell";
  text: string;
  ts: string;
  tool_name?: string;
  repo?: string;
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
