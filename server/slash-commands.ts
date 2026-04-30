import { query } from "@anthropic-ai/claude-agent-sdk";
import { promises as fs, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { JINNI_ROOT } from "./paths.js";

export interface SlashCommand {
  name: string;
  description: string;
  argument_hint?: string;
  source:
    | "user-command"
    | "user-skill"
    | "project-command"
    | "project-skill"
    | "builtin";
  path: string;
}

interface DiscoveryRoot {
  dir: string;
  source: SlashCommand["source"];
  layout: "commands" | "skills";
}

const ROOTS: DiscoveryRoot[] = [
  { dir: join(homedir(), ".claude", "commands"), source: "user-command", layout: "commands" },
  { dir: join(homedir(), ".claude", "skills"), source: "user-skill", layout: "skills" },
  { dir: join(JINNI_ROOT, ".claude", "commands"), source: "project-command", layout: "commands" },
  { dir: join(JINNI_ROOT, ".claude", "skills"), source: "project-skill", layout: "skills" },
];

// Minimal frontmatter parser. We only need `description` and `argument-hint`,
// and skill SKILL.md uses block-scalar (`description: |`) form. Anything fancier
// (arrays, nested keys, anchors) is ignored — we just want the two strings.
function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return out;
  const body = text.slice(3, end).replace(/^\n/, "");
  const lines = body.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) {
      i += 1;
      continue;
    }
    const [, key, rest] = m;
    const trimmed = rest.trim();

    // Block scalar: `key: |` or `key: >` — collect indented continuation lines.
    if (trimmed === "|" || trimmed === ">") {
      const collected: string[] = [];
      i += 1;
      while (i < lines.length) {
        const next = lines[i];
        if (/^\s+/.test(next) || next === "") {
          collected.push(next.replace(/^\s{2}/, ""));
          i += 1;
        } else {
          break;
        }
      }
      const joiner = trimmed === ">" ? " " : "\n";
      out[key] = collected.join(joiner).trim();
      continue;
    }

    // Inline scalar — strip optional surrounding quotes.
    if (trimmed.startsWith("[") || trimmed === "") {
      // Skip arrays / empty values; not needed for description/argument-hint.
      i += 1;
      continue;
    }
    out[key] = trimmed.replace(/^["'](.*)["']$/, "$1");
    i += 1;
  }
  return out;
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readDirSafe(path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch {
    return [];
  }
}

async function discoverCommandsDir(root: DiscoveryRoot): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  const entries = await readDirSafe(root.dir);
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const path = join(root.dir, entry);
    const text = await readFileSafe(path);
    if (text == null) continue;
    const fm = parseFrontmatter(text);
    const name = entry.replace(/\.md$/, "");
    out.push({
      name,
      description: fm.description ?? "",
      argument_hint: fm["argument-hint"],
      source: root.source,
      path,
    });
  }
  return out;
}

async function discoverSkillsDir(root: DiscoveryRoot): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  const entries = await readDirSafe(root.dir);
  for (const entry of entries) {
    const skillPath = join(root.dir, entry);
    const stat = await fs.stat(skillPath).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const skillFile = join(skillPath, "SKILL.md");
    const text = await readFileSafe(skillFile);
    if (text == null) continue;
    const fm = parseFrontmatter(text);
    out.push({
      name: fm.name ?? entry,
      description: fm.description ?? "",
      argument_hint: fm["argument-hint"],
      source: root.source,
      path: skillFile,
    });
  }
  return out;
}

// Lightweight "best-effort" descriptions for the well-known Claude Code
// built-ins. The SDK's init message lists which built-ins are runnable for the
// current install, but it doesn't carry descriptions — so we keep this small
// table to give the autocomplete dropdown useful hover text. Anything in the
// SDK list but missing here still shows up, just with no description.
const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  compact: "Compact conversation history to free up context window",
  clear: "Clear the conversation",
  context: "Show context window usage",
  init: "Initialize a new CLAUDE.md from the current codebase",
  usage: "Show token usage and cost for this session",
  "extra-usage": "Show extended usage breakdown",
  insights: "Show session insights and analytics",
  "team-onboarding": "Show team onboarding guidance",
  debug: "Open the debug panel",
  batch: "Run multiple prompts in a batch",
  heapdump: "Dump heap snapshot for debugging",
};

let fsCache: { value: SlashCommand[]; ts: number } | null = null;
const FS_CACHE_MS = 5_000;

let sdkNamesCache: { value: string[]; ts: number } | null = null;
const SDK_CACHE_MS = 5 * 60_000;

async function fsDiscover(): Promise<SlashCommand[]> {
  if (fsCache && Date.now() - fsCache.ts < FS_CACHE_MS) return fsCache.value;
  const all: SlashCommand[] = [];
  for (const root of ROOTS) {
    const cmds =
      root.layout === "commands"
        ? await discoverCommandsDir(root)
        : await discoverSkillsDir(root);
    all.push(...cmds);
  }
  const byName = new Map<string, SlashCommand>();
  for (const cmd of all) byName.set(cmd.name, cmd);
  const value = Array.from(byName.values());
  fsCache = { value, ts: Date.now() };
  return value;
}

// Boots a throwaway `query()` just long enough to read the system/init
// message, then aborts. The SDK reports every runnable slash command (skills,
// plugins, AND built-ins like /compact and /clear) on init, so this is the
// only place we can learn about built-ins — they don't live as files on disk.
async function probeSdkSlashCommands(): Promise<string[]> {
  if (sdkNamesCache && Date.now() - sdkNamesCache.ts < SDK_CACHE_MS) {
    return sdkNamesCache.value;
  }
  const localBin = join(homedir(), ".local", "bin", "claude");
  const pathToClaudeCodeExecutable =
    process.env.CLAUDE_CODE_EXECUTABLE && existsSync(process.env.CLAUDE_CODE_EXECUTABLE)
      ? process.env.CLAUDE_CODE_EXECUTABLE
      : existsSync(localBin)
        ? localBin
        : undefined;

  try {
    const q = query({
      prompt: "warmup",
      options: {
        maxTurns: 1,
        ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
      },
    });
    let names: string[] = [];
    for await (const msg of q) {
      const m = msg as { type: string; subtype?: string; slash_commands?: unknown };
      if (m.type === "system" && m.subtype === "init") {
        if (Array.isArray(m.slash_commands)) {
          names = m.slash_commands.filter((x): x is string => typeof x === "string");
        }
        // We have what we need; abort the query so it doesn't actually call
        // the model.
        const ctl = (q as unknown as { interrupt?: () => Promise<void> }).interrupt;
        if (typeof ctl === "function") {
          try {
            await ctl.call(q);
          } catch {
            // ignore
          }
        }
        break;
      }
    }
    sdkNamesCache = { value: names, ts: Date.now() };
    return names;
  } catch (err) {
    console.warn("[slash-commands] probeSdkSlashCommands failed:", err);
    sdkNamesCache = { value: [], ts: Date.now() };
    return [];
  }
}

export async function discoverSlashCommands(): Promise<SlashCommand[]> {
  const [fsCmds, sdkNames] = await Promise.all([fsDiscover(), probeSdkSlashCommands()]);
  const byName = new Map<string, SlashCommand>();
  for (const cmd of fsCmds) byName.set(cmd.name, cmd);
  // Augment with SDK-only names — these are typically built-ins (/compact,
  // /clear, /context) and plugin commands that don't have a SKILL.md on disk.
  for (const name of sdkNames) {
    if (byName.has(name)) continue;
    byName.set(name, {
      name,
      description: BUILTIN_DESCRIPTIONS[name] ?? "",
      source: "builtin",
      path: "",
    });
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSdkSlashCommandNames(): Promise<string[]> {
  return probeSdkSlashCommands();
}
