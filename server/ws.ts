import type { WebSocket } from "@fastify/websocket";
import type { WsEvent } from "./types.js";

const clients = new Set<WebSocket>();

export function registerClient(socket: WebSocket): void {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
}

export function broadcast(event: WsEvent): void {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}
