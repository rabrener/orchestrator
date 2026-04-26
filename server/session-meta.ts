import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import { ARCHIVE_DIR, SESSIONS_DIR, sessionDir, todayLocal } from "./paths.js";
import type { SessionMeta } from "./types.js";

function metaPath(todoId: string): string {
  return join(sessionDir(todoId), "meta.json");
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${nanoid(6)}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

export async function readMeta(todoId: string): Promise<SessionMeta | null> {
  try {
    const raw = await readFile(metaPath(todoId), "utf8");
    return JSON.parse(raw) as SessionMeta;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeMeta(meta: SessionMeta): Promise<void> {
  await atomicWriteJson(metaPath(meta.todo_id), meta);
}

export async function archiveSession(todoId: string): Promise<void> {
  const src = sessionDir(todoId);
  const date = todayLocal();
  const dst = join(ARCHIVE_DIR, date, todoId);
  try {
    await mkdir(dirname(dst), { recursive: true });
    await rename(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

export async function listAllMetas(): Promise<SessionMeta[]> {
  try {
    const entries = await readdir(SESSIONS_DIR, { withFileTypes: true });
    const metas = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map((e) => readMeta(e.name)),
    );
    return metas.filter((m): m is SessionMeta => m !== null);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
