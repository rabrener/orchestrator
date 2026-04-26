import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import { DATA_ROOT, SESSIONS_DIR, ARCHIVE_DIR, todayLocal, todayFilePath, sessionDir, archiveDir } from "./paths.js";
import type { TodayFile, Todo } from "./types.js";

let writeChain: Promise<unknown> = Promise.resolve();

async function ensureDirs(): Promise<void> {
  await mkdir(DATA_ROOT, { recursive: true });
  await mkdir(SESSIONS_DIR, { recursive: true });
  await mkdir(ARCHIVE_DIR, { recursive: true });
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${nanoid(6)}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function emptyToday(): TodayFile {
  return { date: todayLocal(), todos: [] };
}

export async function loadToday(): Promise<TodayFile> {
  await ensureDirs();
  const path = todayFilePath();
  const file = await readJson<TodayFile>(path);
  if (!file) {
    const fresh = emptyToday();
    await atomicWriteJson(path, fresh);
    return fresh;
  }
  return file;
}

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
}

async function mutate(fn: (file: TodayFile) => void | Promise<void>): Promise<TodayFile> {
  return serialize(async () => {
    const file = await loadToday();
    await fn(file);
    await atomicWriteJson(todayFilePath(file.date), file);
    return file;
  });
}

export async function listTodos(): Promise<Todo[]> {
  const file = await loadToday();
  return file.todos;
}

export async function addTodo(title: string): Promise<Todo> {
  const todo: Todo = {
    id: `td_${nanoid(8)}`,
    title: title.trim(),
    created_at: new Date().toISOString(),
    completed_at: null,
    session_id: null,
  };
  await mutate((file) => {
    file.todos.push(todo);
  });
  return todo;
}

export async function removeTodo(id: string): Promise<Todo | null> {
  let removed: Todo | null = null;
  await mutate((file) => {
    const idx = file.todos.findIndex((t) => t.id === id);
    if (idx >= 0) {
      removed = file.todos[idx]!;
      file.todos.splice(idx, 1);
    }
  });
  return removed;
}

export async function completeTodo(id: string): Promise<Todo | null> {
  let updated: Todo | null = null;
  await mutate((file) => {
    const todo = file.todos.find((t) => t.id === id);
    if (todo) {
      todo.completed_at = new Date().toISOString();
      updated = todo;
    }
  });
  return updated;
}

export async function setTodoSessionId(todoId: string, sessionId: string | null): Promise<void> {
  await mutate((file) => {
    const todo = file.todos.find((t) => t.id === todoId);
    if (todo) todo.session_id = sessionId;
  });
}

export function pathsForTodo(todoId: string) {
  return {
    sessionDir: sessionDir(todoId),
    archiveDir: (date: string) => archiveDir(date, todoId),
  };
}
