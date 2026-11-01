// Two parallel worktree jobs on different models; auto-approve permissions; merge both.
// Usage: node test/parallel.mjs <repo> <modelA> <modelB>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [repo, modelA, modelB] = process.argv.slice(2);
const c = new Client({ name: "par", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["server.mjs"] }));
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};
const a = await call("run", { prompt: "Create a.txt containing exactly the word ALPHA, then reply DONE.", model: modelA, cwd: repo, worktree: true, label: "A" });
const b = await call("run", { prompt: "Create b.txt containing exactly the word BETA, then reply DONE.", model: modelB, cwd: repo, worktree: true, label: "B" });
console.log("STARTED", a.job, a.worktree?.branch, "|", b.job, b.worktree?.branch);
for (let i = 0; i < 40; i++) {
  const s = await call("check_all", { wait_seconds: 20 });
  console.log("SUMMARY", JSON.stringify(s.summary), "pending:", s.pending.map((p) => `${p.label}:${p.kind}:${p.action ?? p.title}`).join(","));
  for (const p of s.pending) if (p.kind === "permission") await call("approve", { job: p.job, request_id: p.request_id, scope: "once", action: p.action, resources: p.resources });
  if (s.summary.running === 0 && s.pending.length === 0) break;
}
for (const j of [a, b]) {
  const r = await call("check", { job: j.job });
  console.log("RESULT", j.job, r.status, JSON.stringify(r.result), "cost", r.cost);
  console.log("MERGE", JSON.stringify(await call("worktree_finish", { job: j.job, action: "merge" }).catch((e) => e.message)));
}
await c.close();
