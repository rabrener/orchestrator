import { homedir } from "node:os";
import { join } from "node:path";

export const JINNI_ROOT = join(homedir(), "Documents", "jinni");
export const DATA_ROOT = join(homedir(), ".jinni-todo");
export const SESSIONS_DIR = join(DATA_ROOT, "sessions");
export const ARCHIVE_DIR = join(DATA_ROOT, "archive");

const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
export const PREFS_DIR = join(XDG_CONFIG_HOME, "orchestrator-ui");
export const PREFS_FILE = join(PREFS_DIR, "preferences.json");

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
