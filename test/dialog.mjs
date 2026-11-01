// Simulates a client that supports MCP elicitation and "clicks" the dialogs.
// Usage: node test/dialog.mjs <repo> <model> "<prompt>" [permissionDecision]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const [repo, model, prompt, decision = "once"] = process.argv.slice(2);
const c = new Client({ name: "dlg", version: "0" }, { capabilities: { elicitation: {} } });
c.setRequestHandler(ElicitRequestSchema, async (req) => {
  const { message, requestedSchema } = req.params;
  console.log("DIALOG>>", JSON.stringify(message), "\n  schema:", JSON.stringify(requestedSchema));
  const content = {};
  for (const [k, v] of Object.entries(requestedSchema.properties)) {
    content[k] = k === "decision" ? decision : v.enum ? v.enum[0] : v.type === "boolean" ? true : "x";
  }
  const act = process.env.ELICIT_ACTION || "accept";
  console.log("  user action:", act, act === "accept" ? JSON.stringify(content) : "");
  return act === "accept" ? { action: "accept", content } : { action: act };
});
await c.connect(new StdioClientTransport({ command: "node", args: ["server.mjs"] }));
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};
console.log("INFO", JSON.stringify(await call("bridge_info", {})));
const j = await call("run", { prompt, model, cwd: repo, mode: "ask", worktree: process.env.WORKTREE === "1" });
for (let i = 0; i < 20; i++) {
  const s = await call("check", { job: j.job, wait_seconds: 30 });
  console.log("STATUS", s.status, "pending:", (s.pending ?? []).length, "activity:", JSON.stringify(s.activity));
  for (const p of s.pending ?? []) {
    if (p.kind === "permission") console.log("FALLBACK approve ->", JSON.stringify(await call("approve", { job: j.job, request_id: p.request_id, scope: "once", action: p.action, resources: p.resources })));
  }
  if (!["running", "needs_permission", "needs_answer"].includes(s.status)) {
    console.log("RESULT", JSON.stringify(s.result));
    break;
  }
}
await c.close();
