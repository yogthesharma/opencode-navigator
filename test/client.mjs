// Tiny MCP client for exercising server.mjs: node test/client.mjs <tool> '<json args>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [tool, args = "{}"] = process.argv.slice(2);
const t = new StdioClientTransport({ command: "node", args: ["server.mjs"] });
const c = new Client({ name: "test", version: "0" });
await c.connect(t);
if (!tool) console.log((await c.listTools()).tools.map((x) => x.name).join(", "));
else {
  const r = await c.callTool({ name: tool, arguments: JSON.parse(args) });
  console.log(r.isError ? "ERROR:" : "", r.content[0].text);
}
await c.close();
