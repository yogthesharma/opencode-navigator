# opencode-navigator

An MCP server that lets Claude Code plan while cheaper (or free) models do the coding through [opencode](https://opencode.ai). Claude stays the only interface: opencode's permission requests and questions come back to you inside Claude Code, and several jobs can run in parallel in separate git worktrees.

## Features
- Switch between any model opencode knows (OpenCode Zen, OpenRouter, and others) per job, with defaults and routing by task type (`explore`, `implement`, `hard`, `review`).
- Approvals and questions end to end: native dialogs where the client supports MCP elicitation, otherwise Claude Code's own approval prompt.
- Parallel jobs, each in its own worktree and branch (`oc/<job>`); merge only after you have seen the diff, with checks for failed verification, secret-looking strings and conflicts.
- Compact results for Claude's context: short summary, structured report, changed files; full text and patches stay in files.
- `verify` (your test command), automatic second-model `review`, `allowed_paths` scope limits, `max_cost` budget cap, cost ledger, macOS notifications.
- Jobs persist across restarts. Long jobs are fine: `check` waits up to 120 s per call and the `opencode-worker` subagent keeps polling until the job ends.

## Requirements
- Node 20 or newer
- [opencode](https://opencode.ai) installed and logged in (`opencode --version`)
- Claude Code (CLI or desktop Code tab)

## Install
```bash
git clone https://github.com/yogthesharma/opencode-navigator.git && cd opencode-navigator
npm install
```

Register it for all your projects:
```bash
claude mcp add --scope user opencode -- node "$(pwd)/server.mjs"
mkdir -p ~/.claude/agents && cp .claude/agents/opencode-worker.md ~/.claude/agents/
```
Or only for a project: the included `.mcp.json` does that when you open this folder. Then start a new session and check `/mcp`.

Optionally copy the delegation guidance from `CLAUDE.md` into `~/.claude/CLAUDE.md` so Claude delegates by default.

## Use
Ask Claude to delegate: "use the opencode-worker to add tests for X on a free model". Useful tools: `list_models`, `set_default_model`, `set_routing`, `run`, `check_all`, `diff`, `verify`, `review`, `worktree_finish`, `usage`.

For `verify`, add `.opencode-navigator.json` to your project (see `.opencode-navigator.example.json`):
```json
{ "verify": "npm test" }
```

## Modes
| Mode | Behaviour |
|---|---|
| `ask` | reads and questions allowed; edits and commands need your approval |
| `auto` | everything allowed except a destructive deny list (`rm -r`, `sudo`, `git push`, `git reset --hard`, `git clean`, `curl \| sh`, `dd`, `mkfs`, `chmod/chown -R`) |
| `readonly` | exploration only |

`auto` is the default in git repos (set with `set_default_mode`); folders that are not git repos fall back to `ask`. Use `worktree: true` so changes can be reviewed and discarded.

## Configuration
| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_BIN` | `opencode` | path to the opencode binary |
| `OPENCODE_NAVIGATOR_MAX_JOBS` | `4` | concurrent jobs |
| `OPENCODE_NAVIGATOR_APPROVALS` | `elicit` | `elicit` or `relay` |

State lives in `~/.opencode-navigator` (jobs, results, logs, worktrees, cost ledger) and `<project>/.opencode-navigator/state.json` (default model, routing, mode).

## Security notes
- The bridge starts its own `opencode serve` on `127.0.0.1` with a random password and stops it on exit.
- Free models may log prompts; keep secrets out of briefs.
- `approve` always goes through Claude Code's permission prompt and must echo the real action and resources.
- Worktree merges refuse on secret-looking strings; `force` is for use after you agree.

## Tests
Integration scripts in `test/` drive the server over stdio and need a working opencode: `node test/e2e.mjs`, `parallel.mjs`, `interact.mjs`, `dialog.mjs`, `features.mjs`, `saved.mjs`, `modes.mjs`. They call real models, so they can be slow or hit free-tier limits.

## License
MIT
