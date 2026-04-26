import { homedir } from "node:os";
import { join } from "node:path";

export const JINNI_ROOT = join(homedir(), "Documents", "jinni");
export const DATA_ROOT = join(homedir(), ".jinni-todo");
export const SESSIONS_DIR = join(DATA_ROOT, "sessions");
export const ARCHIVE_DIR = join(DATA_ROOT, "archive");

export function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayFilePath(date = todayLocal()): string {
  return join(DATA_ROOT, `${date}.json`);
}

export function sessionDir(todoId: string): string {
  return join(SESSIONS_DIR, todoId);
}

export function archiveDir(date: string, todoId: string): string {
  return join(ARCHIVE_DIR, date, todoId);
}
