// Drives one job, auto-answering questions/permissions, and prints what the bridge surfaced.
// Usage: node test/interact.mjs <repo> <model> "<prompt>"
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [repo, model, prompt] = process.argv.slice(2);
const c = new Client({ name: "int", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["server.mjs"] }));
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};
const j = await call("run", { prompt, model, cwd: repo, mode: "ask" });
for (let i = 0; i < 30; i++) {
  const s = await call("check_all", { wait_seconds: 20 });
  const job = s.jobs[0];
  console.log("STATUS", job.status, "subagents:", JSON.stringify(job.subagents ?? []));
  for (const p of s.pending) {
    console.log("PENDING", JSON.stringify(p).slice(0, 600));
    if (p.kind === "permission") await call("approve", { job: p.job, request_id: p.request_id, scope: "once", action: p.action, resources: p.resources });
    else {
      const answers = {};
      for (const f of p.fields) answers[f.key] = f.options?.length ? f.options[0].value : f.type === "boolean" ? true : "blue";
      console.log("ANSWER", JSON.stringify(answers), JSON.stringify(await call("answer", { job: p.job, form_id: p.form_id, answers })));
    }
  }
  if (!s.pending.length && !["running"].includes(job.status)) break;
}
const r = await call("check", { job: j.job });
console.log("FINAL", r.status, JSON.stringify(r.result)?.slice(0, 400));
await c.close();
