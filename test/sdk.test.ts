// End-to-end test: real pi AgentSession, faux model provider, real tool calls.
// Proves the extension is discovered, overrides bash, and that completion
// really reaches the conversation. Run: npm test (see package.json).
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const bgDir = mkdtempSync(join(tmpdir(), "pi-bg-sdk-"));
process.env.PI_BG_DIR = bgDir;
const core = await import("../core.ts");
const { readTask, sleep } = core;

const sessions: { dispose: () => void }[] = [];
after(() => {
  for (const s of sessions) s.dispose();
});

/** A session with the extension loaded from disk (exactly like pi's discovery). */
async function makeSession(extensionPath: string, cwd: string) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, "agent"),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [extensionPath],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: join(cwd, "agent"),
    modelRuntime,
    model: faux.getModel(),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
  });
  await session.bindExtensions({});
  sessions.push(session);
  const texts: string[] = [];
  const custom: string[] = [];
  session.subscribe((event: any) => {
    if (event.type === "message_start" && event.message?.role === "custom") custom.push(event.message.customType);
    if (event.type === "tool_execution_end") texts.push((event.result.content ?? []).map((c: any) => c.text ?? "").join(""));
  });
  return { session, faux, texts, custom, cwd };
}

const assign = <T,>(id: string) => {
  assert.ok(id, "task id present");
  return id;
};

test("extension loads and declares its tools", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-bg-sdk-a-"));
  const { session } = await makeSession(join(import.meta.dirname, "..", "index.ts"), cwd);
  const names = session.getActiveToolNames();
  for (const t of ["bash", "bg", "wait_for"]) assert.ok(names.includes(t), `${t} active`);
  const bash = session.getToolDefinition("bash");
  assert.match(String(bash?.description), /run_in_background/);
  assert.match(String(bash?.description), /handoff budget/);
});

test("model-driven background bash → bg wait → completion in context", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-bg-sdk-b-"));
  const { session, faux, texts, custom } = await makeSession(join(import.meta.dirname, "..", "index.ts"), cwd);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", {
        command: "echo start; sleep 0.6; echo 'PI_PROGRESS {\"percent\":80,\"message\":\"almost\"}'; echo finished-marker",
        run_in_background: true,
        notify: true,
        wake: true,
      }),
    ),
    fauxAssistantMessage(fauxToolCall("bg", { action: "wait", timeout_seconds: 30, return_on_progress: false })),
    fauxAssistantMessage("all done"),
  ]);
  await session.prompt("run the build in the background, wait for it, then summarise");
  assert.equal(texts.length, 2);
  assert.match(texts[0], /Started background task [0-9a-z]{8}/);
  const id = assign(/Started background task ([0-9a-z]{8})/.exec(texts[0])![1]);
  assert.match(texts[1], /Wait finished/);
  assert.match(texts[1], /completed in/);
  assert.match(texts[1], /finished-marker/);
  const t = readTask(id)!;
  assert.equal(t.status, "completed");
  assert.equal(t.wake, true);
  assert.equal(t.progress?.percent, 80); // progress marker parsed by the follower
  assert.equal(t.delivered, true);
  // the wait result was the delivery, so no second bg-task message is injected
  assert.equal(custom.includes("bg-task"), false);
  // the model saw a clean transcript: marker lines never leak into tool output
  assert.equal(texts.join("\n").split("\n").some((l) => l.trim().startsWith("PI_PROGRESS")), false, "no marker line reaches the model");
});

test("foreground bash still behaves like the built-in tool", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-bg-sdk-c-"));
  const { session, faux, texts } = await makeSession(join(import.meta.dirname, "..", "index.ts"), cwd);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "echo plain-ok" })), fauxAssistantMessage("done")]);
  await session.prompt("say hi");
  assert.equal(texts.length, 1);
  assert.equal(texts[0], "plain-ok\n");
  const [task] = core.listTasks(session.sessionManager.getSessionId());
  assert.equal(task.status, "completed");
  assert.equal(task.delivered, true);
});

test("auto handoff from a real turn: notify-only delivery lands on the next prompt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-bg-sdk-d-"));
  const ext = join(import.meta.dirname, "..", "index.ts");
  // default budget (3s) and tui-only auto handoff: shorten/allow for this print-mode run
  const shim = join(cwd, "fast.ts");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    shim,
    `import { createBgTasks } from ${JSON.stringify(ext)};\nexport default createBgTasks({ autoBackgroundMs: 200, tickMs: 50, autoModes: ["print"] });\n`,
  );
  const { session, faux, texts } = await makeSession(shim, cwd);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.6; echo slow-done" })),
    fauxAssistantMessage("meanwhile: noted"),
    fauxAssistantMessage("woken by the task"),
  ]);
  await session.prompt("run the slow thing");
  assert.match(texts[0], /moved to background task [0-9a-z]{8}/);
  assert.match(texts[0], /Do NOT rerun/);
  const id = assign(/moved to background task ([0-9a-z]{8})/.exec(texts[0])![1]);
  assert.equal(readTask(id)!.origin, "handoff");

  // the monitor delivers as soon as the task finishes
  const deadline = Date.now() + 10_000;
  while (!readTask(id)?.delivered && Date.now() < deadline) await sleep(50);
  assert.equal(readTask(id)?.status, "completed");
  // next prompt carries the completion into the conversation
  await session.prompt("anything else?");
  const msg = session.messages.find((m: any) => m.role === "custom" && m.customType === "bg-task") as any;
  assert.ok(msg, "completion was queued for the next turn");
  assert.match(typeof msg.content === "string" ? msg.content : msg.content.map((c: any) => c.text).join(""), /completed in/);
  assert.equal(readTask(id)!.delivered, true);
});

test("wake: true starts a turn by itself, no prompt needed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-bg-sdk-w-"));
  const { session, faux, texts } = await makeSession(join(import.meta.dirname, "..", "index.ts"), cwd);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.4; echo woken-task-done", run_in_background: true, wake: true })),
    fauxAssistantMessage("started it"),
    fauxAssistantMessage("reacting to the task"),
  ]);
  await session.prompt("start it in the background and wake me");
  const end = Date.now() + 10_000;
  while (faux.getPendingResponseCount() > 0 && Date.now() < end) await sleep(100);
  assert.equal(faux.state.callCount, 3, "a third turn ran without a user prompt");
  assert.ok(session.messages.some((m: any) => m.role === "custom" && m.customType === "bg-task"));
  assert.equal(texts.length, 1);
});

test("wait_for tool drives a real poller to completion", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-bg-sdk-e-"));
  const { session, faux, texts } = await makeSession(join(import.meta.dirname, "..", "index.ts"), cwd);
  const flag = join(cwd, "ready");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("wait_for", { command: `test -f ${flag}`, description: "flag appears", interval_seconds: 5, timeout_seconds: 40 })),
    fauxAssistantMessage(fauxToolCall("bg", { action: "wait", timeout_seconds: 40, return_on_progress: false })),
    fauxAssistantMessage("flag seen"),
  ]);
  // create the flag while the poller sleeps between checks
  const { writeFile } = await import("node:fs/promises");
  setTimeout(() => void writeFile(flag, ""), 500);
  await session.prompt("wait for the flag");
  assert.match(texts[1], /Wait finished/);
  assert.match(texts[1], /condition met/);
  const [task] = core.listTasks(session.sessionManager.getSessionId());
  assert.equal(task.status, "completed");
  assert.equal(task.command, `test -f ${flag}`); // status shows the check, not the loop
});
