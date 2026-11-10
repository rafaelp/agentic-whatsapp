# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

Every version published to npm has a matching `v` tag and GitHub release with these notes. See [Releasing](CONTRIBUTING.md#releasing).

## [Unreleased]

### Added

- A SQLite database (`agentic-whatsapp.db` in the state folder), on the SQLite built into Node: every
  message the agent was given, every batch and its decision, every model call with its tokens, cost,
  tools, prompt and answer, and everything it sent. `[storage] save_text = false` keeps no text, and
  `retention_days` deletes old texts while keeping tokens and costs.
- Cost tracking: each run of the engine records its input, output, cached and thinking tokens and
  its cost, priced at Gemini API rates (Gemini 3.8 Flash built in, others set in `[costs]`).
  `agentic-whatsapp costs` sums today, this week, this month and all time, and breaks the last days
  down by day, chat or model (`--days`, `--by`, `--json`). `status` shows the cost, and the log and
  `stream` show the tokens and cost of every decision.
- Cost limits per day, week and month (`[costs] max_per_day`, `max_per_week`, `max_per_month`): the
  model is not called once one is reached, and you are told once, plus a warning at `warn_percent`.
- Skills and MCP servers for Antigravity, managed with `agentic-whatsapp skills` and
  `agentic-whatsapp mcp` (`list`, `add`, `show`, `tools`, `scope`, `enable`, `disable`, `remove`).
  They run in a workspace of their own, only the tools you allow can be used, by default only on
  your own commands, and changes apply without a restart. `stream` shows the tools each call used.
- `check` reports the prices, the cost limits, the enabled skills and MCP servers, and the database.

### Changed

- The state moved from `state.json` to the database. The first start imports it and renames it to
  `state.json.imported`.
- `engine.max_calls_per_day` counts every run of the engine, including the second attempt after a
  discarded answer.
- Node.js 22.13 or later is required, for its built-in SQLite.
- An answer whose whole decision is written inside a single action, which the model sometimes does
  after using tools, is unwrapped instead of dropped.

## [0.3.1] - 2026-11-10

### Fixed

- A message that wacli delivers twice, first without content and then with its text, was dropped
  as a duplicate. This happens to the first message a device sends in a group, which carries the
  group's encryption key.

## [0.3.0] - 2026-11-10

The first npm release since 0.1.0. It also ships [0.2.0](#020---2026-11-10), which was tagged but never published to npm: the Claude Code plugin marketplace with the `whatsapp` plugin.

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

## [0.2.0] - 2026-11-10

Tagged, but not published to npm. Its changes ship in 0.3.0.

### Added

- Claude Code plugin marketplace with the `whatsapp` plugin: a `/whatsapp [command]` skill that runs
  any wacli command, confirming sends, account changes and deletions first, and a `wacli` skill with
  a reference of every wacli command.

## [0.1.0] - 2026-11-10

### Added

- `run`: keeps `wacli sync --follow` running and receives its messages on a signed localhost webhook.
- Routing: one-to-one chats, allowlisted groups, and the owner's `@<name>` commands in any chat or in the home chat.
- Per-chat batching, so a burst of messages costs one model call.
- Engines: Antigravity CLI (default, on a Google AI subscription) and Gemini CLI (API key). Both run with the prompt on stdin, in an empty workspace, with tools denied; Antigravity runs are killed at the first tool call no setting can deny.
- Actions `notify`, `reply` and `update_instructions`, with a policy that turns unrequested replies into suggestions and only lets the owner change the instructions.
- Daily limit on model calls.
- `init`, `check`, `launchd` and a systemd unit.

[Unreleased]: https://github.com/rafaelp/agentic-whatsapp/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/rafaelp/agentic-whatsapp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/rafaelp/agentic-whatsapp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rafaelp/agentic-whatsapp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rafaelp/agentic-whatsapp/releases/tag/v0.1.0
