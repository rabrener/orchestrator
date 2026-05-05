# orchestrator-ui

A local web UI for driving multiple Claude Code agents against the repos in a workspace. Each todo gets its own session, transcript, and working directory; one browser window babysits them all.

## Requirements

- Node.js ≥ 20
- The [`claude` CLI](https://docs.claude.com/en/docs/claude-code) on your `PATH` (or installed at `~/.local/bin/claude`)
- _(Optional)_ The [`codex` CLI](https://github.com/openai/codex) if you want the in-app diff review button

## Installation

```bash
git clone https://github.com/rabrener/orchestrator.git
cd orchestrator
npm install
npm --prefix web install
```

## Running

```bash
npm run dev
```

This starts the Fastify server on `http://127.0.0.1:7777` and the Vite dev server for the React frontend (printed in the terminal — usually `http://localhost:5173`). Open the Vite URL in your browser.

To build the frontend for production and serve the API standalone:

```bash
npm --prefix web run build
npm start
```

## Claude Code auth

Sessions are spawned through the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), which shells out to your local `claude` CLI. Authentication is whatever that CLI is using.

```bash
# install the CLI (one-time)
npm install -g @anthropic-ai/claude-code

# authenticate via Claude.ai subscription (OAuth, opens a browser)
claude login
```

Once `claude` works in your terminal, the orchestrator will pick it up automatically. The server **unsets `ANTHROPIC_API_KEY` at startup** to make sure subagents use your subscription rather than silently falling back to API billing — if you'd rather pay per-token, comment that block out in `server/index.ts`.

## Codex auth (optional)

The chat panel has a `codex review` button that runs OpenAI's Codex CLI against the diff in your active workspace. It's optional — the rest of the app works without it.

```bash
# install (Node ≥ 20)
npm install -g @openai/codex

# authenticate (opens browser for OAuth)
codex login
```

Or skip `codex login` and `export OPENAI_API_KEY=...` in the same shell that launched `npm run dev`. The app shows the same instructions in-app under the **codex: setup** chip when the CLI isn't detected.

## Configuration

| Env var                       | Default                              | Purpose                                                                  |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| `PORT`                        | `7777`                               | Fastify server port                                                      |
| `ORCHESTRATOR_WORKSPACE_ROOT` | grandparent of `cwd`                 | Directory whose immediate children are the repos sessions can `cd` into  |
| `XDG_CONFIG_HOME`             | `~/.config`                          | Where preferences are stored (`<config>/orchestrator-ui/preferences.json`) |

Per-todo state (transcripts, sessions, archived days) lives at `~/.orchestrator-ui/`.

## License

[MIT](./LICENSE)
