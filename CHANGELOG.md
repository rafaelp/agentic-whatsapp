# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
