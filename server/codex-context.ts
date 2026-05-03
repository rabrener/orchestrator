import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ChatMessage } from "./types.js";

// Pin distillation to Haiku 4.5 — fast and cheap, and the task (summarize a
// chat into a 4-bullet brief) is well within its capability. Bumping to a
// bigger model would just add latency before the codex call starts.
const DISTILL_MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You produce review briefs for the Codex code-review CLI.

Given a developer's chat transcript with their AI coding agent, write a tight brief that frames a follow-up code review. The brief tells Codex *why* the change was made so it can review against the user's actual goal — not just the diff in isolation.

Output exactly four sections, each one short bullet list (or "(none)"). Use this format verbatim:

Goal:
- <one line: what the user was trying to achieve>

Decisions:
- <non-obvious choices made along the way that aren't visible in the diff>

Focus:
- <what the reviewer should scrutinize most carefully>

Out-of-scope:
- <known unrelated issues, deliberate omissions, or things not to flag>

Rules:
- Keep the whole brief under ~200 words.
- Only include facts grounded in the transcript or the todo title. If a section has nothing to say, write "- (none)".
- Do not invent acceptance criteria, tests, or file names that weren't discussed.
- Do not preface or follow with any other text. Output only the four sections.`;

// Bound transcript size so the distill call stays cheap and fast. The most
// recent turns carry the most relevant context; we drop older turns and skip
// tool I/O entirely (noisy JSON blobs that don't reflect intent).
const MAX_TURNS = 30;
const MAX_TEXT_PER_TURN = 1200;

function summarizeTranscript(messages: ChatMessage[]): string {
  const usable = messages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
  const recent = usable.slice(-MAX_TURNS);
  return recent
    .map((m) => {
      const text =
        m.text.length > MAX_TEXT_PER_TURN
          ? m.text.slice(0, MAX_TEXT_PER_TURN) + "…[truncated]"
          : m.text;
      return `[${m.role}] ${text}`;
    })
    .join("\n\n");
}

function fallbackBrief(todoTitle: string): string {
  return [
    "Goal:",
    `- ${todoTitle}`,
    "",
    "Decisions:",
    "- (none captured — distillation skipped)",
    "",
    "Focus:",
    "- (none)",
    "",
    "Out-of-scope:",
    "- (none)",
  ].join("\n");
}

function resolveClaudePath(): string | undefined {
  if (
    process.env.CLAUDE_CODE_EXECUTABLE &&
    existsSync(process.env.CLAUDE_CODE_EXECUTABLE)
  ) {
    return process.env.CLAUDE_CODE_EXECUTABLE;
  }
  const localBin = join(homedir(), ".local", "bin", "claude");
  return existsSync(localBin) ? localBin : undefined;
}

export async function distillContext(
  todoTitle: string,
  messages: ChatMessage[],
): Promise<{ brief: string; distilled: boolean; error: string | null }> {
  const transcript = summarizeTranscript(messages);
  if (!transcript.trim()) {
    return { brief: fallbackBrief(todoTitle), distilled: false, error: null };
  }

  const userPrompt = `Todo title: ${todoTitle}

Transcript (most recent turns):
${transcript}`;

  const claudePath = resolveClaudePath();

  try {
    const q = query({
      prompt: userPrompt,
      options: {
        model: DISTILL_MODEL,
        maxTurns: 1,
        tools: [],
        allowedTools: [],
        systemPrompt: SYSTEM_PROMPT,
        ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      },
    });

    let collected = "";
    for await (const msg of q) {
      const m = msg as {
        type: string;
        message?: { content?: unknown[] };
      };
      if (m.type !== "assistant") continue;
      const content = m.message?.content ?? [];
      for (const block of content) {
        const b = block as { type: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") {
          collected += b.text;
        }
      }
    }

    const trimmed = collected.trim();
    if (!trimmed) {
      return {
        brief: fallbackBrief(todoTitle),
        distilled: false,
        error: "empty distillation",
      };
    }
    return { brief: trimmed, distilled: true, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { brief: fallbackBrief(todoTitle), distilled: false, error: msg };
  }
}
