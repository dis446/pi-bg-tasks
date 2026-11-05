/**
 * pi-bg-tasks core — pi-independent task model, process runner, progress
 * parser, follower, wait and card rendering. Follows the background-task model
 * documented in https://github.com/1jehuang/jcode (docs/BACKGROUND_TASKS.md).
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
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
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

// ---------------------------------------------------------------- storage

/** Shared by every pi process on the machine; PI_BG_DIR overrides (tests). */
export function taskDir(): string {
  const dir = process.env.PI_BG_DIR || join(tmpdir(), "pi-bg-tasks");
  mkdirSync(dir, { recursive: true });
  return dir;
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
  writeFileSync(tmp, JSON.stringify(task, null, 2));
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
  try {
    return JSON.parse(readFileSync(statusPath(id), "utf-8")) as Task;
  } catch {
    return undefined;
  }
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

/** Remove terminal task files older than maxAgeHours; running tasks are skipped. */
export function cleanupTasks(maxAgeHours = 24, now = Date.now()): string[] {
  const removed: string[] = [];
  for (const t of listTasks()) {
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
  writeFileSync(outputPath, "");
  writeFileSync(cmdPath(id), opts.command);
  const child = spawn("bash", ["-c", WRAPPER], {
    cwd: opts.cwd,
    detached: true,
    stdio: "ignore",
    env: { ...(opts.env ?? process.env), PI_BG_CMD: cmdPath(id), PI_BG_OUT: outputPath, PI_BG_EXIT: exitPath },
  });
  if (child.pid === undefined) throw new Error(`failed to spawn bash for: ${opts.command}`);
  child.on("error", () => {}); // surfaced through the missing exit file instead
  return { id, pid: child.pid, child, outputPath, exitPath };
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

/** TERM the whole group, KILL it after the grace period. */
export async function killGroup(pid: number | undefined, graceMs = CANCEL_GRACE_MS): Promise<void> {
  if (!pid) return;
  const sig = (s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s);
    } catch {
      /* already gone */
    }
  };
  sig("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isAlive(pid)) await sleep(25);
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
  } else if (!isAlive(task.pid)) {
    finish(task, "failed", now, { error: "process exited without recording a status (killed or interrupted)" });
  } else if (task.timeoutSec && now - task.startedAt >= task.timeoutSec * 1000) {
    // record the verdict before signalling, so a concurrent follower cannot call it "killed"
    finish(task, "failed", now, { exitCode: 124, error: `timed out after ${task.timeoutSec}s` });
    if (writeTask(task)) await killGroup(task.pid);
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
    await killGroup(task.pid);
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

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function describeTask(t: Task, now = Date.now()): string {
  const dur = fmtDuration((t.finishedAt ?? now) - t.startedAt);
  const prog = t.progress ? ` · ${t.progress.percent !== undefined ? `${t.progress.percent}%` : ""}${t.progress.message ? ` ${t.progress.message}` : ""}` : "";
  const exit = t.exitCode !== undefined ? ` · exit ${t.exitCode}` : "";
  const err = t.error && t.status === "failed" ? ` · ${t.error}` : "";
  return `${t.id}\t${t.status}\t${t.label}\t${dur}${exit}${err}${prog}`;
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
  const preview = stripProgressMarkers(tailFile(t.outputPath, 4096).text).trim();
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
    label: t.label,
    state: t.status,
    percent: t.progress?.percent,
    message: t.progress?.message,
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
