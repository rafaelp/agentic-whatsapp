# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Background service commands, modeled on agentic-joplin: `install`, `uninstall`, `start`, `stop`,
  `restart`, `status`, `logs` and `print`. The service pins Node by absolute path, finds wacli and
  the engine on PATH, restarts after a crash and stays down, with a notification, when it cannot
  start for a reason the user has to fix.
- `agentic-whatsapp stream`: a live view of the agent, with messages arriving (text read from the
  wacli archive, never from the log), decisions, sends and errors. `--all`, `--no-text`, `--lines N`.
- `agent.log`, with size rotation (`[service] log_max_mb`, `log_keep`), and `launchd.log` for crashes.
- macOS notifications when WhatsApp sync or the model fails 3 times in a row, and when they recover
  (`[service] notify`).
- `health.json`, read by `status`: start time, last message and decision, failures in a row.

### Changed

- `launchd` is now `print` (the old name still works), and the plist runs `run --service`.
- The build marks `dist/cli.js` executable, so `npm link` keeps working after a rebuild.

## [0.2.0]

### Added

- Claude Code plugin marketplace with the `whatsapp` plugin: a `/whatsapp [command]` skill that runs
  any wacli command, confirming sends, account changes and deletions first, and a `wacli` skill with
  a reference of every wacli command.

## [0.1.0]

### Added

- `run`: keeps `wacli sync --follow` running and receives its messages on a signed localhost webhook.
- Routing: one-to-one chats, allowlisted groups, and the owner's `@<name>` commands in any chat or in the home chat.
- Per-chat batching, so a burst of messages costs one model call.
- Engines: Antigravity CLI (default, on a Google AI subscription) and Gemini CLI (API key). Both run with the prompt on stdin, in an empty workspace, with tools denied; Antigravity runs are killed at the first tool call no setting can deny.
- Actions `notify`, `reply` and `update_instructions`, with a policy that turns unrequested replies into suggestions and only lets the owner change the instructions.
- Daily limit on model calls.
- `init`, `check`, `launchd` and a systemd unit.
