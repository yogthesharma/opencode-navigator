// Creates a saved "always" permission in a throwaway repo, lists it, rejects a mismatched revoke, revokes it for real.
// Usage: node test/saved.mjs <repo> <model>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [repo, model] = process.argv.slice(2);
const c = new Client({ name: "saved", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["server.mjs"] }));
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args });
  return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
};
const j = await call("run", { prompt: "Create hello.txt containing OK, then reply DONE.", model, cwd: repo });
for (let i = 0; i < 20; i++) {
  const s = await call("check_all", { wait_seconds: 15 });
  for (const p of s.pending ?? []) if (p.kind === "permission") await call("approve", { job: p.job, request_id: p.request_id, scope: "always", action: p.action, resources: p.resources });
  if (s.summary.running === 0 && !(s.pending ?? []).length) break;
}
const l1 = await call("list_saved_permissions", { directory: repo });
console.log("LIST", JSON.stringify(l1.saved));
const rule = l1.saved[0];
console.log("MISMATCH", JSON.stringify(await call("revoke_permission", { id: rule.id, directory: repo, action: "shell", resource: "nope" })));
console.log("REVOKE", JSON.stringify(await call("revoke_permission", { id: rule.id, directory: repo, action: rule.action, resource: rule.resource })));
console.log("LIST AFTER", JSON.stringify((await call("list_saved_permissions", { directory: repo })).saved));
await c.close();
