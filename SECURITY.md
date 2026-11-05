# Security policy

## Reporting a vulnerability

Report privately through GitHub's "Report a vulnerability" form on
[dis446/pi-bg-tasks](https://github.com/dis446/pi-bg-tasks/security/advisories/new),
or by email to dis446@yahoo.com.

Include the pi and `@dis446/pi-bg-tasks` versions, the platform, and what an
attacker gains. Please do not open a public issue first.

Expected first reply: within seven days. This is a personal project with no
paid support and no bounty.

## What is in scope

The extension's own boundary:

- the task directory (`$TMPDIR/pi-bg-tasks` by default): file modes, ownership,
  symlink handling, records read from disk;
- process handling: which pid or process group is signalled, timeouts, cancel;
- session isolation: which session may read, wait on, cancel or clean a task;
- what reaches the model and the terminal (marker stripping, control characters);
- the published artifact and its workflows: tarball contents, registry pinning,
  publish credentials.

## What is not in scope

- A model or user running `bash`: the extension runs commands with your full
  user permissions by design, as pi's built-in `bash` does. There is no sandbox.
- Secrets placed in command text or in the task directory. It is private to your
  user (`0700`/`0600`), but it is not encrypted and it is not wiped on exit.
- Vulnerabilities in pi itself or in a provider SDK; report those upstream.

## Known limits, stated up front

- POSIX only (process groups, `bash`); Windows is untested.
- Tasks survive pi, not a reboot: they live under `$TMPDIR`.
- `process.env` is inherited by every task, as pi's `bash` does, and a detached
  task keeps those variables after pi exits.
- A task's output is shown to the model verbatim; it is command output, and the
  model can already read it.

See the Security section of the [README](./README.md#security) for the
properties the implementation maintains.
