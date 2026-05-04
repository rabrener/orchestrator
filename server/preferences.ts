import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { PREFS_FILE, WORKSPACE_ROOT } from "./paths.js";

export const THEMES = [
  "dark-soft",
  "dark-warm",
  "dark-high-contrast",
  "light-soft",
  "light-warm",
] as const;
export type Theme = (typeof THEMES)[number];

export const FONT_SIZES = ["small", "medium", "large", "x-large"] as const;
export type FontSize = (typeof FONT_SIZES)[number];

export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface Preferences {
  theme: Theme;
  font_size: FontSize;
  default_permission_mode: PermissionMode;
  // Absolute filesystem path. When null, callers should fall back to
  // WORKSPACE_ROOT. Only validated for shape here (absolute string); existence
  // is re-checked at session-start so a deleted directory surfaces clearly.
  default_cwd: string | null;
}

const DEFAULTS: Preferences = {
  theme: "dark-soft",
  font_size: "medium",
  default_permission_mode: "default",
  default_cwd: null,
};

function sanitize(input: unknown): Preferences {
  const obj = (input ?? {}) as Partial<Preferences>;
  const theme = THEMES.includes(obj.theme as Theme) ? (obj.theme as Theme) : DEFAULTS.theme;
  const font_size = FONT_SIZES.includes(obj.font_size as FontSize)
    ? (obj.font_size as FontSize)
    : DEFAULTS.font_size;
  const default_permission_mode = PERMISSION_MODES.includes(
    obj.default_permission_mode as PermissionMode,
  )
    ? (obj.default_permission_mode as PermissionMode)
    : DEFAULTS.default_permission_mode;
  const default_cwd =
    typeof obj.default_cwd === "string" && obj.default_cwd.length > 0 && isAbsolute(obj.default_cwd)
      ? obj.default_cwd
      : null;
  return { theme, font_size, default_permission_mode, default_cwd };
}

export async function readPreferences(): Promise<Preferences> {
  try {
    const raw = await readFile(PREFS_FILE, "utf8");
    return sanitize(JSON.parse(raw));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ...DEFAULTS };
    throw err;
  }
}

export async function writePreferences(input: Partial<Preferences>): Promise<Preferences> {
  const current = await readPreferences();
  const next = sanitize({ ...current, ...input });
  await mkdir(dirname(PREFS_FILE), { recursive: true });
  await writeFile(PREFS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

// Resolve a usable absolute cwd from preferences. If the configured default
// no longer exists or isn't a directory, fall through to WORKSPACE_ROOT so
// the orchestrator stays bootable even after the user moves a folder.
export async function resolvePreferredCwd(prefs: Preferences): Promise<string> {
  if (prefs.default_cwd) {
    try {
      const s = await stat(prefs.default_cwd);
      if (s.isDirectory()) return prefs.default_cwd;
    } catch {
      // fall through
    }
  }
  return WORKSPACE_ROOT;
}
