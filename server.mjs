#!/usr/bin/env node
// MCP bridge: lets Claude delegate coding work to opencode (many parallel jobs, any model)
// and relay opencode's permission requests and questions to the user through normal tool calls.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(HERE, ".opencode-navigator", "state.json");
const WORKTREE_ROOT = path.join(os.homedir(), ".opencode-navigator", "worktrees");
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";
const MAX_RUNNING = Number(process.env.OPENCODE_NAVIGATOR_MAX_JOBS || 4);
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
    serverProc = spawn(OPENCODE_BIN, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ["ignore", "ignore", "pipe"],
    });
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
// ask: reads allowed, destructive shell denied, everything else asks (Claude relays to the user).
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
  // question/subagent are only routing; the edits and commands inside them still ask.
  return [{ action: "*", resource: "*", effect: "ask" }, ...["read", "glob", "grep", "question", "subagent"].map((action) => ({ action, resource: "*", effect: "allow" })), ...deny];
}

// ---------- git worktrees ----------
const git = (cwd, ...args) => execFileP("git", ["-C", cwd, ...args], { maxBuffer: 10 * 1024 * 1024 });

async function createWorktree(repoDir, jobId) {
  let top;
  try {
    top = (await git(repoDir, "rev-parse", "--show-toplevel")).stdout.trim();
    await git(top, "rev-parse", "--verify", "HEAD");
  } catch {
    throw new Error(`worktree needs ${repoDir} to be a git repo with at least one commit`);
  }
  const branch = `oc/${jobId}`;
  const dir = path.join(WORKTREE_ROOT, `${path.basename(top)}-${jobId}`);
  await fs.mkdir(WORKTREE_ROOT, { recursive: true });
  await git(top, "worktree", "add", "-b", branch, dir);
  // keep the same relative subdirectory if the job was started in a subfolder
  const rel = path.relative(top, repoDir);
  return { repo: top, branch, dir: rel && !rel.startsWith("..") ? path.join(dir, rel) : dir, root: dir };
}

// ---------- jobs ----------
// job: { id, sessionID, directory, modelLabel, mode, agent, startedAt, promptDone, promptError, worktree?, label }
const jobs = new Map();
const sessionRoot = new Map(); // sessionID -> job id (covers opencode's own subagent sessions)

const newJobId = () => "job_" + randomBytes(4).toString("hex");

function getJob(id) {
  const j = jobs.get(id);
  if (!j) throw new Error(`Unknown job "${id}". Jobs live only while this bridge process runs.`);
  return j;
}

function collectText(node, out = []) {
  if (node == null || typeof node === "string") return out;
  if (Array.isArray(node)) {
    node.forEach((n) => collectText(n, out));
    return out;
  }
  if (typeof node === "object") {
    if (node.type === "text" && typeof node.text === "string") out.push(node.text);
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

// Which of our jobs does this session belong to? Walks parentID (opencode subagents are child sessions).
async function jobIdForSession(sessionID, directory) {
  let sid = sessionID;
  const trail = [];
  for (let i = 0; i < 8 && sid; i++) {
    if (sessionRoot.has(sid)) {
      const id = sessionRoot.get(sid);
      for (const t of trail) sessionRoot.set(t, id);
      return id;
    }
    trail.push(sid);
    let parent;
    try {
      parent = (await api("GET", `/api/session/${sid}`, { directory }))?.data?.parentID;
    } catch {
      return null;
    }
    sid = parent;
  }
  return null;
}

// Everything currently waiting on a human, across all jobs and their subagents.
async function collectPending() {
  const dirs = [...new Set([...jobs.values()].map((j) => j.directory))];
  const byJob = new Map();
  const add = (jobId, item) => {
    if (!byJob.has(jobId)) byJob.set(jobId, []);
    byJob.get(jobId).push(item);
  };
  for (const directory of dirs) {
    const [perms, forms] = await Promise.all([
      api("GET", "/api/permission/request", { directory }).catch(() => null),
      api("GET", "/api/form", { directory }).catch(() => null),
    ]);
    for (const p of perms?.data ?? []) {
      const jobId = await jobIdForSession(p.sessionID, directory);
      if (!jobId) continue;
      add(jobId, {
        kind: "permission",
        request_id: p.id,
        action: p.action,
        resources: p.resources,
        message: p.message,
        from_subagent: p.sessionID !== jobs.get(jobId).sessionID,
        reply_with: "approve(job, request_id, scope, action, resources) or reject(job, request_id)",
        _session: p.sessionID,
      });
    }
    for (const f of forms?.data ?? []) {
      const jobId = await jobIdForSession(f.sessionID, directory);
      if (!jobId) continue;
      add(jobId, {
        kind: "question",
        form_id: f.id,
        title: f.title,
        fields: (f.fields ?? []).map(({ when, hidden, ...x }) => x),
        from_subagent: f.sessionID !== jobs.get(jobId).sessionID,
        reply_with: "answer(job, form_id, answers)",
        _session: f.sessionID,
      });
    }
  }
  return byJob;
}

async function jobSnapshot(id, pendingByJob, { full = true } = {}) {
  const job = getJob(id);
  const pendingMap = pendingByJob ?? (await collectPending());
  const [active, sess, kids] = await Promise.all([
    api("GET", "/api/session/active", { directory: job.directory }),
    api("GET", `/api/session/${job.sessionID}`, { directory: job.directory }),
    api("GET", "/api/session", { query: { parentID: job.sessionID, limit: 20 }, directory: job.directory }).catch(() => null),
  ]);
  const activeMap = active?.data ?? {};
  const running = Boolean(activeMap[job.sessionID]);
  const pending = (pendingMap.get(id) ?? []).map(({ _session, ...rest }) => rest);
  const info = sess?.data ?? {};
  const subagents = (kids?.data ?? []).map((k) => ({ session: k.id, agent: k.agent, running: Boolean(activeMap[k.id]) }));
  job.childSessions = subagents.map((k) => k.session);
  let status;
  if (job.promptError) status = "failed";
  else if (pending.some((p) => p.kind === "permission")) status = "needs_permission";
  else if (pending.some((p) => p.kind === "question")) status = "needs_answer";
  else if (job.cancelled) status = "cancelled";
  else if (running || !job.promptDone) status = "running";
  else status = info.outcome === "failed" ? "failed" : info.outcome === "interrupted" ? "cancelled" : "done";
  const snap = {
    job: id,
    label: job.label,
    status,
    model: job.modelLabel,
    mode: job.mode,
    directory: job.directory,
    elapsed_s: Math.round((Date.now() - job.startedAt) / 1000),
    cost: info.cost,
    tokens: info.tokens,
  };
  if (job.agent) snap.agent = job.agent;
  if (job.worktree) snap.worktree = { branch: job.worktree.branch, path: job.worktree.root };
  if (subagents.length) snap.subagents = subagents;
  if (pending.length) snap.pending = pending;
  if (job.promptError) snap.error = job.promptError;
  if (full && ["done", "failed", "cancelled"].includes(status)) snap.result = await lastAssistantText(job);
  return snap;
}

const ATTENTION = new Set(["needs_permission", "needs_answer", "done", "failed", "cancelled"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asText = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const asError = (e) => ({ isError: true, content: [{ type: "text", text: String(e?.message ?? e) }] });
const tool = (fn) => async (args, extra) => {
  try {
    return asText(await fn(args, extra));
  } catch (e) {
    return asError(e);
  }
};


// ---------- activity feed (also written to a per-job log you can tail) ----------
const LOG_DIR = path.join(os.homedir(), ".opencode-navigator", "logs");
const loggedParts = new Set();

function brief(input) {
  if (!input || typeof input !== "object") return "";
  const v = input.command ?? input.filePath ?? input.file ?? input.path ?? input.description ?? input.pattern ?? input.query ?? input.prompt ?? JSON.stringify(input);
  return String(v).replace(/\s+/g, " ").slice(0, 110);
}

async function recentActivity(job, limit = 6) {
  const sessions = [job.sessionID, ...(job.childSessions ?? [])];
  const lines = [];
  await Promise.all(
    sessions.map(async (sid) => {
      const r = await api("GET", `/api/session/${sid}/message`, { query: { order: "desc", limit: 10, type: "assistant" }, directory: job.directory }).catch(() => null);
      for (const m of r?.data ?? []) {
        for (const part of m.content ?? []) {
          if (part.type !== "tool") continue;
          lines.push({ t: m.time?.created ?? 0, key: `${part.id}:${part.state?.status}`, sub: sid !== job.sessionID, text: `${part.state?.status ?? "?"} ${part.name}: ${brief(part.state?.input)}` });
        }
      }
    }),
  );
  lines.sort((a, b) => a.t - b.t);
  const fresh = lines.filter((l) => !loggedParts.has(`${job.id}:${l.key}`));
  if (fresh.length) {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const stamp = new Date().toTimeString().slice(0, 8);
    await fs.appendFile(path.join(LOG_DIR, `${job.id}.log`), fresh.map((l) => `${stamp} ${l.sub ? "[subagent] " : ""}${l.text}`).join("\n") + "\n");
    fresh.forEach((l) => loggedParts.add(`${job.id}:${l.key}`));
  }
  return lines.slice(-limit).map((l) => (l.sub ? "[subagent] " : "") + l.text);
}

let progressTick = 0;
async function progress(extra, message) {
  const token = extra?._meta?.progressToken;
  if (token == null) return;
  await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++progressTick, message } }).catch(() => {});
}

// ---------- approvals: native dialog (MCP elicitation) or relay through Claude ----------
const clientCanElicit = () => Boolean(mcp.server.getClientCapabilities()?.elicitation);
async function approvalMode() {
  const want = (await readState()).approvalUi ?? process.env.OPENCODE_NAVIGATOR_APPROVALS ?? "elicit";
  return want === "elicit" && clientCanElicit() ? "elicit" : "relay";
}

async function sendPermission(j, sid, requestId, decision, message) {
  await api("POST", `/api/session/${sid}/permission/${requestId}/reply`, { body: { decision, message: message ?? null }, directory: j.directory });
}
async function sendAnswer(j, sid, formId, answers, cancel) {
  if (cancel) await api("DELETE", `/api/session/${sid}/form/${formId}`, { directory: j.directory });
  else await api("POST", `/api/session/${sid}/form/${formId}/reply`, { body: { answer: answers ?? {} }, directory: j.directory });
}

function fieldSchema(f) {
  const title = f.title ?? f.label ?? f.question ?? f.key;
  const description = f.description ?? f.placeholder;
  const base = { title: String(title), ...(description ? { description: String(description) } : {}) };
  const values = (f.options ?? []).map((o) => o.value);
  if (f.type === "string") return values.length ? { ...base, type: "string", enum: values, ...(f.default ? { default: f.default } : {}) } : { ...base, type: "string" };
  if (f.type === "number" || f.type === "integer") return { ...base, type: f.type };
  if (f.type === "boolean") return { ...base, type: "boolean" };
  if (f.type === "multiselect" && values.length) return { ...base, type: "array", items: { type: "string", enum: values } };
  return null; // e.g. "external": cannot be shown in a dialog
}

const dismissed = new Set(); // items the user closed without deciding; handed to Claude instead of asking again
const inflight = new Set(); // items a dialog is currently open for (several check calls may run at once)
async function debugLog(line) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.appendFile(path.join(LOG_DIR, "bridge.log"), `${new Date().toISOString()} ${line}\n`).catch(() => {});
}

// Ask the user directly. Returns true if anything was answered.
async function autoResolve() {
  if (!jobs.size || (await approvalMode()) !== "elicit") return false;
  const pendingMap = await collectPending();
  let acted = false;
  for (const [jobId, items] of pendingMap) {
    const job = jobs.get(jobId);
    const who = `${job.label ? job.label + " · " : ""}${job.modelLabel} · ${jobId}`;
    for (const p of items) {
      const key = p.request_id ?? p.form_id;
      if (dismissed.has(key) || inflight.has(key)) continue;
      inflight.add(key);
      try {
        if (p.kind === "permission") {
          const r = await mcp.server.elicitInput(
            {
              message: `opencode${p.from_subagent ? " subagent" : ""} wants to ${p.action}:\n${(p.resources ?? []).join("\n")}\n\n${who}`,
              requestedSchema: { type: "object", properties: { decision: { type: "string", title: "Decision (once / always / reject)", enum: ["once", "always", "reject"], default: "once" } }, required: ["decision"] },
            },
            { timeout: 300000 },
          );
          await debugLog(`elicit permission ${p.action} ${JSON.stringify(p.resources)} -> ${r.action} ${JSON.stringify(r.content ?? {})}`);
          // Only an explicit answer counts. A declined/cancelled/auto-dismissed dialog is NOT a user decision:
          // hand the request to Claude instead (approve() shows Claude Code's own prompt).
          if (r.action === "accept" && ["once", "always", "reject"].includes(r.content?.decision)) {
            await sendPermission(job, p._session, p.request_id, r.content.decision, r.content.decision === "reject" ? "Rejected by user" : undefined);
            acted = true;
          } else dismissed.add(key);
        } else {
          const properties = {};
          for (const f of p.fields) {
            const sch = fieldSchema(f);
            if (!sch) throw new Error("unsupported field");
            properties[f.key] = sch;
          }
          const r = await mcp.server.elicitInput({ message: `opencode asks (${who}):\n${p.title ?? ""}`, requestedSchema: { type: "object", properties } }, { timeout: 300000 });
          await debugLog(`elicit question ${p.form_id} -> ${r.action} ${JSON.stringify(r.content ?? {})}`);
          if (r.action === "accept") {
            await sendAnswer(job, p._session, p.form_id, r.content ?? {});
            acted = true;
          } else dismissed.add(key); // let Claude relay it; do not cancel the question for the user
        }
      } catch (e) {
        await debugLog(`elicit failed for ${key}: ${String(e?.message ?? e)}`);
        dismissed.add(key); // unsupported or dialog failed: fall back to relaying via Claude
      } finally {
        inflight.delete(key);
      }
    }
  }
  return acted;
}

// ---------- MCP server ----------
const mcp = new McpServer({ name: "opencode-navigator", version: "0.3.0" });

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
  "list_agents",
  { description: "List opencode agents (usable as run's `agent`, and as subagents opencode can spawn itself).", inputSchema: { directory: z.string().optional() } },
  tool(async ({ directory }) => {
    const r = await api("GET", "/api/agent", { directory });
    return (r?.data ?? []).filter((a) => !a.hidden).map((a) => ({ id: a.id, name: a.name, mode: a.mode, model: a.model ? `${a.model.providerID}/${a.model.id}` : undefined }));
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
  { description: "Set the default model (provider/model, optional #variant). Validated against list_models.", inputSchema: { model: z.string() } },
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
      "Start an opencode job in the background and return a job id immediately; start as many as needed in parallel (each can use a different model). " +
      "Then follow them with check / check_all. opencode may spawn its own subagents inside a job; their permission requests and questions show up on the job. " +
      "mode: 'ask' (default; opencode asks before edits/commands, relay each to the user), 'auto' (everything allowed except a destructive-command deny list; only in a git repo/worktree), 'readonly'. " +
      "Use worktree:true for any job that writes while other jobs run, so jobs cannot overwrite each other.",
    inputSchema: {
      prompt: z.string().min(1).describe("Self-contained brief: goal, files, constraints, done criteria"),
      model: z.string().optional().describe("provider/model[#variant]; defaults to get_default_model"),
      cwd: z.string().optional().describe("Absolute project directory; defaults to the bridge's working directory"),
      mode: z.enum(["ask", "auto", "readonly"]).optional(),
      agent: z.string().optional().describe("opencode agent name (see list_agents)"),
      worktree: z.boolean().optional().describe("Run in a fresh git worktree on branch oc/<job> (needs a git repo with a commit)"),
      label: z.string().optional().describe("Short name to tell jobs apart"),
    },
  },
  tool(async ({ prompt, model, cwd, mode, agent, worktree, label }) => {
    const runningNow = [...jobs.values()].filter((j) => !j.promptDone && !j.cancelled).length;
    if (runningNow >= MAX_RUNNING) throw new Error(`${runningNow} jobs are already running (limit ${MAX_RUNNING}, env OPENCODE_NAVIGATOR_MAX_JOBS). Wait for one to finish with check_all, or cancel one.`);
    const state = await readState();
    const modelLabel = model ?? state.defaultModel ?? null;
    let directory = path.resolve(cwd ?? process.cwd());
    await fs.access(directory);
    const jobId = newJobId();
    let wt = null;
    if (worktree) {
      wt = await createWorktree(directory, jobId);
      directory = wt.dir;
    }
    const useMode = mode ?? "ask";
    const body = { location: { directory }, permissions: rulesFor(useMode) };
    if (agent) body.agent = agent;
    if (modelLabel) body.model = parseModel(modelLabel);
    let sessionID;
    try {
      sessionID = (await api("POST", "/api/session", { body, directory }))?.data?.id;
      if (!sessionID) throw new Error("opencode did not return a session id");
    } catch (e) {
      if (wt) await git(wt.repo, "worktree", "remove", "--force", wt.root).catch(() => {});
      throw e;
    }
    const job = { id: jobId, sessionID, directory, modelLabel: modelLabel ?? "(opencode default)", mode: useMode, agent, label, worktree: wt, startedAt: Date.now(), promptDone: false };
    jobs.set(jobId, job);
    sessionRoot.set(sessionID, jobId);
    // The prompt call may block until the run ends, so don't await it.
    const preface = wt
      ? `[Your working directory is ${directory}. Work only inside it, using relative paths. Do not read or edit ${wt.repo}; it is the original checkout and is off limits.]\n\n`
      : "";
    api("POST", `/api/session/${sessionID}/prompt`, { body: { text: preface + prompt }, directory })
      .then(() => (job.promptDone = true))
      .catch((e) => {
        job.promptDone = true;
        job.promptError = String(e.message ?? e);
      });
    return { job: jobId, status: "running", model: job.modelLabel, mode: useMode, directory, worktree: wt ? { branch: wt.branch, path: wt.root } : undefined, next: "check(job, wait_seconds) or check_all(wait_seconds)" };
  }),
);

mcp.registerTool(
  "check",
  {
    description:
      "Status of one job: running | needs_permission | needs_answer | done | failed | cancelled, plus a short `activity` feed of what opencode just did. Waits up to wait_seconds (max 120). " +
      "If the client can show dialogs, permission requests and questions are put to the user right here as native dialogs and handled automatically. " +
      "Anything still unresolved is listed under `pending`: for permissions call approve() (after the user's OK) or reject(); for questions relay to the user and call answer().",
    inputSchema: { job: z.string(), wait_seconds: z.number().int().min(0).max(120).optional() },
  },
  tool(async ({ job, wait_seconds }, extra) => {
    const j = getJob(job);
    const deadline = Date.now() + (wait_seconds ?? 0) * 1000;
    for (;;) {
      if (await autoResolve()) continue;
      const snap = await jobSnapshot(job);
      if (ATTENTION.has(snap.status) || Date.now() >= deadline) {
        snap.activity = await recentActivity(j);
        return snap;
      }
      const act = await recentActivity(j, 1);
      await progress(extra, `${j.label ?? job}: ${act[0] ?? "working"}`);
      await sleep(2000);
    }
  }),
);

mcp.registerTool(
  "check_all",
  {
    description:
      "Status of every job at once, plus all unresolved permissions and questions in one list. With wait_seconds (max 120) it returns as soon as ANY job needs attention or finishes, " +
      "so use it as the single polling call when several jobs run in parallel. If the client can show dialogs, requests are put to the user natively and handled automatically.",
    inputSchema: { wait_seconds: z.number().int().min(0).max(120).optional(), only_active: z.boolean().optional() },
  },
  tool(async ({ wait_seconds, only_active }, extra) => {
    if (!jobs.size) return { jobs: [], note: "No jobs yet." };
    const deadline = Date.now() + (wait_seconds ?? 0) * 1000;
    const startStatus = new Map();
    for (;;) {
      if (await autoResolve()) continue;
      const pendingMap = await collectPending();
      const snaps = await Promise.all([...jobs.keys()].map((id) => jobSnapshot(id, pendingMap, { full: false })));
      if (!startStatus.size) snaps.forEach((s) => startStatus.set(s.job, s.status));
      const changed = snaps.some((s) => s.status !== startStatus.get(s.job) && ATTENTION.has(s.status));
      const waiting = snaps.some((s) => s.status === "needs_permission" || s.status === "needs_answer");
      if (changed || waiting || !wait_seconds || Date.now() >= deadline || snaps.every((s) => s.status !== "running")) {
        const list = only_active ? snaps.filter((s) => s.status === "running" || s.status.startsWith("needs_")) : snaps;
        await Promise.all(list.filter((s) => s.status === "running").map(async (s) => (s.activity = await recentActivity(jobs.get(s.job), 3))));
        const pending = list.flatMap((s) => (s.pending ?? []).map((p) => ({ job: s.job, label: s.label, ...p })));
        return {
          summary: Object.fromEntries(["running", "needs_permission", "needs_answer", "done", "failed", "cancelled"].map((k) => [k, snaps.filter((s) => s.status === k).length])),
          pending,
          jobs: list.map(({ pending: _p, ...s }) => s),
          note: "Use check(job) to read a finished job's result.",
        };
      }
      await progress(extra, snaps.map((s) => `${s.label ?? s.job}:${s.status}`).join(" "));
      await sleep(2000);
    }
  }),
);

mcp.registerTool(
  "approve",
  {
    description:
      "Approve an opencode permission request (scope once, or always to remember it). Claude Code shows the user its own approval prompt for every call, with the exact action and resources below, " +
      "so pass them exactly as listed in `pending` (the call fails if they don't match the real request). A denied prompt means the user said no: then call reject().",
    inputSchema: {
      job: z.string(),
      request_id: z.string(),
      scope: z.enum(["once", "always"]),
      action: z.string().describe("The request's action, e.g. edit or shell"),
      resources: z.array(z.string()).describe("The request's resources, e.g. file paths or commands"),
    },
    _meta: { "anthropic/requiresUserInteraction": true },
  },
  tool(async ({ job, request_id, scope, action, resources }) => {
    const j = getJob(job);
    const target = ((await collectPending()).get(job) ?? []).find((p) => p.request_id === request_id);
    if (!target) throw new Error(`No pending permission ${request_id} on ${job}; it may already be answered. Call check(${job}).`);
    if (target.action !== action || JSON.stringify(target.resources) !== JSON.stringify(resources))
      throw new Error(`Mismatch: the real request is ${target.action}: ${JSON.stringify(target.resources)}. Nothing was approved.`);
    await sendPermission(j, target._session, request_id, scope);
    return { ok: true, request_id, decision: scope };
  }),
);

mcp.registerTool(
  "reject",
  {
    description: "Reject an opencode permission request (use when the user says no or denies the approve prompt). Safe: never unlocks anything.",
    inputSchema: { job: z.string(), request_id: z.string(), message: z.string().optional().describe("Optional note for opencode, e.g. why") },
  },
  tool(async ({ job, request_id, message }) => {
    const j = getJob(job);
    const target = ((await collectPending()).get(job) ?? []).find((p) => p.request_id === request_id);
    if (!target) throw new Error(`No pending permission ${request_id} on ${job}; it may already be answered.`);
    await sendPermission(j, target._session, request_id, "reject", message);
    return { ok: true, request_id, decision: "reject" };
  }),
);

mcp.registerTool(
  "list_saved_permissions",
  {
    description:
      "List permissions opencode has remembered for a project (from earlier 'always' answers). While a rule such as edit * is saved, matching requests are never asked about. " +
      "Defaults to the directory of the most recent job, else the bridge's working directory.",
    inputSchema: { directory: z.string().optional() },
  },
  tool(async ({ directory }) => {
    const last = [...jobs.values()].at(-1);
    const dir = path.resolve(directory ?? last?.directory ?? process.cwd());
    const r = await api("GET", "/api/permission/saved", { directory: dir });
    return {
      directory: dir,
      saved: (r?.data ?? []).map((p) => ({ id: p.id, action: p.action, resource: p.resource, created: new Date(p.time?.created ?? 0).toISOString() })),
      next: "revoke_permission(id, directory) removes one; opencode will ask again next time.",
    };
  }),
);

mcp.registerTool(
  "revoke_permission",
  {
    description: "Remove one remembered permission (id from list_saved_permissions). Claude Code shows the user an approval prompt for this call. Afterwards opencode asks again for matching requests.",
    inputSchema: { id: z.string().regex(/^psv_/), directory: z.string().describe("The directory list_saved_permissions reported"), action: z.string().describe("The rule's action, echoed from the listing"), resource: z.string().describe("The rule's resource, echoed from the listing") },
    _meta: { "anthropic/requiresUserInteraction": true },
  },
  tool(async ({ id, directory, action, resource }) => {
    const dir = path.resolve(directory);
    const rule = ((await api("GET", "/api/permission/saved", { directory: dir }))?.data ?? []).find((p) => p.id === id);
    if (!rule) throw new Error(`No saved permission ${id} in ${dir}. Call list_saved_permissions.`);
    if (rule.action !== action || rule.resource !== resource) throw new Error(`Mismatch: ${id} is ${rule.action} ${rule.resource}. Nothing was removed.`);
    await api("DELETE", `/api/permission/saved/${id}`, { directory: dir });
    return { ok: true, removed: { id, action, resource }, directory: dir };
  }),
);

mcp.registerTool(
  "bridge_info",
  { description: "Show how this bridge reaches the user: whether native dialogs (elicitation) are available and in use, active jobs, log folder.", inputSchema: {} },
  tool(async () => ({
    client: mcp.server.getClientVersion?.(),
    client_supports_dialogs: clientCanElicit(),
    approvals: await approvalMode(),
    jobs: jobs.size,
    max_parallel_jobs: MAX_RUNNING,
    job_logs: LOG_DIR,
    tip: "tail -f <job_logs>/<job>.log in a terminal to watch a job live",
  })),
);

mcp.registerTool(
  "set_approval_ui",
  {
    description: "Choose how permissions/questions reach the user. 'elicit' = native dialogs from the bridge (needs client support); 'relay' = return them to Claude, which asks the user. Switch to relay if dialogs don't appear.",
    inputSchema: { mode: z.enum(["elicit", "relay"]) },
  },
  tool(async ({ mode }) => {
    await writeState({ approvalUi: mode });
    return { approvals: await approvalMode(), requested: mode };
  }),
);

mcp.registerTool(
  "answer",
  {
    description:
      "Answer a question opencode asked (kind:'question' in pending). `answers` maps each field key to the user's answer (string, number, boolean or array for multiselect). " +
      "Set cancel:true to dismiss the question. Only answer with what the user actually said.",
    inputSchema: {
      job: z.string(),
      form_id: z.string(),
      answers: z.record(z.string(), z.any()).optional(),
      cancel: z.boolean().optional(),
    },
  },
  tool(async ({ job, form_id, answers, cancel }) => {
    const j = getJob(job);
    const target = ((await collectPending()).get(job) ?? []).find((p) => p.form_id === form_id);
    if (!target) throw new Error(`No pending question ${form_id} on ${job}; it may already be answered. Call check(${job}).`);
    await sendAnswer(j, target._session, form_id, answers, cancel);
    return { ok: true, form_id, cancelled: Boolean(cancel) };
  }),
);

mcp.registerTool(
  "send_message",
  {
    description: "Send a follow-up instruction to a job's main session (steer it while it runs, or continue after it finished).",
    inputSchema: { job: z.string(), text: z.string().min(1), queue: z.boolean().optional().describe("Queue after the current step instead of steering immediately") },
  },
  tool(async ({ job, text, queue }) => {
    const j = getJob(job);
    j.promptDone = false;
    j.promptError = undefined;
    j.cancelled = false;
    api("POST", `/api/session/${j.sessionID}/prompt`, { body: { text, delivery: queue ? "queue" : "steer" }, directory: j.directory })
      .then(() => (j.promptDone = true))
      .catch((e) => {
        j.promptDone = true;
        j.promptError = String(e.message ?? e);
      });
    return { ok: true, job, next: "check(job)" };
  }),
);

mcp.registerTool(
  "cancel",
  { description: "Interrupt a running job (and its subagents).", inputSchema: { job: z.string() } },
  tool(async ({ job }) => {
    const j = getJob(job);
    j.cancelled = true;
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

mcp.registerTool(
  "worktree_finish",
  {
    description:
      "For a job started with worktree:true. action 'merge' merges branch oc/<job> into the repo's current branch (refuses if the repo has uncommitted changes or the merge conflicts) and removes the worktree; " +
      "'discard' deletes the worktree and branch; 'keep' leaves them for the user. Only merge or discard with the user's OK, after showing diff.",
    inputSchema: { job: z.string(), action: z.enum(["merge", "discard", "keep"]) },
  },
  tool(async ({ job, action }) => {
    const j = getJob(job);
    const wt = j.worktree;
    if (!wt) throw new Error(`${job} was not started with worktree:true`);
    if (action === "keep") return { ok: true, branch: wt.branch, path: wt.root };
    if (!j.promptDone) throw new Error("Job is still running; cancel it or wait before finishing the worktree.");
    if (action === "merge") {
      const dirty = (await git(wt.repo, "status", "--porcelain", "--untracked-files=no")).stdout.trim();
      if (dirty) throw new Error("The main repo has uncommitted changes; commit or stash them first.");
      // commit whatever opencode left in the worktree so it can be merged
      const wtDirty = (await git(wt.root, "status", "--porcelain")).stdout.trim();
      if (wtDirty) {
        await git(wt.root, "add", "-A");
        await git(wt.root, "-c", "user.name=opencode", "-c", "user.email=opencode@localhost", "commit", "-m", `opencode job ${job}${j.label ? `: ${j.label}` : ""}`);
      }
      try {
        await git(wt.repo, "merge", "--no-ff", "-m", `Merge ${wt.branch}`, wt.branch);
      } catch (e) {
        await git(wt.repo, "merge", "--abort").catch(() => {});
        throw new Error(`Merge conflict; nothing was merged. Branch ${wt.branch} is kept at ${wt.root}. ${String(e.stderr ?? e.message).slice(0, 400)}`);
      }
    }
    await git(wt.repo, "worktree", "remove", "--force", wt.root);
    await git(wt.repo, "branch", action === "merge" ? "-d" : "-D", wt.branch);
    j.worktree = null;
    return { ok: true, action, branch: wt.branch };
  }),
);

await mcp.connect(new StdioServerTransport());
