// Default mode: auto applies in git repos without prompts, falls back to ask outside git. Usage: node test/modes.mjs <gitdir> <nogitdir>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [git, nogit] = process.argv.slice(2);
const c = new Client({ name: "modes", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["server.mjs"] }));
const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); const t = r.content[0].text; if (r.isError) return { error: t }; try { return JSON.parse(t); } catch { return t; } };
const model = "opencode/deepseek-v4.1-flash-free";
console.log("set_default_mode", JSON.stringify(await call("set_default_mode", { mode: "auto" })));
const a = await call("run", { prompt: "Create a.txt containing OK, edit README.md to add a line, then reply DONE.", model, cwd: git, report: false });
console.log("git repo job mode:", a.mode, a.note ?? "");
let sawPrompt = false;
for (let i = 0; i < 20; i++) { const s = await call("check", { job: a.job, wait_seconds: 20 }); if (s.status.startsWith("needs_")) { sawPrompt = true; console.log("UNEXPECTED prompt", JSON.stringify(s.pending)); break; } if (["done","failed","cancelled"].includes(s.status)) { console.log("status", s.status, "files", JSON.stringify((s.files ?? []).map((f) => f.file)), "error", s.error ?? ""); break; } }
console.log("prompted?", sawPrompt);
const b = await call("run", { prompt: "Create b.txt containing OK.", model, cwd: nogit, report: false });
console.log("non-git job mode:", b.mode, "|", b.note);
await call("cancel", { job: b.job });
console.log("explicit override:", (await call("run", { prompt: "noop", model, cwd: git, mode: "readonly", report: false })).mode);
await c.close();
