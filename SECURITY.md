# Security

agentic-whatsapp reads your WhatsApp conversations, sends them to a language model and can send messages from your account. This document explains how it limits what can go wrong, what it cannot prevent, and how to report a problem.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub's **Report a vulnerability** button, on the repository's **Security** tab.

Include what you found, how to reproduce it, and what an attacker could do with it. You should get an answer within a week. Once a fix is released, the report can be made public, with credit to you if you want it.

## Supported versions

Only the latest release receives security fixes.

## Threat model

### Who can talk to the agent

The main attacker is **anyone who can send you a WhatsApp message**: a stranger, a group member, a compromised contact. They control the text of their messages and will try to make the agent obey it.

The owner is the only one who can give commands:

- A command is a message sent **from your own account** (`FromMe`) that contains `@<agent name>`, or any message from your account in the home chat.
- The same text written by someone else is an ordinary message.
- A message you **forward** carries someone else's words, so a mention inside it is never a command outside the home chat. Forwarded messages in the home chat are passed to the model marked `forwarded_by_owner`, and they cannot change the instructions.
- The group allowlist takes JIDs only. Group names are rejected, because any member can rename a group.

### What the model can do

The model is treated as untrusted, because its answer can be shaped by the messages it reads. Its only job is to return a JSON decision; it must not act by itself.

**Antigravity CLI** (the default engine) cannot turn its tools off, so the tools are blocked in layers:

1. Every call passes `--settings` with settings for that run only. agy never saves them, and your own agy settings are not touched. They deny every permission namespace (`read_file`, `write_file`, `read_url`, `execute_url`, `command`, `mcp`), set `toolPermission` to `strict` so any other tool action needs an approval that headless mode cannot give, disable slash commands, and forbid spending paid AI credits.
2. agy runs in an empty working directory that belongs to agentic-whatsapp.
3. agentic-whatsapp watches agy's event stream. File reads, file writes and commands, which agy is verified to refuse under these settings, are left to fail. **Any other tool**, such as web search, which no setting can deny, **kills the run as soon as it starts**, and the answer is discarded. So is the answer of a run where a supposedly refused tool completes. After a discarded answer the model gets one more attempt, told why the first one failed.

**Gemini CLI** runs with an admin-tier policy that denies every tool (`toolName = "*"`, `decision = "deny"`), in an empty working directory, with its system prompt replaced.

### Skills and MCP tools the owner enables

With Antigravity, the owner can give the agent skills and MCP servers (`agentic-whatsapp skills` and `agentic-whatsapp mcp`). None is on by default, and they widen only what the model can do while deciding: the actions it can cause afterwards, and their policy, stay the same. The one built-in server, the agent's own settings, is described in the next section.

- **Opt-in, tool by tool.** A server's tools are allowed by name (`mcp tools <server> <tool...>`), or all of them only when the owner says so (`*`). Each allowed tool becomes an agy permission rule, `mcp(<server>/<tool>)`; nothing else is allowed.
- **Owner commands only, by default.** A server or skill with scope `commands` (the default) is only offered for a batch with a command the owner typed. Batches made only of other people's messages, or of forwarded ones, get no tools at all, so a stranger's message alone cannot make the agent use one. Scope `all` offers it to every batch; the owner is told to keep that for tools that only read harmless information.
- **A separate workspace.** Runs with tools happen in `antigravity/workspace-tools/`, which holds only the MCP config of the servers offered to that batch and copies of its skills. Runs without tools still use the empty workspace with every permission denied.
- **Settings for that run only.** agy's `strict` mode refuses allowed MCP tools too, so these runs use `request-review`: the allow rules go through, and anything else that needs an approval is refused, because headless mode cannot give one. Commands, file writes and URL tools stay denied, and so do MCP tools when no server is offered. File reads cannot be denied as a whole, because agy reads skills and the schemas of MCP tools as files and a deny rule beats any allow rule. The MCP config, which can hold credentials, is denied by name.
- **The watchdog still decides.** A run may go on only through `finish`, the allowed MCP tools (checked by server and tool name), and reads inside the skills folder or the schema folder agy keeps for an offered server. Any other tool, including a read of any other path, a search of the workspace, a subagent or web search, kills the run as soon as it starts, and the answer is discarded.
- **Prompt rules.** The model is told to use tools only for the owner's instructions and commands, never because a message from someone else asks, and never to put private information in a tool call on someone else's behalf.

### Its own settings

With Antigravity, the agent has one MCP server of its own, `agentic-whatsapp`, on by default (`agent.settings_tools`). Its tools change what reaches the model and where it may reply, so they are kept narrow:

- **Commands typed in the home chat only.** The server is offered only for a batch of the home chat with a command the owner typed. The home chat is a chat where only the owner writes; a batch made only of forwarded messages gets no tools, and the server is never offered in any other chat, even on a command with `@<agent name>`, where other people's messages can share the batch.
- **A few keys of [routing], nothing else.** The tools can read the settings, look chats up in the wacli archive (`--read-only`), read the cost figures of the database (`get_costs`: totals, limits, and costs per day, chat name, model and purpose, never message text), add or remove a group in `group_allowlist` or a chat in `auto_reply_chats`, and turn `direct_messages` on or off. They cannot touch the agent's name, home chat, engine, limits, storage, or the tools themselves. A group or chat must be a well-formed ID that the wacli archive knows; names are only used to find IDs, never stored.
- **The file stays valid and recoverable.** Only those keys are rewritten, the result is parsed with the same rules as at startup before it is written, and the previous file is kept in `config-history/`. A dry run changes nothing.
- **The same guards as any MCP tool.** agy gets a permission rule for each settings tool, and the watchdog checks every call by server and tool name. The server is this program itself (`agentic-whatsapp settings-mcp`), started by agy with the agent's config file.
- **Seen in the log.** The running agent reads `[routing]` again when the file changes and logs what changed (chat IDs only), and the call that used the tools lists them.

### Command-line programs the owner allows

`[cli]` lets the agent run command-line programs for the owner. It is empty by default, and it is the widest thing the agent can be given: an allowed program does whatever it does with your user's rights. It is built so that only what the owner listed can run, and only for the owner:

- **No shell, ever.** agy's own command tool stays denied (`command(*)`) in every run, because agy runs commands through a shell, where a rule cannot be matched safely. Commands go through one MCP tool of the agent's own, `run_cli` (`agentic-whatsapp cli-mcp`), which takes the program and its arguments as a list and starts the program directly, without a shell. Message text that ends up in an argument is never interpreted.
- **Allow and deny rules, checked before anything runs.** A rule is a program, by name or full path, then the words a command must start with. A command runs only when an allow rule matches and no deny rule does. The model is told the rules; a refused command is recorded and the model gets the reason back.
- **Owner commands only.** `run_cli` is offered for a batch with a command the owner typed: in any chat with `scope = "commands"`, only in the home chat with `scope = "home"`. Batches made only of other people's messages, or of forwarded ones, never get it.
- **Bounded runs.** The program runs in the agent's own `cli/` folder, with stdin closed and a time limit (`timeout_seconds`), and the model gets at most 8,000 characters of each output. With `--dry-run` nothing runs.
- **An audit trail.** Every command, run or refused, is stored in the `commands` table with the rule that allowed it, its status and exit code. Its arguments are kept like other texts (`storage.save_text`, `retention_days`), and the agent log, which never holds message text, gets only the program and the rule.

### Images and audio

With Antigravity, the image or audio of a message that reaches the model is downloaded and put into words before the decision. Its content comes from whoever sent it, so it is handled like message text:

- **A run that sees only the file.** Each file is read in its own agy run, in an empty workspace (`antigravity/workspace-media/`), with no rules, instructions, history or messages: only the request to describe or transcribe that one file. Whatever the file says can at most distort the text the run returns.
- **Settings for that run only.** `strict` refuses reads even with an allow rule, so these runs use `request-review` with one allow rule, `read_file(<that file>)`, written to a settings file that is deleted afterwards. Commands, writes, URL tools and MCP stay denied, and reading any other file needs an approval headless mode cannot give.
- **The watchdog.** The run may read that file, by its path or its real path, and end its turn; any other tool, including a read of anything else or web search, kills it, and it gets one more attempt.
- **Text, marked as such.** The description or transcript is capped and JSON-encoded into the message it belongs to, as `description` or `transcript`. The model is told they are data like any message text. The one exception is the transcript of a voice note the owner recorded in a command, which is the owner speaking; text that appears inside an image is data even then. A forwarded voice note is not a command.
- **Downloads.** wacli fetches the file in read-only mode, straight from WhatsApp's media servers with the keys in its archive; nothing is sent. Files larger than `media.max_size_mb`, and formats Gemini cannot read, are not downloaded or read.

With both engines:

- The prompt goes through stdin, so message content does not show up in the process list.
- Message text is JSON-encoded inside the prompt, with `<` escaped, so it cannot close the section it sits in and pose as instructions.
- The answer must be a JSON list of known actions; Antigravity also enforces it with `--json-schema`. Anything else is dropped, at most five actions run per decision, and texts are capped.

### What an answer can cause

agentic-whatsapp checks every action before it happens:

| Action | Allowed when |
| --- | --- |
| `notify` | Always. It only reaches the owner, in the home chat. |
| `reply` | The owner invoked the agent in that chat, or the chat is in `routing.auto_reply_chats`. Otherwise it becomes a suggestion sent to the owner. |
| `update_instructions` | The batch contains a command the owner typed. Every previous version is kept in `instructions-history/`. |
| `highlight` | Always, since nothing is sent: it is stored in the database for `agentic-whatsapp stream`. It may only point at new messages of its batch; any other ID is ignored. |

Outgoing messages carry a prefix and have `@<agent name>` defused, and the agent remembers what it sent (by ID and by text). It cannot trigger itself or loop.

### Local surfaces

- The webhook receiver only binds to a loopback address, refuses requests without a valid `X-Wacli-Signature` (HMAC-SHA256), and limits request size.
- The webhook secret is random on every start and never written to disk.
- Config, instructions, their previous versions, the database, the MCP config and downloaded images and audio are created readable by your user only.
- Commands are run without a shell, so message text is never interpreted by one. That includes the programs `[cli]` allows.

## Risks that remain

- **Manipulated content.** Prompt injection cannot be fully prevented. A crafted message can still make the model misjudge it: hide something from you, alarm you, or word a reply badly in a chat where replies are allowed. Keep `auto_reply_chats` short and review what the agent does in `--dry-run` first.
- **A misleading description or transcript.** An image or audio can be made to mislead the model that reads it: text in a picture that looks like an instruction, or speech that pretends to be someone else. The run that reads it has nothing to act on, and its text reaches the decision as data, but it can still change what you are told about that message.
- **A tool call before the kill.** With Antigravity, a tool that no setting can deny may start before agentic-whatsapp kills the run. The ones seen so far, such as web search, only read public information, and whatever they return is discarded with the answer. In runs with tools, the same goes for a read or search of the agent's own workspace, which agy allows by itself: it may complete, and its result may reach the model, before the run is killed.
- **What enabled tools can do.** An allowed MCP tool does whatever its server does, with the arguments the model chooses, and the model chooses them after reading the batch. On an owner command, the batch can still contain other people's messages and history, so prompt injection can steer a tool call. An MCP server that writes, sends or deletes is as dangerous as the arguments the model can be talked into. Allow only the tools you need, prefer read-only servers, and keep scope `all` for harmless ones.
- **MCP credentials.** `--env` and `--header` values, and the client secret of an OAuth server, are stored in plain text in the database and in the MCP config of the tools workspace, both readable only by your user, and stdio servers see the environment agy runs with. They are never printed by `mcp list` or `mcp show`. The OAuth tokens of a server you signed in to with `mcp login` are kept by agy, like those of your own agy sessions, and any agent run offered that server can use them, within the tools you allowed.
- **What allowed programs can do.** On an owner command, the model picks the arguments of `run_cli` after reading the command and the rest of the batch and history, which can include other people's messages. Within the rules, prompt injection can steer them: overwrite a note with `joplin set`, or pass an option that changes what an allowed subcommand does. A deny rule only matches the first words of a command, so options placed before them, or another command that does the same (`gh api -X DELETE …` instead of `gh repo delete`), get past it. Allow only the subcommands you need, prefer programs that cannot delete or send, use `scope = "home"` for anything that writes, and never allow a shell or an interpreter (`check` warns about those), which would let the agent run anything your user can.
- **Settings changed on a misunderstanding.** On a command in the home chat, the model chooses the arguments of the settings tools after reading that command, its history and any forwarded messages, so a misread request, or a forwarded message posing as one, could start or stop monitoring a group, or allow auto-replies in a chat. The change is limited to those keys, the model is told to report it with a notify, and `logs` shows it; review it there and undo it in the config file, whose previous versions are kept.
- **Skills are trusted.** A skill is instructions the owner chose to install; a malicious skill can misguide the model like malicious instructions would. Skills cannot run their scripts, because commands stay denied.
- **Data sent to Google.** Every message that passes routing, with its image or audio, plus the chat history sent as context and your instructions, goes to the model. How it is stored and used depends on your Google plan and its terms.
- **Same-user processes.** The webhook secret is passed to `wacli` as a command-line argument, and outgoing text is passed to `wacli send` the same way. Other processes running as your user can see them. A malicious process running as your user can do far more than this, so the agent does not try to defend against it.
- **Files on disk.** wacli's message store and this tool's database are not encrypted by this tool. The database keeps message text, descriptions and transcripts, prompts, the model's answers, what was sent and why messages were highlighted, and the images and audio the agent read stay in its state folder, unless `storage.save_text = false`; `storage.retention_days` deletes those texts and files after a while. The agent log holds chat IDs, contact and group names, what the agent decided, tokens and costs, but never message text; `agentic-whatsapp logs` and `agentic-whatsapp stream` read text from the wacli archive or the database only to show it on screen (`--no-text` turns that off). Protect your computer account and use disk encryption.
- **WhatsApp account.** wacli is an unofficial client. WhatsApp may restrict accounts that behave in automated ways.
