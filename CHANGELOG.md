# Changelog

Notable changes to `@dis446/pi-bg-tasks`. Format follows the version headings pi
reads for package changelogs (`## [x.y.z]`).

## [0.1.0] - 2026-11-05

Initial release. A port of the background-task model from
[jcode](https://github.com/1jehuang/jcode) to pi's extension API.

- `bash` override: every command runs detached in its own process group with
  output in a task file; `run_in_background`, `notify`, `wake` and
  `stall_wake_seconds` parameters; foreground calls keep pi's result shape.
- Handoff of a running foreground command instead of a timeout, at the
  `PI_BG_AUTO_MS` budget, on `/bg handoff`, or on `alt+shift+b`.
- `bg` tool: `list`, `status`, `output`, `tail`, `wait` (any/all/first_failure,
  optional early return on progress), `cancel`, `cleanup`, `watch`.
- `wait_for` tool: a condition poller as a wake-enabled background task.
- Progress reporting: `PI_PROGRESS` / `PI_CHECKPOINT` markers plus heuristics
  for percentages, ratios and build phases; markers never reach the model.
- Delivery: notify queues for the next turn, wake starts or steers a turn,
  stall watchdog for silent tasks.
- TUI: `⏳ Background` card with progress bars and retention rules, footer
  count, compact completion card, `/bg` command family.
- Reload and resume safety: detached tasks are reconciled from their status
  files, and a terminal status is never overwritten by a stale follower.
- Hardened storage: the task directory is `0700` (files `0600`), a directory
  created by another user is never used, planted symlinks are removed instead of
  followed, and a record cannot point a read, delete or signal outside it.
- Process identity: each task stores its process start time, so a reused pid is
  never adopted, cancelled or killed by a timeout.
- Session isolation: `bg output`/`tail`/`wait`/`cancel`/`watch`/`cleanup` stay
  inside the owning session; `all_sessions: true` opts into another session's
  task, and a machine-wide `list` marks foreign tasks.
