// Extension-level tests: the real factory driven through a fake ExtensionAPI.
// Covers what a print-mode SDK session cannot: the TUI card, auto/manual
// handoff, reload survival, wait suppression, renderers and /bg.
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.PI_BG_DIR = mkdtempSync(join(tmpdir(), "pi-bg-ext-"));
const { createBgTasks } = await import("../index.ts");
const { isAlive, listTasks, readTask, renderCard, sleep } = await import("../core.ts");
type Task = import("../core.ts").Task;

// ------------------------------------------------------------ harness

let sessionSeq = 0;
function harness(opts: Parameters<typeof createBgTasks>[0] = {}, sessionId = `sess${++sessionSeq}`) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const renderers = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const sent: { msg: any; opts: any }[] = [];
  const pi = {
    on: (ev: string, h: Function) => (handlers.set(ev, [...(handlers.get(ev) ?? []), h]), () => {}),
    registerTool: (def: any) => tools.set(def.name, def),
    registerCommand: (name: string, o: any) => commands.set(name, o),
    registerShortcut: (k: string, o: any) => shortcuts.set(k, o),
    registerMessageRenderer: (t: string, r: any) => renderers.set(t, r),
    registerProvider: () => {},
    registerFlag: () => {},
    sendMessage: (msg: any, o: any) => sent.push({ msg, opts: o }),
    sendUserMessage: (text: any, o: any) => sent.push({ msg: { content: text }, opts: o }),
    events: { on: () => () => {}, emit: () => {} },
  };
  createBgTasks({ autoBackgroundMs: 80, tickMs: 30, ...opts })(pi as any);

  const widgets = new Map<string, any>();
  const statuses = new Map<string, string | undefined>();
  const notices: string[] = [];
  let renders = 0;
  const ctx: any = {
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/tmp/${sessionId}.jsonl` },
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    model: { provider: "p", id: "m" },
    thinkingLevel: "medium",
    isIdle: () => true,
    ui: {
      theme: { fg: (_c: string, s: string) => s },
      setWidget: (k: string, v: any) => (v === undefined ? widgets.delete(k) : widgets.set(k, v)),
      setStatus: (k: string, v: string | undefined) => statuses.set(k, v),
      notify: (m: string) => notices.push(m),
    },
  };
  const emit = async (ev: string, event: any = {}, c = ctx) => {
    for (const h of handlers.get(ev) ?? []) await h(event, c);
  };
  const cardLines = (width = 80): string[] => {
    const w = widgets.get("bg-tasks");
    if (typeof w !== "function") return [];
    const comp = w({ requestRender: () => renders++ }, ctx.ui.theme);
    return comp.render(width);
  };
  return { sessionId, pi, tools, commands, shortcuts, renderers, handlers, sent, widgets, statuses, notices, ctx, emit, cardLines, renders: () => renders };
}

const run = (tool: any, params: any, ctx: any, signal?: AbortSignal) => tool.execute("call-1", params, signal, undefined, ctx);
const start = (h: ReturnType<typeof harness>) => h.emit("session_start", { reason: "startup" });
const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await sleep(20);
  return fn();
};

// ------------------------------------------------------------ background bash

test("background bash: card, footer, completion delivery, no double run", async () => {
  const h = harness();
  await start(h);
  const r = await run(h.tools.get("bash"), { command: "echo out; sleep 0.4", run_in_background: true }, h.ctx);
  const text = r.content[0].text as string;
  assert.match(text, /Started background task [0-9a-z]{8}/);
  const id = r.structuredContent.task_id as string;
  assert.equal(r.structuredContent.exit_code, -1);

  await until(() => h.widgets.has("bg-tasks"));
  const lines = h.cardLines();
  assert.equal(lines[0], "⏳ Background · 1 running");
  assert.match(lines[1], /^◌ echo out; sleep 0\.4/);
  assert.equal(h.statuses.get("bg-tasks"), "⏳ 1 bg");

  // progress + completion
  await until(() => readTask(id)?.status === "completed");
  const t = readTask(id)!;
  assert.equal(t.status, "completed");
  assert.equal(t.exitCode, 0);
  assert.equal(t.foreground, false);
  assert.equal(t.delivered, true);
  const msg = h.sent.find((s) => (s.msg as any).customType === "bg-task");
  assert.ok(msg, "completion message delivered");
  assert.equal(msg!.opts.deliverAs, "nextTurn"); // notify only: no turn started
  assert.match(msg!.msg.content, /completed in/);
  assert.match(msg!.msg.content, /Full output: /);
  assert.equal(h.notices.pop()!.includes("done"), true);
  await until(() => h.statuses.get("bg-tasks") === undefined);
  assert.match(h.cardLines()[1], /^✓ echo out; sleep 0\.4 {2}━━━━━━ 100%/);
});

test("background bash failures stay in the card and report the exit code", async () => {
  const h = harness();
  await start(h);
  await run(h.tools.get("bash"), { command: "echo bad; exit 7", run_in_background: true }, h.ctx);
  await until(() => h.sent.some((s) => (s.msg as any).customType === "bg-task"));
  const msg = h.sent.find((s) => (s.msg as any).customType === "bg-task")!;
  assert.match(msg.msg.content, /FAILED: exit code 7/);
  assert.match(h.cardLines()[1], /^× echo bad; exit 7 {2}failed/);
});

test("wake: true starts a turn instead of waiting for the next prompt", async () => {
  const h = harness();
  await start(h);
  await run(h.tools.get("bash"), { command: "true", run_in_background: true, wake: true }, h.ctx);
  await until(() => h.sent.some((s) => (s.msg as any).customType === "bg-task"));
  assert.deepEqual(h.sent.find((s) => (s.msg as any).customType === "bg-task")!.opts, { triggerTurn: true, deliverAs: "steer" });
});

// ------------------------------------------------------------ foreground bash

test("foreground bash keeps the built-in result shape and never shows in the card", async () => {
  const h = harness();
  await start(h);
  const out: string[] = [];
  const tool = h.tools.get("bash");
  const r = await tool.execute("call-9", { command: "echo hi; echo err >&2" }, undefined, (u: any) => out.push(String(u.content?.[0]?.text ?? "")), h.ctx);
  assert.equal(r.content[0].text, "hi\nerr\n");
  assert.equal(r.structuredContent.exit_code, 0);
  assert.equal(r.structuredContent.output, "hi\nerr\n");
  assert.ok(r.structuredContent.wall_time_seconds >= 0);
  assert.equal(h.widgets.size, 0);
  const [t] = listTasks(h.sessionId);
  assert.equal(t.status, "completed");
  assert.equal(t.delivered, true);
  assert.equal(t.foreground, false);
});

test("foreground failure is an error result with the built-in wording", async () => {
  const h = harness();
  await start(h);
  const r = await run(h.tools.get("bash"), { command: "exit 2" }, h.ctx);
  assert.equal((r as any).isError, true);
  assert.match(r.content[0].text, /Command exited with code 2$/);
});

test("foreground timeout is reported, not silently backgrounded", async () => {
  const h = harness({ autoBackgroundMs: 5000 });
  await start(h);
  await assert.rejects(run(h.tools.get("bash"), { command: "sleep 20", timeout: 0.3 }, h.ctx), /timed out after 0\.3 seconds/);
});

test("output is truncated to the tail and points at the task file", async () => {
  const h = harness({ autoBackgroundMs: 5000 });
  await start(h);
  const r = await run(h.tools.get("bash"), { command: `for i in $(seq 1 3000); do echo line$i; done` }, h.ctx);
  const text = r.content[0].text as string;
  assert.match(text, /^line\d+\n/);
  assert.match(text, /\[Showing the last 2000 lines/);
  assert.ok(!text.includes("line1\n"));
  assert.ok((r as any).details.fullOutputPath);
  assert.equal((r as any).details.truncation.truncated, true);
});

// ------------------------------------------------------------ handoff

test("auto handoff: past the budget the still-running command becomes a task, no rerun", async () => {
  const h = harness({ autoBackgroundMs: 150 });
  await start(h);
  const started = Date.now();
  const r = await run(h.tools.get("bash"), { command: "sleep 0.8; echo late", run_in_background: false }, h.ctx);
  const took = Date.now() - started;
  assert.ok(took < 700, `returned quickly (${took}ms), the command keeps running`);
  assert.match(r.content[0].text, /moved to background task [0-9a-z]{8} after 150ms/);
  assert.match(r.content[0].text, /Do NOT rerun the command/);
  const id = r.structuredContent.task_id as string;
  assert.equal(readTask(id)!.status, "running");
  assert.equal(readTask(id)!.origin, "handoff");
  await until(() => readTask(id)?.status === "completed");
  const out = await run(h.tools.get("bg"), { action: "output", task_id: id }, h.ctx);
  assert.match(out.content[0].text, /late/);
  const body = out.content[0].text.split("\n").filter((l: string) => !l.startsWith("── "));
  assert.deepEqual(body.filter((l: string) => l.trim() !== ""), ["late"], "command ran exactly once");
});

test("manual handoff key backgrounds the running command", async () => {
  const h = harness({ autoBackgroundMs: 0 });
  await start(h);
  const p = run(h.tools.get("bash"), { command: "sleep 1.5; echo done" }, h.ctx);
  await sleep(200);
  await h.shortcuts.get("alt+shift+b").handler(h.ctx);
  const r = await p;
  assert.match(r.content[0].text, /moved to background task .* on request/);
});

test("/bg handoff backgrounds the running command (shortcut-independent path)", async () => {
  const h = harness({ autoBackgroundMs: 0 });
  await start(h);
  const p = run(h.tools.get("bash"), { command: "sleep 1.5; echo done" }, h.ctx);
  await sleep(150);
  await h.commands.get("bg").handler("handoff", h.ctx);
  assert.match((await p).content[0].text, /moved to background task .* on request/);
  assert.match(h.notices.at(-1)!, /moving 1 running command/);
  await h.commands.get("bg").handler("handoff", h.ctx);
  assert.match(h.notices.at(-1)!, /no foreground bash command/);
});

test("reload: a running foreground command is handed off and resumed by the next incarnation", async () => {
  const h = harness({ autoBackgroundMs: 0 });
  await start(h);
  const p = run(h.tools.get("bash"), { command: "sleep 0.8; echo survived reload" }, h.ctx);
  await sleep(150);
  await h.emit("session_shutdown", { reason: "reload" });
  const r = await p;
  assert.match(r.content[0].text, /because pi is reloading/);
  const id = r.structuredContent.task_id as string;
  // no delivery attempt during shutdown; the old ctx is stale
  assert.equal(h.sent.filter((s) => (s.msg as any).customType === "bg-task").length, 0);
  assert.equal(readTask(id)!.delivered, undefined);

  // next incarnation of the same session
  const h2 = harness({ autoBackgroundMs: 0 }, h.sessionId);
  await start(h2);
  const note = h2.sent.find((s) => (s.msg as any).customType === "bg-task-note");
  assert.ok(note, "resumed task reported to the agent");
  assert.match(note!.msg.content, /still running/);
  assert.match(note!.msg.content, /do not rerun/);
  await until(() => h2.sent.some((s) => (s.msg as any).customType === "bg-task"));
  assert.match(h2.sent.find((s) => (s.msg as any).customType === "bg-task")!.msg.content, /survived reload/);
});

test("a task that died while pi was away is settled and delivered on session start", async () => {
  const h = harness();
  await start(h);
  const { spawnProcess, writeTask, readExitCode } = await import("../core.ts");
  const sp = spawnProcess({ command: "sleep 30", cwd: process.cwd() });
  writeTask({
    id: sp.id, label: "nightly build", command: "sleep 30", cwd: process.cwd(), owner: "sBackfill", pid: sp.pid,
    status: "running", startedAt: Date.now() - 100, events: [], notify: true, wake: false, origin: "background",
    outputPath: sp.outputPath, exitPath: sp.exitPath,
  });
  process.kill(-sp.pid!, "SIGKILL"); // no exit file: the crash case
  await until(() => !isAlive(sp.pid));
  assert.equal(readExitCode(sp.exitPath), undefined);
  assert.equal(readTask(sp.id)!.status, "running", "the record stays stale until a session settles it");

  const h2 = harness({}, "sBackfill");
  await start(h2);
  const msg = h2.sent.find((s) => (s.msg as any).customType === "bg-task");
  assert.ok(msg, "failure reported");
  assert.match(msg!.msg.content, /nightly build/);
  assert.match(msg!.msg.content, /FAILED/);
  assert.equal(readTask(sp.id)!.status, "failed");
  assert.equal(readTask(sp.id)!.delivered, true);
  assert.equal(h2.sent.some((s) => (s.msg as any).customType === "bg-task-note"), false);
});

test("abort cancels as a failure, never as a background task", async () => {
  const h = harness({ autoBackgroundMs: 0 });
  await start(h);
  const ac = new AbortController();
  const p = run(h.tools.get("bash"), { command: "sleep 5" }, h.ctx, ac.signal);
  await sleep(150);
  ac.abort();
  await assert.rejects(p, /Command aborted/);
  const [t] = listTasks(h.sessionId);
  assert.equal(t.status, "failed");
  assert.match(t.error!, /Cancelled by user/);
});

// ------------------------------------------------------------ bg tool

test("bg list/status/tail/watch/cleanup/cancel", async () => {
  const h = harness({}, "bgtool");
  await start(h);
  const bg = h.tools.get("bg");
  assert.match((await run(bg, { action: "list", session_only: true }, h.ctx)).content[0].text, /no background tasks/);

  const r = await run(h.tools.get("bash"), { command: "echo 'PI_PROGRESS {\"percent\":30,\"message\":\"working\"}'; sleep 5", run_in_background: true }, h.ctx);
  const id = r.structuredContent.task_id as string;
  await until(() => readTask(id)?.progress?.percent === 30);

  const list = await run(bg, { action: "list", session_only: true }, h.ctx);
  assert.match(list.content[0].text, new RegExp(`${id}\\trunning`));
  assert.match(list.content[0].text, /30%/);

  const st = await run(bg, { action: "status" }, h.ctx); // auto-resolves the only running task
  assert.match(st.content[0].text, /command: echo/);
  assert.match(st.content[0].text, /delivery: notify=true wake=false/);

  const tail = await run(bg, { action: "tail", task_id: id, lines: 5 }, h.ctx);
  const tailBody = (tail.content[0].text as string).split("\n").filter((l) => !l.startsWith("── ")).join("\n");
  assert.doesNotMatch(tailBody, /PI_PROGRESS/, "marker lines are plumbing, not output");

  const watch = await run(bg, { action: "watch", task_id: id, wake: true, stall_wake_seconds: 10 }, h.ctx);
  assert.match(watch.content[0].text, /wake=true stall=30s/); // clamped to the 30s minimum

  const canc = await run(bg, { action: "cancel", task_id: id }, h.ctx);
  assert.match(canc.content[0].text, /failed \(Cancelled by user\)/);
  assert.equal(readTask(id)!.delivered, true);

  const clean = await run(bg, { action: "cleanup", max_age_hours: 0 }, h.ctx);
  assert.match(clean.content[0].text, /removed \d+ task/);
  assert.equal(readTask(id), undefined);

  assert.match((await run(bg, { action: "status", task_id: "zzzz" }, h.ctx) as any).content[0].text, /unknown task id/);
  assert.equal((await run(bg, { action: "status", task_id: "zzzz" }, h.ctx) as any).isError, true);
});

test("bg wait: progress wakes the wait, completion delivers once, no duplicate notice", async () => {
  const h = harness({ autoBackgroundMs: 5000 });
  await start(h);
  const r = await run(h.tools.get("bash"), { command: "sleep 0.3; echo 'PI_PROGRESS {\"percent\":50}'; sleep 0.3; echo end", run_in_background: true }, h.ctx);
  const id = r.structuredContent.task_id as string;
  const bg = h.tools.get("bg");
  const w1 = await run(bg, { action: "wait", task_id: id, timeout_seconds: 5 }, h.ctx);
  assert.match(w1.content[0].text, /^Returned on a progress update/);
  const w2 = await run(bg, { action: "wait", task_id: id, timeout_seconds: 5, return_on_progress: false }, h.ctx);
  assert.match(w2.content[0].text, /^Wait finished\./);
  assert.match(w2.content[0].text, /completed in/);
  await sleep(300);
  assert.equal(h.sent.filter((s) => (s.msg as any).customType === "bg-task").length, 0, "the wait result was the delivery");
  assert.equal(readTask(id)!.delivered, true);
});

test("bg wait timeout leaves the task running; multiple running tasks need an id", async () => {
  const h = harness();
  await start(h);
  const bg = h.tools.get("bg");
  const a = await run(h.tools.get("bash"), { command: "sleep 5", run_in_background: true }, h.ctx);
  const b = await run(h.tools.get("bash"), { command: "sleep 5", run_in_background: true }, h.ctx);
  const ambiguous = await run(bg, { action: "status" }, h.ctx);
  assert.equal((ambiguous as any).isError, true);
  assert.match(ambiguous.content[0].text, /2 running tasks/);
  const w = await run(bg, { action: "wait", task_ids: [a.structuredContent.task_id, b.structuredContent.task_id], wait_mode: "all", timeout_seconds: 0.2 }, h.ctx);
  assert.match(w.content[0].text, /timed out/);
  for (const id of [a.structuredContent.task_id, b.structuredContent.task_id]) await run(bg, { action: "cancel", task_id: id }, h.ctx);
});

// ------------------------------------------------------------ wait_for

test("wait_for polls until the condition holds, then wakes the session", async () => {
  const h = harness();
  await start(h);
  const counter = join(process.env.PI_BG_DIR!, "counter");
  const r = await run(
    h.tools.get("wait_for"),
    { command: `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; [ "$n" -ge 2 ]`, description: "deploy uat", interval_seconds: 5, timeout_seconds: 30 },
    h.ctx,
  );
  const id = r.details.task_id as string;
  const t = readTask(id)!;
  assert.equal(t.label, "deploy uat");
  assert.equal(t.command.startsWith("n=$(cat"), true, "status shows the check, not the loop");
  assert.equal(t.wake, true);
  // first check fails, the loop retries (interval 5s/weekly) — shorten by inspecting the wrapper output
  const w = await run(h.tools.get("bg"), { action: "wait", task_id: id, timeout_seconds: 8, return_on_progress: false }, h.ctx);
  assert.match(w.content[0].text, /Wait finished/);
  const done = readTask(id)!;
  assert.equal(done.status, "completed");
  assert.match(readFileSync(done.outputPath, "utf-8"), /condition met on check 2/);
  await run(h.tools.get("bg"), { action: "status", task_id: id }, h.ctx);
  assert.equal(readTask(id)!.delivered, true);
});

test("wait_for timeout fails the task with the timeout error", async () => {
  const h = harness();
  await start(h);
  const r = await run(h.tools.get("wait_for"), { command: "false", description: "never", interval_seconds: 5, timeout_seconds: 0.2 }, h.ctx);
  const id = r.details.task_id as string;
  await run(h.tools.get("bg"), { action: "wait", task_id: id, timeout_seconds: 5 }, h.ctx);
  const t = readTask(id)!;
  assert.equal(t.status, "failed");
  assert.match(t.error!, /timed out after 0\.2s/);
});

// ------------------------------------------------------------ renderers + command

test("message renderer: compact on success, diagnostic on failure, raw when unknown", () => {
  const h = harness();
  const render = h.renderers.get("bg-task");
  const theme = { fg: (_c: string, s: string) => s };
  const make = (t: Partial<Task>, kind = "completion") => ({ content: "x", details: { task: t, kind } });
  const base: Task = {
    id: "abc12345", label: "cargo test", command: "cargo test", cwd: "/", owner: "s1", status: "completed",
    startedAt: 1000, finishedAt: 5000, exitCode: 0, events: [], notify: true, wake: false,
    origin: "background", outputPath: join(process.env.PI_BG_DIR!, "abc12345.output"), exitPath: "/x",
  };
  writeFileSync(base.outputPath, "test result: ok. 12 passed\n");
  const line = render(make(base), { expanded: false }, theme).render(200).join("\n").trimEnd();
  assert.equal(line, "✓ cargo test · 4s · abc12345");
  const expanded = render(make(base), { expanded: true }, theme).render(200).join("\n");
  assert.match(expanded, /test result: ok/);
  const failed = render(make({ ...base, status: "failed", exitCode: 1, error: "exit code 1" }), { expanded: false }, theme).render(200).join("\n");
  assert.match(failed, /^× cargo test · exit 1 · 4s · abc12345/);
  assert.match(failed, /exit code 1/);
  const stalled = render(make(base, "stall"), { expanded: false }, theme).render(200).join("\n");
  assert.match(stalled, /^⚠ cargo test · stalled/);
  assert.equal(render({ content: "plain" }, { expanded: false }, theme).render(200).join("\n").trimEnd(), "plain");
});

test("/bg toggles the card, lists, cancels and clears", async () => {
  const h = harness();
  await start(h);
  await run(h.tools.get("bash"), { command: "sleep 5", run_in_background: true }, h.ctx);
  await until(() => h.widgets.has("bg-tasks"));
  const bg = h.commands.get("bg");
  await bg.handler("", h.ctx);
  assert.equal(h.widgets.has("bg-tasks"), false);
  assert.equal(h.renderers.size, 1);
  await bg.handler("", h.ctx);
  assert.equal(h.widgets.has("bg-tasks"), true);
  await bg.handler("list", h.ctx);
  assert.match(h.notices.at(-1)!, /running/);
  const id = listTasks(h.sessionId)[0].id;
  await bg.handler(`cancel ${id}`, h.ctx);
  assert.equal(readTask(id)!.status, "failed");
  await bg.handler("clear", h.ctx);
  assert.equal(h.widgets.has("bg-tasks"), false);
  await bg.handler("bogus", h.ctx);
  assert.match(h.notices.at(-1)!, /usage: \/bg/);
});

test("requests a redraw instead of rebuilding the widget on every tick", async () => {
  const h = harness();
  await start(h);
  await run(h.tools.get("bash"), { command: "sleep 5; echo 'PI_PROGRESS {\"percent\":10}'", run_in_background: true }, h.ctx);
  await until(() => h.widgets.has("bg-tasks"));
  h.cardLines(); // first render binds requestRender
  const before = h.renders();
  await sleep(200);
  assert.ok(h.renders() > before, "widget invalidated in place");
  const [t] = listTasks(h.sessionId);
  await run(h.tools.get("bg"), { action: "cancel", task_id: t.id }, h.ctx);
});

test("card truncates to the available width and clears when nothing is left", async () => {
  const h = harness();
  await start(h);
  const fg = (_c: string, s: string) => s;
  const rows = [{ id: "a", label: "a-very-long-label-that-will-not-fit", state: "running" as const, percent: 5, startedAt: Date.now(), updatedAt: Date.now() }];
  const width = 20;
  assert.deepEqual(renderCard(rows, fg, Date.now()).map((l: string) => l.slice(0, width)).length, 2);
  const r = await run(h.tools.get("bash"), { command: "true", run_in_background: true }, h.ctx);
  await until(() => readTask(r.structuredContent.task_id)?.status === "completed");
  await sleep(400);
  assert.equal(h.statuses.get("bg-tasks"), undefined);
});

// ------------------------------------------------------------ security regressions

/** A task record owned by another pi session, finished, with known output. */
async function foreignTask(owner: string, command = "echo other-session-secret") {
  const { spawnProcess, writeTask } = await import("../core.ts");
  const sp = spawnProcess({ command, cwd: process.cwd() });
  sp.child.unref();
  writeTask({
    id: sp.id, label: "other work", command, cwd: process.cwd(), owner, pid: sp.pid, pidStart: sp.pidStart,
    status: "running", startedAt: Date.now(), events: [], notify: true, wake: false, origin: "background",
    outputPath: sp.outputPath, exitPath: sp.exitPath,
  });
  return sp;
}

test("bg will not read another session's output unless asked with all_sessions", async () => {
  const h = harness();
  await start(h);
  const sp = await foreignTask("someone-else");
  await until(() => readTask(sp.id)?.status !== "running");
  const bg = h.tools.get("bg");

  const denied = await run(bg, { action: "output", task_id: sp.id }, h.ctx);
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /another pi session/);
  assert.match(denied.content[0].text, /all_sessions: true/);
  assert.doesNotMatch(denied.content[0].text, /other-session-secret/);

  const allowed = await run(bg, { action: "output", task_id: sp.id, all_sessions: true }, h.ctx);
  assert.equal(allowed.isError, undefined);
  assert.match(allowed.content[0].text, /other-session-secret/);

  // machine-wide listing still works, and marks the owner
  const list = await run(bg, { action: "list" }, h.ctx);
  assert.match(list.content[0].text, new RegExp(`${sp.id}.*other session`));
});

test("bg will not cancel or clean up another session's task unless asked", async () => {
  const h = harness();
  await start(h);
  const sp = await foreignTask("someone-else", "sleep 30");
  const bg = h.tools.get("bg");

  const denied = await run(bg, { action: "cancel", task_id: sp.id }, h.ctx);
  assert.equal(denied.isError, true);
  assert.equal(readTask(sp.id)!.status, "running", "still running: not cancelled");
  assert.ok(isAlive(sp.pid), "process untouched");

  const allowed = await run(bg, { action: "cancel", task_id: sp.id, all_sessions: true }, h.ctx);
  assert.equal(allowed.isError, undefined);
  assert.equal(readTask(sp.id)!.status, "failed");

  // cleanup skips foreign tasks by default
  const done = await foreignTask("someone-else", "true");
  const { settle } = await import("../core.ts");
  await until(() => {
    void settle(readTask(done.id)!);
    return readTask(done.id)?.status !== "running";
  });
  await run(bg, { action: "cleanup", max_age_hours: 0 }, h.ctx);
  assert.ok(readTask(done.id), "foreign record survives a default cleanup");
  await run(bg, { action: "cleanup", max_age_hours: 0, all_sessions: true }, h.ctx);
  assert.equal(readTask(done.id), undefined);
});

test("/bg cancel refuses a task of another session", async () => {
  const h = harness();
  await start(h);
  const sp = await foreignTask("someone-else", "sleep 30");
  await h.commands.get("bg").handler(`cancel ${sp.id}`, h.ctx);
  assert.match(h.notices.pop()!, /another pi session/);
  assert.equal(readTask(sp.id)!.status, "running");
  assert.ok(isAlive(sp.pid));
  const { cancelTask } = await import("../core.ts");
  await cancelTask(readTask(sp.id)!);
});

test("bg rejects a task id that is a path", async () => {
  const h = harness();
  await start(h);
  const bg = h.tools.get("bg");
  for (const bad of ["../../etc/passwd", "a/b", ".."]) {
    const r = await run(bg, { action: "output", task_id: bad }, h.ctx);
    assert.equal(r.isError, true, bad);
    assert.match(r.content[0].text, /invalid task id/);
  }
  const many = await run(bg, { action: "status", task_ids: ["ok1", "../x"] }, h.ctx);
  assert.match(many.content[0].text, /invalid task id/);
});

test("/bg doctor reports the task dir, its mode and the running counts", async () => {
  const h = harness();
  await start(h);
  await h.commands.get("bg").handler("doctor", h.ctx);
  const text = h.notices.pop()!;
  assert.match(text, /task dir: \/tmp\/pi-bg-ext-/);
  assert.match(text, /mode 700/);
  assert.match(text, /tasks: \d+ on this machine, \d+ in this session/);
  assert.match(text, /auto-handoff: 80ms in tui/);
  assert.match(text, new RegExp(`node ${process.version.replace(/\./g, "\\.")}`));
});
