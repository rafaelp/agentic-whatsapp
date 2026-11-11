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
  `logs` show the tokens and cost of every decision.
- Cost limits per day, week and month (`[costs] max_per_day`, `max_per_week`, `max_per_month`): the
  model is not called once one is reached, and you are told once, plus a warning at `warn_percent`.
- Skills and MCP servers for Antigravity, managed with `agentic-whatsapp skills` and
  `agentic-whatsapp mcp` (`list`, `add`, `show`, `tools`, `scope`, `enable`, `disable`, `remove`).
  They run in a workspace of their own, only the tools you allow can be used, by default only on
  your own commands, and changes apply without a restart. `logs` shows the tools each call used.
- `check` reports the prices, the cost limits, the enabled skills and MCP servers, and the database.
- Images and audio: when a message that reaches the model carries one, it is downloaded through wacli
  and read by the model first, in a run that can read only that file. Images are described, audio and
  voice notes transcribed, and the decision gets that text with the message and in later history. A
  voice note you record in the home chat is a command. `[media]` turns images or audio off and sets
  `max_size_mb`; files go to the `media/` state folder and follow `[storage]`. `logs` shows each
  file read with its cost, and `costs --by purpose` splits decisions, images and audio.

- A new `agentic-whatsapp stream` shows only the messages Ane highlighted for you: ask it in the home
  chat, for example "highlight the messages from Carol for me", and the model highlights them from
  then on with a new `highlight` action, which sends nothing. Highlights are kept in the database
  with why they matter, and the stream shows each message's text, transcript or description.
- Every day at 1 am, `agentic-whatsapp stream` shows the cost of the day before: its model calls,
  tokens and cost.
- `agentic-whatsapp stream` clears the terminal when it starts; `--no-clear` keeps what was there.
- Your commands get a ✨ reaction as soon as they arrive, taken off once Ane has handled them
  (`agent.working_reaction`, `""` turns it off). Other people's messages never get one.
- Ane can change its own settings when you ask in the home chat, such as "monitor the Family group":
  built-in MCP tools find chats by name in the wacli archive and change `routing.direct_allowlist`,
  `group_allowlist`, `direct_messages` and `auto_reply_chats` in the config file, keeping its comments and the previous
  version in `config-history/`. They are offered only for commands you typed in the home chat, need
  Antigravity, and `agent.settings_tools = false` turns them off.
- `[cli]`: any command-line programs Ane may run for your commands, such as `gh issue create` or
  `joplin mknote` to take a note from any chat with "@ane make a note of this". `allow` and `deny` rules name a program and
  the words a command must start with, and deny wins. The model runs them through a `run_cli` MCP
  tool, without a shell; agy's own command tool stays denied. Every command is recorded in the
  database with its rule and exit code, and `logs` shows it. `scope = "home"` keeps it to the home
  chat, `install` adds the programs' folders to the service PATH, and `check` lists them.
- MCP servers that sign in with OAuth, such as Google's Gmail server: `mcp add --oauth-client-id
  --oauth-client-secret`, and `agentic-whatsapp mcp login <name>` to sign in once, in agy, from the
  agent's own workspace. The README explains how to set up Gmail.
- `routing.direct_allowlist`: the one-to-one chats whose messages reach the model. "follow Carol" in
  the home chat adds one, with the `monitor_chat` tool, which follows groups too.
- `agent.stream_deleted` (on by default): when someone deletes a message for everyone, the stream
  shows what it said, in any chat and without calling the model.
- Media hooks (`[[hooks]]`): when a file of the chosen media and MIME types arrives in the chosen
  chats (`home`, `direct`, `group`), Ane follows a skill of yours on it, with read access to that
  file, `run_cli` and your MCP tools, and tells you what it did. A file without a caption goes to its
  hooks only. `check` says whether each hook's skill is installed; costs show as `hook`.
- `media.audio_transcribe` (`none` by default, `direct`, `group` or `both`): every audio other
  people send you is transcribed, followed chat or not, and `media.audio_transcribe_to` sends the
  transcript to the home chat (`home`, the default), the stream (`stream`) or both. A followed
  chat's audio is transcribed once, for the decision too.
- Ane can answer what it costs: its `get_costs` tool gives every figure of `agentic-whatsapp costs` in
  one call, with today, this week, this month and all time, the limits, and the last days by day,
  chat, model and purpose. `costs --json` and the tool share the same code.

### Changed

- The live view of the agent that was `agentic-whatsapp stream` is now `agentic-whatsapp logs`, with
  the same options; following the raw log is `logs --raw`.
- Changes to `[routing]` in the config file apply from the next message, without a restart.
- Nothing reaches the model by default but your own commands: `routing.direct_messages` is now
  `false`, so one-to-one chats need to be followed (`direct_allowlist`) or turned on all at once.
- http MCP servers are written with `serverUrl`, as `agy mcp add` writes them; agy 1.5.5 reads the
  older `url` too.
- The state moved from `state.json` to the database. The first start imports it and renames it to
  `state.json.imported`.
- `engine.max_calls_per_day` counts every run of the engine, including the second attempt after a
  discarded answer.
- Node.js 22.13 or later is required, for its built-in SQLite.
- An answer whose whole decision is written inside a single action, which the model sometimes does
  after using tools, is unwrapped instead of dropped.

### Fixed

- A decision whose structured output lost a field, such as a reply without its text, now uses the
  written answer when that one has more valid actions. A voice note in the home chat went
  unanswered because of it.
- `install` over a running service could leave it stopped, with "launchctl bootstrap failed: 5:
  Input/output error": it now waits for the old agent to stop before starting the new one.

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
