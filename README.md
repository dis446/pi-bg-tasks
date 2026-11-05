# pi-bg-tasks

[![npm version](https://img.shields.io/npm/v/@dis446/pi-bg-tasks.svg)](https://www.npmjs.com/package/@dis446/pi-bg-tasks)
[![Node](https://img.shields.io/node/v/@dis446/pi-bg-tasks.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Background tasks for [pi](https://github.com/earendil-works/pi). Long-running
commands keep running after the tool call returns, report progress into a live
task card, and wake the session when they finish.

The model stops burning turns on `sleep` loops: start the work, keep going, get
told when it is done.

```text
⏳ Background · 1 running
◌ cargo test  ━━━╺──  42%  running integration tests
✓ cargo build  ━━━━━━ 100%
```

## Features

- **Detached by default.** Every `bash` command runs in its own process group
  with output written to a task file, so a task survives a pi reload, `/resume`
  or pi exiting entirely.
- **Handoff instead of timeout.** A foreground command that runs past the
  handoff budget is *adopted* — not killed, not re-run — and the model gets its
  task id.
- **Progress that means something.** Explicit `PI_PROGRESS` / `PI_CHECKPOINT`
  markers, plus recognition of ordinary `42%`, `7/20`, `1.5/4 GiB` and
  `Compiling …` output.
- **Delivery you control.** `notify` queues the result for the next turn,
  `wake` starts one immediately, `stall_wake_seconds` wakes you when a task goes
  silent.
- **A card, not a log.** Running, completed and failed tasks with a percentage
  bar; completions collapse to one line in the transcript.
- **A `wait_for` primitive.** Poll any condition (a pipeline, a rollout, an HTTP
  probe) in the background and get woken when it holds.

## Requirements

- pi 1.5 or newer (`@earendil-works/pi-coding-agent`). The extension uses tool
  `outputSchema`, `registerMessageRenderer`, `registerShortcut` and the widget
  `requestRender` API.
- Node 22.19 or newer, matching pi's own engine floor.
- Linux or macOS. The runner uses POSIX process groups; Windows is untested.

## Install

```bash
pi install npm:@dis446/pi-bg-tasks
```

Or from a checkout, without touching your settings:

```bash
pi -e npm:@dis446/pi-bg-tasks      # one run
pi install ./pi-bg-tasks           # local directory
```

The extension overrides pi's built-in `bash` tool and adds `bg` and `wait_for`.
Nothing else is required — no build step, no external dependency.

## Try this first

You do not need to learn the tools or the slash commands. After installing, ask
pi in plain language:

```text
Run the test suite in the background and tell me when it finishes.
```

```text
Start the dev server in the background, then fix the failing auth test.
```

```text
Wait for the uat rollout to finish, then run the smoke tests.
```

```text
What is still running? Show me the tail of the build output.
```

Pi decides whether to call `bash` with `run_in_background`, `bg` or `wait_for`.
The card appears once something is running.

## Usage

Long work, started and awaited later:

```text
bash { command: "cargo test 2>&1 | tail -5", run_in_background: true }
→ Started background task 3f9kd2ab (cargo test 2>&1 | tail -5). Output: /tmp/pi-bg-tasks/3f9kd2ab.output

… the model does other things …

bg { action: "wait", timeout_seconds: 300 }
→ Wait finished. Background task 3f9kd2ab completed in 4m12s. Output preview: …
```

Waiting on something external:

```text
wait_for {
  command: "kubectl -n uat rollout status deploy/api --timeout=5s",
  description: "uat api rollout",
  interval_seconds: 20,
  timeout_seconds: 900
}
```

A command that reports its own progress:

```bash
for i in $(seq 1 20); do
  printf 'PI_PROGRESS {"current":%s,"total":20,"unit":"tests","message":"suite %s"}\n' "$i" "$i"
  sleep 2
done
```

## Tools

### `bash` (override)

| Parameter | Description |
| --- | --- |
| `command` | Bash command to execute. |
| `timeout` | Seconds before the command is killed, group included. No default. |
| `run_in_background` | Start a task and return its id immediately. |
| `notify` | Background only: report completion (default `true`). |
| `wake` | Background only: start or steer a turn on completion (default `false`). |
| `stall_wake_seconds` | Background only: wake if no output for this long (minimum 30). |

Foreground calls keep pi's built-in result shape (`output`, `truncated`,
`full_output_path`, `exit_code`, `wall_time_seconds`) plus `task_id` when the
command was handed off.

### `bg`

| Action | Purpose |
| --- | --- |
| `list` | Tasks, newest first. `session_only: true` limits it to this session. |
| `status` | Metadata, progress, delivery flags and recent events. |
| `output` / `tail` | The full output file, or its last `lines` (default 40). |
| `wait` | Block until a task finishes, reports progress, stalls, or `timeout_seconds` passes. `wait_mode`: `any` (default), `all`, `first_failure`. `return_on_progress` defaults to `true`. |
| `cancel` | Terminate the process group and record `Cancelled by user`. |
| `cleanup` | Delete finished task files older than `max_age_hours` (default 24). |
| `watch` | Change `notify`, `wake`, `stall_wake_seconds` without blocking. |

With `task_id` omitted, `bg` uses the only running task in the session; with
several it asks for `task_id`, `task_ids` or `latest: true`.

A task belongs to the pi session that started it. `list` and `status` show tasks
of every session on the machine (marked `other session`), but `output`, `tail`,
`wait`, `cancel` and `cleanup` stay inside the session; pass
`all_sessions: true` to reach another session's task deliberately. `/bg cancel`
refuses foreign ids outright.

### `wait_for`

| Parameter | Description |
| --- | --- |
| `command` | Read-only check; exit 0 means the condition holds. |
| `description` | Task label, shown in the card and the wake message. |
| `interval_seconds` | Seconds between checks (default 20, minimum 5). |
| `timeout_seconds` | Give up after this long (default 600). |

A `wait_for` task is notify + wake enabled: it wakes the session when the
condition holds, and fails with `timed out after Ns` when it does not.

## Progress protocol

Explicit markers are the reliable interface:

```text
PI_PROGRESS {"percent":42,"message":"Compiling"}
PI_PROGRESS {"current":7,"total":20,"unit":"tests","message":"integration"}
PI_PROGRESS {"kind":"indeterminate","message":"waiting for lock"}
PI_CHECKPOINT {"message":"database migrated"}
PI_CHECKPOINT plain text checkpoint
```

Accepted fields: `percent`, `current`, `total`, `unit`, `eta_seconds`,
`message`, `kind` (`determinate`, `indeterminate`, `checkpoint`), `checkpoint`.

Normalisation rules: counts are authoritative (`current: 2, total: 10` beats a
contradictory `percent: 80`), percentages are clamped to 0–100, and a
phase-only update keeps the last known percentage instead of dropping to 0.

Without markers, the parser also recognises `42/100`, `7 of 20 tests`, byte
ratios such as `1.5/4 GiB`, percentages such as `42%`, and the phase prefixes
`Compiling`, `Downloading`, `Building`, `Linking`, `Resolving`, `Fetching`,
`Installing`.

Marker lines are plumbing: they update the card and the task status but never
reach the model, in tool output or in the completion message.

## Delivery

| Flag | Effect |
| --- | --- |
| `notify` (default) | A notice, a card row update, and the completion queued for the next turn. |
| `wake` | Starts a turn when pi is idle, or steers the running one. Implies `notify`. |
| `stall_wake_seconds` | Fires once per silence episode while the task is still running; activity re-arms it. Not a terminal event. |

Completion messages carry the status, a 500-character output preview and the
path to the full output file. A cancelled task records a terminal `failed`
status but publishes no completion event — check `bg status` instead.

## TUI

- Card rows: `◌` running, `✓` completed, `×` failed; six-cell bar for
  determinate progress, elapsed time otherwise.
- Successful rows linger 12 s, failures stay until the eight-row cap pushes them
  out, running rows always stay. Most recently active first, up to six rows plus
  `+N more`.
- Footer shows `⏳ N bg` while anything runs.
- `/bg` toggles the card; `/bg list`, `/bg doctor`, `/bg handoff`,
  `/bg cancel <id>`, `/bg clear` do the obvious things.
- `/bg handoff` (or `alt+shift+b` where the terminal and any multiplexer forward
  the Kitty keyboard protocol) backgrounds the command running in the
  foreground.

## Configuration

| Setting | Meaning |
| --- | --- |
| `PI_BG_AUTO_MS` | Foreground handoff budget in ms. Default `3000`; `0` disables auto-handoff. |
| `PI_BG_DIR` | Task directory. Default `$TMPDIR/pi-bg-tasks`. Must be private to your user; it is created `0700` and tightened if it is not. |
| `PI_BG_MAX_OUTPUT_BYTES` | Cap on one task's output file (default 64 MiB, minimum 64 KiB). Past it the file keeps its last 1 MiB and a truncation notice. |

The factory also takes options when you wrap it yourself:

```ts
import { createBgTasks } from "@dis446/pi-bg-tasks";
export default createBgTasks({
  autoBackgroundMs: 3000,
  autoModes: ["tui"],   // run modes where auto-handoff applies
  tickMs: 1000,         // monitor interval
  handoffKey: "alt+shift+b",
});
```

The package ships TypeScript sources, not a build output, so that named import
needs a runtime that loads `.ts` — pi's own loader (jiti), `tsx`, or a bundler.
Plain `node` cannot strip types inside `node_modules`, so `node -e 'import(...)'`
is not a supported entry point. Installing the package with pi needs no loader at
all: pi reads `pi.extensions` from the manifest.

## How it works

```text
tool call ──► spawn (detached, own process group)
                 │  wrapper shell: stdout+stderr → <id>.output, exit code → <id>.exit
                 ├─ foreground: polled in-process, reported as the tool result
                 └─ background: followed from the output file, progress parsed per line
                        └─ completion → card update + notify/wake delivery
```

- **Storage.** `$TMPDIR/pi-bg-tasks` holds `<id>.status.json` (atomic writes;
  a terminal status is never overwritten by a stale follower), `<id>.output`,
  `<id>.exit`, `<id>.cmd`. The command lives in a file, so its length is not
  limited by `ARG_MAX`. The directory is private to your user (`0700`, files
  `0600`, planted symlinks are removed instead of followed); if another user
  created that path first, a private directory is used instead and the squatted
  one is never written to.
- **Ownership.** A task records the pi session that started it; only that
  session is woken. Tasks are shared across pi processes of the same user, and
  `settle()` reconciles a stale `running` record from its pid, its process start
  identity and its exit file — that is how a reloaded or resumed session learns
  what happened while it was away. A pid whose start identity does not match is
  treated as a stranger: never adopted, never signalled.
- **No adoption of foreign tools.** A pi extension cannot take over a tool call
  it does not own mid-flight, so only `bash` hands off. Auto-handoff is limited
  to interactive (`tui`) sessions and direct model calls: print/JSON runs would
  exit and orphan the task, and codemode's nested `bash` calls must return their
  output inline.

## Limitations

- POSIX only (process groups, `bash`).
- Tasks do not survive a reboot: they are detached from pi, not from the
  machine.
- `alt+shift+b` needs the Kitty keyboard protocol end to end; use `/bg handoff`
  when a terminal or multiplexer does not forward it.
- Output files keep the last 1 MiB once they pass `PI_BG_MAX_OUTPUT_BYTES`
  (64 MiB); `bg cleanup` removes the rest.

## If something feels off

```
/bg doctor
```

Prints the task directory and its mode, the task counts for this machine and
this session, the handoff budget, the output cap and the Node version — the
handful of facts a bug report needs. `pi list` shows whether the package is
installed; a `pi update --extensions` upgrade is picked up on the next start or
`/reload`.

Things that surprise people, and why:

- A command that ran past the handoff budget keeps running and shows a task id.
  Do not rerun it; use `bg wait` or `bash` is already returning its output.
- Tasks live under `$TMPDIR`, so a reboot forgets them and `bg cleanup` collects
  the files of finished ones.
- `bg list` shows tasks from other pi sessions on the machine, marked
  `other session`; their output stays unreadable unless you pass
  `all_sessions: true`.
- Auto-handoff applies to interactive sessions only: a `-p`/`--mode json` run
  would exit and orphan the task.

## Development

```bash
npm install        # host packages as devDependencies (peers of the extension)
npm test           # core, extension and end-to-end SDK suites
npm run test:core  # unit tests only
npm run typecheck  # tsc --noEmit over core.ts, index.ts and test/
npm run ci         # typecheck + tests
```

`npm test` also works without `node_modules`: `test/resolve.mjs` then maps the
host packages to the copy inside your own pi installation.

- `core.ts` — pi-independent task model: process runner, progress parser,
  follower, wait, card rendering. Node built-ins only.
- `index.ts` — the extension: tools, TUI, delivery, shortcuts, `/bg`.
- `test/` — unit tests, a fake-`ExtensionAPI` harness, and end-to-end tests that
  drive a real `AgentSession` with a faux provider.
- `test/resolve.mjs` — test-only resolver for pi's host packages, which pi ships
  inside a bundle rather than a flat `node_modules`.

CI (`.github/workflows/test.yml`) runs `npm ci`, `npm run typecheck` and
`npm test` on Node 22.19 and 24. Releases are described below; the changelog is
[CHANGELOG.md](./CHANGELOG.md).

`tsconfig.json` is check-only (`noEmit`): pi loads the `.ts` sources directly, so
nothing is built. Types resolve from the devDependency copies of the host
packages; the tests additionally run through Node's type stripping.

### Versions and releases

Every version in `package.json` is exact — devDependencies included — and
`.npmrc` sets `save-exact=true`, so a fresh install reproduces the lockfile
instead of resolving new ranges. Host packages stay `peerDependencies: "*"` as
pi's package docs require; they are never installed or bundled, so they add no
supply-chain surface. `npm ci` is the only supported way to install them here.

Releases are cut by pushing a `v<version>` tag: `.github/workflows/release.yml`
re-runs `npm run ci`, checks that the tag matches `package.json` and is an
ancestor of `main`, then publishes with provenance (`--provenance`,
`--access public`). Both workflows install with `npm ci --ignore-scripts`, so no
dependency install script runs next to a publish credential. The publish step
prefers npm **Trusted Publishing** (OIDC, no secret); it falls back to an
`NPM_TOKEN` secret when one exists.

## Security

Pi extensions run with your full user permissions and can execute arbitrary
code; a background task runs whatever command the model asks for. Review the
source before installing, and read the output of anything you did not ask for.

The task directory is the only shared surface, and it is defended on the
assumption that it can be hostile:

- **Private by default.** Created `0700` with `0600` files, because `<id>.cmd`
  and `<id>.output` contain the command text and its output. A world-writable
  or foreign-owned directory is tightened when we own it, and never used when
  someone else owns it.
- **Derived paths.** Task ids are validated as `[0-9a-z]` and every file path is
  rebuilt from the id, so a record read from disk cannot redirect a read, a
  delete or a signal outside the directory.
- **Process identity.** Each task records its process start time (ProcFS
  `starttime`, `ps -o lstart` elsewhere) next to the pid; a mismatched identity
  is never adopted and never signalled, so a reused pid cannot be killed by a
  cancel or a timeout.
- **Session isolation.** Output, waits, cancels, watch changes and cleanup are
  scoped to the session that owns the task.
- **No network.** The extension makes no outbound request, sends no telemetry,
  and evaluates no code beyond the commands you ask for. The check text of a
  `wait_for` poller travels in the environment, never interpolated into a shell
  string.
- **Bounded state.** One output file cannot exceed its cap, a command that never
  emits a newline cannot grow the follower's buffer, and a status record larger
  than 256 KiB is ignored.
- **Terminal safety.** Control characters and escape sequences are stripped
  from labels, progress messages and rendered output, so a command cannot
  repaint the card, the transcript or the window title.

Residual: a task's output reaches the model verbatim (it is command output), and
`process.env` is passed to every task, as pi's own `bash` does — a detached task
keeps those variables after pi exits. Keep secrets out of command text you do
not want on disk in your own task directory. A `wait_for` check travels in
`PI_WAIT_CHECK`, which same-uid processes can read from `/proc/<pid>/environ`.

## Credits

This extension is a port of the background-task model from
**[jcode](https://github.com/1jehuang/jcode)**: detached task ownership, per-task
status and output files, progress markers and normalisation, the notify/wake
split, the stall watchdog, terminal status semantics, and the task card's layout
and retention rules.

All design credit belongs to jcode's authors. This repository is an independent
TypeScript implementation written against pi's extension API — no jcode code is
vendored here.

## License

[MIT](./LICENSE) © Tsetsen-erdene Ganbaatar
