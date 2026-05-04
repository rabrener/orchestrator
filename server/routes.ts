import type { FastifyInstance } from "fastify";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  addTodo,
  completeTodo,
  listTodos,
  removeTodo,
  renameTodo,
  reorderTodos,
  setTodoCwd,
} from "./store.js";
import { listDirectory } from "./fs-browser.js";
import { sessionManager } from "./session-manager.js";
import { runCodexReview } from "./codex-review.js";
import { probeCodex } from "./codex-status.js";
import { broadcast } from "./ws.js";
import { readPreferences, writePreferences } from "./preferences.js";
import type { Preferences } from "./preferences.js";
import { discoverSlashCommands } from "./slash-commands.js";
import type { PermissionMode } from "./types.js";

const VALID_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
];

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({ ok: true, ts: new Date().toISOString() }));

  // ── Integrations ───────────────────────────────────────────────────
  app.get<{ Querystring: { refresh?: string } }>(
    "/api/integrations/codex",
    async (req) => probeCodex(req.query?.refresh === "1"),
  );

  // ── Slash commands ─────────────────────────────────────────────────
  app.get("/api/slash-commands", async () => ({
    commands: await discoverSlashCommands(),
  }));

  // ── Filesystem browser ─────────────────────────────────────────────
  app.get<{ Querystring: { path?: string } }>("/api/fs/list", async (req, reply) => {
    const path = req.query?.path?.trim();
    if (!path) {
      reply.code(400);
      return { error: "path_required" };
    }
    const result = await listDirectory(path);
    if (!result.ok) {
      reply.code(result.error === "not_absolute" ? 400 : 404);
      return { error: result.error };
    }
    return result.listing;
  });

  // ── Preferences ────────────────────────────────────────────────────
  app.get("/api/preferences", async () => ({ preferences: await readPreferences() }));
  app.put<{ Body: Partial<Preferences> }>(
    "/api/preferences",
    async (req) => ({ preferences: await writePreferences(req.body ?? {}) }),
  );

  // ── To-dos ─────────────────────────────────────────────────────────
  app.get("/api/todos", async () => ({ todos: await listTodos() }));

  app.post<{ Body: { title?: string } }>("/api/todos", async (req, reply) => {
    const title = req.body?.title?.trim();
    if (!title) {
      reply.code(400);
      return { error: "title_required" };
    }
    const todo = await addTodo(title);
    broadcast({ type: "todos.updated", payload: await listTodos() });
    return { todo };
  });

  app.patch<{ Params: { id: string }; Body: { title?: string; cwd?: string | null } }>(
    "/api/todos/:id",
    async (req, reply) => {
      const { title: rawTitle, cwd: rawCwd } = req.body ?? {};
      const wantsTitle = typeof rawTitle === "string";
      const wantsCwd = rawCwd !== undefined;

      if (!wantsTitle && !wantsCwd) {
        reply.code(400);
        return { error: "no_fields_provided" };
      }

      let updated = null as Awaited<ReturnType<typeof renameTodo>>;

      if (wantsTitle) {
        const title = rawTitle!.trim();
        if (!title) {
          reply.code(400);
          return { error: "title_required" };
        }
        updated = await renameTodo(req.params.id, title);
        if (!updated) {
          reply.code(404);
          return { error: "not_found" };
        }
      }

      if (wantsCwd) {
        if (rawCwd !== null) {
          if (typeof rawCwd !== "string" || !isAbsolute(rawCwd)) {
            reply.code(400);
            return { error: "cwd_must_be_absolute" };
          }
          try {
            const s = await stat(rawCwd);
            if (!s.isDirectory()) {
              reply.code(400);
              return { error: "cwd_not_a_directory" };
            }
          } catch {
            reply.code(400);
            return { error: "cwd_does_not_exist" };
          }
        }
        updated = await setTodoCwd(req.params.id, rawCwd);
        if (!updated) {
          reply.code(404);
          return { error: "not_found" };
        }
      }

      broadcast({ type: "todos.updated", payload: await listTodos() });
      return { todo: updated };
    },
  );

  app.post<{ Body: { ids?: unknown } }>("/api/todos/reorder", async (req, reply) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
      reply.code(400);
      return { error: "ids_array_required" };
    }
    const todos = await reorderTodos(ids as string[]);
    broadcast({ type: "todos.updated", payload: todos });
    return { todos };
  });

  app.delete<{ Params: { id: string } }>("/api/todos/:id", async (req, reply) => {
    const removed = await removeTodo(req.params.id);
    if (!removed) {
      reply.code(404);
      return { error: "not_found" };
    }
    if (sessionManager.has(req.params.id)) {
      await sessionManager.stop(req.params.id);
    }
    broadcast({ type: "todos.updated", payload: await listTodos() });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/todos/:id/complete", async (req, reply) => {
    const updated = await completeTodo(req.params.id);
    if (!updated) {
      reply.code(404);
      return { error: "not_found" };
    }
    await sessionManager.stop(req.params.id, { archive: true });
    broadcast({ type: "todos.updated", payload: await listTodos() });
    return { todo: updated };
  });

  // ── Sessions ───────────────────────────────────────────────────────
  app.get("/api/sessions", async () => ({
    sessions: sessionManager.list().map((s) => s.snapshot()),
  }));

  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
    const session = sessionManager.get(req.params.id);
    const messages = await sessionManager.getTranscript(req.params.id);
    if (!session) {
      reply.code(404);
      return { error: "not_found", messages };
    }
    return { session: session.snapshot(), messages };
  });

  app.post<{ Params: { id: string } }>("/api/todos/:id/session", async (req, reply) => {
    const todos = await listTodos();
    const todo = todos.find((t) => t.id === req.params.id);
    if (!todo) {
      reply.code(404);
      return { error: "todo_not_found" };
    }
    if (todo.completed_at) {
      reply.code(400);
      return { error: "todo_completed" };
    }
    const session = await sessionManager.start(
      req.params.id,
      todo.title,
      todo.session_id ?? undefined,
      todo.cwd ?? null,
    );
    const messages = await sessionManager.getTranscript(req.params.id);
    return { session: session.snapshot(), messages };
  });

  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    "/api/sessions/:id/message",
    async (req, reply) => {
      const text = req.body?.text?.trim();
      if (!text) {
        reply.code(400);
        return { error: "text_required" };
      }
      const session = sessionManager.get(req.params.id);
      if (!session) {
        reply.code(404);
        return { error: "session_not_found" };
      }
      const listener = sessionManager["listener"];
      if (!listener) {
        reply.code(500);
        return { error: "listener_not_configured" };
      }
      await session.sendUserMessage(text, listener);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { mode?: PermissionMode } }>(
    "/api/sessions/:id/mode",
    async (req, reply) => {
      const mode = req.body?.mode;
      if (!mode || !VALID_MODES.includes(mode)) {
        reply.code(400);
        return { error: "invalid_mode", valid: VALID_MODES };
      }
      const session = sessionManager.get(req.params.id);
      if (!session) {
        reply.code(404);
        return { error: "session_not_found" };
      }
      const listener = sessionManager["listener"];
      if (!listener) {
        reply.code(500);
        return { error: "listener_not_configured" };
      }
      await session.setMode(mode, listener);
      return { ok: true, mode };
    },
  );

  app.post<{ Params: { id: string }; Body: { request_id?: string; allow?: boolean } }>(
    "/api/sessions/:id/permission",
    async (req, reply) => {
      const { request_id, allow } = req.body ?? {};
      if (!request_id || typeof allow !== "boolean") {
        reply.code(400);
        return { error: "request_id_and_allow_required" };
      }
      const session = sessionManager.get(req.params.id);
      if (!session) {
        reply.code(404);
        return { error: "session_not_found" };
      }
      const ok = session.resolvePermission(request_id, allow);
      if (!ok) {
        reply.code(404);
        return { error: "permission_not_found" };
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>("/api/sessions/:id/stop", async (req, reply) => {
    const session = sessionManager.get(req.params.id);
    if (!session) {
      reply.code(404);
      return { error: "session_not_found" };
    }
    // User-initiated stop: interrupt the current turn but leave the session
    // in the map so /message can queue a new turn afterward.
    await sessionManager.stop(req.params.id, { keepAlive: true });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/codex-review",
    async (req, reply) => {
      const session = sessionManager.get(req.params.id);
      if (!session) {
        reply.code(404);
        return { error: "session_not_found" };
      }
      // Fire-and-forget; review messages stream via WS as each repo finishes.
      void runCodexReview(req.params.id, {
        emitMessage: (todoId, message) => {
          broadcast({
            type: "session.message",
            payload: { todo_id: todoId, message },
          });
        },
      }).catch((err) => {
        app.log.error({ err }, "codex review failed");
      });
      return { ok: true };
    },
  );
}
