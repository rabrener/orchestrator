import { realpath, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";

export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface FsListing {
  path: string;
  parent: string | null;
  home: string;
  entries: FsEntry[];
}

export type FsBrowserError =
  | "not_absolute"
  | "not_found"
  | "not_a_directory"
  | "permission_denied"
  | "read_failed";

// Resolve a candidate path into a canonical, listable directory listing.
// Symlinks are followed via realpath so the picker shows the user where they
// truly are; bad paths fall back to the user's homedir rather than crashing.
export async function listDirectory(input: string): Promise<{
  ok: true;
  listing: FsListing;
} | {
  ok: false;
  error: FsBrowserError;
}> {
  if (!input || typeof input !== "string" || !isAbsolute(input)) {
    return { ok: false, error: "not_absolute" };
  }

  let canonical: string;
  try {
    canonical = await realpath(input);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, error: "not_found" };
    if (code === "EACCES" || code === "EPERM") return { ok: false, error: "permission_denied" };
    return { ok: false, error: "read_failed" };
  }

  let s;
  try {
    s = await stat(canonical);
  } catch {
    return { ok: false, error: "not_found" };
  }
  if (!s.isDirectory()) return { ok: false, error: "not_a_directory" };

  let raw;
  try {
    raw = await readdir(canonical, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return { ok: false, error: "permission_denied" };
    return { ok: false, error: "read_failed" };
  }

  // Hide dotfiles by default — power users can still type the path. Sort
  // case-insensitively so directory listings feel ordered the way Finder/
  // Files do, not the way readdir happens to return them.
  const entries: FsEntry[] = raw
    .filter((e) => !e.name.startsWith("."))
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => ({
      name: e.name,
      path: canonical === "/" ? `/${e.name}` : `${canonical}/${e.name}`,
      is_dir: true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  return {
    ok: true,
    listing: {
      path: canonical,
      parent: canonical === "/" ? null : dirname(canonical),
      home: homedir(),
      entries,
    },
  };
}
