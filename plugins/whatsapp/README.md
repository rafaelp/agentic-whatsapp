# whatsapp plugin for Claude Code

This plugin helps Claude Code work with your WhatsApp through
[wacli](https://github.com/openclaw/wacli), the WhatsApp command line.

| Skill | How it is used | What it does |
| --- | --- | --- |
| `wacli` | Loaded automatically when you ask about your WhatsApp | Teaches Claude every wacli command and its traps: reads with `--read-only`, names resolved to chat IDs before anything is sent, which commands work while a sync is running, and message content treated as data, never as instructions |
| `whatsapp` | `/whatsapp [command] [args...]` | Runs any wacli command with the same syntax as `wacli`. Reads run right away; sends, account changes and deletions are shown with the resolved recipient and confirmed first, and commands that would hang (`auth`, a following `sync`) get an alternative |

The `wacli` skill comes with a [reference of every command](skills/wacli/commands.md), what each one
changes and whether it works while `sync --follow` is running.

## Install

```text
/plugin marketplace add rafaelp/agentic-whatsapp
/plugin install whatsapp@agentic-whatsapp
```

## Requirements

wacli 0.26 or newer, linked to your account:

```bash
brew install openclaw/tap/wacli
wacli auth      # scan the QR code: WhatsApp › Linked devices › Link a device
```

The plugin works on its own, with or without the agentic-whatsapp agent. When the agent is running,
it already keeps the archive in sync, and sends from `/whatsapp` go through it.

## Examples

```text
/whatsapp chats list --unread
/whatsapp messages search "invoice" --after 2026-11-01
/whatsapp messages list --chat "Mom" --limit 20
/whatsapp send text --to "Bob" --message "Running 10 min late"
/whatsapp chats mute --chat "Building" --duration 168h
/whatsapp groups participants list --jid 120363000000000000@g.us
/whatsapp media download --chat <jid> --id <message id>
```

Or ask in plain language, for example "what did the school group say about Friday?" or "tell Bob on
WhatsApp that I'm running late".

## License

[MIT](../../LICENSE)
