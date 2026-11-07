// Offline checks: every tool declares all four annotation hints, and the tools that need no job can be called.
// Usage: node test/tools.mjs   (settings it touches are restored)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "claude-code", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["server.mjs"] }));
const fail = [];
const check = (ok, msg) => { console.log(ok ? "ok  " : "FAIL", msg); if (!ok) fail.push(msg); };
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  let body = r.content[0].text;
  try { body = JSON.parse(body); } catch {}
  return { error: r.isError, body };
};

const { tools } = await c.listTools();
for (const t of tools) {
  const a = t.annotations ?? {};
  check(["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].every((k) => typeof a[k] === "boolean"), `annotations on ${t.name}`);
}

const models = await call("list_models", { filter: "free" });
check(!models.error, "list_models");
check(!(await call("list_agents")).error, "list_agents");
const def = await call("get_default_model");
check(!def.error, "get_default_model");

const info = (await call("bridge_info")).body;
if (def.body.default_model || def.body.defaultModel) {
  const m = def.body.default_model ?? def.body.defaultModel;
  check(!(await call("set_default_model", { model: m })).error, "set_default_model (unchanged value)");
}
check(!(await call("set_approval_ui", { mode: info.approvals === "elicit" ? "elicit" : "relay" })).error, "set_approval_ui (unchanged value)");
check(!(await call("set_notifications", { on: Boolean(info.notifications) })).error, "set_notifications (unchanged value)");
check((await call("send_message", { job: "job_missing", message: "x" })).error === true, "send_message rejects an unknown job");
const rw = await call("remove_worktrees", { paths: ["/nonexistent/path"] });
check(!rw.error && rw.body.removed.length === 0 && rw.body.skipped.length === 1, "remove_worktrees skips paths that are not job worktrees");

await c.close();

// gated tools refuse clients that are not known to prompt, unless the user opts in
const gated = async (clientName, env) => {
  const g = new Client({ name: clientName, version: "0" });
  await g.connect(new StdioClientTransport({ command: "node", args: ["server.mjs"], env: { ...process.env, ...env } }));
  const out = [];
  for (const [name, args] of [["approve", { job: "job_x", request_id: "r", scope: "once", action: "edit", resources: [] }], ["revoke_permission", { id: "psv_x", directory: ".", action: "edit", resource: "*" }], ["remove_worktrees", { paths: ["/nonexistent/path"] }]]) {
    const r = await g.callTool({ name, arguments: args });
    out.push(r.isError && /refused/.test(r.content[0].text));
  }
  await g.close();
  return out;
};
check((await gated("cursor", { OPENCODE_NAVIGATOR_TRUST_CLIENT: "" })).every(Boolean), "unknown client is refused on approve, revoke_permission and remove_worktrees");
check((await gated("cursor", { OPENCODE_NAVIGATOR_TRUST_CLIENT: "1" })).every((x) => !x), "opt-in env var lifts the refusal");
check((await gated("claude-code", { OPENCODE_NAVIGATOR_TRUST_CLIENT: "" })).every((x) => !x), "claude-code is trusted");

if (fail.length) { console.log(`\n${fail.length} failed`); process.exit(1); }
console.log("\nall passed");
