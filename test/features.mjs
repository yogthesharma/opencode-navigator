// Exercises: routing, scope limits, auto verify, auto review, compact results, usage, secrets check, persistence.
// Usage: node test/features.mjs <repo>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [repo] = process.argv.slice(2);
const open = async () => {
  const c = new Client({ name: "feat", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["server.mjs"] }));
  const call = async (name, args) => {
    const r = await c.callTool({ name, arguments: args });
    const t = r.content[0].text;
    if (r.isError) return { error: t };
    try { return JSON.parse(t); } catch { return t; }
  };
  return { c, call };
};
const show = (label, v, n = 700) => console.log(`\n## ${label}\n${(typeof v === "string" ? v : JSON.stringify(v)).slice(0, n)}`);
async function waitDone(call, job) {
  for (let i = 0; i < 40; i++) {
    const s = await call("check", { job, wait_seconds: 20 });
    if (["done", "failed", "cancelled"].includes(s.status)) return s;
    if (s.status.startsWith("needs_")) show("UNEXPECTED PENDING", s.pending);
  }
}
let { c, call } = await open();
show("set_routing", await call("set_routing", { task_type: "implement", model: "opencode/deepseek-v4.1-flash-free" }));
await call("set_routing", { task_type: "review", model: "openrouter/cohere/north-mini-code:free" });
const j1 = await call("run", {
  prompt: "Add a subtract(a, b) function to calc.py (returns a - b). Also create a file notes.txt containing hello. Reply when done.",
  task_type: "implement", cwd: repo, mode: "auto", worktree: true, verify: true, review: true,
  allowed_paths: ["calc.py", "check.py"], max_cost: 0.5, label: "feature-test",
});
show("run", j1);
const d1 = await waitDone(call, j1.job);
show("check (compact result)", { status: d1.status, model: d1.model, result: d1.result, report: d1.report, files: d1.files, scope_violations: d1.scope_violations, verify: d1.verify, review_job: d1.review_job, result_file: d1.result_file }, 1500);
show("diff (compact)", await call("diff", { job: j1.job }));
if (d1.verify) show("verify()", await call("verify", { job: j1.job, wait_seconds: 60 }), 500);
if (d1.review_job || j1.job) {
  const rj = (await call("check", { job: j1.job })).review_job;
  if (rj) { const r = await waitDone(call, rj); show("review job result", { status: r.status, model: r.model, result: r.result }, 900); }
}
show("usage", await call("usage", {}), 900);
// secrets check
const j2 = await call("run", { prompt: "Create config.txt containing exactly this single line: api_key = 'abcdefghijklmnopqrstuvwxyz123456'", model: "opencode/deepseek-v4.1-flash-free", cwd: repo, mode: "auto", worktree: true, report: false, label: "secret-test" });
await waitDone(call, j2.job);
show("merge with secret", await call("worktree_finish", { job: j2.job, action: "merge" }), 500);
show("discard secret job", await call("worktree_finish", { job: j2.job, action: "discard" }));
// merge verified job
show("merge job1", await call("worktree_finish", { job: j1.job, action: "merge" }), 500);
await c.close();
// persistence: new bridge process
({ c, call } = await open());
const all = await call("check_all", { include_old: true });
show("after restart: check_all", { summary: all.summary, jobs: all.jobs.map((j) => `${j.job}:${j.status}:${j.label}`) }, 600);
show("stale worktrees", await call("list_stale_worktrees", { older_than_hours: 0 }), 600);
await c.close();
