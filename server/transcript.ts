import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sessionDir } from "./paths.js";
import type { ChatMessage } from "./types.js";

function transcriptPath(todoId: string): string {
  return join(sessionDir(todoId), "transcript.jsonl");
}

export async function appendMessage(todoId: string, msg: ChatMessage): Promise<void> {
  const path = transcriptPath(todoId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(msg) + "\n", "utf8");
}

export async function readTranscript(todoId: string): Promise<ChatMessage[]> {
  try {
    const raw = await readFile(transcriptPath(todoId), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ChatMessage);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
