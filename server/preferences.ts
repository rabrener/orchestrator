import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PREFS_FILE } from "./paths.js";

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
}

const DEFAULTS: Preferences = {
  theme: "dark-soft",
  font_size: "medium",
  default_permission_mode: "default",
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
  return { theme, font_size, default_permission_mode };
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
