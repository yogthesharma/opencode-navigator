# Using opencode-navigator from an MCP client

The `opencode` MCP server delegates coding work to opencode (cheaper models). Use it for well-specified implementation, refactor, test-writing and exploration; plan and review yourself.

- Start a job with `run` (set `model` or `task_type`, a short `label`, `worktree: true` when jobs run in parallel, `verify: true` if the project has `.opencode-navigator.json`).
- Stay in the turn until the job ends: call `check(job, wait_seconds: 30)` (or `check_all(wait_seconds: 120)` for several jobs) in a loop until nothing is `running`. Long jobs are normal; do not report early.
- Never approve permissions or answer opencode's questions on the user's behalf. Pending ones are listed under `pending`; relay them to the user, then call `approve` / `reject` / `answer` with the user's decision. `approve` only works if the client prompts the user before each tool call (see README, "Other MCP clients").
- When a job is done, read the compact `result` and `report`, review `diff`, run `verify` / `review`, and show the user the file list before `worktree_finish(job, merge)`.
- Keep secrets out of briefs: free models may log prompts.

Full details: README.md and CLAUDE.md.
