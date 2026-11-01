# opencode-navigator

Plan here, delegate coding to cheaper models through opencode via the `opencode` MCP server (`server.mjs`).

## Delegating
1. `list_models` (filter e.g. `free`) / `set_default_model` to pick the model. Pass `model` to `run` to override per task. Format: `provider/model[#variant]`.
2. `run` with a self-contained brief (goal, files, constraints, done criteria). It returns a job id immediately.
3. `check(job, wait_seconds)` until `done`/`failed`.
4. If `needs_permission`: show the user the `pending_permissions` (action + resources) and call `reply` only with their decision (`once` / `always` / `reject`). Never approve on your own.
5. Review with `diff(job)` and `git diff` before accepting. Use `cancel` to stop.

## Modes
- `ask` (default): reads allowed, edits and commands need the user's approval, destructive shell commands denied.
- `auto`: everything allowed except the deny list. Only in a git repo or worktree.
- `readonly`: exploration only.

Don't run two writing jobs in the same directory at once; use separate git worktrees.
Free models can be rate-limited and may log prompts; keep secrets out of briefs.

## Testing
`node test/client.mjs <tool> '<json>'` calls one tool. `node test/e2e.mjs <model> <dir> [mode] [decision]` runs a full permission round trip.
