/**
 * pi-bg-tasks core — pi-independent task model, process runner, progress
 * parser, follower, wait and card rendering. Follows the background-task model
 * of https://github.com/1jehuang/jcode.
 *
 * Every command runs as a detached process group (`setsid` via Node's
 * `detached: true`) whose wrapper shell appends stdout+stderr to
 * `<id>.output` and records the exit code in `<id>.exit`. Nothing is piped
 * through pi, so a task survives pi reload/exit and is reconciled from its
 * pid and exit file — the upstream "detached" ownership mode, used for every
 * task here.
 *
 * Only Node built-ins here: the unit tests run with plain `node --test`.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------- types

export type TaskStatus = "running" | "completed" | "failed";

export interface Progress {
  percent?: number;
  current?: number;
  total?: number;
  unit?: string;
  message?: string;
  etaSeconds?: number;
  kind: "determinate" | "indeterminate" | "checkpoint";
}

export interface TaskEvent {
  at: number;
  kind: "progress" | "checkpoint" | "stall" | "status";
  message: string;
}

export interface Task {
  id: string;
  label: string;
  command: string;
  cwd: string;
  /** pi session id that owns delivery for this task. */
  owner: string;
  pid?: number;
  /** Process start identity at spawn, so a reused pid is never signalled or adopted. */
  pidStart?: string;
  status: TaskStatus;
  exitCode?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** Kill the process group after this many seconds (from startedAt). */
  timeoutSec?: number;
  progress?: Progress;
  events: TaskEvent[];
  notify: boolean;
  wake: boolean;
  stallWakeSeconds?: number;
  /** Completion already delivered to the owning session (never re-sent on resume). */
  delivered?: boolean;
  origin: "background" | "handoff";
  /** Still owned by a foreground bash call: the session monitor neither follows nor delivers it. */
  foreground?: boolean;
  outputPath: string;
  exitPath: string;
}

export const MAX_EVENTS = 50;
export const MIN_STALL_SECONDS = 30;
export const CANCEL_GRACE_MS = 400;
/** Longest single unterminated line kept between follower passes. */
export const PARTIAL_MAX = 8 * 1024;
/** Above this, a task file keeps only its tail. PI_BG_MAX_OUTPUT_BYTES overrides. */
export function outputCapBytes(): number {
  const n = Number(process.env.PI_BG_MAX_OUTPUT_BYTES);
  return Number.isFinite(n) && n >= 64 * 1024 ? n : 64 * 1024 * 1024;
}
/** Bytes kept when an output file is capped. */
export const OUTPUT_KEEP_BYTES = 1024 * 1024;
/** Largest status record accepted from disk. */
export const STATUS_MAX_BYTES = 256 * 1024;

// ---------------------------------------------------------------- storage

/** Shared by every pi process of this user; PI_BG_DIR overrides (tests). */
export function taskDir(): string {
  const explicit = process.env.PI_BG_DIR;
  return privateDir(explicit || join(tmpdir(), "pi-bg-tasks"), explicit !== undefined);
}

/** Set once if the shared path is squatted, so every call agrees on the fallback. */
let fallbackDir: string | undefined;

/**
 * The task dir holds command text and output, so it is private to this user:
 * created 0700, tightened when an older version or a loose umask left it open,
 * and never used when another user created it first (symlink/plant attacks).
 */
function privateDir(preferred: string, explicit: boolean): string {
  mkdirSync(preferred, { recursive: true, mode: 0o700 });
  const st = statSync(preferred);
  const uid = process.getuid?.();
  if (uid === undefined || st.uid === uid) {
    if ((st.mode & 0o077) !== 0) {
      try {
        chmodSync(preferred, 0o700);
      } catch {
        /* tighten below via a private fallback */
      }
    }
    if ((statSync(preferred).mode & 0o077) === 0) return preferred;
  }
  if (explicit) throw new Error(`PI_BG_DIR is not private to uid ${uid}: ${preferred}`);
  // Someone else created the shared path: use a fresh directory we own instead.
  fallbackDir ??= mkdtempSync(join(tmpdir(), "pi-bg-tasks-"));
  return fallbackDir;
}

/** Task ids are file-name fragments, never paths. */
const TASK_ID = /^[0-9a-z]{1,32}$/;
export const isValidId = (id: string): boolean => TASK_ID.test(id);

/**
 * Create or replace a file we own without following a symlink and without
 * inheriting another file's mode: O_EXCL refuses an existing entry, so a
 * planted link is removed instead of written through.
 */
function writePrivate(path: string, data: string): void {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = openSync(path, flags, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    unlinkSync(path); // a stale file or a planted symlink: drop the entry, keep the target
    fd = openSync(path, flags, 0o600);
  }
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

export const statusPath = (id: string): string => join(taskDir(), `${id}.status.json`);

/** Short unique id: base36 time tail plus random characters. */
export function newTaskId(): string {
  const t = Date.now().toString(36).slice(-5);
  const r = Math.random().toString(36).slice(2, 5).padEnd(3, "0");
  return `${t}${r}`;
}

/**
 * Atomic write so a concurrent reader never sees a half-written status.
 * A terminal status on disk is never replaced by a different outcome (a stale
 * `running` snapshot, or a follower's "process vanished" racing a cancel);
 * only the same outcome may be re-written, e.g. to set `delivered`.
 * Returns false when the write was refused.
 */
export function writeTask(task: Task): boolean {
  const p = statusPath(task.id);
  const cur = readTask(task.id);
  if (cur && cur.status !== "running" && (task.status === "running" || task.finishedAt !== cur.finishedAt)) return false;
  const tmp = `${p}.${process.pid}.tmp`;
  writePrivate(tmp, JSON.stringify(task, null, 2));
  renameSync(tmp, p);
  return true;
}

/** Set `delivered` (and release foreground ownership) on the on-disk record; never touches the outcome. */
export function markDelivered(id: string): void {
  const t = readTask(id);
  if (t && (!t.delivered || t.foreground)) {
    t.delivered = true;
    t.foreground = false;
    writeTask(t);
  }
}

export function readTask(id: string): Task | undefined {
  if (!isValidId(id)) return undefined; // ids index the directory, they never address paths
  const p = statusPath(id);
  let t: Task;
  try {
    // A record is data, not a command: bounded in size, `__proto__` stays a key.
    if (statSync(p).size > STATUS_MAX_BYTES) return undefined;
    const raw = readFileSync(p, "utf-8");
    t = JSON.parse(raw, (k, v) => (k === "__proto__" ? undefined : v)) as Task;
  } catch {
    return undefined;
  }
  if (!t || typeof t !== "object") return undefined;
  // Records are data, not commands: paths are derived from the id on every read,
  // so a record can never point reads, deletes or signals outside this directory.
  t.id = id;
  t.outputPath = join(taskDir(), `${id}.output`);
  t.exitPath = join(taskDir(), `${id}.exit`);
  if (!Number.isInteger(t.pid) || (t.pid as number) <= 0) delete t.pid;
  if (typeof t.pidStart !== "string") delete t.pidStart;
  return t;
}

export function listTasks(owner?: string): Task[] {
  const out: Task[] = [];
  for (const f of readdirSync(taskDir())) {
    if (!f.endsWith(".status.json")) continue;
    const t = readTask(f.slice(0, -".status.json".length));
    if (t && (!owner || t.owner === owner)) out.push(t);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** Remove terminal task files older than maxAgeHours; running tasks are skipped. `owner` limits the sweep. */
export function cleanupTasks(maxAgeHours = 24, now = Date.now(), owner?: string): string[] {
  const removed: string[] = [];
  for (const t of listTasks(owner)) {
    if (t.status === "running") continue;
    if (now - (t.finishedAt ?? t.startedAt) < maxAgeHours * 3_600_000) continue;
    for (const p of [statusPath(t.id), t.outputPath, t.exitPath, cmdPath(t.id)]) rmSync(p, { force: true });
    removed.push(t.id);
  }
  return removed;
}

export function pushEvent(task: Task, kind: TaskEvent["kind"], message: string, at = Date.now()): void {
  task.events.push({ at, kind, message });
  if (task.events.length > MAX_EVENTS) task.events.splice(0, task.events.length - MAX_EVENTS);
}

// ---------------------------------------------------------------- process

export const cmdPath = (id: string): string => join(taskDir(), `${id}.cmd`);

// The command lives in a file, not argv/env, so its size is unbounded (ARG_MAX).
const WRAPPER = `cmd=$PI_BG_CMD; out=$PI_BG_OUT; ex=$PI_BG_EXIT
unset PI_BG_CMD PI_BG_OUT PI_BG_EXIT
bash "$cmd" >>"$out" 2>&1 </dev/null
ec=$?
printf '%s' "$ec" >"$ex.tmp" && mv -f "$ex.tmp" "$ex"
exit $ec`;

export interface Spawned {
  id: string;
  pid: number;
  /** Process start identity; compared before any signal so a reused pid is left alone. */
  pidStart?: string;
  child: ChildProcess;
  outputPath: string;
  exitPath: string;
}

/** Start `command` in its own process group, output appended to `<id>.output`. */
export function spawnProcess(opts: {
  id?: string;
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Spawned {
  const id = opts.id ?? newTaskId();
  const dir = taskDir();
  const outputPath = join(dir, `${id}.output`);
  const exitPath = join(dir, `${id}.exit`);
  writePrivate(outputPath, "");
  writePrivate(cmdPath(id), opts.command);
  const child = spawn("bash", ["-c", WRAPPER], {
    cwd: opts.cwd,
    detached: true,
    stdio: "ignore",
    env: { ...(opts.env ?? process.env), PI_BG_CMD: cmdPath(id), PI_BG_OUT: outputPath, PI_BG_EXIT: exitPath },
  });
  if (child.pid === undefined) throw new Error(`failed to spawn bash for: ${opts.command}`);
  child.on("error", () => {}); // surfaced through the missing exit file instead
  return { id, pid: child.pid, pidStart: processStartId(child.pid), child, outputPath, exitPath };
}

/**
 * Start identity of a live process: /proc starttime on Linux, `ps -o lstart`
 * elsewhere. A pid plus this value names one process, across pid reuse.
 */
export function processStartId(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // field 22 (starttime); fields 3.. follow the last ")\n", so index 19 is field 22
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (start) return `linux:${start}`;
  } catch {
    /* not Linux */
  }
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? `ps:${out}` : undefined;
  } catch {
    return undefined;
  }
}

/** The task's own process, not a stranger that inherited its pid. */
export function isOurProcess(pid: number | undefined, pidStart?: string): boolean {
  if (!pid || !isAlive(pid)) return false;
  if (!pidStart) return true; // record predates identity tracking
  return processStartId(pid) === pidStart;
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** TERM the whole group, KILL it after the grace period. Never signals a reused pid. */
export async function killGroup(pid: number | undefined, graceMs = CANCEL_GRACE_MS, pidStart?: string): Promise<void> {
  if (!pid) return;
  const sig = (s: NodeJS.Signals) => {
    if (!isOurProcess(pid, pidStart)) return;
    try {
      process.kill(-pid, s);
    } catch {
      /* already gone */
    }
  };
  sig("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isOurProcess(pid, pidStart)) await sleep(25);
  sig("SIGKILL");
}

export function readExitCode(exitPath: string): number | undefined {
  try {
    const n = Number.parseInt(readFileSync(exitPath, "utf-8").trim(), 10);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Last `maxBytes` of a file as text (whole file when smaller). */
export function tailFile(path: string, maxBytes = 64 * 1024): { text: string; size: number } {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { text: "", size: 0 };
  }
  const start = Math.max(0, size - maxBytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  let text = buf.toString("utf-8");
  if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
  return { text, size };
}

/**
 * Keep only the tail of an oversized output file. In place, because the task
 * still writes through its own O_APPEND descriptor: the next write lands at the
 * new end of file, so nothing is lost for good.
 * shortcut: a concurrent append during the rewrite can be cut, at most one
 * monitor tick's worth; upgrade to a capping writer process if that matters.
 */
export function capOutput(path: string, size: number, cap = outputCapBytes()): boolean {
  if (size <= cap) return false;
  const keep = Math.min(size, OUTPUT_KEEP_BYTES);
  const start = size - keep;
  const buf = Buffer.alloc(keep);
  const notice = Buffer.from(`\n[pi-bg-tasks: output passed ${cap} bytes; older output dropped, tail kept]\n`);
  const fd = openSync(path, "r+");
  try {
    readSync(fd, buf, 0, keep, start);
    let text = buf.toString("utf-8");
    text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
    const body = Buffer.from(text, "utf-8");
    writeSync(fd, notice, 0, notice.length, 0);
    writeSync(fd, body, 0, body.length, notice.length);
    ftruncateSync(fd, notice.length + body.length);
  } finally {
    closeSync(fd);
  }
  return true;
}

export function tailLines(text: string, n: number): string {
  const lines = text.replace(/\n$/, "").split("\n");
  return lines.slice(-n).join("\n");
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- progress

const MARKER = /^\s*(?:PI|JCODE)_(PROGRESS|CHECKPOINT)\s+(.*)$/;
const PHASE = /^\s*(Compiling|Downloading|Building|Linking|Resolving|Fetching|Installing)\b\s*(.*)$/;
const PERCENT = /(?:^|[\s(\[])(\d{1,3}(?:\.\d+)?)\s?%/;
const RATIO = /(?:^|[\s(\[])(\d+(?:\.\d+)?)\s*(?:\/|\bof\b)\s*(\d+(?:\.\d+)?)(?:\s*([A-Za-z]+))?/;

export interface ProgressUpdate {
  progress: Progress;
  /** Line was an explicit PI_/JCODE_ marker. */
  marker: boolean;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;

/** Counts are authoritative, percent clamped, a measurable indeterminate becomes determinate. */
export function normalizeProgress(raw: Partial<Progress>): Progress {
  const p: Progress = { kind: raw.kind ?? "indeterminate" };
  if (raw.message) p.message = String(raw.message).slice(0, 200);
  if (raw.unit) p.unit = String(raw.unit);
  if (raw.etaSeconds !== undefined) p.etaSeconds = raw.etaSeconds;
  if (raw.current !== undefined) p.current = raw.current;
  if (raw.total !== undefined) p.total = raw.total;
  let percent = raw.percent;
  if (raw.current !== undefined && raw.total !== undefined && raw.total > 0) percent = (raw.current / raw.total) * 100;
  if (percent !== undefined) {
    p.percent = Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10;
    if (p.kind === "indeterminate") p.kind = "determinate";
  }
  return p;
}

/** Parse one output line into a progress/checkpoint update, or undefined. */
export function parseProgressLine(line: string): ProgressUpdate | undefined {
  const m = MARKER.exec(line);
  if (m) {
    const [, which, payload] = m;
    let obj: Record<string, unknown> | undefined;
    try {
      const v = JSON.parse(payload);
      if (v && typeof v === "object") obj = v as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    if (which === "CHECKPOINT") {
      const message = obj ? String(obj.message ?? "") : payload.trim();
      return { marker: true, progress: normalizeProgress({ kind: "checkpoint", message }) };
    }
    if (!obj) return undefined; // malformed marker: ordinary output
    const checkpoint = obj.checkpoint === true || obj.kind === "checkpoint";
    return {
      marker: true,
      progress: normalizeProgress({
        kind: checkpoint ? "checkpoint" : obj.kind === "indeterminate" ? "indeterminate" : "determinate",
        percent: num(obj.percent),
        current: num(obj.current),
        total: num(obj.total),
        unit: typeof obj.unit === "string" ? obj.unit : undefined,
        message: typeof obj.message === "string" ? obj.message : undefined,
        etaSeconds: num(obj.eta_seconds),
      }),
    };
  }
  const text = line.trim();
  if (!text) return undefined;
  const pct = PERCENT.exec(text);
  if (pct) {
    const v = Number(pct[1]);
    if (v <= 100) return { marker: false, progress: normalizeProgress({ percent: v, message: text.slice(0, 80) }) };
  }
  const ratio = RATIO.exec(text);
  if (ratio) {
    const current = Number(ratio[1]);
    const total = Number(ratio[2]);
    // current > total rejects dates and versions such as 2026/11/05
    if (total > 0 && current <= total)
      return { marker: false, progress: normalizeProgress({ current, total, unit: ratio[3], message: text.slice(0, 80) }) };
  }
  const phase = PHASE.exec(text);
  if (phase) return { marker: false, progress: normalizeProgress({ kind: "indeterminate", message: text.slice(0, 80) }) };
  return undefined;
}

/** A phase-only update keeps the last known percentage instead of dropping to 0. */
export function mergeProgress(prev: Progress | undefined, next: Progress): Progress {
  if (next.percent === undefined && prev?.percent !== undefined && next.kind !== "checkpoint")
    return { ...next, percent: prev.percent, kind: "determinate" };
  return next;
}

// ---------------------------------------------------------------- follower

/** Per-task, in-memory follower state (not persisted). */
export interface FollowState {
  offset: number;
  partial: string;
  lastActivityAt: number;
  stallFired: boolean;
}

export const newFollowState = (task: Task, now = Date.now()): FollowState => ({
  offset: 0,
  partial: "",
  lastActivityAt: now,
  stallFired: false,
});

export interface AdvanceResult {
  changed: boolean;
  progressed: boolean;
  finished: boolean;
  stalled: boolean;
}

/**
 * One follower pass: read new output, apply progress, detect exit, vanished
 * process, timeout and stall. Mutates and persists `task` when it changed.
 */
export async function advance(task: Task, st: FollowState, now = Date.now()): Promise<AdvanceResult> {
  const r: AdvanceResult = { changed: false, progressed: false, finished: false, stalled: false };
  if (task.status !== "running") return r;

  // 1. new output since the last pass (bounded per pass)
  let size = 0;
  try {
    size = statSync(task.outputPath).size;
  } catch {
    /* missing output file: treated below via liveness */
  }
  if (size > st.offset) {
    // cap before reading: a runaway command must not fill the disk
    if (capOutput(task.outputPath, size)) st.offset = 0;
    const len = Math.min(size - st.offset, 1024 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(task.outputPath, "r");
    try {
      readSync(fd, buf, 0, len, st.offset);
    } finally {
      closeSync(fd);
    }
    st.offset += len;
    st.lastActivityAt = now;
    st.stallFired = false;
    const lines = (st.partial + buf.toString("utf-8")).split("\n");
    st.partial = lines.pop() ?? "";
    // a command that never emits a newline must not grow pi's heap
    if (st.partial.length > PARTIAL_MAX) st.partial = st.partial.slice(-PARTIAL_MAX);
    for (const line of lines) {
      const u = parseProgressLine(line);
      if (!u) continue;
      task.progress = mergeProgress(task.progress, u.progress);
      if (u.progress.kind === "checkpoint" || u.marker)
        pushEvent(task, u.progress.kind === "checkpoint" ? "checkpoint" : "progress", u.progress.message ?? `${u.progress.percent ?? "?"}%`, now);
      r.progressed = true;
      r.changed = true;
    }
  }

  // 2. terminal transitions
  // Another follower may already have finalized it (cancel, a concurrent wait): adopt that verdict.
  const disk = readTask(task.id);
  if (disk && disk.status !== "running") {
    Object.assign(task, disk);
    return { ...r, changed: true, finished: true };
  }
  const code = readExitCode(task.exitPath);
  if (code !== undefined) {
    finish(task, code === 0 ? "completed" : "failed", now, { exitCode: code, error: code === 0 ? undefined : `exit code ${code}` });
  } else if (!isOurProcess(task.pid, task.pidStart)) {
    finish(task, "failed", now, { error: "process exited without recording a status (killed or interrupted)" });
  } else if (task.timeoutSec && now - task.startedAt >= task.timeoutSec * 1000) {
    // record the verdict before signalling, so a concurrent follower cannot call it "killed"
    finish(task, "failed", now, { exitCode: 124, error: `timed out after ${task.timeoutSec}s` });
    if (writeTask(task)) await killGroup(task.pid, CANCEL_GRACE_MS, task.pidStart);
    else Object.assign(task, readTask(task.id));
    return { ...r, changed: true, finished: true };
  } else if (task.stallWakeSeconds && !st.stallFired && now - st.lastActivityAt >= task.stallWakeSeconds * 1000) {
    st.stallFired = true;
    r.stalled = true;
    pushEvent(task, "stall", `no output for ${task.stallWakeSeconds}s`, now);
    r.changed = true;
  }
  if (task.status !== "running") {
    r.finished = true;
    r.changed = true;
  }
  if (r.changed && !writeTask(task)) {
    // lost a race to another writer (cancel): adopt the on-disk outcome
    Object.assign(task, readTask(task.id));
    r.finished = task.status !== "running";
  }
  return r;
}

export function finish(task: Task, status: Exclude<TaskStatus, "running">, now: number, o: { exitCode?: number; error?: string }): void {
  task.status = status;
  task.finishedAt = now;
  if (o.exitCode !== undefined) task.exitCode = o.exitCode;
  if (o.error !== undefined) task.error = o.error;
  pushEvent(task, "status", o.error ?? status, now);
}

/** Cancel: terminal `failed` "Cancelled by user", process group killed. */
export async function cancelTask(task: Task): Promise<Task> {
  if (task.status === "running") {
    task.foreground = false;
    finish(task, "failed", Date.now(), { error: "Cancelled by user" });
    task.delivered = true; // cancellation publishes no completion event
    writeTask(task);
    await killGroup(task.pid, CANCEL_GRACE_MS, task.pidStart);
  }
  return task;
}

/**
 * Terminal reconciliation for tasks no live session follows (owner gone, or
 * read from another session): drain the output so progress/checkpoint events
 * are kept, then apply the exit state.
 */
export async function settle(task: Task, now = Date.now()): Promise<Task> {
  if (task.status !== "running" || task.foreground) return task;
  await advance(task, newFollowState(task, now), now);
  return task;
}

// ---------------------------------------------------------------- wait

export type WaitMode = "any" | "all" | "first_failure";

export interface WaitOptions {
  mode?: WaitMode;
  timeoutSec?: number;
  returnOnProgress?: boolean;
  signal?: AbortSignal;
  pollMs?: number;
}

export interface WaitOutcome {
  reason: "finished" | "progress" | "stall" | "timeout" | "aborted" | "missing";
  tasks: Task[];
}

const progressKey = (t: Task) => `${t.events.length}:${t.events.at(-1)?.at ?? 0}`;

/** Block until the wait condition holds. Reads status files, so it works across processes. */
export async function waitTasks(ids: string[], o: WaitOptions = {}): Promise<WaitOutcome> {
  const mode = o.mode ?? "any";
  const deadline = Date.now() + Math.min(Math.max(o.timeoutSec ?? 60, 0), 3600) * 1000;
  const returnOnProgress = o.returnOnProgress ?? true;
  const initial = new Map<string, string>();
  for (;;) {
    const tasks = ids.map((id) => readTask(id));
    if (tasks.some((t) => !t)) return { reason: "missing", tasks: tasks.filter(Boolean) as Task[] };
    const ts = tasks as Task[];
    const done = ts.filter((t) => t.status !== "running");
    if (mode === "first_failure" && ts.some((t) => t.status === "failed")) return { reason: "finished", tasks: ts };
    if (mode === "any" ? done.length > 0 : done.length === ts.length) return { reason: "finished", tasks: ts };
    for (const t of ts) {
      const k = progressKey(t);
      if (!initial.has(t.id)) initial.set(t.id, k);
      else if (initial.get(t.id) !== k) {
        const last = t.events.at(-1);
        if (last?.kind === "stall") return { reason: "stall", tasks: ts };
        if (returnOnProgress && (last?.kind === "progress" || last?.kind === "checkpoint")) return { reason: "progress", tasks: ts };
      }
    }
    if (o.signal?.aborted) return { reason: "aborted", tasks: ts };
    for (const t of ts) await settle(t); // a task nobody follows still reaches a terminal status
    if (Date.now() >= deadline) return { reason: "timeout", tasks: ts };
    await sleep(o.pollMs ?? 200);
  }
}

// ---------------------------------------------------------------- text

/** Control characters and escape sequences never reach the terminal. */
export function stripControl(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "") // OSC (window title, hyperlinks)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI (colors, cursor, erase)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""); // remaining C0 and DEL
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function describeTask(t: Task, now = Date.now()): string {
  const dur = fmtDuration((t.finishedAt ?? now) - t.startedAt);
  const prog = t.progress
    ? ` · ${t.progress.percent !== undefined ? `${t.progress.percent}%` : ""}${t.progress.message ? ` ${stripControl(t.progress.message)}` : ""}`
    : "";
  const exit = t.exitCode !== undefined ? ` · exit ${t.exitCode}` : "";
  const err = t.error && t.status === "failed" ? ` · ${stripControl(t.error)}` : "";
  return `${t.id}\t${t.status}\t${stripControl(t.label)}\t${dur}${exit}${err}${prog}`;
}

/** Explicit progress/checkpoint markers are plumbing; they never reach the model. */
export function stripProgressMarkers(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*(?:PI|JCODE)_(?:PROGRESS|CHECKPOINT)\s/.test(l))
    .join("\n");
}

/** Message for the model when a task finishes: status, 500-char output preview, file path. */
export function completionText(t: Task): string {
  const preview = stripControl(stripProgressMarkers(tailFile(t.outputPath, 4096).text)).trim();
  const short = preview.length > 500 ? `…${preview.slice(-500)}` : preview;
  const head =
    t.status === "completed"
      ? `Background task ${t.id} (${t.label}) completed in ${fmtDuration((t.finishedAt ?? Date.now()) - t.startedAt)}.`
      : `Background task ${t.id} (${t.label}) FAILED${t.error ? `: ${t.error}` : ""} after ${fmtDuration((t.finishedAt ?? Date.now()) - t.startedAt)}.`;
  return `${head}\nOutput preview:\n${short || "(no output)"}\nFull output: ${t.outputPath}`;
}

// ---------------------------------------------------------------- card

export interface Row {
  id: string;
  label: string;
  state: TaskStatus;
  percent?: number;
  message?: string;
  startedAt: number;
  finishedAt?: number;
  updatedAt: number;
}

export const ROW_LIMIT = 8;
export const SUCCESS_LINGER_MS = 12_000;

export function rowFromTask(t: Task, now = Date.now()): Row {
  return {
    id: t.id,
    label: stripControl(t.label),
    state: t.status,
    percent: t.progress?.percent,
    message: t.progress?.message === undefined ? undefined : stripControl(t.progress.message),
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    updatedAt: t.finishedAt ?? t.events.at(-1)?.at ?? t.startedAt ?? now,
  };
}

/** Retention: running always, successes 12 s, failures until the 8-row cap pushes them out. */
export function retainRows(rows: Row[], now = Date.now()): Row[] {
  const kept = rows
    .filter((r) => !(r.state === "completed" && now - (r.finishedAt ?? now) > SUCCESS_LINGER_MS))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const running = kept.filter((r) => r.state === "running");
  const rest = kept.filter((r) => r.state !== "running").slice(0, Math.max(0, ROW_LIMIT - running.length));
  return [...running, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function bar(percent: number, cells = 6): string {
  const exact = (Math.min(100, Math.max(0, percent)) / 100) * cells;
  const full = Math.floor(exact);
  const half = exact - full >= 0.5 && full < cells ? 1 : 0;
  return "━".repeat(full) + "╺".repeat(half) + "─".repeat(cells - full - half);
}

export type Fg = (color: "accent" | "success" | "error" | "muted" | "dim" | "text" | "warning", text: string) => string;

/** Card lines (unstyled width is the caller's job). `max` rows, rest collapsed to "+N more". */
export function renderCard(rows: Row[], fg: Fg, now = Date.now(), max = 6): string[] {
  if (rows.length === 0) return [];
  const running = rows.filter((r) => r.state === "running").length;
  const lines = [fg("accent", "⏳ Background") + fg("muted", ` · ${running} running`)];
  for (const r of rows.slice(0, max)) {
    const icon = r.state === "running" ? fg("accent", "◌") : r.state === "completed" ? fg("success", "✓") : fg("error", "×");
    let tail: string;
    if (r.state === "failed") tail = fg("error", "failed");
    else if (r.state === "completed") tail = fg("success", bar(100)) + fg("muted", ` 100%`);
    else if (r.percent !== undefined) tail = fg("accent", bar(r.percent)) + fg("muted", ` ${String(Math.round(r.percent)).padStart(3)}%`);
    else tail = fg("dim", fmtDuration(now - r.startedAt));
    const msg = r.state === "running" && r.message ? fg("dim", `  ${r.message}`) : "";
    lines.push(`${icon} ${fg("text", r.label)}  ${tail}${msg}`);
  }
  if (rows.length > max) lines.push(fg("dim", `+${rows.length - max} more`));
  return lines;
}
