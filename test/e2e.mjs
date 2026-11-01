// Relay path (client without dialogs): run -> pending -> approve/reject -> done -> diff.
// Usage: node test/e2e.mjs <model> <dir> [mode] [approve|reject|mismatch]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [model, cwd, mode = "ask", action = "approve"] = process.argv.slice(2);
const c = new Client({ name: "e2e", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["server.mjs"] }));
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) return { error: r.content[0].text };
  return JSON.parse(r.content[0].text);
};
console.log("INFO", JSON.stringify(await call("bridge_info", {})).slice(0, 200));
const started = await call("run", { prompt: "Create a file hello.txt containing exactly the word OK, then reply DONE.", model, cwd, mode });
let probed = false;
for (let i = 0; i < 40; i++) {
  const s = await call("check_all", { wait_seconds: 15 });
  console.log("SUMMARY", JSON.stringify(s.summary));
  for (const p of s.pending ?? []) {
    if (p.kind !== "permission") continue;
    if (action === "mismatch" && !probed) {
      probed = true;
      console.log("MISMATCH TRY ->", JSON.stringify(await call("approve", { job: p.job, request_id: p.request_id, scope: "once", action: p.action, resources: ["/etc/passwd"] })));
    }
    const out = action === "reject" ? await call("reject", { job: p.job, request_id: p.request_id }) : await call("approve", { job: p.job, request_id: p.request_id, scope: "once", action: p.action, resources: p.resources });
    console.log(action === "reject" ? "REJECT" : "APPROVE", p.action, JSON.stringify(p.resources), "->", JSON.stringify(out));
  }
  if (s.summary.running === 0 && !(s.pending ?? []).length) break;
}
console.log("DIFF", JSON.stringify(await call("diff", { job: started.job })).slice(0, 200));
await c.close();
