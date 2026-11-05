// Unit tests for core.ts — run: node --test pi/agent/extensions/bg-tasks/test/
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.PI_BG_DIR = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
const tdir = process.env.PI_BG_DIR;
void tdir;
const core = await import("../core.ts");
const {
  advance, bar, cancelTask, cleanupTasks, cmdPath, isAlive, isValidId, killGroup, listTasks, markDelivered, mergeProgress,
  newFollowState, newTaskId, normalizeProgress, parseProgressLine, processStartId, readTask, renderCard, retainRows,
  describeTask, rowFromTask, settle, sleep, spawnProcess, stripControl, taskDir, waitTasks, writeTask,
} = core;
type Task = import("../core.ts").Task;

function mkTask(command: string, extra: Partial<Task> = {}): Task {
  const sp = spawnProcess({ command, cwd: process.cwd() });
  sp.child.unref();
  const t: Task = {
    id: sp.id, label: command, command, cwd: process.cwd(), owner: "test", pid: sp.pid, status: "running",
    startedAt: Date.now(), events: [], notify: true, wake: false, origin: "background",
    outputPath: sp.outputPath, exitPath: sp.exitPath, ...extra,
  };
  writeTask(t);
  return t;
}

async function runToEnd(t: Task, limitMs = 10_000) {
  const st = newFollowState(t);
  const end = Date.now() + limitMs;
  while (t.status === "running" && Date.now() < end) {
    await advance(t, st);
    await sleep(30);
  }
  return st;
}

// ------------------------------------------------------------ progress parsing

test("explicit PI_/JCODE_ markers", () => {
  const a = parseProgressLine('PI_PROGRESS {"percent":42,"message":"Compiling"}')!;
  assert.equal(a.marker, true);
  assert.equal(a.progress.percent, 42);
  assert.equal(a.progress.kind, "determinate");
  const b = parseProgressLine('JCODE_PROGRESS {"current":7,"total":20,"unit":"tests"}')!;
  assert.equal(b.progress.percent, 35);
  assert.equal(b.progress.unit, "tests");
  assert.equal(parseProgressLine('PI_PROGRESS {"kind":"indeterminate","message":"lock"}')!.progress.kind, "indeterminate");
  assert.equal(parseProgressLine("PI_CHECKPOINT db migrated")!.progress.kind, "checkpoint");
  assert.equal(parseProgressLine("PI_CHECKPOINT db migrated")!.progress.message, "db migrated");
  assert.equal(parseProgressLine('PI_PROGRESS {"checkpoint":true,"message":"x"}')!.progress.kind, "checkpoint");
  assert.equal(parseProgressLine('PI_CHECKPOINT {"message":"json cp"}')!.progress.message, "json cp");
});

test("malformed marker is ordinary output", () => {
  assert.equal(parseProgressLine("PI_PROGRESS {not json"), undefined);
});

test("heuristics: percent, ratio, 'of', phase; rejects dates and >100%", () => {
  assert.equal(parseProgressLine("downloading 42%")!.progress.percent, 42);
  assert.equal(parseProgressLine("[3/4] building")!.progress.percent, 75);
  assert.equal(parseProgressLine("7 of 20 tests")!.progress.percent, 35);
  assert.equal(parseProgressLine("1.5/4 GiB")!.progress.unit, "GiB");
  assert.equal(parseProgressLine("Compiling myproject v0.1")!.progress.kind, "indeterminate");
  assert.equal(parseProgressLine("released 2026/11/05"), undefined);
  assert.equal(parseProgressLine("cpu 250%"), undefined);
  assert.equal(parseProgressLine("hello world"), undefined);
  assert.equal(parseProgressLine("   "), undefined);
});

test("normalization: counts beat percent, clamp, indeterminate+percent becomes determinate", () => {
  assert.equal(normalizeProgress({ current: 2, total: 10, percent: 80 }).percent, 20);
  assert.equal(normalizeProgress({ percent: 150 }).percent, 100);
  assert.equal(normalizeProgress({ percent: -5 }).percent, 0);
  assert.equal(normalizeProgress({ kind: "indeterminate", percent: 30 }).kind, "determinate");
});

test("phase-only update keeps the last percentage", () => {
  const prev = normalizeProgress({ percent: 60 });
  const next = mergeProgress(prev, normalizeProgress({ kind: "indeterminate", message: "Linking" }));
  assert.equal(next.percent, 60);
  assert.equal(next.message, "Linking");
  assert.equal(mergeProgress(prev, normalizeProgress({ kind: "checkpoint", message: "c" })).percent, undefined);
});

// ------------------------------------------------------------ card

test("bar and card rendering", () => {
  assert.equal(bar(0), "░░░░░░");
  assert.equal(bar(100), "██████");
  assert.equal(bar(42), "██▌░░░");
  const fg = (_c: string, s: string) => s;
  const now = Date.now();
  const rows = [
    { id: "a", label: "cargo test", state: "running" as const, percent: 42, startedAt: now, updatedAt: now },
    { id: "b", label: "cargo build", state: "completed" as const, startedAt: now - 5000, finishedAt: now, updatedAt: now - 1 },
    { id: "c", label: "lint", state: "failed" as const, startedAt: now, finishedAt: now, updatedAt: now - 2 },
  ];
  const lines = renderCard(rows, fg, now);
  assert.equal(lines[0], "⏳ Background · 1 running");
  assert.match(lines[1], /^◌ cargo test {2}██▌░░░ {2}42%/);
  assert.match(lines[2], /^✓ cargo build {2}██████ 100%/);
  assert.match(lines[3], /^× lint {2}failed/);
  const many = Array.from({ length: 8 }, (_, i) => ({ ...rows[0], id: `r${i}`, label: `t${i}` }));
  const l2 = renderCard(many, fg, now);
  assert.equal(l2.length, 1 + 6 + 1);
  assert.equal(l2.at(-1), "+2 more");
  assert.deepEqual(renderCard([], fg), []);
});

test("row retention: success lingers 12s, running always kept, cap 8", () => {
  const now = 1_000_000;
  const r = (id: string, state: "running" | "completed" | "failed", finishedAt?: number, updatedAt = now) => ({
    id, label: id, state, startedAt: 0, finishedAt, updatedAt,
  });
  const kept = retainRows([r("ok-old", "completed", now - 13_000), r("ok-new", "completed", now - 1000), r("bad", "failed", now - 999_999)], now);
  assert.deepEqual(kept.map((x) => x.id).sort(), ["bad", "ok-new"]);
  const flood = [
    ...Array.from({ length: 6 }, (_, i) => r(`run${i}`, "running", undefined, now - 100 * i)),
    ...Array.from({ length: 5 }, (_, i) => r(`fail${i}`, "failed", now, now - i)),
  ];
  const k2 = retainRows(flood, now);
  assert.equal(k2.length, 8);
  assert.equal(k2.filter((x) => x.state === "running").length, 6);
});

// ------------------------------------------------------------ processes

test("success: output captured, progress parsed, exit 0", async () => {
  const t = mkTask('echo hello; echo \'PI_PROGRESS {"percent":50,"message":"half"}\'; echo "3/4 done" >&2');
  await runToEnd(t);
  assert.equal(t.status, "completed");
  assert.equal(t.exitCode, 0);
  const out = readFileSync(t.outputPath, "utf-8");
  assert.match(out, /hello/);
  assert.match(out, /3\/4 done/); // stderr merged
  assert.equal(t.progress?.percent, 75);
  assert.ok(t.events.some((e) => e.kind === "progress" && e.message === "half"));
  assert.equal(readTask(t.id)?.status, "completed");
});

test("failure: non-zero exit code", async () => {
  const t = mkTask("echo boom; exit 3");
  await runToEnd(t);
  assert.equal(t.status, "failed");
  assert.equal(t.exitCode, 3);
  assert.match(t.error!, /exit code 3/);
});

test("large commands are not limited by argv size", async () => {
  const big = `x='${"a".repeat(300_000)}'; echo \${#x}`;
  const t = mkTask(big);
  await runToEnd(t);
  assert.equal(t.status, "completed");
  assert.match(readFileSync(t.outputPath, "utf-8"), /300000/);
});

test("timeout kills the whole process group", async () => {
  const t = mkTask("sleep 30 & sleep 30; echo never", { timeoutSec: 1 });
  const childPid = t.pid!;
  await runToEnd(t, 5000);
  assert.equal(t.status, "failed");
  assert.equal(t.exitCode, 124);
  assert.match(t.error!, /timed out/);
  await sleep(100);
  assert.equal(isAlive(childPid), false);
  assert.doesNotMatch(readFileSync(t.outputPath, "utf-8"), /never/);
});

test("cancel: terminal failed 'Cancelled by user', marked delivered, group dead, not overwritten by follower", async () => {
  const t = mkTask("sleep 30");
  const st = newFollowState(t);
  await advance(t, st);
  // a follower holding a stale running snapshot must not clobber the cancel
  const stale: Task = JSON.parse(JSON.stringify(t));
  await cancelTask(t);
  assert.equal(t.status, "failed");
  assert.equal(t.error, "Cancelled by user");
  assert.equal(readTask(t.id)?.delivered, true);
  await sleep(100);
  assert.equal(isAlive(t.pid), false);
  await advance(stale, newFollowState(stale));
  assert.equal(readTask(t.id)?.error, "Cancelled by user");
  assert.equal(stale.error, "Cancelled by user"); // follower adopted the on-disk outcome
});

test("writeTask refuses to replace a terminal status", () => {
  const t = mkTask("true");
  const done = { ...t, status: "completed" as const, finishedAt: 1, exitCode: 0 };
  assert.equal(writeTask(done), true);
  assert.equal(writeTask({ ...t, status: "running" }), false);
  assert.equal(writeTask({ ...done, status: "failed", finishedAt: 2 }), false);
  assert.equal(writeTask({ ...done, delivered: true }), true); // same outcome may be re-written
  assert.equal(readTask(t.id)?.delivered, true);
});

test("vanished process without exit file fails", async () => {
  const t = mkTask("sleep 30");
  process.kill(-t.pid!, "SIGKILL");
  await sleep(100);
  await advance(t, newFollowState(t));
  assert.equal(t.status, "failed");
  assert.match(t.error!, /without recording/);
});

test("stall fires once per silence episode and re-arms on activity", async () => {
  const t = mkTask("sleep 30", { stallWakeSeconds: 30 });
  const st = newFollowState(t, 0);
  const now = Date.now();
  st.lastActivityAt = now - 31_000;
  assert.equal((await advance(t, st, now)).stalled, true);
  assert.equal((await advance(t, st, now + 1000)).stalled, false);
  writeFileSync(t.outputPath, "activity\n", { flag: "a" });
  await advance(t, st, now + 2000); // resets
  assert.equal(st.stallFired, false);
  assert.equal((await advance(t, st, now + 33_000)).stalled, true);
  assert.equal(t.events.filter((e) => e.kind === "stall").length, 2);
  await cancelTask(t);
});

test("detached task survives its spawner and is reconciled by settle()", async () => {
  // spawned by a separate node process that exits immediately — pi exiting mid-task
  const script = `
    process.env.PI_BG_DIR = ${JSON.stringify(process.env.PI_BG_DIR)};
    const c = await import(${JSON.stringify(new URL("../core.ts", import.meta.url).href)});
    const sp = c.spawnProcess({ command: "sleep 0.5; echo survived", cwd: "/" });
    c.writeTask({ id: sp.id, label: "x", command: "x", cwd: "/", owner: "gone", pid: sp.pid, status: "running",
      startedAt: Date.now(), events: [], notify: true, wake: false, origin: "background", outputPath: sp.outputPath, exitPath: sp.exitPath });
    sp.child.unref();
    console.log(sp.id);
  `;
  const { execFileSync } = await import("node:child_process");
  const id = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf-8" }).trim();
  assert.equal(readTask(id)?.status, "running");
  await sleep(1200);
  const t = await settle(readTask(id)!);
  assert.equal(t.status, "completed");
  assert.match(readFileSync(t.outputPath, "utf-8"), /survived/);
});

test("settle() leaves foreground-owned tasks alone", async () => {
  const t = mkTask("true", { foreground: true });
  t.pid = 999_999_999; // definitely not alive
  writeTask(t);
  assert.equal((await settle(readTask(t.id)!)).status, "running");
});

// ------------------------------------------------------------ wait

test("wait any / all / first_failure / timeout / progress / missing", async () => {
  const fast = mkTask("sleep 0.2");
  const slow = mkTask("sleep 1.5");
  const bad = mkTask("sleep 0.3; exit 1");
  // nothing follows these tasks: waitTasks must settle them itself
  let o = await waitTasks([fast.id, slow.id], { mode: "any", timeoutSec: 5, pollMs: 50 });
  assert.equal(o.reason, "finished");
  assert.equal(o.tasks.find((t) => t.id === fast.id)?.status, "completed");
  o = await waitTasks([slow.id, bad.id], { mode: "first_failure", timeoutSec: 5, pollMs: 50 });
  assert.equal(o.reason, "finished");
  assert.equal(o.tasks.find((t) => t.id === slow.id)?.status, "running");
  o = await waitTasks([slow.id], { mode: "all", timeoutSec: 0.2, pollMs: 50 });
  assert.equal(o.reason, "timeout");
  o = await waitTasks([fast.id, slow.id], { mode: "all", timeoutSec: 5, pollMs: 50 });
  assert.equal(o.reason, "finished");
  assert.ok(o.tasks.every((t) => t.status === "completed"));
  assert.equal((await waitTasks(["nope"], { timeoutSec: 1 })).reason, "missing");

  const prog = mkTask("sleep 0.3; echo 'PI_PROGRESS {\"percent\":10}'; sleep 5");
  const st = newFollowState(prog);
  const follower = (async () => {
    for (let i = 0; i < 40 && prog.status === "running"; i++) {
      await advance(prog, st);
      await sleep(50);
    }
  })();
  o = await waitTasks([prog.id], { timeoutSec: 5, pollMs: 50 });
  assert.equal(o.reason, "progress");
  await cancelTask(prog);
  await follower;

  const ac = new AbortController();
  const long = mkTask("sleep 5");
  const w = waitTasks([long.id], { timeoutSec: 5, pollMs: 50, signal: ac.signal });
  ac.abort();
  assert.equal((await w).reason, "aborted");
  await cancelTask(long);
});

test("markDelivered, listTasks by owner, cleanup skips running", async () => {
  const done = mkTask("true", { owner: "o1" });
  const running = mkTask("sleep 30", { owner: "o1" });
  await runToEnd(done);
  markDelivered(done.id);
  assert.equal(readTask(done.id)?.delivered, true);
  assert.ok(listTasks("o1").every((t) => t.owner === "o1"));
  assert.equal(listTasks("o1").length, 2);
  const removed = cleanupTasks(0, Date.now() + 1000);
  assert.ok(removed.includes(done.id));
  assert.ok(!removed.includes(running.id));
  assert.equal(readTask(done.id), undefined);
  await cancelTask(running);
});

test("ids are short and unique", () => {
  const ids = new Set(Array.from({ length: 500 }, () => newTaskId()));
  assert.ok(ids.size > 490);
  for (const id of ids) assert.match(id, /^[0-9a-z]{8}$/);
});

test("rowFromTask carries progress and terminal state", () => {
  const now = Date.now();
  const t = { id: "x", label: "l", status: "running", startedAt: now, events: [], progress: { kind: "determinate", percent: 30, message: "m" } } as unknown as Task;
  const r = rowFromTask(t, now);
  assert.equal(r.percent, 30);
  assert.equal(r.state, "running");
  assert.equal(rowFromTask({ ...t, status: "failed", finishedAt: now + 5 }, now).updatedAt, now + 5);
});

// ------------------------------------------------------------ security regressions

const priv = (p: string) => (statSync(p).mode & 0o077) === 0;

test("task dir is private: a loose directory is tightened and files are 0600", async () => {
  const loose = mkdtempSync(join(tmpdir(), "pi-bg-loose-"));
  chmodSync(loose, 0o777);
  await withEnv("PI_BG_DIR", loose, () => {
    const sp = spawnProcess({ command: "echo hi", cwd: process.cwd() });
    sp.child.unref();
    assert.ok(priv(loose), "directory is not group/other accessible");
    assert.ok(priv(sp.outputPath), "output file is private");
    assert.ok(priv(cmdPath(sp.id)), "command file is private (it holds the command text)");
  });
});

test("a planted symlink is removed, never written through", async () => {
  const dir = taskDir();
  const target = join(dir, `target-${Date.now()}`);
  writeFileSync(target, "keep");
  const id = "planted1";
  symlinkSync(target, join(dir, `${id}.cmd`));
  const sp = spawnProcess({ id, command: "echo x", cwd: process.cwd() });
  sp.child.unref();
  assert.equal(readFileSync(target, "utf-8"), "keep", "symlink target untouched");
  assert.ok(!statSync(join(dir, `${id}.cmd`)).isSymbolicLink(), "planted link replaced by a real file");
  rmSync(target, { force: true });
});

test("pid identity: a reused pid is never adopted or signalled", async () => {
  const sp = spawnProcess({ command: "sleep 30", cwd: process.cwd() });
  sp.child.unref();
  assert.ok(sp.pidStart, "spawn records a start identity");
  const t: Task = {
    id: sp.id, label: "sleep 30", command: "sleep 30", cwd: process.cwd(), owner: "test", pid: sp.pid,
    pidStart: `${sp.pidStart}-bogus`, status: "running", startedAt: Date.now(), events: [], notify: true,
    wake: false, origin: "background", outputPath: sp.outputPath, exitPath: sp.exitPath,
  };
  writeTask(t);
  // the live process belongs to somebody else now (pid reuse): settle must not touch it
  const settled = await settle(readTask(t.id)!);
  assert.equal(settled.status, "failed");
  assert.match(settled.error!, /without recording a status/);
  await killGroup(sp.pid, 100, `${sp.pidStart}-bogus`);
  assert.ok(isAlive(sp.pid), "a mismatched identity is never signalled");
  // with the real identity the group is killed
  await killGroup(sp.pid, 100, sp.pidStart);
  assert.ok(!isAlive(sp.pid));
});

test("records cannot point reads or deletes outside the task dir", async () => {
  const dir = taskDir();
  const victim = join(dir, `victim-${Date.now()}`);
  writeFileSync(victim, "keep");
  const id = "forged01";
  writeFileSync(
    join(dir, `${id}.status.json`),
    JSON.stringify({
      id, label: "forged", command: "x", cwd: "/", owner: "test", pid: 1, status: "completed",
      startedAt: 0, finishedAt: 0, events: [], notify: false, wake: false, origin: "background",
      outputPath: victim, exitPath: "/etc/passwd",
    }),
  );
  const t = readTask(id)!;
  assert.equal(t.outputPath, join(dir, `${id}.output`));
  assert.equal(t.exitPath, join(dir, `${id}.exit`));
  cleanupTasks(0, Date.now() + 1000);
  assert.equal(readFileSync(victim, "utf-8"), "keep", "a forged outputPath is never deleted");
  rmSync(victim, { force: true });
});

test("task ids are never paths", () => {
  for (const bad of ["../../etc/passwd", "a/b", "x.status.json", "..", "A1"]) assert.equal(isValidId(bad), false, bad);
  assert.equal(readTask("../../etc/passwd"), undefined);
  assert.equal(readTask("abc/def"), undefined);
  assert.equal(isValidId(newTaskId()), true);
});

/** Run `fn` with a different PI_BG_DIR, restoring it afterwards. */
async function withEnv(key: string, value: string, fn: () => Promise<void> | void) {
  const prev = process.env[key];
  process.env[key] = value;
  try {
    await fn();
  } finally {
    process.env[key] = prev;
  }
}

test("a command with no newline cannot grow the partial buffer", async () => {
  const t = mkTask("printf 'x%.0s' $(seq 1 200000)"); // 200 KB, one line
  const st = newFollowState(t);
  await runToEnd(t, 20_000);
  assert.equal(t.status, "completed");
  assert.ok(st.partial.length <= 8192, `partial buffer bounded (${st.partial.length})`);
});

test("an oversized output file keeps only its tail", async () => {
  await withEnv("PI_BG_MAX_OUTPUT_BYTES", "65536", async () => {
    const t = mkTask("seq 1 400000"); // ~2.6 MB
    const st = newFollowState(t);
    await runToEnd(t, 30_000);
    assert.equal(t.status, "completed");
    assert.ok(statSync(t.outputPath).size < 1.5 * 1024 * 1024, `output capped (${statSync(t.outputPath).size})`);
    const text = readFileSync(t.outputPath, "utf-8");
    assert.match(text, /output passed 65536 bytes; older output dropped/);
    assert.match(text, /\n400000\n?$/, "the tail survived");
  });
});

test("an oversized status record is ignored", () => {
  const id = "bigrec01";
  const t: Task = {
    id, label: "x", command: "x", cwd: "/", owner: "test", status: "completed", startedAt: 0, finishedAt: 0,
    events: [], notify: false, wake: false, origin: "background",
    outputPath: join(taskDir(), `${id}.output`), exitPath: join(taskDir(), `${id}.exit`),
  };
  writeFileSync(join(taskDir(), `${id}.status.json`), JSON.stringify({ ...t, error: "x".repeat(300 * 1024) }));
  assert.equal(readTask(id), undefined);
});

test("escape sequences are stripped before text reaches the terminal", () => {
  assert.equal(stripControl("a\u001b[31mb\u001b[0m\u0007c"), "abc");
  assert.equal(stripControl("\u001b]0;title\u0007ok"), "ok");
  assert.equal(stripControl("plain\ttext\nnext"), "plain\ttext\nnext", "tabs and newlines are text");
  const t = { id: "x", label: "\u001b[2Jwiped", status: "running", startedAt: 0, events: [] } as unknown as Task;
  assert.equal(rowFromTask(t, 0).label, "wiped");
  assert.match(describeTask({ ...t, progress: { kind: "determinate", message: "\u001b[31mred" } } as Task, 0), /red$/);
});
