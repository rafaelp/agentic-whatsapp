# wacli command reference

Every command of wacli 0.26, with its main flags. `wacli help <command>` prints the full help.

**Effect**

- `read`: reads the local archive only. Run it with `--read-only`.
- `live`: asks WhatsApp's servers or your phone. Nobody else sees it.
- `account`: changes your WhatsApp account, or something other people see. Confirm first.
- `local`: changes only the local archive or files on disk.
- `delete`: deletes from the local archive. Run with `--dry-run` first, then `--confirm`.
- `interactive`: waits for the user. The user runs it with `! wacli …`.

**During sync**: what happens while `sync --follow` owns the archive.
`✓` works · `handed` goes through the running sync · `lock` fails until the sync stops.

**Global flags**: `--json` · `--read-only` · `--full` (no truncation) · `--store <dir>` ·
`--account <name>` · `--timeout <duration>` (default 5m) · `--lock-wait <duration>` ·
`--events` (NDJSON lifecycle events on stderr).

## Account and login

| Command | Effect | During sync | Main flags |
| --- | --- | --- | --- |
| `auth` | interactive | lock | Links the account with a QR code, then syncs. `--phone <+E164>` pairs with a code instead · `--full-history` · `--history-days N` · `--history-max-per-chat N` · `--history-size-mb N` · `--follow` · `--download-media` · `--qr-format terminal\|text` |
| `auth status` | read | ✓ | Whether the account is linked |
| `auth logout` | account | lock | Unlinks this device from the account |
| `accounts list` | read | ✓ | Named accounts in `config.yaml` |
| `accounts show NAME` | read | ✓ | One account |
| `accounts add NAME` | interactive | lock | Adds a named account and links it (same flags as `auth`; `--no-auth` only creates it) |
| `accounts use NAME` | local | ✓ | Sets the default account |
| `accounts remove NAME` | local | ✓ | Removes it from the config; its archive stays on disk |

## Chats

| Command | Effect | During sync | Main flags |
| --- | --- | --- | --- |
| `chats list` | read | ✓ | `--query <text>` · `--unread` · `--pinned` · `--muted` · `--archived` · `--no-archived` (and the other `--no-…`) · `--limit N` |
| `chats show` | read | ✓ | `--jid <jid>` |
| `chats mark-read` | account | handed | `--chat <chat>` · `--receipts` (also sends read receipts, for up to 100 messages) · `--through-message-id <id>` · `--pick N` |
| `chats mark-unread` | account | handed | `--chat <chat>` · `--pick N` |
| `chats archive` / `unarchive` | account | handed | `--chat <chat>` · `--pick N` |
| `chats pin` / `unpin` | account | handed | `--chat <chat>` · `--pick N` |
| `chats mute` / `unmute` | account | handed | `--chat <chat>` · `--duration 8h` (0 = forever) · `--pick N` |
| `chats cleanup` | delete | lock | Removes chats with no messages in `--days N` (default 365) · `--jid <jid>` · `--dry-run` · `--confirm` |

## Messages

| Command | Effect | During sync | Main flags |
| --- | --- | --- | --- |
| `messages list` | read | ✓ | `--chat <chat>` · `--sender <who>` · `--after` / `--before <date>` · `--from-me` / `--from-them` · `--starred` · `--forwarded` · `--asc` · `--limit N` · `--cursor` |
| `messages search <query>` | read | ✓ | `--chat` · `--from <who>` · `--after` / `--before` · `--type text\|image\|video\|audio\|document` · `--has-media` · `--starred` · `--forwarded` · `--context-before N` / `--context-after N` · `--limit N` · `--cursor` |
| `messages show` | read | ✓ | `--chat <chat>` · `--id <id>` (also shows deleted messages kept as tombstones) |
| `messages context` | read | ✓ | `--chat <chat>` · `--id <id>` · `--before N` / `--after N` (default 5) |
| `messages starred` | read | ✓ | `--chat` · `--after` / `--before` (star time) · `--asc` · `--limit N` |
| `messages export` | read | ✓ | JSON export: `--chat` · `--after` / `--before` · `--limit N` (default 1000) · `--output <file>` · `--cursor` |
| `messages changes` | read | ✓ | Content-free change feed: `--since <checkpoint>` · `--checkpoint` · `--limit N` |
| `messages edit` | account | handed | `--chat` · `--id` · `--message <new text>`; only your own recent text messages |
| `messages forward` | account | lock | `--chat <source chat>` · `--id <id>` · `--to <recipient>` · `--pick N` |
| `messages delete` | account | lock | Deletes your message for everyone: `--chat` · `--id`. `--for-me` deletes any message from your account only · `--delete-media` (with `--for-me`) |
| `messages revoke` | account | lock | Explicit form of delete for everyone: `--chat` · `--id` |
| `messages purge` | delete | lock | Erases a tombstone's retained content: `--chat` · `--id` · `--dry-run` · `--confirm` |

## Sending

Every send takes `--to <recipient>` (JID, phone number or name), `--pick N` when the name is
ambiguous, and `--post-send-wait <duration>` (default 2s).

| Command | Effect | During sync | Main flags |
| --- | --- | --- | --- |
| `send text` | account | handed | `--message <text>` · `--message-escapes` · `--reply-to <id>` · `--reply-to-sender <jid>` · `--mention <phone or jid>` (repeatable) · `--no-preview` · `--ephemeral` · `--ephemeral-duration 7d` · `--allow-self` |
| `send file` | account | handed | `--file <path>` · `--caption` · `--filename` · `--as auto\|document\|audio\|image\|video` · `--mime` · `--ptt` · `--max-size-mb N` (default 100) · `--reply-to` · `--reply-to-sender` |
| `send voice` | account | handed | `--file <path.ogg>` (OGG/Opus) · `--mime` · `--reply-to` · `--reply-to-sender` |
| `send sticker` | account | handed | `--file <path.webp>` · `--reply-to` · `--reply-to-sender` |
| `send location` | account | handed | `--latitude` · `--longitude` · `--name` |
| `send poll` | account | handed | `--question` · `--option` (repeat, 2 to 12) · `--multi N` (default 1) · `--ephemeral` |
| `send react` | account | handed | `--id <message id>` · `--reaction <emoji>` (default 👍; `""` removes) · `--sender <jid>` (group messages) |
| `send select` | account | handed | Answers a button or list message: `--id` · `--index N` · `--label <text>` · `--button-id` · `--type list_row\|quick_reply` · `--sender` |
| `send status` | account | lock | Posts a status update: `--message` · `--file` · `--background-color #RRGGBB` · `--font N` · `--mime` |

## Polls

| Command | Effect | During sync | Main flags |
| --- | --- | --- | --- |
| `polls list` | read | ✓ | `--chat <chat>` · `--limit N` · `--pick N` |
| `poll show` | read | ✓ | `--to <chat>` · `--id <poll id>` · `--pick N` |
| `poll vote` | account | handed | `--to <chat>` · `--id <poll id>` · `--option <text>` (repeat for multi-select) · `--sender <jid>` (group poll not in the archive) |

## Contacts

| Command | Effect | During sync | Main flags |
| --- | --- | --- | --- |
| `contacts search <query>` | read | ✓ | `--limit N` |
| `contacts show` | read | ✓ | `--jid <jid>` |
| `contacts resolve <lid\|phone\|jid>…` | read | ✓ | Maps LIDs to phone numbers and back |
| `contacts check <phone>…` | live | handed | Whether the numbers are on WhatsApp; nothing is stored |
| `contacts save` | account | handed | `--account-wide` (required) · `--jid <phone>` · `--name` · `--first-name` · `--phonebook` (also the phone's address book) |
| `contacts refresh` | local | lock | Copies contacts from the session into the archive |
| `contacts import-system` | local | lock | Display names from macOS Contacts: `--input <json file>` · `--dry-run` · `--clear` |
| `contacts alias set` / `rm` | local | lock | `--jid` · `--alias` |
| `contacts tags add` / `rm` | local | lock | `--jid` · `--tag` |

## Groups

All take `--jid <group jid>` unless noted. `--user` accepts a phone number or JID and repeats.

| Command | Effect | During sync | Main flags |
| --- | --- | --- | --- |
| `groups list` | read | ✓ | `--query <text>` · `--limit N` |
| `groups participants list` | read | ✓ | Local snapshot, possibly stale (`sync --once --refresh-groups` updates it) |
| `groups info` | live | lock | Fetches the group and updates the archive |
| `groups refresh` | live | lock | Fetches every joined group |
| `groups invite link get` | live | lock | The invite link |
| `groups requests list` | live | lock | Pending join requests |
| `groups create` | account | lock | `--name` · `--user` · `--announce-only` · `--locked` · `--join-approval` · `--community` · `--linked-parent <jid>` (no `--jid`) |
| `groups rename` | account | lock | `--name` |
| `groups description` / `topic` | account | lock | `--text` (empty clears it) |
| `groups announce-only` | account | lock | `--on` / `--off`: only admins can send |
| `groups locked` | account | lock | `--on` / `--off`: only admins can edit the group info |
| `groups participants add` / `remove` | account | lock | `--user` |
| `groups participants promote` / `demote` | account | lock | `--user` |
| `groups requests approve` / `reject` | account | lock | `--user` |
| `groups invite link revoke` | account | lock | Resets the invite link |
| `groups join` | account | lock | `--code <invite code>` (no `--jid`) |
| `groups leave` | account | lock | Leaves the group |
| `groups prune` | delete | lock | Removes left (and with `--include-active`, inactive) groups from the archive: `--days N` · `--dry-run` · `--confirm` |

## Channels

| Command | Effect | During sync | Main flags |
| --- | --- | --- | --- |
| `channels list` | live | lock | Subscribed channels |
| `channels info` | live | lock | `--jid <…@newsletter>` |
| `channels join` | account | lock | `--invite <link or code>` |
| `channels leave` | account | lock | `--jid <…@newsletter>` |

## Profile

| Command | Effect | During sync | Main flags |
| --- | --- | --- | --- |
| `profile get-about` | live | lock | `--jid <jid or phone>` |
| `profile business` | live | lock | `--jid <jid or phone>` |
| `profile picture-info` | live | lock | `--jid` · `--preview` · `--existing-id` |
| `profile set-name <name>` | account | lock | Your display name |
| `profile set-about <text>` | account | lock | Your About text |
| `profile set-picture <image>` | account | lock | JPEG or PNG, resized to 640 px at most |
| `profile remove-picture` | account | lock | Removes your picture |

## Presence

| Command | Effect | During sync | Main flags |
| --- | --- | --- | --- |
| `presence typing` | account | handed | `--to <jid>` · `--media audio` (shows "recording audio") |
| `presence paused` | account | handed | `--to <jid>` |
| `presence subscribe` | live | handed | `--to <jid>` · `--wait 10s` (0 needs a running sync). Shows online and last seen, if the contact's privacy allows |

## Media

| Command | Effect | During sync | Main flags |
| --- | --- | --- | --- |
| `media download` | local | lock | `--chat <jid>` · `--id <id>` · `--output <file or dir>` · `--retry-on-phone` |
| `media backfill` | local | lock | Downloads media missing locally: `--chat` · `--limit N` · `--workers N` |
| `media retry` | live | lock | Asks the phone to re-upload expired media: `--chat` · `--type` · `--before <date>` · `--limit N` · `--batch N` · `--wait` |

## History

| Command | Effect | During sync | Main flags |
| --- | --- | --- | --- |
| `history coverage` | read | ✓ | What the archive holds per chat: `--query` · `--chat` · `--kind dm\|group\|broadcast\|newsletter` · `--only-actionable` · `--limit N` |
| `history fill` | live | lock | Plans a backfill over several chats: `--query` · `--chat` · `--kind` · `--limit N` · `--dry-run` (no connection) |
| `history backfill` | live | lock | Asks the phone for older messages of one chat: `--chat <jid>` · `--count N` (default 50) · `--requests N` · `--wait 1m` |

## Sync, archive and diagnostics

| Command | Effect | During sync | Main flags |
| --- | --- | --- | --- |
| `sync` | local | lock | Follows until stopped; `--once` exits when idle (`--idle-exit 30s`) · `--refresh-contacts` · `--refresh-groups` · `--refresh-channels` · `--download-media` · `--max-db-size 2GB` · `--max-messages N` · `--webhook <url>` · `--webhook-secret` · `--webhook-events` · `--send-spacing 2s` · `--presence-mode normal\|quiet` |
| `store stats` | read | ✓ | Counts of chats, groups and messages |
| `store cleanup` | delete | lock | Removes chats and messages older than `--days N` (default 365) · `--dry-run` · `--confirm` |
| `calls list` | read | ✓ | `--chat` · `--after` / `--before` · `--asc` · `--limit N` |
| `doctor` | read | ✓ | Store, login, lock and search status; `--connect` also connects (needs the lock) |
| `version` · `docs` · `help [command]` | read | ✓ | Version, documentation URL, help |
| `completion <shell>` | read | ✓ | Shell completion script |
