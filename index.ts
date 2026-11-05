/**
 * pi-bg-tasks — background tasks for pi.
 *
 * The model is ported from jcode (https://github.com/1jehuang/jcode) and its
 * docs/BACKGROUND_TASKS.md; see README.md for the credit and the differences.
 *
 *  - `bash` override: every command runs detached with output in a task file.
 *    A foreground call is handed to the background (not killed, not rerun) on
 *    `run_in_background`, after the auto-handoff budget, or on alt+shift+b.
 *  - `bg` tool: list / status / output / tail / wait / cancel / cleanup / watch.
 *  - `wait_for` tool: a condition poller, as a wake-enabled background task.
 *  - TUI: "⏳ Background" card (◌ ✓ ×, progress bar), footer count, compact
 *    completion card in the transcript; `/bg` toggles the card.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, getAgentDir, truncateTail } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { delimiter, join } from "node:path";
import {
  advance,
  cancelTask,
  cleanupTasks,
  completionText,
  describeTask,
  fmtDuration,
  listTasks,
  markDelivered,
  MIN_STALL_SECONDS,
  newFollowState,
  newTaskId,
  readTask,
  renderCard,
  retainRows,
  rowFromTask,
  settle,
  sleep,
  stripProgressMarkers,
  spawnProcess,
  tailFile,
  tailLines,
  waitTasks,
  writeTask,
  type FollowState,
  type Row,
  type Task,
  type WaitMode,
} from "./core.ts";

export interface BgOptions {
  /** Foreground budget before a running bash call is handed off. 0 disables. Default 3000 (jcode's default). */
  autoBackgroundMs?: number;
  /** Run modes where auto-handoff applies: print/json runs exit and would orphan the task. */
  autoModes?: string[];
  /** Monitor tick. */
  tickMs?: number;
  /** Manual handoff key (pi already uses alt+b / ctrl+b for cursor movement). */
  handoffKey?: string;
}

/** Marker lines are progress plumbing, never output the model should read. */
const stripMarkers = stripProgressMarkers;

const HANDOFF_GUIDANCE =
  "Continue with independent work. If nothing independent remains, call `bg` with action \"wait\" instead of polling. Do NOT rerun the command: the first copy is still running.";

export function createBgTasks(opts: BgOptions = {}) {
  const autoMs = opts.autoBackgroundMs ?? Number(process.env.PI_BG_AUTO_MS ?? 3000);
  const autoModes = opts.autoModes ?? ["tui"];
  const tickMs = opts.tickMs ?? 1000;
  const handoffKey = opts.handoffKey ?? "alt+shift+b";

  return function bgTasks(pi: ExtensionAPI) {
    let owner = "default";
    let uiCtx: ExtensionContext | undefined;
    let timer: NodeJS.Timeout | undefined;
    let shuttingDown = false;
    let cardHidden = false;
    let requestRender: (() => void) | undefined;
    /** Background tasks this session follows (output, progress, completion). */
    const followed = new Map<string, { task: Task; st: FollowState }>();
    /** Foreground bash calls in flight; a handoff request resolves their race. */
    const foreground = new Map<string, { task: Task; handoff: () => void }>();
    const rows = new Map<string, Row>();
    /** Task ids a `bg wait` call is blocked on: its result is the delivery. */
    const waiting = new Map<string, number>();

    // ------------------------------------------------------------ delivery

    const updateRow = (t: Task) => rows.set(t.id, rowFromTask(t));

    /** notify → visible notice + context for the next turn; wake → start or steer a turn. */
    const deliver = (t: Task, kind: "completion" | "stall") => {
      const text =
        kind === "stall"
          ? `Background task ${t.id} (${t.label}) has produced no output for ${t.stallWakeSeconds}s. It is still running; check it with bg tail, or cancel it.\nOutput: ${t.outputPath}`
          : stripMarkers(completionText(t));
      if (shuttingDown) return; // the next incarnation of this session delivers it
      if (kind === "completion") markDelivered(t.id);
      if (!t.notify && !t.wake) return;
      const msg = { customType: "bg-task", content: text, display: true, details: { task: t, kind } };
      try {
        if (t.wake) pi.sendMessage(msg, { triggerTurn: true, deliverAs: "steer" });
        else pi.sendMessage(msg, { deliverAs: "nextTurn" });
        if (uiCtx?.hasUI) {
          const ok = t.status === "completed";
          uiCtx.ui.notify(
            kind === "stall" ? `bg ${t.id} stalled: ${t.label}` : `bg ${t.id} ${ok ? "done" : "failed"}: ${t.label}`,
            kind === "stall" ? "warning" : ok ? "info" : "error",
          );
        }
      } catch {
        /* session being replaced: the delivered flag is unset only on crash, resume re-sends */
      }
    };

    const adopt = (task: Task, st?: FollowState) => {
      if (shuttingDown) return; // picked up from its status file on the next session_start
      followed.set(task.id, { task, st: st ?? newFollowState(task) });
      updateRow(task);
      ensureTimer();
      refreshUi();
    };

    // ------------------------------------------------------------ monitor

    /** pi invalidates every captured ctx on reload/dispose; stop touching a dead one. */
    const liveCtx = (): boolean => {
      try {
        uiCtx?.sessionManager.getSessionId();
        return true;
      } catch {
        stopTimer();
        followed.clear();
        return false;
      }
    };

    let ticking = false;
    const tick = async () => {
      if (ticking || !liveCtx()) return;
      ticking = true;
      try {
        for (const [id, f] of followed) {
          // another process (bg cancel elsewhere) may have finalized it
          const disk = readTask(id);
          if (disk && disk.status !== "running") Object.assign(f.task, disk);
          const r = f.task.status === "running" ? await advance(f.task, f.st) : { finished: true, stalled: false, progressed: false };
          if (r.progressed || r.finished || r.stalled) updateRow(f.task);
          if (r.stalled) deliver(f.task, "stall");
          if (f.task.status !== "running") {
            if (waiting.has(id)) continue; // the wait result reports it; retry after the wait
            followed.delete(id);
            if (!readTask(id)?.delivered) deliver(f.task, "completion");
          }
        }
      } catch {
        /* never let the timer die */
      } finally {
        ticking = false;
      }
      refreshUi();
    };

    const ensureTimer = () => {
      if (timer) return;
      timer = setInterval(() => void tick(), tickMs);
      timer.unref?.();
    };

    const stopTimer = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };

    // ------------------------------------------------------------ TUI

    const visibleRows = () => retainRows([...rows.values()]);

    const refreshUi = () => {
      const ctx = uiCtx;
      if (!ctx?.hasUI) return;
      const vis = visibleRows();
      for (const id of rows.keys()) if (!vis.some((r) => r.id === id)) rows.delete(id);
      const running = vis.filter((r) => r.state === "running").length;
      try {
        ctx.ui.setStatus("bg-tasks", running ? ctx.ui.theme.fg("accent", `⏳ ${running} bg`) : undefined);
        if (cardHidden || vis.length === 0) {
          ctx.ui.setWidget("bg-tasks", undefined);
          requestRender = undefined;
        } else if (!requestRender) {
          ctx.ui.setWidget("bg-tasks", (tui, theme) => {
            requestRender = () => tui.requestRender();
            const fg = (c: Parameters<typeof theme.fg>[0], s: string) => theme.fg(c, s);
            return {
              render: (width: number) => renderCard(visibleRows(), fg as never).map((l) => truncateToWidth(l, width)),
              invalidate: () => {},
            };
          });
        } else requestRender();
      } catch {
        /* stale ctx after session replacement */
      }
      // keep the elapsed clock and linger expiry moving while anything is shown
      if (vis.length) ensureTimer();
      else if (followed.size === 0 && foreground.size === 0) stopTimer();
    };

    // ------------------------------------------------------------ lifecycle

    pi.on("session_start", async (event, ctx) => {
      stopTimer();
      shuttingDown = false;
      uiCtx = ctx;
      requestRender = undefined;
      owner = ctx.sessionManager.getSessionId();
      if (event.reason === "startup") cleanupTasks(24);
      const resumed: Task[] = [];
      for (const t of listTasks(owner)) {
        if (t.foreground) {
          // a foreground call of an earlier incarnation of this session: its tool call is gone
          t.foreground = false;
          t.origin = "handoff";
          writeTask(t);
        }
        await settle(t); // finished while pi was down: report it instead of calling it running
        if (t.status === "running") {
          resumed.push(t);
          adopt(t);
        } else if (!t.delivered) {
          updateRow(t);
          deliver(t, "completion");
        }
      }
      if (resumed.length)
        pi.sendMessage(
          {
            customType: "bg-task-note",
            content: `Background tasks from before the restart are still running:\n${resumed.map((t) => describeTask(t)).join("\n")}\nUse the bg tool to wait on or inspect them; do not rerun them.`,
            display: false,
          },
          { deliverAs: "nextTurn" },
        );
      ensureTimer();
      refreshUi();
    });

    pi.on("session_shutdown", async () => {
      // reload persistence: an in-flight foreground command keeps running as a background task
      shuttingDown = true;
      for (const f of foreground.values()) f.handoff();
      stopTimer();
      uiCtx = undefined;
      requestRender = undefined;
      followed.clear();
    });

    pi.registerShortcut(handoffKey as never, {
      description: "Move the running bash command to the background (/bg handoff)",
      handler: async (ctx) => {
        if (foreground.size === 0) return ctx.ui.notify("no foreground bash command to background", "info");
        for (const f of foreground.values()) f.handoff();
      },
    });

    pi.registerCommand("bg", {
      description: "Background tasks: /bg (toggle card) · /bg list · /bg handoff · /bg cancel <id> · /bg clear",
      handler: async (args, ctx) => {
        const [sub, id] = args.trim().split(/\s+/);
        if (sub === "handoff") {
          // the reliable form of the shortcut: terminals and multiplexers do not all
          // forward the Kitty CSI-u sequence that alt+shift+b needs
          if (foreground.size === 0) return ctx.ui.notify("no foreground bash command to background", "info");
          for (const f of foreground.values()) f.handoff();
          return ctx.ui.notify(`moving ${foreground.size} running command to the background`, "info");
        }
        if (!sub) {
          cardHidden = !cardHidden;
          requestRender = undefined;
          refreshUi();
          return ctx.ui.notify(`background card ${cardHidden ? "hidden" : "shown"}`, "info");
        }
        if (sub === "list") {
          const ts = await Promise.all(listTasks(owner).map((t) => settle(t)));
          return ctx.ui.notify(ts.length ? ts.map((t) => describeTask(t)).join("\n") : "no background tasks", "info");
        }
        if (sub === "cancel" && id) {
          const t = readTask(id);
          if (!t) return ctx.ui.notify(`no task ${id}`, "error");
          await cancelTask(t);
          followed.delete(id);
          updateRow(t);
          refreshUi();
          return ctx.ui.notify(`cancelled ${id}`, "info");
        }
        if (sub === "clear") {
          for (const [rid, r] of rows) if (r.state !== "running") rows.delete(rid);
          requestRender = undefined;
          refreshUi();
          return;
        }
        ctx.ui.notify("usage: /bg [list | handoff | cancel <id> | clear]", "warning");
      },
    });

    pi.registerMessageRenderer("bg-task", (message, { expanded }, theme) => {
      const d = message.details as { task?: Task; kind?: string } | undefined;
      const t = d?.task;
      if (!t) return new Text(String(message.content), 0, 0);
      const dur = fmtDuration((t.finishedAt ?? Date.now()) - t.startedAt);
      if (d?.kind === "stall")
        return new Text(theme.fg("warning", "⚠ ") + theme.fg("text", t.label) + theme.fg("dim", ` · stalled · ${t.id}`), 0, 0);
      if (t.status === "completed" && !expanded)
        return new Text(theme.fg("success", "✓ ") + theme.fg("text", t.label) + theme.fg("dim", ` · ${dur} · ${t.id}`), 0, 0);
      const head =
        (t.status === "completed" ? theme.fg("success", "✓ ") : theme.fg("error", "× ")) +
        theme.fg("text", t.label) +
        theme.fg("dim", ` · ${t.exitCode !== undefined ? `exit ${t.exitCode} · ` : ""}${dur} · ${t.id}`);
      const err = t.error && t.status === "failed" ? `\n${theme.fg("error", t.error)}` : "";
      const tail = stripMarkers(tailLines(tailFile(t.outputPath, 8192).text, expanded ? 40 : 6)).trim();
      return new Text(`${head}${err}${tail ? `\n${theme.fg("dim", tail)}` : ""}`, 0, 0);
    });

    // ------------------------------------------------------------ task creation

    const shellEnv = (ctx: ExtensionContext): NodeJS.ProcessEnv => {
      // same environment as pi's built-in bash: agent bin dir on PATH + PI_* session details
      const env = { ...process.env };
      const bin = join(getAgentDir(), "bin");
      if (!(env.PATH ?? "").split(delimiter).includes(bin)) env.PATH = [bin, env.PATH].filter(Boolean).join(delimiter);
      env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
      const file = ctx.sessionManager.getSessionFile?.();
      if (file) env.PI_SESSION_FILE = file;
      else delete env.PI_SESSION_FILE;
      if (ctx.model) {
        env.PI_PROVIDER = ctx.model.provider;
        env.PI_MODEL = ctx.model.id;
      }
      if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
      return env;
    };

    const startTask = (
      ctx: ExtensionContext,
      p: {
        command: string;
        label: string;
        timeoutSec?: number;
        notify: boolean;
        wake: boolean;
        stallWakeSeconds?: number;
        foreground: boolean;
        env?: NodeJS.ProcessEnv;
      },
    ): Task => {
      owner = ctx.sessionManager.getSessionId();
      const id = newTaskId();
      const sp = spawnProcess({ id, command: p.command, cwd: ctx.cwd, env: { ...shellEnv(ctx), ...p.env } });
      const task: Task = {
        id,
        label: p.label,
        command: p.command,
        cwd: ctx.cwd,
        owner,
        pid: sp.pid,
        status: "running",
        startedAt: Date.now(),
        timeoutSec: p.timeoutSec && p.timeoutSec > 0 ? p.timeoutSec : undefined,
        events: [],
        notify: p.notify || p.wake,
        wake: p.wake,
        stallWakeSeconds: p.stallWakeSeconds ? Math.max(MIN_STALL_SECONDS, p.stallWakeSeconds) : undefined,
        origin: "background",
        foreground: p.foreground,
        outputPath: sp.outputPath,
        exitPath: sp.exitPath,
      };
      sp.child.unref();
      writeTask(task);
      return task;
    };

    const labelOf = (command: string) => {
      const first = command.trim().split("\n")[0];
      return first.length > 48 ? `${first.slice(0, 47)}…` : first;
    };

    // ------------------------------------------------------------ bash override

    pi.registerTool({
      name: "bash",
      label: "bash",
      description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); the full output stays in a task file. Optionally provide a timeout in seconds (kills the command). Set run_in_background for long-running work; a foreground call that runs past the handoff budget is moved to the background automatically, still running, and returns a task id.`,
      promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
      promptGuidelines: [
        "You can inspect PI_* environment variables for current model and session details.",
        "Use bash with run_in_background: true for builds, test suites, servers and other long commands, then keep working; you are notified when it finishes (set wake: true to be woken). When a bash result says the command was moved to the background, do not rerun it: continue independent work, and if none remains call bg with action \"wait\".",
        "Long bash commands can report progress by printing lines like PI_PROGRESS {\"percent\":42,\"message\":\"step\"} or PI_PROGRESS {\"current\":7,\"total\":20,\"unit\":\"tests\"}, and PI_CHECKPOINT <text> for milestones.",
      ],
      parameters: Type.Object({
        command: Type.String({ description: "Bash command to execute" }),
        timeout: Type.Optional(Type.Number({ description: "Timeout in seconds; the command is killed when exceeded (optional, no default timeout)" })),
        run_in_background: Type.Optional(Type.Boolean({ description: "Start as a background task and return its id immediately" })),
        notify: Type.Optional(Type.Boolean({ description: "Background only: report completion (default true)" })),
        wake: Type.Optional(Type.Boolean({ description: "Background only: start or steer a turn on completion (default false)" })),
        stall_wake_seconds: Type.Optional(Type.Number({ description: `Background only: wake if no output for this many seconds (min ${MIN_STALL_SECONDS})` })),
      }),
      outputSchema: Type.Object({
        output: Type.String(),
        truncated: Type.Boolean(),
        full_output_path: Type.Optional(Type.String()),
        exit_code: Type.Number({ description: "-1 while the command runs as a background task" }),
        wall_time_seconds: Type.Number(),
        task_id: Type.Optional(Type.String({ description: "Set when the command runs in the background" })),
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const command = params.command;
        if (params.run_in_background) {
          const task = startTask(ctx, {
            command,
            label: labelOf(command),
            timeoutSec: params.timeout,
            notify: params.notify ?? true,
            wake: params.wake ?? false,
            stallWakeSeconds: params.stall_wake_seconds,
            foreground: false,
          });
          adopt(task);
          const text = `Started background task ${task.id} (${task.label}).\nOutput: ${task.outputPath}\nYou will be ${task.wake ? "woken" : "notified"} when it finishes. ${HANDOFF_GUIDANCE.split(". ").slice(0, 2).join(". ")}.`;
          return {
            content: [{ type: "text", text }],
            details: undefined,
            structuredContent: { output: text, truncated: false, exit_code: -1, wall_time_seconds: 0, task_id: task.id },
          };
        }

        const task = startTask(ctx, { command, label: labelOf(command), timeoutSec: params.timeout, notify: true, wake: false, foreground: true });
        const st = newFollowState(task);
        const started = Date.now();
        // codemode scripts (nested ids "<parent>/<n>") and headless runs need the real output
        const autoAllowed = autoMs > 0 && autoModes.includes(ctx.mode) && !toolCallId.includes("/");
        let handoffRequested = false;
        foreground.set(task.id, { task, handoff: () => (handoffRequested = true) });
        ensureTimer();

        const snapshot = () => {
          const { text, size } = tailFile(task.outputPath, DEFAULT_MAX_BYTES * 2);
          const tr = truncateTail(stripMarkers(text), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
          const truncated = tr.truncated || size > DEFAULT_MAX_BYTES * 2;
          return { content: tr.content, truncated, size, tr };
        };

        let lastUpdate = 0;
        let lastOffset = 0;
        try {
          onUpdate?.({ content: [], details: undefined });
          for (;;) {
            await advance(task, st);
            if (task.status !== "running") break;
            if (signal?.aborted && !shuttingDown) {
              await cancelTask(task);
              const s = snapshot();
              throw new Error(`${s.content ? `${s.content}\n\n` : ""}Command aborted`);
            }
            if (handoffRequested || shuttingDown || (autoAllowed && Date.now() - started >= autoMs)) {
              task.foreground = false;
              task.origin = "handoff";
              writeTask(task);
              foreground.delete(task.id);
              adopt(task, st);
              const s = snapshot();
              const why = shuttingDown ? "because pi is reloading" : handoffRequested ? "on request" : `after ${autoMs < 1000 ? `${autoMs}ms` : fmtDuration(autoMs)}`;
              const text = `${s.content ? `${s.content}\n\n` : ""}[Command still running; moved to background task ${task.id} ${why}. Output: ${task.outputPath}]\n${HANDOFF_GUIDANCE}`;
              return {
                content: [{ type: "text", text }],
                details: undefined,
                structuredContent: { output: s.content, truncated: s.truncated, exit_code: -1, wall_time_seconds: (Date.now() - started) / 1000, task_id: task.id },
              };
            }
            if (onUpdate && st.offset !== lastOffset && Date.now() - lastUpdate > 250) {
              lastOffset = st.offset;
              lastUpdate = Date.now();
              onUpdate({ content: [{ type: "text", text: snapshot().content }], details: undefined });
            }
            await sleep(50);
          }
        } finally {
          foreground.delete(task.id);
        }

        // finished in the foreground: this result is the delivery
        markDelivered(task.id);
        const s = snapshot();
        const details = s.truncated ? { truncation: s.tr, fullOutputPath: task.outputPath } : undefined;
        let text = s.content || "(no output)";
        if (s.truncated) text += `\n\n[Showing the last ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}. Full output: ${task.outputPath}]`;
        if (task.exitCode === 124 && task.error?.startsWith("timed out")) throw new Error(`${s.content ? `${s.content}\n\n` : ""}Command timed out after ${task.timeoutSec} seconds`);
        if (task.exitCode === undefined) throw new Error(`${text}\n\n${task.error ?? "Command terminated without an exit code"}`);
        const structuredContent = {
          output: stripMarkers(tailFile(task.outputPath, 1024 * 1024).text),
          truncated: s.size > 1024 * 1024,
          ...(s.size > 1024 * 1024 ? { full_output_path: task.outputPath } : {}),
          exit_code: task.exitCode,
          wall_time_seconds: Math.round((Date.now() - started) / 100) / 10,
        };
        if (task.exitCode !== 0)
          return { content: [{ type: "text", text: `${text}\n\nCommand exited with code ${task.exitCode}` }], details: details as never, structuredContent, isError: true };
        return { content: [{ type: "text", text }], details: details as never, structuredContent };
      },
    });

    // ------------------------------------------------------------ bg tool

    const resolveIds = async (p: { task_id?: string; task_ids?: string[]; latest?: boolean }, sessionOnly = true): Promise<string[] | string> => {
      if (p.task_ids?.length) return p.task_ids;
      if (p.task_id) return [p.task_id];
      const mine = await Promise.all(listTasks(sessionOnly ? owner : undefined).map((t) => settle(t)));
      if (p.latest) return mine.length ? [mine[0].id] : "no tasks in this session";
      const running = mine.filter((t) => t.status === "running");
      if (running.length === 1) return [running[0].id];
      if (running.length === 0) return "no running task in this session; pass task_id";
      return `${running.length} running tasks (${running.map((t) => t.id).join(", ")}); pass task_id, task_ids or latest: true`;
    };

    const ok = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });
    const err = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });

    const statusText = (t: Task) => {
      const ev = t.events.slice(-5).map((e) => `  ${new Date(e.at).toLocaleTimeString()} ${e.kind}: ${e.message}`);
      return [
        describeTask(t),
        `  command: ${t.command.length > 200 ? `${t.command.slice(0, 200)}…` : t.command}`,
        `  delivery: notify=${t.notify} wake=${t.wake}${t.stallWakeSeconds ? ` stall=${t.stallWakeSeconds}s` : ""}`,
        `  output: ${t.outputPath}`,
        ...(ev.length ? ["  recent events:", ...ev] : []),
      ].join("\n");
    };

    pi.registerTool({
      name: "bg",
      label: "Background tasks",
      description:
        "Manage background tasks (bash run_in_background, auto-backgrounded commands, wait_for pollers). Actions: list, status, output, tail, wait (blocks until a task finishes, reports progress or stalls, or timeout_seconds passes; wait_mode any|all|first_failure), cancel, cleanup (remove finished task files older than max_age_hours), watch (change notify/wake/stall_wake_seconds). Without task_id the only running task of this session is used.",
      promptSnippet: "Wait on, inspect, tail or cancel background tasks",
      promptGuidelines: [
        "Use bg with action \"wait\" when you have nothing independent left to do while a background task runs; never poll with sleep loops or repeated bg status calls.",
      ],
      parameters: Type.Object({
        action: StringEnum(["list", "status", "output", "tail", "wait", "cancel", "cleanup", "watch"] as const),
        task_id: Type.Optional(Type.String()),
        task_ids: Type.Optional(Type.Array(Type.String())),
        latest: Type.Optional(Type.Boolean({ description: "Use the most recent task of this session" })),
        session_only: Type.Optional(Type.Boolean({ description: "list: only this session's tasks (default false)" })),
        lines: Type.Optional(Type.Number({ description: "tail: number of lines (default 40)" })),
        timeout_seconds: Type.Optional(Type.Number({ description: "wait: max seconds (default 60, max 3600)" })),
        wait_mode: Type.Optional(StringEnum(["any", "all", "first_failure"] as const)),
        return_on_progress: Type.Optional(Type.Boolean({ description: "wait: return on the first progress/checkpoint event (default true)" })),
        notify: Type.Optional(Type.Boolean()),
        wake: Type.Optional(Type.Boolean()),
        stall_wake_seconds: Type.Optional(Type.Number()),
        max_age_hours: Type.Optional(Type.Number({ description: "cleanup: default 24" })),
      }),
      async execute(_id, p, signal, onUpdate, ctx) {
        owner = ctx.sessionManager.getSessionId();
        if (p.action === "list") {
          const ts = await Promise.all(listTasks(p.session_only ? owner : undefined).map((t) => settle(t)));
          return ok(ts.length ? ts.map((t) => describeTask(t)).join("\n") : "no background tasks", { count: ts.length });
        }
        if (p.action === "cleanup") {
          const removed = cleanupTasks(p.max_age_hours ?? 24);
          return ok(removed.length ? `removed ${removed.length} task(s): ${removed.join(", ")}` : "nothing to clean up");
        }
        const ids = await resolveIds(p, p.action !== "status" || !p.task_id);
        if (typeof ids === "string") return err(ids);
        const tasks = ids.map((id) => readTask(id));
        const missing = ids.filter((_, i) => !tasks[i]);
        if (missing.length) return err(`unknown task id: ${missing.join(", ")}`);
        const ts = await Promise.all((tasks as Task[]).map((t) => settle(t)));
        const reportTerminal = (t: Task) => {
          if (t.status !== "running" && t.owner === owner) markDelivered(t.id);
        };

        switch (p.action) {
          case "status":
            ts.forEach(reportTerminal);
            return ok(ts.map(statusText).join("\n\n"), { tasks: ts });
          case "output":
          case "tail": {
            const n = p.action === "tail" ? (p.lines ?? 40) : 2000;
            const parts = ts.map((t) => {
              reportTerminal(t);
              const body = stripMarkers(tailLines(tailFile(t.outputPath, p.action === "tail" ? 256 * 1024 : DEFAULT_MAX_BYTES).text, n));
              const tr = truncateTail(body, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
              return `── ${describeTask(t)}\n${tr.content || "(no output yet)"}${tr.truncated ? `\n[truncated; full output: ${t.outputPath}]` : ""}`;
            });
            return ok(parts.join("\n\n"));
          }
          case "cancel":
            for (const t of ts) {
              await cancelTask(t);
              followed.delete(t.id);
              updateRow(t);
            }
            refreshUi();
            return ok(ts.map((t) => `${t.id}: ${t.status}${t.error ? ` (${t.error})` : ""}`).join("\n"));
          case "watch":
            for (const t of ts) {
              if (p.notify !== undefined) t.notify = p.notify;
              if (p.wake !== undefined) t.wake = p.wake;
              else if (p.notify === undefined && p.stall_wake_seconds === undefined) t.wake = true; // bare watch = subscribe
              t.notify = t.notify || t.wake;
              if (p.stall_wake_seconds !== undefined) t.stallWakeSeconds = p.stall_wake_seconds > 0 ? Math.max(MIN_STALL_SECONDS, p.stall_wake_seconds) : undefined;
              writeTask(t);
              const f = followed.get(t.id);
              if (f) Object.assign(f.task, { notify: t.notify, wake: t.wake, stallWakeSeconds: t.stallWakeSeconds });
            }
            return ok(ts.map((t) => `${t.id}: notify=${t.notify} wake=${t.wake}${t.stallWakeSeconds ? ` stall=${t.stallWakeSeconds}s` : ""}`).join("\n"));
          case "wait": {
            onUpdate?.({ content: [{ type: "text", text: `waiting on ${ids.join(", ")}…` }], details: {} });
            for (const id of ids) waiting.set(id, (waiting.get(id) ?? 0) + 1);
            let out: Awaited<ReturnType<typeof waitTasks>>;
            try {
              out = await waitTasks(ids, {
                mode: (p.wait_mode as WaitMode) ?? "any",
                timeoutSec: p.timeout_seconds ?? 60,
                returnOnProgress: p.return_on_progress ?? true,
                signal,
              });
            } finally {
              for (const id of ids) {
                const n = (waiting.get(id) ?? 1) - 1;
                if (n > 0) waiting.set(id, n);
                else waiting.delete(id);
              }
            }
            const lines = out.tasks.map((t) => {
              if (t.status === "running") return describeTask(t);
              reportTerminal(t);
              return stripMarkers(completionText(t));
            });
            const head =
              out.reason === "finished"
                ? "Wait finished."
                : out.reason === "progress"
                  ? "Returned on a progress update; the task is still running."
                  : out.reason === "stall"
                    ? "Returned because a task stalled (no output)."
                    : out.reason === "timeout"
                      ? "Wait timed out; tasks are still running."
                      : out.reason === "aborted"
                        ? "Wait aborted."
                        : "A task disappeared.";
            return ok(`${head}\n${lines.join("\n\n")}`, { reason: out.reason });
          }
        }
        return err(`unknown action ${p.action}`);
      },
    });

    // ------------------------------------------------------------ wait_for

    pi.registerTool({
      name: "wait_for",
      label: "Wait for condition",
      description:
        "Start a background poller: runs `command` every interval_seconds until it exits 0 (condition met) or timeout_seconds passes (task fails). The agent keeps working; this session is woken when it finishes. Use for deployments, pipelines, rollouts, HTTP probes, CI. Manage it with the bg tool.",
      promptSnippet: "Poll an external condition in the background and wake when it holds",
      promptGuidelines: [
        "Use wait_for instead of sleep loops when waiting on an external condition (deployments, pipelines, CI). Its command must be a read-only check that exits 0 exactly when the condition is met.",
      ],
      parameters: Type.Object({
        command: Type.String({ description: "Read-only check; exit 0 = condition met" }),
        description: Type.String({ description: "What is being waited for (task label)" }),
        interval_seconds: Type.Optional(Type.Number({ description: "Seconds between checks (default 20, min 5)" })),
        timeout_seconds: Type.Optional(Type.Number({ description: "Give up after this many seconds (default 600)" })),
      }),
      async execute(_id, p, _signal, _onUpdate, ctx) {
        const interval = Math.max(5, p.interval_seconds ?? 20);
        // check text travels in the env, so no quoting of user input into the script
        const loop = `n=0
while :; do
  n=$((n+1))
  out=$(bash -c "$PI_WAIT_CHECK" 2>&1); ec=$?
  if [ "$ec" -eq 0 ]; then printf '%s\\n' "$out"; echo "condition met on check $n"; exit 0; fi
  printf 'check %s · exit %s · %s\\n' "$n" "$ec" "$(printf '%s' "$out" | tail -n 1 | cut -c1-120)"
  sleep ${interval}
done`;
        const task = startTask(ctx, {
          command: loop,
          label: p.description.slice(0, 60),
          timeoutSec: p.timeout_seconds ?? 600,
          notify: true,
          wake: true,
          foreground: false,
          env: { PI_WAIT_CHECK: p.command },
        });
        task.command = p.command; // show the check, not the loop
        writeTask(task);
        adopt(task);
        return ok(
          `Started poller ${task.id} (${task.label}): every ${interval}s, timeout ${task.timeoutSec}s. This session is woken when it finishes. Continue with other work; manage it with bg.`,
          { task_id: task.id },
        );
      },
    });
  };
}

export default createBgTasks();
