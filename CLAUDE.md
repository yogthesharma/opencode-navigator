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
1. Models: `list_models` (filter e.g. `free`), `set_default_model`, and `set_routing(task_type, model)` so `run(task_type: "explore" | "implement" | "hard" | ...)` picks a model; `review` is the reviewer's key. An explicit `model` always wins.
2. `run` -> job id at once. Useful options: `worktree`, `allowed_paths` (edits elsewhere are denied), `max_cost` (USD cap, the job is stopped when exceeded), `verify: true`, `review: true`, `label`.
3. `check` / `check_all(wait_seconds)` follow progress. Results are compact on purpose: `result` (short), `report` (files_changed / tests / open_issues / assumptions), `files`, `verify`, `review_job`. Full text and patches are in `result_file` / `patch_file`: read them only when something is unclear.
4. `diff(job)` lists changed files with +/- counts; `diff(job, file)` shows one file's patch. `verify(job)` runs the project's test command; failures can go back to the job with `send_message`. `review(job, model?)` has another model review the diff (findings + VERDICT).
5. Before merging: show the user the file list, report and verify/review outcome, then `worktree_finish(job, merge)` (refuses on failed verify, secret-looking strings, conflicts, dirty repo; `force` overrides after the user agrees).
6. `usage` shows cost per model. `list_stale_worktrees` / `remove_worktrees` clean up leftovers. `tail -f ~/.opencode-navigator/logs/<job>.log` watches a job live. Jobs survive restarts (`~/.opencode-navigator/jobs.json`); macOS notifications fire when jobs finish or need you (`set_notifications`).

## Project setup for verify
Create `.opencode-navigator.json` in the repo root (see `.opencode-navigator.example.json`), e.g. `{"verify": "npm test"}`. It is read from the original repo when a job starts, never from the job's worktree.

## Parallel jobs
- Use `worktree: true` for every job that writes while other jobs run. Each gets its own branch `oc/<job>` in `~/.opencode-navigator/worktrees/`.
- After reviewing the diff and with the user's OK: `worktree_finish(job, merge|discard|keep)`. Merge refuses on a dirty main repo or conflicts and keeps the branch.
- At most 4 jobs run at once (`OPENCODE_NAVIGATOR_MAX_JOBS`). Free models get rate-limited.
- opencode can spawn its own subagents inside a job (`subagents` in the status). Their approvals and questions are handled like the job's own.

## Modes
The default mode is saved (`set_default_mode`, shown in `bridge_info`); an explicit `mode` on `run` always wins. Currently the default is `auto`, so jobs in git repos run without per-file prompts. Non-git folders fall back to `ask`, because edits there can't be undone.
- `ask`: reads, questions and subagent spawning are allowed; edits and commands need approval; destructive shell denied.
- `auto`: everything allowed except the destructive deny list (rm -r, sudo, git push, git reset --hard, git clean, curl | sh, dd, mkfs, chmod/chown -R).
- `readonly`: exploration only.
In `auto` the safety net is git: use `worktree: true` for isolation and review `diff` / `git diff` before merging or committing.

Free models may log prompts; keep secrets out of briefs. Jobs live only while the MCP server process runs.

## Testing
`node test/client.mjs <tool> '<json>'` (single tool), `test/e2e.mjs` (approval round trip), `test/parallel.mjs` (two worktree jobs, merge), `test/interact.mjs` (questions and subagents), `test/dialog.mjs` (simulated native dialogs), `test/features.mjs` (routing, scope, verify, review, secrets, persistence), `test/saved.mjs` (saved permissions).
