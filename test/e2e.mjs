// End-to-end: run -> wait for permission -> reply -> done -> diff. Usage: node test/e2e.mjs <model> <dir> [mode] [decision]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [model, cwd, mode = "ask", decision = "once"] = process.argv.slice(2);
const c = new Client({ name: "e2e", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["server.mjs"] }));
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content[0].text;
  if (r.isError) throw new Error(text);
  return JSON.parse(text);
};
const started = await call("run", { prompt: "Create a file hello.txt containing exactly the word OK, then reply DONE.", model, cwd, mode });
console.log("RUN", started);
for (let i = 0; i < 40; i++) {
  const s = await call("check", { job: started.job, wait_seconds: 15 });
  console.log("CHECK", JSON.stringify(s).slice(0, 700));
  if (s.status === "needs_permission") {
    for (const p of s.pending_permissions) console.log("REPLY", await call("reply", { job: started.job, request_id: p.request_id, decision }));
  } else if (s.status !== "running") break;
}
console.log("DIFF", (await call("diff", { job: started.job }).catch((e) => e.message)));
await c.close();
