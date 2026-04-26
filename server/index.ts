import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { registerRoutes } from "./routes.js";
import { broadcast, registerClient } from "./ws.js";
import { listTodos } from "./store.js";
import { sessionManager } from "./session-manager.js";

// Force OAuth (claude login) auth for spawned subagents — an exported
// ANTHROPIC_API_KEY would silently route every session through API billing.
if (process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "[orchestrator-ui] ANTHROPIC_API_KEY detected; unsetting so subagents use the Claude.ai subscription",
  );
  delete process.env.ANTHROPIC_API_KEY;
}

const PORT = Number(process.env.PORT ?? 7777);
const HOST = "127.0.0.1";

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: "info" } });

  await app.register(cors, { origin: true });
  await app.register(websocket);

  sessionManager.setListener({
    onStatus: (todoId, status, meta) => {
      broadcast({ type: "session.status", payload: { todo_id: todoId, status, meta } });
    },
    onMessage: (todoId, message) => {
      broadcast({ type: "session.message", payload: { todo_id: todoId, message } });
    },
    onPermissionRequest: (todoId, permission) => {
      broadcast({
        type: "session.permission_request",
        payload: { todo_id: todoId, permission },
      });
    },
  });

  await registerRoutes(app);

  app.get("/ws", { websocket: true }, async (socket) => {
    registerClient(socket);
    socket.send(
      JSON.stringify({ type: "todos.updated", payload: await listTodos() }),
    );
  });

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`orchestrator-ui listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Phase 6 hook: auto-resume previously running sessions
  sessionManager.resumeAll().catch((err) => {
    app.log.error({ err }, "resumeAll failed");
  });
}

main();
