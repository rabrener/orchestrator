import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import { DATA_ROOT, SESSIONS_DIR, ARCHIVE_DIR, todayLocal, todayFilePath, sessionDir, archiveDir } from "./paths.js";
import type { TodayFile, Todo } from "./types.js";

let writeChain: Promise<unknown> = Promise.resolve();

// Roll-forward state. We want pending todos from prior days to surface in
// today's list automatically. The migration runs at most once per day; the
// first listTodos() / mutate() call on a fresh date triggers it. We gate it
// behind serialize() so it can't race with a concurrent mutation, and we
// snapshot the in-flight promise so concurrent callers await the same run.
let lastRolledForwardDate: string | null = null;
let rollForwardInFlight: Promise<void> | null = null;

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

// Walks every `<YYYY-MM-DD>.json` file older than `today`, moves any todo with
// `completed_at: null` into today's file, and rewrites each prior file with
// the moved todos stripped. Preserves the original todo object (id, created_at,
// session_id) so chat sessions for carried-over tasks resume cleanly. De-dups
// against today's existing ids in case a todo was already manually carried over.
// Carried-over todos are prepended (oldest first) so in-progress work stays
// visible at the top above any todos newly added today.
async function rollForwardPendingImpl(today: string): Promise<void> {
  const entries = await readdir(DATA_ROOT).catch(() => [] as string[]);
  const priorDates: string[] = [];
  for (const entry of entries) {
    const m = entry.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    if (m[1] >= today) continue;
    priorDates.push(m[1]);
  }
  if (priorDates.length === 0) return;
  priorDates.sort();

  const todayPath = todayFilePath(today);
  let todayFile = await readJson<TodayFile>(todayPath);
  if (!todayFile) todayFile = { date: today, todos: [] };
  const existingIds = new Set(todayFile.todos.map((t) => t.id));

  const moved: Todo[] = [];
  const filesToRewrite: Array<{ path: string; data: TodayFile }> = [];

  for (const date of priorDates) {
    const path = todayFilePath(date);
    const priorFile = await readJson<TodayFile>(path);
    if (!priorFile) continue;
    const remaining: Todo[] = [];
    let mutated = false;
    for (const todo of priorFile.todos) {
      if (todo.completed_at === null) {
        if (!existingIds.has(todo.id)) {
          moved.push(todo);
          existingIds.add(todo.id);
        }
        // Either we just queued it for move, or today already has it via a
        // manual copy — in both cases drop from the prior file to avoid the
        // duplicate the user explicitly does not want.
        mutated = true;
        continue;
      }
      remaining.push(todo);
    }
    if (mutated) {
      filesToRewrite.push({ path, data: { ...priorFile, todos: remaining } });
    }
  }

  if (moved.length === 0 && filesToRewrite.length === 0) return;

  todayFile.todos = [...moved, ...todayFile.todos];
  await atomicWriteJson(todayPath, todayFile);
  for (const u of filesToRewrite) {
    await atomicWriteJson(u.path, u.data);
  }
}

// Lazy, idempotent. Cheap when same-day (a single string compare). Routes
// through `serialize` so it interleaves correctly with writes — and we
// deliberately call it BEFORE `mutate`'s own serialize block to avoid the
// re-entrant deadlock that would happen if a serialize body awaited another
// serialize call.
function ensureRolledForward(): Promise<void> {
  const today = todayLocal();
  if (lastRolledForwardDate === today) return Promise.resolve();
  if (rollForwardInFlight) return rollForwardInFlight;
  rollForwardInFlight = serialize(async () => {
    if (lastRolledForwardDate === today) return;
    await ensureDirs();
    await rollForwardPendingImpl(today);
    lastRolledForwardDate = today;
  }).finally(() => {
    rollForwardInFlight = null;
  });
  return rollForwardInFlight;
}

async function mutate(fn: (file: TodayFile) => void | Promise<void>): Promise<TodayFile> {
  await ensureRolledForward();
  return serialize(async () => {
    const file = await loadToday();
    await fn(file);
    await atomicWriteJson(todayFilePath(file.date), file);
    return file;
  });
}

export async function listTodos(): Promise<Todo[]> {
  await ensureRolledForward();
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

export async function renameTodo(id: string, title: string): Promise<Todo | null> {
  const trimmed = title.trim();
  if (!trimmed) return null;
  let updated: Todo | null = null;
  await mutate((file) => {
    const todo = file.todos.find((t) => t.id === id);
    if (todo) {
      todo.title = trimmed;
      updated = todo;
    }
  });
  return updated;
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

export async function reorderTodos(orderedIds: string[]): Promise<Todo[]> {
  let result: Todo[] = [];
  await mutate((file) => {
    const byId = new Map(file.todos.map((t) => [t.id, t]));
    const seen = new Set<string>();
    const reordered: Todo[] = [];
    for (const id of orderedIds) {
      const todo = byId.get(id);
      if (todo && !seen.has(id)) {
        reordered.push(todo);
        seen.add(id);
      }
    }
    // Preserve any todos the client didn't enumerate (e.g. completed items
    // the UI doesn't drag) by appending them in their original relative order.
    for (const todo of file.todos) {
      if (!seen.has(todo.id)) reordered.push(todo);
    }
    file.todos = reordered;
    result = reordered;
  });
  return result;
}

export async function setTodoSessionId(todoId: string, sessionId: string | null): Promise<void> {
  await mutate((file) => {
    const todo = file.todos.find((t) => t.id === todoId);
    if (todo) todo.session_id = sessionId;
  });
}

export async function setTodoCwd(todoId: string, cwd: string | null): Promise<Todo | null> {
  let updated: Todo | null = null;
  await mutate((file) => {
    const todo = file.todos.find((t) => t.id === todoId);
    if (todo) {
      todo.cwd = cwd && cwd.length > 0 ? cwd : null;
      updated = todo;
    }
  });
  return updated;
}

export function pathsForTodo(todoId: string) {
  return {
    sessionDir: sessionDir(todoId),
    archiveDir: (date: string) => archiveDir(date, todoId),
  };
}
