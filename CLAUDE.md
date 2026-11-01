# opencode-navigator

Plan here, delegate coding to cheaper models through opencode via the `opencode` MCP server (`server.mjs`).
You are the user's interface: opencode never talks to the user directly. Everything it needs (approvals, questions) comes back to you.

## Always delegate through the `opencode-worker` subagent
Implementation work goes to the `opencode-worker` subagent (`.claude/agents/opencode-worker.md`), not to the main conversation. Give it a self-contained brief plus model/cwd/worktree wishes; it runs and supervises the opencode job and returns a short summary. Spawn several in parallel for independent tasks (use `worktree: true` when they write).
The main conversation plans, reviews (`git diff`), and talks to the user.

## How approvals and questions reach the user
- **Native dialogs (preferred):** if the client supports MCP elicitation, `check`/`check_all` put each opencode permission request and question to the user as a dialog automatically. Check with `bridge_info`; switch with `set_approval_ui` (`elicit` | `relay`) if dialogs don't show up.
- **Claude Code approval prompt (fallback):** otherwise requests come back as `pending`. Approving is done with `approve(...)`, which always triggers Claude Code's own permission prompt showing the exact action and resources (the call fails if they don't match the real request). A denied prompt = `reject`.
- **Questions in fallback mode:** subagents cannot ask the user. The worker reports `BLOCKED` with the question; the main conversation asks the user (AskUserQuestion) and calls `answer(job, form_id, answers)` keyed by field key (`cancel: true` dismisses), then resumes the worker with SendMessage.
- **Remembered permissions:** answering `always` saves a rule per project (e.g. `edit *`), after which matching requests are never asked about. `list_saved_permissions` shows them; `revoke_permission` removes one (Claude Code shows the user an approval prompt). If a job edits files without asking, check this first.
- Never approve or answer on the user's behalf.

## Workflow (tools)
1. `list_models` (filter e.g. `free`) / `set_default_model`; `model` on `run` overrides per job (`provider/model[#variant]`). `list_agents` shows opencode agents.
2. `run` -> job id at once. `check` / `check_all(wait_seconds)` follow progress and show an `activity` feed. `tail -f ~/.opencode-navigator/logs/<job>.log` in a terminal watches a job live.
3. `diff(job)`, then review with `git diff`. `send_message` steers or continues, `cancel` stops.

## Parallel jobs
- Use `worktree: true` for every job that writes while other jobs run. Each gets its own branch `oc/<job>` in `~/.opencode-navigator/worktrees/`.
- After reviewing the diff and with the user's OK: `worktree_finish(job, merge|discard|keep)`. Merge refuses on a dirty main repo or conflicts and keeps the branch.
- At most 4 jobs run at once (`OPENCODE_NAVIGATOR_MAX_JOBS`). Free models get rate-limited.
- opencode can spawn its own subagents inside a job (`subagents` in the status). Their approvals and questions are handled like the job's own.

## Modes
- `ask` (default): reads, questions and subagent spawning are allowed; edits and commands need approval; destructive shell denied.
- `auto`: everything allowed except the deny list. Only in a git repo or worktree.
- `readonly`: exploration only.

Free models may log prompts; keep secrets out of briefs. Jobs live only while the MCP server process runs.

## Testing
`node test/client.mjs <tool> '<json>'` (single tool), `test/e2e.mjs` (approval round trip), `test/parallel.mjs` (two worktree jobs, merge), `test/interact.mjs` (questions and subagents), `test/dialog.mjs` (simulated native dialogs).
