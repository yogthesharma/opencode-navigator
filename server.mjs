#!/usr/bin/env node
// MCP bridge: lets Claude delegate coding tasks to opencode with any model,
// and answer opencode's permission requests through normal tool calls.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(HERE, ".opencode-navigator", "state.json");
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";
const MAX_TEXT = 20000;

// ---------- state (default model) ----------
async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
async function writeState(patch) {
  const next = { ...(await readState()), ...patch };
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

// ---------- opencode server lifecycle ----------
let serverPromise = null;
let serverProc = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function ensureServer() {
  if (serverPromise) return serverPromise;
  serverPromise = (async () => {
    const port = await freePort();
    const password = randomBytes(18).toString("hex");
    serverProc = spawn(
      OPENCODE_BIN,
      ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    serverProc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    serverProc.on("exit", () => {
      serverPromise = null;
      serverProc = null;
    });
    const base = `http://127.0.0.1:${port}`;
    const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${base}/api/model/default`, { headers: { authorization: auth } });
        if (r.status < 500) return { base, auth };
      } catch {}
      if (!serverProc) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`opencode serve did not start. ${stderr}`);
  })();
  try {
    return await serverPromise;
  } catch (e) {
    serverPromise = null;
    throw e;
  }
}

function shutdown() {
  if (serverProc) serverProc.kill();
}
process.on("exit", shutdown);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

async function api(method, route, { body, query, directory } = {}) {
  const { base, auth } = await ensureServer();
  const url = new URL(base + route);
  for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
  const headers = { authorization: auth };
  if (directory) headers["x-opencode-directory"] = directory;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw new Error(`opencode ${method} ${route} -> ${res.status}: ${text.slice(0, 500)}`);
  return json;
}

// ---------- models ----------
// "openrouter/deepseek/deepseek-v4.1-flash#high" -> provider "openrouter", id "deepseek/...", variant "high"
function parseModel(spec) {
  const [main, variant] = spec.split("#");
  const i = main.indexOf("/");
  if (i < 1) throw new Error(`Model must look like provider/model, got "${spec}"`);
  const m = { providerID: main.slice(0, i), id: main.slice(i + 1) };
  if (variant) m.variant = variant;
  return m;
}

async function listModels() {
  const r = await api("GET", "/api/model");
  const rows = Array.isArray(r?.data) ? r.data : [];
  return rows.map((m) => `${m.providerID}/${m.modelID ?? m.id}`).sort();
}

// ---------- permission modes ----------
// ask: reads allowed, destructive shell denied, everything else asks (Claude relays to you).
// auto: everything allowed except the destructive deny list.
const DENY_SHELL = ["rm -rf *", "rm -r *", "sudo *", "git push *", "git reset --hard*", "git clean *", "curl * | *", "dd *", "mkfs*", "chmod -R *", "chown -R *"];
function rulesFor(mode) {
  const deny = DENY_SHELL.map((resource) => ({ action: "shell", resource, effect: "deny" }));
  if (mode === "auto") return [{ action: "*", resource: "*", effect: "allow" }, ...deny];
  if (mode === "readonly")
    return [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
    ];
  return [{ action: "*", resource: "*", effect: "ask" }, { action: "read", resource: "*", effect: "allow" }, { action: "glob", resource: "*", effect: "allow" }, { action: "grep", resource: "*", effect: "allow" }, ...deny];
}

// ---------- jobs ----------
const jobs = new Map(); // jobId -> { sessionID, directory, model, mode, startedAt, promptDone, promptError }

function newJobId() {
  return "job_" + randomBytes(4).toString("hex");
}

function getJob(id) {
  const j = jobs.get(id);
  if (!j) throw new Error(`Unknown job "${id}". Jobs live only while this bridge process runs.`);
  return j;
}

function collectText(node, out = []) {
  if (node == null) return out;
  if (typeof node === "string") return out;
  if (Array.isArray(node)) {
    node.forEach((n) => collectText(n, out));
    return out;
  }
  if (typeof node === "object") {
    if ((node.type === "text" || node.type === "reasoning-text") && typeof node.text === "string" && node.type === "text") out.push(node.text);
    for (const [k, v] of Object.entries(node)) if (k !== "text") collectText(v, out);
  }
  return out;
}

async function lastAssistantText(job) {
  const r = await api("GET", `/api/session/${job.sessionID}/message`, { query: { order: "desc", limit: 20, type: "assistant" }, directory: job.directory });
  const msgs = Array.isArray(r?.data) ? r.data : [];
  for (const m of msgs) {
    const t = collectText(m.payload ?? m).join("\n").trim();
    if (t) return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + "\n…[truncated]" : t;
  }
  return "";
}

async function jobSnapshot(id) {
  const job = getJob(id);
  const [active, perms, sess] = await Promise.all([
    api("GET", "/api/session/active", { directory: job.directory }),
    api("GET", `/api/session/${job.sessionID}/permission`, { directory: job.directory }),
    api("GET", `/api/session/${job.sessionID}`, { directory: job.directory }),
  ]);
  const running = Boolean(active?.data?.[job.sessionID]);
  const pending = (perms?.data ?? []).map((p) => ({
    request_id: p.id,
    action: p.action,
    resources: p.resources,
    message: p.message,
  }));
  const info = sess?.data ?? {};
  let status;
  if (job.promptError) status = "failed";
  else if (pending.length) status = "needs_permission";
  else if (running || !job.promptDone) status = "running";
  else status = info.outcome === "failed" ? "failed" : info.outcome === "interrupted" ? "cancelled" : "done";
  const snap = {
    job: id,
    status,
    model: job.modelLabel,
    mode: job.mode,
    directory: job.directory,
    elapsed_s: Math.round((Date.now() - job.startedAt) / 1000),
    cost: info.cost,
    tokens: info.tokens,
  };
  if (pending.length) snap.pending_permissions = pending;
  if (job.promptError) snap.error = job.promptError;
  if (status === "done" || status === "failed" || status === "cancelled") snap.result = await lastAssistantText(job);
  return snap;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asText = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const asError = (e) => ({ isError: true, content: [{ type: "text", text: String(e?.message ?? e) }] });
const tool = (fn) => async (args) => {
  try {
    return asText(await fn(args));
  } catch (e) {
    return asError(e);
  }
};

// ---------- MCP server ----------
const mcp = new McpServer({ name: "opencode-navigator", version: "0.1.0" });

mcp.registerTool(
  "list_models",
  {
    description: "List models opencode can use, as provider/model. Optional case-insensitive substring filter, e.g. 'free' or 'deepseek'.",
    inputSchema: { filter: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
  },
  tool(async ({ filter, limit }) => {
    let all = await listModels();
    if (filter) all = all.filter((m) => m.toLowerCase().includes(filter.toLowerCase()));
    return { count: all.length, models: all.slice(0, limit ?? 100) };
  }),
);

mcp.registerTool(
  "get_default_model",
  { description: "Show the model used when run() is called without a model.", inputSchema: {} },
  tool(async () => {
    const s = await readState();
    return { default_model: s.defaultModel ?? null, note: s.defaultModel ? undefined : "No default set; opencode's own default applies." };
  }),
);

mcp.registerTool(
  "set_default_model",
  {
    description: "Set the default model (provider/model, optional #variant). It is validated against list_models.",
    inputSchema: { model: z.string() },
  },
  tool(async ({ model }) => {
    parseModel(model);
    const known = await listModels();
    if (!known.includes(model.split("#")[0])) throw new Error(`"${model}" is not in opencode's model list. Use list_models to find the exact name.`);
    await writeState({ defaultModel: model });
    return { default_model: model };
  }),
);

mcp.registerTool(
  "run",
  {
    description:
      "Start an opencode coding task in the background and return a job id immediately. Then poll with check(). " +
      "mode: 'ask' (default; opencode asks before edits/commands and you relay the question to the user), " +
      "'auto' (everything allowed except a destructive-command deny list; use only in a git repo/worktree), " +
      "'readonly' (reads only).",
    inputSchema: {
      prompt: z.string().min(1),
      model: z.string().optional().describe("provider/model[#variant]; defaults to get_default_model"),
      cwd: z.string().optional().describe("Absolute project directory; defaults to the bridge's working directory"),
      mode: z.enum(["ask", "auto", "readonly"]).optional(),
    },
  },
  tool(async ({ prompt, model, cwd, mode }) => {
    const state = await readState();
    const modelLabel = model ?? state.defaultModel ?? null;
    const directory = path.resolve(cwd ?? process.cwd());
    await fs.access(directory);
    const useMode = mode ?? "ask";
    const body = { location: { directory }, permissions: rulesFor(useMode) };
    if (modelLabel) body.model = parseModel(modelLabel);
    const created = await api("POST", "/api/session", { body, directory });
    const sessionID = created?.data?.id;
    if (!sessionID) throw new Error("opencode did not return a session id");
    const jobId = newJobId();
    const job = { sessionID, directory, modelLabel: modelLabel ?? "(opencode default)", mode: useMode, startedAt: Date.now(), promptDone: false };
    jobs.set(jobId, job);
    // Fire the prompt; it may block until the run ends, so don't await it.
    api("POST", `/api/session/${sessionID}/prompt`, { body: { text: prompt }, directory })
      .then(() => (job.promptDone = true))
      .catch((e) => {
        job.promptDone = true;
        job.promptError = String(e.message ?? e);
      });
    return { job: jobId, status: "running", model: job.modelLabel, mode: useMode, directory, next: "Call check(job, wait_seconds) to follow progress." };
  }),
);

mcp.registerTool(
  "check",
  {
    description:
      "Get a job's status: running | needs_permission | done | failed | cancelled. Waits up to wait_seconds (max 120) for a change. " +
      "On needs_permission, show the user pending_permissions and call reply().",
    inputSchema: { job: z.string(), wait_seconds: z.number().int().min(0).max(120).optional() },
  },
  tool(async ({ job, wait_seconds }) => {
    const deadline = Date.now() + (wait_seconds ?? 0) * 1000;
    for (;;) {
      const snap = await jobSnapshot(job);
      if (snap.status !== "running" || Date.now() >= deadline) return snap;
      await sleep(1500);
    }
  }),
);

mcp.registerTool(
  "reply",
  {
    description: "Answer an opencode permission request: once (this time), always (remember), or reject. Only call this with the user's decision.",
    inputSchema: {
      job: z.string(),
      request_id: z.string(),
      decision: z.enum(["once", "always", "reject"]),
      message: z.string().optional().describe("Optional note shown to the model, e.g. why it was rejected"),
    },
  },
  tool(async ({ job, request_id, decision, message }) => {
    const j = getJob(job);
    await api("POST", `/api/session/${j.sessionID}/permission/${request_id}/reply`, { body: { decision, message: message ?? null }, directory: j.directory });
    return { ok: true, request_id, decision };
  }),
);

mcp.registerTool(
  "cancel",
  { description: "Interrupt a running job.", inputSchema: { job: z.string() } },
  tool(async ({ job }) => {
    const j = getJob(job);
    await api("POST", `/api/session/${j.sessionID}/interrupt`, { directory: j.directory });
    return { ok: true, job };
  }),
);

mcp.registerTool(
  "diff",
  { description: "Show the file changes opencode made in a job's session.", inputSchema: { job: z.string() } },
  tool(async ({ job }) => {
    const j = getJob(job);
    const r = await api("GET", `/api/session/${j.sessionID}/diff`, { directory: j.directory });
    const s = JSON.stringify(r?.data ?? r, null, 2);
    return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "\n…[truncated]" : s;
  }),
);

await mcp.connect(new StdioServerTransport());
