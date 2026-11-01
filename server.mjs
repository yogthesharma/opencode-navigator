#!/usr/bin/env node
// MCP bridge: lets Claude delegate coding work to opencode (many parallel jobs, any model),
// keeps Claude's context small (compact results, files for the details), and gets approvals
// and questions to the user through native dialogs or Claude Code's own approval prompts.
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
const DATA_DIR = path.join(os.homedir(), ".opencode-navigator");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const LEDGER_FILE = path.join(DATA_DIR, "ledger.jsonl");
const RESULT_DIR = path.join(DATA_DIR, "results");
const WORKTREE_ROOT = path.join(DATA_DIR, "worktrees");
const LOG_DIR = path.join(DATA_DIR, "logs");
const PROJECT_CONFIG = ".opencode-navigator.json"; // per-repo: { "verify": "npm test", "verify_timeout_s": 300 }
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";
const MAX_RUNNING = Number(process.env.OPENCODE_NAVIGATOR_MAX_JOBS || 4);
const MAX_TEXT = 20000;
const INLINE_RESULT = 1800; // how much of a job's answer goes into Claude's context; the rest stays in result_file
const PRUNE_DAYS = 7;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = (s, n) => (s.length > n ? s.slice(0, n) + "\n…[truncated]" : s);

// ---------- state (default model, routing, settings) ----------
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
      await sleep(250);
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

async function assertKnownModel(model) {
  parseModel(model);
  const known = await listModels();
  if (!known.includes(model.split("#")[0])) throw new Error(`"${model}" is not in opencode's model list. Use list_models to find the exact name.`);
}

// explicit model > routing[task_type] > default model > opencode's own default
function resolveModel(state, model, taskType) {
  return model ?? (taskType ? state.routing?.[taskType] : undefined) ?? state.defaultModel ?? null;
}

// ---------- permission modes ----------
// ask: reads allowed, destructive shell denied, everything else asks (the user decides).
// auto: everything allowed except the destructive deny list.
// allowed_paths limits where edits are possible at all (anything else is denied outright).
const DENY_SHELL = ["rm -rf *", "rm -r *", "sudo *", "git push *", "git reset --hard*", "git clean *", "curl * | *", "dd *", "mkfs*", "chmod -R *", "chown -R *"];
function rulesFor(mode, allowedPaths) {
  const deny = DENY_SHELL.map((resource) => ({ action: "shell", resource, effect: "deny" }));
  let rules;
  if (mode === "auto") rules = [{ action: "*", resource: "*", effect: "allow" }, ...deny];
  else if (mode === "readonly")
    return [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
    ];
  // question/subagent are only routing; the edits and commands inside them still ask.
  else rules = [{ action: "*", resource: "*", effect: "ask" }, ...["read", "glob", "grep", "question", "subagent"].map((action) => ({ action, resource: "*", effect: "allow" })), ...deny];
  if (allowedPaths?.length) {
    const inside = mode === "auto" ? "allow" : "ask";
    rules.push({ action: "edit", resource: "*", effect: "deny" }, ...allowedPaths.map((g) => ({ action: "edit", resource: g.replace(/\*\*/g, "*"), effect: inside })));
  }
  return rules;
}

const globRe = (g) =>
  new RegExp(
    "^" +
      g
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, ".*")
        .replace(/\?/g, "[^/]") +
      "$",
  );

// ---------- git ----------
const git = (cwd, ...args) => execFileP("git", ["-C", cwd, ...args], { maxBuffer: 10 * 1024 * 1024 });

async function repoTop(dir) {
  try {
    return (await git(dir, "rev-parse", "--show-toplevel")).stdout.trim();
  } catch {
    return null;
  }
}

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

// Project settings are read from the ORIGINAL repo when a job starts, never from the job's worktree,
// so a job cannot rewrite the command that verify will later run.
async function readProjectConfig(dir) {
  const top = (await repoTop(dir)) ?? dir;
  try {
    return JSON.parse(await fs.readFile(path.join(top, PROJECT_CONFIG), "utf8"));
  } catch {
    return {};
  }
}

// ---------- jobs (persisted so they survive restarts) ----------
// job: plain JSON only. { id, sessionID, directory, modelLabel, mode, agent, label, worktree, startedAt, promptDone, promptError,
//   cancelled, budgetExceeded, restarted, childSessions, opts:{allowed_paths,max_cost,verifyCommand,verifyTimeout,autoVerify,autoReview},
//   finalized, finishedAt, summary, report, resultFile, patchFile, changed, scopeViolations, verify, reviewJob, ledgeredCost, notified:[] }
const jobs = new Map();
const sessionRoot = new Map(); // sessionID -> job id (covers opencode's own subagent sessions)
const verifyRuns = new Map(); // job id -> Promise of a verify in progress (not persisted)

const newJobId = () => "job_" + randomBytes(4).toString("hex");

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(JOBS_FILE, JSON.stringify([...jobs.values()], null, 1));
    } catch {}
  }, 150);
}

async function loadJobs() {
  try {
    const arr = JSON.parse(await fs.readFile(JOBS_FILE, "utf8"));
    const cutoff = Date.now() - PRUNE_DAYS * 86400e3;
    for (const j of arr) {
      if (j.finalized && (j.finishedAt ?? 0) < cutoff) continue;
      if (!j.promptDone) {
        // the opencode server that ran it died with the previous bridge process
        j.promptDone = true;
        j.cancelled = true;
        j.restarted = true;
      }
      if (j.verify?.status === "running") j.verify = { status: "unknown", note: "bridge restarted while verify was running; run verify again" };
      jobs.set(j.id, j);
      sessionRoot.set(j.sessionID, j.id);
      for (const c of j.childSessions ?? []) sessionRoot.set(c, j.id);
    }
  } catch {}
}

function getJob(id) {
  const j = jobs.get(id);
  if (!j) throw new Error(`Unknown job "${id}". Call check_all to list known jobs.`);
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
    if (t) return t;
  }
  return "";
}

// ---------- structured report (keeps Claude's context small) ----------
const REPORT_SUFFIX = `

When you are completely finished, end your final message with exactly this block (plain text, no markdown):
REPORT
files_changed: <comma-separated paths, or none>
tests: <what you ran and the outcome, or "not run">
open_issues: <anything unfinished or uncertain, or none>
assumptions: <decisions you made that the user should check, or none>
END_REPORT`;

function splitReport(text) {
  const m = text.match(/REPORT\s*\n([\s\S]*?)\nEND_REPORT/);
  if (!m) return { body: text, report: null };
  const report = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) report[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { body: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim(), report };
}

// ---------- diff, scope, secrets ----------
// build artifacts and caches are never part of a job's changes (not listed, reviewed, scope-checked or committed)
const JUNK_RE = /(^|\/)(__pycache__|node_modules|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|\.next|\.turbo)(\/|$)|\.pyc$|(^|\/)\.DS_Store$/;
const JUNK_PATHSPEC = ["__pycache__", "node_modules", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", ".next", ".turbo"].map((d) => `:(exclude,glob)**/${d}/**`).concat([":(exclude,glob)**/*.pyc", ":(exclude,glob)**/.DS_Store"]);

async function sessionDiff(job) {
  const r = await api("GET", `/api/session/${job.sessionID}/diff`, { directory: job.directory }).catch(() => null);
  return (Array.isArray(r?.data) ? r.data : []).filter((f) => !JUNK_RE.test(f.file));
}

// opencode records why a run failed (rate limit, auth, ...) on the session's idle marker
async function sessionError(job) {
  const r = await api("GET", `/api/session/${job.sessionID}/message`, { query: { order: "desc", limit: 3, type: "idle" }, directory: job.directory }).catch(() => null);
  const e = (r?.data ?? []).find((m) => m.error)?.error;
  return e ? `${e.type ?? "error"}${e.status ? ` (${e.status})` : ""}: ${e.message ?? ""}`.trim() : undefined;
}

const SECRET_PATTERNS = [
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["OpenAI/Anthropic-style key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["generic secret assignment", /(?:api[_-]?key|secret|token|passwd|password)\s*[:=]\s*['"][^'"\s]{16,}['"]/i],
];

function scanSecrets(patch) {
  const findings = [];
  let file = "?";
  let line = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("+++ ")) file = l.slice(4).replace(/^b\//, "");
    else if (l.startsWith("@@")) line = Number(l.match(/\+(\d+)/)?.[1] ?? 0) - 1;
    else if (l.startsWith("+")) {
      line++;
      for (const [kind, re] of SECRET_PATTERNS) if (re.test(l)) findings.push({ file, line, kind });
    } else if (!l.startsWith("-")) line++;
  }
  return findings;
}

// ---------- notifications ----------
async function notify(title, message) {
  if (process.platform !== "darwin") return;
  if ((await readState()).notifications === false) return;
  const esc = (s) => String(s).replace(/[\\"]/g, " ").slice(0, 180);
  execFile("osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`], () => {});
}

// ---------- pending approvals / questions ----------
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

// Everything currently waiting on a human, across all running jobs and their subagents.
async function collectPending() {
  const live = [...jobs.values()].filter((j) => !j.finalized);
  const dirs = [...new Set(live.map((j) => j.directory))];
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

// ---------- job lifecycle: snapshot, finalize, verify, review ----------
const FINAL = new Set(["done", "failed", "cancelled"]);

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
  for (const k of job.childSessions) sessionRoot.set(k, id);
  let status;
  if (job.promptError) status = "failed";
  else if (pending.some((p) => p.kind === "permission")) status = "needs_permission";
  else if (pending.some((p) => p.kind === "question")) status = "needs_answer";
  else if (job.cancelled) status = "cancelled";
  else if (running || !job.promptDone) status = "running";
  else status = info.outcome === "failed" ? "failed" : info.outcome === "interrupted" ? "cancelled" : "done";
  job.lastOutcome = info.outcome;
  job.lastCost = info.cost ?? job.lastCost;
  job.lastTokens = info.tokens ?? job.lastTokens;
  if (FINAL.has(status) && !job.finalized) await finalizeJob(job, status);
  const snap = {
    job: id,
    label: job.label,
    status,
    model: job.modelLabel,
    mode: job.mode,
    directory: job.directory,
    elapsed_s: Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000),
    cost: info.cost ?? job.lastCost,
    tokens: info.tokens ?? job.lastTokens,
  };
  if (job.agent) snap.agent = job.agent;
  if (job.worktree) snap.worktree = { branch: job.worktree.branch, path: job.worktree.root };
  if (subagents.length) snap.subagents = subagents;
  if (pending.length) snap.pending = pending;
  if (job.promptError) snap.error = job.promptError;
  else if (job.errorMessage) snap.error = job.errorMessage;
  if (job.budgetExceeded) snap.budget_exceeded = `stopped at $${job.opts?.max_cost}`;
  if (job.restarted) snap.note = "The bridge restarted while this job was running; opencode's work up to that point is kept.";
  if (job.finalized) {
    snap.changed_files = (job.changed ?? []).length;
    if (job.scopeViolations?.length) snap.scope_violations = job.scopeViolations;
    if (job.verify) snap.verify = job.verify;
    if (job.reviewJob) snap.review_job = job.reviewJob;
    if (full) {
      snap.result = job.summary;
      if (job.report) snap.report = job.report;
      if (job.resultFile) snap.result_file = job.resultFile;
      if (job.patchFile) snap.patch_file = job.patchFile;
      if (job.changed?.length) snap.files = job.changed;
    }
  }
  return snap;
}

// Runs once when a job reaches a final state: stores compact results + full files, books the cost, notifies,
// and starts the optional verify/review steps in the background.
async function finalizeJob(job, status) {
  job.finalized = true;
  job.finishedAt = Date.now();
  persist();
  try {
    const dir = path.join(RESULT_DIR, job.id);
    await fs.mkdir(dir, { recursive: true });
    const text = await lastAssistantText(job).catch(() => "");
    const { body, report } = splitReport(text);
    if (status === "failed" || job.lastOutcome === "failed") job.errorMessage = await sessionError(job);
    job.summary = cap((job.errorMessage ? `FAILED: ${job.errorMessage}\n\n` : "") + (body || "(no final message)"), INLINE_RESULT);
    job.report = report ?? undefined;
    job.resultFile = path.join(dir, "result.md");
    await fs.writeFile(job.resultFile, text || "(no final message)");
    const files = await sessionDiff(job);
    job.changed = files.map((f) => ({ file: f.file, status: f.status, additions: f.additions, deletions: f.deletions }));
    if (files.length) {
      job.patchFile = path.join(dir, "diff.patch");
      await fs.writeFile(job.patchFile, files.map((f) => f.patch).join("\n"));
    }
    if (job.opts?.allowed_paths?.length) {
      const res = job.opts.allowed_paths.map(globRe);
      job.scopeViolations = job.changed.map((f) => f.file).filter((f) => !res.some((re) => re.test(f)));
    }
  } catch (e) {
    job.summary = job.summary ?? `(could not store result: ${String(e.message ?? e)})`;
  }
  const delta = Math.max(0, (job.lastCost ?? 0) - (job.ledgeredCost ?? 0));
  job.ledgeredCost = job.lastCost ?? 0;
  await fs
    .appendFile(LEDGER_FILE, JSON.stringify({ ts: new Date().toISOString(), job: job.id, label: job.label, model: job.modelLabel, status, cost: delta, tokens: job.lastTokens, seconds: Math.round((job.finishedAt - job.startedAt) / 1000) }) + "\n")
    .catch(() => {});
  notify(`opencode: ${status}`, `${job.label ?? job.id} (${job.modelLabel})${job.changed?.length ? ` · ${job.changed.length} file(s) changed` : ""}`);
  if (status === "done" && job.opts?.autoVerify && job.opts.verifyCommand) startVerify(job);
  if (status === "done" && job.opts?.autoReview) startReview(job).catch((e) => debugLog(`auto review failed: ${String(e.message ?? e)}`));
  persist();
}

function startVerify(job) {
  if (verifyRuns.has(job.id)) return verifyRuns.get(job.id);
  const command = job.opts?.verifyCommand;
  if (!command) throw new Error(`No verify command: add {"verify": "<command>"} to ${PROJECT_CONFIG} in the project root and start the job with verify:true.`);
  job.verify = { status: "running", command };
  persist();
  const started = Date.now();
  const p = new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { cwd: job.directory, timeout: (job.opts.verifyTimeout ?? 300) * 1000, maxBuffer: 20 * 1024 * 1024 }, async (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim();
      const logFile = path.join(RESULT_DIR, job.id, "verify.log");
      await fs.mkdir(path.dirname(logFile), { recursive: true }).catch(() => {});
      await fs.writeFile(logFile, out).catch(() => {});
      job.verify = {
        status: "finished",
        command,
        passed: !err,
        exit_code: err ? (typeof err.code === "number" ? err.code : err.killed ? "timeout" : 1) : 0,
        seconds: Math.round((Date.now() - started) / 1000),
        output_tail: out.slice(-1500),
        log_file: logFile,
      };
      verifyRuns.delete(job.id);
      persist();
      notify(`opencode verify ${job.verify.passed ? "passed" : "FAILED"}`, `${job.label ?? job.id}: ${command}`);
      resolve(job.verify);
    });
  });
  verifyRuns.set(job.id, p);
  return p;
}

async function startReview(job, { model, focus } = {}) {
  const files = await sessionDiff(job);
  if (!files.length) throw new Error("This job changed no files, nothing to review.");
  const patch = cap(files.map((f) => f.patch).join("\n"), 40000);
  const state = await readState();
  const reviewModel = model ?? state.routing?.review ?? state.reviewModel ?? (job.modelLabel.startsWith("(") ? undefined : job.modelLabel);
  const prompt =
    `You are a strict code reviewer. Below is a diff made by another model. Do NOT modify any files.\n` +
    `Find real problems only: bugs, regressions, missing edge cases, missing tests, security issues, deviations from the task.${focus ? ` Extra focus: ${focus}.` : ""}\n` +
    `Reply with at most 8 findings, one per line, in the form: severity(high|medium|low) | file:line | issue | suggested fix.\n` +
    `Finish with one line: VERDICT: ok  or  VERDICT: needs-changes.\n\n` +
    `The original task was handled by job ${job.id} (${job.label ?? "no label"}).\n\nDIFF:\n${patch}`;
  const started = await startJob({ prompt, model: reviewModel, cwd: job.directory, mode: "readonly", label: `review:${job.label ?? job.id}`, report: false, review: false, internal: true });
  job.reviewJob = started.job;
  persist();
  return started;
}

// ---------- activity feed (also written to a per-job log you can tail) ----------
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

async function debugLog(line) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.appendFile(path.join(LOG_DIR, "bridge.log"), `${new Date().toISOString()} ${line}\n`).catch(() => {});
}

// ---------- approvals: native dialog (MCP elicitation) or relay through Claude ----------
const clientCanElicit = () => Boolean(mcp.server.getClientCapabilities()?.elicitation);
let dialogsDeadUntil = 0; // set when the host auto-dismisses dialogs (e.g. background subagents)
async function approvalMode() {
  if (Date.now() < dialogsDeadUntil) return "relay";
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
          const askedAt = Date.now();
          const r = await mcp.server.elicitInput(
            {
              message: `opencode${p.from_subagent ? " subagent" : ""} wants to ${p.action}:\n${(p.resources ?? []).join("\n")}\n\n${who}`,
              requestedSchema: { type: "object", properties: { decision: { type: "string", title: "Decision (once / always / reject)", enum: ["once", "always", "reject"], default: "once" } }, required: ["decision"] },
            },
            { timeout: 300000 },
          );
          if (r.action !== "accept" && Date.now() - askedAt < 2000) {
            dialogsDeadUntil = Date.now() + 30 * 60 * 1000; // answered in <2s without accepting: nobody saw it
            await debugLog("dialogs look auto-dismissed by the host; using relay (Claude Code approval prompts) for 30 min");
          }
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

// ---------- starting jobs ----------
async function startJob(o) {
  const { prompt, model, task_type, cwd, mode: requestedMode, agent, worktree, label, allowed_paths, max_cost, verify, review, report = true, internal } = o;
  const runningNow = [...jobs.values()].filter((j) => !j.finalized).length;
  if (!internal && runningNow >= MAX_RUNNING) throw new Error(`${runningNow} jobs are already running (limit ${MAX_RUNNING}, env OPENCODE_NAVIGATOR_MAX_JOBS). Wait for one to finish with check_all, or cancel one.`);
  const state = await readState();
  const modelLabel = resolveModel(state, model, task_type);
  if (modelLabel) parseModel(modelLabel);
  let directory = path.resolve(cwd ?? process.cwd());
  await fs.access(directory);
  // No explicit mode: use the saved default. A default of "auto" only applies inside a git repo (edits are revertable there).
  let mode = requestedMode ?? state.defaultMode ?? "ask";
  let modeNote;
  if (!requestedMode && mode === "auto" && !(await repoTop(directory))) {
    mode = "ask";
    modeNote = `Default mode is auto, but ${directory} is not a git repo, so this job uses ask (edits there could not be undone). Pass mode:"auto" to override.`;
  }
  const config = await readProjectConfig(directory);
  if (verify && !config.verify) throw new Error(`verify:true needs a "verify" command in ${PROJECT_CONFIG} at the project root, e.g. {"verify": "npm test"}.`);
  const jobId = newJobId();
  let wt = null;
  if (worktree) {
    wt = await createWorktree(directory, jobId);
    directory = wt.dir;
  }
  const body = { location: { directory }, permissions: rulesFor(mode, allowed_paths) };
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
  const job = {
    id: jobId,
    sessionID,
    directory,
    modelLabel: modelLabel ?? "(opencode default)",
    mode,
    agent,
    label,
    worktree: wt,
    startedAt: Date.now(),
    promptDone: false,
    opts: { allowed_paths, max_cost, verifyCommand: verify ? config.verify : undefined, verifyTimeout: config.verify_timeout_s, autoVerify: Boolean(verify), autoReview: Boolean(review) },
    notified: [],
  };
  jobs.set(jobId, job);
  sessionRoot.set(sessionID, jobId);
  persist();
  ensureWatcher();
  const preface = wt ? `[Your working directory is ${directory}. Work only inside it, using relative paths. Do not read or edit ${wt.repo}; it is the original checkout and is off limits.]\n\n` : "";
  // The prompt call may block until the run ends, so don't await it.
  api("POST", `/api/session/${sessionID}/prompt`, { body: { text: preface + prompt + (report ? REPORT_SUFFIX : "") }, directory })
    .then(() => {
      job.promptDone = true;
      persist();
    })
    .catch((e) => {
      job.promptDone = true;
      job.promptError = String(e.message ?? e);
      persist();
    });
  return { job: jobId, status: "running", model: job.modelLabel, mode, ...(modeNote ? { note: modeNote } : {}), directory, worktree: wt ? { branch: wt.branch, path: wt.root } : undefined, next: "check(job, wait_seconds) or check_all(wait_seconds)" };
}

// ---------- background watcher: budget caps, completion handling, notifications ----------
let watcher = null;
let ticking = false;
function ensureWatcher() {
  if (watcher) return;
  watcher = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      const live = [...jobs.values()].filter((j) => !j.finalized);
      if (!live.length) return;
      const pendingMap = await collectPending();
      const relay = (await approvalMode()) === "relay";
      for (const job of live) {
        const snap = await jobSnapshot(job.id, pendingMap, { full: false }).catch(() => null);
        if (!snap) continue;
        const max = job.opts?.max_cost;
        if (max && (snap.cost ?? 0) > max && !job.cancelled && !FINAL.has(snap.status)) {
          job.cancelled = true;
          job.budgetExceeded = true;
          await api("POST", `/api/session/${job.sessionID}/interrupt`, { directory: job.directory }).catch(() => {});
          persist();
        }
        for (const p of snap.pending ?? []) {
          const key = p.request_id ?? p.form_id;
          job.notified ??= [];
          if (job.notified.includes(key) || !(relay || dismissed.has(key))) continue;
          job.notified.push(key);
          notify("opencode needs you", `${job.label ?? job.id}: ${p.kind === "permission" ? `${p.action} ${(p.resources ?? []).join(", ")}` : p.title ?? "question"}`);
        }
      }
    } catch {
    } finally {
      ticking = false;
    }
  }, 4000);
  watcher.unref?.();
}

// ---------- MCP plumbing ----------
const ATTENTION = new Set(["needs_permission", "needs_answer", "done", "failed", "cancelled"]);
const asText = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const asError = (e) => ({ isError: true, content: [{ type: "text", text: String(e?.message ?? e) }] });
const tool = (fn) => async (args, extra) => {
  try {
    return asText(await fn(args, extra));
  } catch (e) {
    return asError(e);
  }
};

const mcp = new McpServer({
  name: "opencode-navigator",
  version: "0.5.0",
}, {
  instructions:
    "Delegates coding work to opencode. Start with run(); follow with check/check_all; review with diff/verify/review; finish worktrees with worktree_finish. " +
    "Results are compact on purpose: full output and patches are in files (result_file, patch_file) that you read only if needed. Never approve permissions or answer questions on the user's behalf.",
});

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
  { description: "Show the default model and the task_type routing table.", inputSchema: {} },
  tool(async () => {
    const s = await readState();
    return { default_model: s.defaultModel ?? null, routing: s.routing ?? {}, review_model: s.routing?.review ?? s.reviewModel ?? null, note: s.defaultModel ? undefined : "No default set; opencode's own default applies." };
  }),
);

mcp.registerTool(
  "set_default_model",
  { description: "Set the default model (provider/model, optional #variant). Validated against list_models.", inputSchema: { model: z.string() } },
  tool(async ({ model }) => {
    await assertKnownModel(model);
    await writeState({ defaultModel: model });
    return { default_model: model };
  }),
);

mcp.registerTool(
  "set_default_mode",
  {
    description:
      "Set the permission mode used when run() gets no mode. 'auto' = opencode edits and runs commands without asking (destructive commands like rm -r, sudo, git push stay blocked; applies only inside git repos); " +
      "'ask' = prompt for every edit/command; 'readonly'. An explicit mode on run() always wins.",
    inputSchema: { mode: z.enum(["ask", "auto", "readonly"]) },
  },
  tool(async ({ mode }) => {
    await writeState({ defaultMode: mode });
    return { default_mode: mode, note: mode === "auto" ? "Jobs in git repos now run without per-file approval prompts; non-git folders still ask." : undefined };
  }),
);

mcp.registerTool(
  "set_routing",
  {
    description:
      "Map a task type to a model so run(task_type) picks it automatically, e.g. explore -> a free model, hard -> a stronger one, review -> the reviewer. " +
      "Any name works; 'review' is used by review(). Pass model:null to remove an entry.",
    inputSchema: { task_type: z.string().min(1), model: z.string().nullable() },
  },
  tool(async ({ task_type, model }) => {
    const s = await readState();
    const routing = { ...(s.routing ?? {}) };
    if (model === null) delete routing[task_type];
    else {
      await assertKnownModel(model);
      routing[task_type] = model;
    }
    await writeState({ routing });
    return { routing };
  }),
);

mcp.registerTool(
  "run",
  {
    description:
      "Start an opencode job in the background and return a job id immediately; start as many as needed in parallel (each can use a different model). " +
      "Then follow them with check / check_all. opencode may spawn its own subagents inside a job; their permission requests and questions show up on the job. " +
      "mode: 'ask' (default; opencode asks before edits/commands), 'auto' (everything allowed except a destructive-command deny list; only in a git repo/worktree), 'readonly'. " +
      "Use worktree:true for any job that writes while other jobs run. Model: `model`, else routing[task_type], else the default. " +
      "verify:true runs the project's verify command (from .opencode-navigator.json) when the job finishes; review:true starts a second-model review of the diff.",
    inputSchema: {
      prompt: z.string().min(1).describe("Self-contained brief: goal, files, constraints, done criteria"),
      model: z.string().optional().describe("provider/model[#variant]"),
      task_type: z.string().optional().describe("Routing key, see set_routing (e.g. explore, implement, hard)"),
      cwd: z.string().optional().describe("Absolute project directory; defaults to the bridge's working directory"),
      mode: z.enum(["ask", "auto", "readonly"]).optional(),
      agent: z.string().optional().describe("opencode agent name (see list_agents)"),
      worktree: z.boolean().optional().describe("Run in a fresh git worktree on branch oc/<job> (needs a git repo with a commit)"),
      label: z.string().optional().describe("Short name to tell jobs apart"),
      allowed_paths: z.array(z.string()).optional().describe("Globs (relative to cwd) the job may edit, e.g. ['src/**','tests/**']; edits elsewhere are denied"),
      max_cost: z.number().positive().optional().describe("Stop the job if its cost exceeds this many USD"),
      verify: z.boolean().optional().describe("Run the configured verify command when the job finishes"),
      review: z.boolean().optional().describe("Start a read-only review job by another model when the job finishes"),
      report: z.boolean().optional().describe("Ask for a structured REPORT block (default true)"),
    },
  },
  tool(async (args) => startJob(args)),
);

mcp.registerTool(
  "check",
  {
    description:
      "Status of one job: running | needs_permission | needs_answer | done | failed | cancelled, plus a short `activity` feed. Waits up to wait_seconds (max 120). " +
      "A finished job returns a compact summary, a structured `report`, the changed-file list and paths to the full files; read those files only if you need more. " +
      "If the client can show dialogs, permission requests and questions are put to the user here automatically. " +
      "Anything still unresolved is listed under `pending`: for permissions call approve() (after the user's OK) or reject(); for questions relay to the user and call answer().",
    inputSchema: { job: z.string(), wait_seconds: z.number().int().min(0).max(120).optional() },
  },
  tool(async ({ job, wait_seconds }, extra) => {
    const j = getJob(job);
    const deadline = Date.now() + (wait_seconds ?? 0) * 1000;
    for (;;) {
      if (await autoResolve()) continue;
      const snap = j.finalized ? await jobSnapshotSafe(job) : await jobSnapshot(job);
      if (ATTENTION.has(snap.status) || Date.now() >= deadline) {
        if (!snap.result) snap.activity = await recentActivity(j);
        return snap;
      }
      const act = await recentActivity(j, 1);
      await progress(extra, `${j.label ?? job}: ${act[0] ?? "working"}`);
      await sleep(2000);
    }
  }),
);

// finished jobs can still be asked about after their opencode session is gone; snapshot works as long as the session exists
async function jobSnapshotSafe(job) {
  try {
    return await jobSnapshot(job);
  } catch (e) {
    const j = getJob(job);
    return { job, status: j.cancelled ? "cancelled" : j.promptError ? "failed" : "done", label: j.label, model: j.modelLabel, result: j.summary, report: j.report, result_file: j.resultFile, patch_file: j.patchFile, files: j.changed, verify: j.verify, review_job: j.reviewJob, note: "Live session data unavailable; showing the stored result." };
  }
}

mcp.registerTool(
  "check_all",
  {
    description:
      "Status of every job at once (compact), plus all unresolved permissions and questions in one list. With wait_seconds (max 120) it returns as soon as ANY job needs attention or finishes, " +
      "so use it as the single polling call when several jobs run in parallel. Finished jobs older than an hour are hidden unless include_old is set.",
    inputSchema: { wait_seconds: z.number().int().min(0).max(120).optional(), only_active: z.boolean().optional(), include_old: z.boolean().optional() },
  },
  tool(async ({ wait_seconds, only_active, include_old }, extra) => {
    if (!jobs.size) return { jobs: [], note: "No jobs yet." };
    const deadline = Date.now() + (wait_seconds ?? 0) * 1000;
    const startStatus = new Map();
    for (;;) {
      if (await autoResolve()) continue;
      const visible = [...jobs.values()].filter((j) => include_old || !j.finalized || Date.now() - (j.finishedAt ?? 0) < 3600e3);
      const pendingMap = await collectPending();
      const snaps = await Promise.all(visible.map((j) => jobSnapshot(j.id, pendingMap, { full: false }).catch(() => ({ job: j.id, label: j.label, status: j.cancelled ? "cancelled" : "done", model: j.modelLabel }))));
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
          note: "Use check(job) to read a finished job's summary and report.",
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
  "answer",
  {
    description:
      "Answer a question opencode asked (kind:'question' in pending). `answers` maps each field key to the user's answer (string, number, boolean or array for multiselect). " +
      "Set cancel:true to dismiss the question. Only answer with what the user actually said.",
    inputSchema: { job: z.string(), form_id: z.string(), answers: z.record(z.string(), z.any()).optional(), cancel: z.boolean().optional() },
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
    description: "Send a follow-up instruction to a job's main session (steer it while it runs, or continue after it finished, e.g. to fix verify failures or review findings).",
    inputSchema: { job: z.string(), text: z.string().min(1), queue: z.boolean().optional().describe("Queue after the current step instead of steering immediately") },
  },
  tool(async ({ job, text, queue }) => {
    const j = getJob(job);
    j.promptDone = false;
    j.promptError = undefined;
    j.cancelled = false;
    j.budgetExceeded = false;
    j.restarted = false;
    j.finalized = false;
    j.verify = undefined;
    j.reviewJob = undefined;
    persist();
    ensureWatcher();
    api("POST", `/api/session/${j.sessionID}/prompt`, { body: { text: text + REPORT_SUFFIX, delivery: queue ? "queue" : "steer" }, directory: j.directory })
      .then(() => {
        j.promptDone = true;
        persist();
      })
      .catch((e) => {
        j.promptDone = true;
        j.promptError = String(e.message ?? e);
        persist();
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
    persist();
    await api("POST", `/api/session/${j.sessionID}/interrupt`, { directory: j.directory });
    return { ok: true, job };
  }),
);

mcp.registerTool(
  "diff",
  {
    description:
      "Changes a job made. Default: a compact file list (status, +/- lines) and the path of the full patch file. Pass `file` for one file's patch, or full:true for the whole patch inline (capped). " +
      "Prefer the list; read patches only for files you need to judge.",
    inputSchema: { job: z.string(), file: z.string().optional(), full: z.boolean().optional() },
  },
  tool(async ({ job, file, full }) => {
    const j = getJob(job);
    const files = await sessionDiff(j);
    if (file) {
      const f = files.find((x) => x.file === file || x.file.endsWith(file));
      if (!f) throw new Error(`No change to "${file}" in ${job}. Changed: ${files.map((x) => x.file).join(", ") || "nothing"}`);
      return cap(f.patch, 8000);
    }
    if (full) return cap(files.map((f) => f.patch).join("\n"), MAX_TEXT);
    const dir = path.join(RESULT_DIR, j.id);
    await fs.mkdir(dir, { recursive: true });
    const patchFile = path.join(dir, "diff.patch");
    await fs.writeFile(patchFile, files.map((f) => f.patch).join("\n"));
    return { job, files: files.map((f) => ({ file: f.file, status: f.status, additions: f.additions, deletions: f.deletions })), patch_file: patchFile, hint: "diff(job, file) shows one file's patch." };
  }),
);

mcp.registerTool(
  "verify",
  {
    description:
      `Run the project's verify command (from ${PROJECT_CONFIG} in the repo root, captured when the job started with verify:true) inside the job's directory: tests, lint, typecheck. ` +
      "Returns pass/fail, exit code and the tail of the output (full log in log_file). If it fails, use send_message with the failure to have the job fix it. Waits up to wait_seconds for a run in progress.",
    inputSchema: { job: z.string(), wait_seconds: z.number().int().min(0).max(600).optional() },
  },
  tool(async ({ job, wait_seconds }) => {
    const j = getJob(job);
    if (!j.promptDone) throw new Error("Job is still running; verify after it finishes.");
    if (!j.opts?.verifyCommand) {
      const cfg = await readProjectConfig(j.worktree?.repo ?? j.directory);
      if (!cfg.verify) throw new Error(`No verify command configured. Add {"verify": "<command>"} to ${PROJECT_CONFIG} in the project root, then start jobs with verify:true.`);
      j.opts = { ...j.opts, verifyCommand: cfg.verify, verifyTimeout: cfg.verify_timeout_s };
    }
    const p = startVerify(j);
    const result = await Promise.race([p, sleep((wait_seconds ?? 120) * 1000).then(() => null)]);
    return result ?? { status: "running", note: "Still running; call verify(job, wait_seconds) again." };
  }),
);

mcp.registerTool(
  "review",
  {
    description:
      "Start a read-only review of a finished job's diff by another model (default: routing.review, else the job's own model). Returns a review job id: follow it with check(); " +
      "its result lists up to 8 findings (severity | file:line | issue | fix) and a VERDICT. Use before merging.",
    inputSchema: { job: z.string(), model: z.string().optional(), focus: z.string().optional().describe("Extra emphasis, e.g. 'security' or 'edge cases'") },
  },
  tool(async ({ job, model, focus }) => {
    const j = getJob(job);
    if (!j.promptDone) throw new Error("Job is still running; review after it finishes.");
    return startReview(j, { model, focus });
  }),
);

mcp.registerTool(
  "worktree_finish",
  {
    description:
      "For a job started with worktree:true. action 'merge' merges branch oc/<job> into the repo's current branch and removes the worktree; it refuses if the repo has uncommitted changes, the merge conflicts, " +
      "the diff contains secret-looking strings, or verification failed (override with force:true after showing the user). 'discard' deletes the worktree and branch; 'keep' leaves them. " +
      "Only merge or discard with the user's OK, after showing the diff.",
    inputSchema: { job: z.string(), action: z.enum(["merge", "discard", "keep"]), force: z.boolean().optional() },
  },
  tool(async ({ job, action, force }) => {
    const j = getJob(job);
    const wt = j.worktree;
    if (!wt) throw new Error(`${job} was not started with worktree:true`);
    if (action === "keep") return { ok: true, branch: wt.branch, path: wt.root };
    if (!j.promptDone) throw new Error("Job is still running; cancel it or wait before finishing the worktree.");
    if (action === "merge") {
      if (!force && j.verify?.status === "finished" && j.verify.passed === false) throw new Error("Verification FAILED for this job (see verify). Fix it with send_message, or pass force:true if the user accepts.");
      if (!force && j.verify?.status === "running") throw new Error("Verification is still running; wait for verify(job).");
      const dirty = (await git(wt.repo, "status", "--porcelain", "--untracked-files=no")).stdout.trim();
      if (dirty) throw new Error("The main repo has uncommitted changes; commit or stash them first.");
      // commit whatever opencode left in the worktree so it can be scanned and merged
      const wtDirty = (await git(wt.root, "status", "--porcelain")).stdout.split("\n").filter((l) => l.trim() && !JUNK_RE.test(l.slice(3))).join("\n");
      if (wtDirty) {
        await git(wt.root, "add", "-A", "--", ".", ...JUNK_PATHSPEC);
        await git(wt.root, "-c", "user.name=opencode", "-c", "user.email=opencode@localhost", "commit", "-m", `opencode job ${job}${j.label ? `: ${j.label}` : ""}`);
      }
      const base = (await git(wt.repo, "merge-base", "HEAD", wt.branch)).stdout.trim();
      const patch = (await git(wt.repo, "diff", base, wt.branch)).stdout;
      const findings = scanSecrets(patch);
      if (findings.length && !force) throw new Error(`Possible secrets in the diff (nothing merged): ${findings.slice(0, 8).map((f) => `${f.file}:${f.line} ${f.kind}`).join("; ")}. Review them; pass force:true only if they are false positives.`);
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
    persist();
    return { ok: true, action, branch: wt.branch };
  }),
);

// ----- stale worktree cleanup (list first, then remove with an explicit, user-approved call) -----
async function staleWorktrees({ older_than_hours, include_unmerged }) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(WORKTREE_ROOT);
  } catch {}
  for (const name of entries) {
    const dir = path.join(WORKTREE_ROOT, name);
    try {
      const gitFile = (await fs.readFile(path.join(dir, ".git"), "utf8")).trim();
      const repo = gitFile.replace(/^gitdir:\s*/, "").split("/.git/worktrees/")[0];
      const branch = (await git(dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
      const ageH = (Date.now() - (await fs.stat(dir)).mtimeMs) / 3600e3;
      const owner = [...jobs.values()].find((j) => j.worktree?.root === dir);
      const dirty = Boolean((await git(dir, "status", "--porcelain")).stdout.trim());
      const ahead = Number((await git(repo, "rev-list", "--count", `HEAD..${branch}`)).stdout.trim() || 0);
      const inUse = owner && !owner.finalized;
      const reason = inUse ? "job still running" : ageH < older_than_hours ? `younger than ${older_than_hours}h` : (dirty || ahead > 0) && !include_unmerged ? "has unmerged work" : null;
      out.push({ path: dir, repo, branch, job: owner?.id, age_hours: Math.round(ageH), uncommitted_changes: dirty, unmerged_commits: ahead, removable: reason === null, kept_because: reason ?? undefined });
    } catch (e) {
      out.push({ path: dir, removable: false, kept_because: `unreadable: ${String(e.message ?? e).slice(0, 80)}` });
    }
  }
  return out;
}

mcp.registerTool(
  "list_stale_worktrees",
  {
    description: "List leftover job worktrees (~/.opencode-navigator/worktrees) with whether each is safe to remove: removable means old enough, not in use and holding no unmerged work. Removes nothing.",
    inputSchema: { older_than_hours: z.number().min(0).optional(), include_unmerged: z.boolean().optional() },
  },
  tool(async ({ older_than_hours, include_unmerged }) => ({ worktrees: await staleWorktrees({ older_than_hours: older_than_hours ?? 24, include_unmerged: Boolean(include_unmerged) }), next: "remove_worktrees(paths) deletes the ones you pick (Claude Code asks the user)." })),
);

mcp.registerTool(
  "remove_worktrees",
  {
    description: "Delete leftover job worktrees and their branches. Claude Code shows the user an approval prompt. Paths must come from list_stale_worktrees; unmerged_ok:true is needed to delete worktrees holding unmerged work (use only if the user agrees).",
    inputSchema: { paths: z.array(z.string()).min(1), unmerged_ok: z.boolean().optional() },
    _meta: { "anthropic/requiresUserInteraction": true },
  },
  tool(async ({ paths, unmerged_ok }) => {
    const known = await staleWorktrees({ older_than_hours: 0, include_unmerged: Boolean(unmerged_ok) });
    const removed = [];
    const skipped = [];
    for (const p of paths) {
      const w = known.find((x) => x.path === path.resolve(p));
      if (!w) skipped.push({ path: p, why: "not a job worktree" });
      else if (!w.removable) skipped.push({ path: p, why: w.kept_because });
      else {
        await git(w.repo, "worktree", "remove", "--force", w.path);
        await git(w.repo, "branch", "-D", w.branch).catch(() => {});
        const owner = jobs.get(w.job);
        if (owner) owner.worktree = null;
        removed.push(w.path);
      }
    }
    persist();
    return { removed, skipped };
  }),
);

mcp.registerTool(
  "usage",
  {
    description: "Cost and token ledger: totals per model and overall for finished jobs, plus the cost of jobs still running. Optional since_hours window.",
    inputSchema: { since_hours: z.number().positive().optional() },
  },
  tool(async ({ since_hours }) => {
    let rows = [];
    try {
      rows = (await fs.readFile(LEDGER_FILE, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {}
    if (since_hours) rows = rows.filter((r) => Date.now() - Date.parse(r.ts) < since_hours * 3600e3);
    const byModel = {};
    for (const r of rows) {
      const m = (byModel[r.model] ??= { jobs: 0, cost: 0, input: 0, output: 0 });
      m.jobs++;
      m.cost += r.cost ?? 0;
      m.input += r.tokens?.input ?? 0;
      m.output += r.tokens?.output ?? 0;
    }
    const running = [...jobs.values()].filter((j) => !j.finalized).map((j) => ({ job: j.id, label: j.label, model: j.modelLabel, cost: j.lastCost ?? 0 }));
    return {
      jobs_finished: rows.length,
      total_cost_usd: Number(rows.reduce((a, r) => a + (r.cost ?? 0), 0).toFixed(6)),
      by_model: byModel,
      running,
      ledger_file: LEDGER_FILE,
    };
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
  { description: "Show how this bridge reaches the user (native dialogs or Claude Code prompts), settings, active jobs and where its files live.", inputSchema: {} },
  tool(async () => {
    const s = await readState();
    return {
      client: mcp.server.getClientVersion?.(),
      client_supports_dialogs: clientCanElicit(),
      approvals: await approvalMode(),
      default_mode: s.defaultMode ?? "ask",
      notifications: s.notifications !== false && process.platform === "darwin",
      jobs_total: jobs.size,
      jobs_running: [...jobs.values()].filter((j) => !j.finalized).length,
      max_parallel_jobs: MAX_RUNNING,
      routing: s.routing ?? {},
      data_dir: DATA_DIR,
      job_logs: LOG_DIR,
      results: RESULT_DIR,
      project_config_file: PROJECT_CONFIG,
      tip: "tail -f <job_logs>/<job>.log in a terminal to watch a job live",
    };
  }),
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
  "set_notifications",
  { description: "Turn macOS notifications on/off for job completion, verify results and approvals waiting.", inputSchema: { on: z.boolean() } },
  tool(async ({ on }) => {
    await writeState({ notifications: on });
    return { notifications: on };
  }),
);

await loadJobs();
if ([...jobs.values()].some((j) => !j.finalized)) ensureWatcher();
await mcp.connect(new StdioServerTransport());
