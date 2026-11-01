# opencode-navigator

Plan here, delegate coding to cheaper models through opencode via the `opencode` MCP server (`server.mjs`).
You are the user's interface: opencode never talks to the user directly. Everything it needs (approvals, questions) comes back to you.

## Workflow
1. `list_models` (filter e.g. `free`) / `set_default_model`. Pass `model` to `run` to override per job. Format: `provider/model[#variant]`. `list_agents` shows opencode agents (`agent` param).
2. `run` with a self-contained brief (goal, files, constraints, done criteria). Returns a job id at once. Start several jobs in parallel for independent work, each with a short `label` and its own model if useful.
3. Poll with `check_all(wait_seconds: 20)` (all jobs; returns as soon as any needs attention) or `check(job, wait_seconds)`.
4. Act on `pending` items. Never decide for the user:
   - `kind: "permission"` -> show action + resources (and whether `from_subagent`), ask the user, then `reply(job, request_id, once|always|reject)`.
   - `kind: "question"` -> relay `title` and each field (with options) to the user, then `answer(job, form_id, answers)` keyed by field key. `cancel: true` dismisses it.
   - Batch several pending items into one message to the user when they arise together.
5. When `done`: `check(job)` for the result, `diff(job)` for changes, review with `git diff`.
6. `send_message` steers or continues a job, `cancel` stops it.

## Parallel jobs
- Use `worktree: true` for every job that writes while other jobs run. Each gets its own branch `oc/<job>` in `~/.opencode-navigator/worktrees/`.
- After reviewing the diff and with the user's OK: `worktree_finish(job, merge|discard|keep)`. Merge refuses on a dirty main repo or conflicts and keeps the branch.
- At most 4 jobs run at once (`OPENCODE_NAVIGATOR_MAX_JOBS`). Free models get rate-limited.
- opencode can spawn its own subagents inside a job (`subagents` in the status). Their approvals and questions appear on the parent job.

## Modes
- `ask` (default): reads, questions and subagent spawning are allowed; edits and commands need approval; destructive shell denied.
- `auto`: everything allowed except the deny list. Only in a git repo or worktree.
- `readonly`: exploration only.

Free models may log prompts; keep secrets out of briefs. Jobs live only while the MCP server process runs.

## Testing
`node test/client.mjs <tool> '<json>'` (single tool), `test/e2e.mjs` (approval round trip), `test/parallel.mjs` (two worktree jobs, merge), `test/interact.mjs` (questions and subagents).
