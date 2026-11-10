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

Outgoing messages carry a prefix and have `@<agent name>` defused, and the agent remembers what it sent (by ID and by text). It cannot trigger itself or loop.

### Local surfaces

- The webhook receiver only binds to a loopback address, refuses requests without a valid `X-Wacli-Signature` (HMAC-SHA256), and limits request size.
- The webhook secret is random on every start and never written to disk.
- Config, instructions and state files are created readable by your user only.
- Commands are run without a shell, so message text is never interpreted by one.

## Risks that remain

- **Manipulated content.** Prompt injection cannot be fully prevented. A crafted message can still make the model misjudge it: hide something from you, alarm you, or word a reply badly in a chat where replies are allowed. Keep `auto_reply_chats` short and review what the agent does in `--dry-run` first.
- **A tool call before the kill.** With Antigravity, a tool that no setting can deny may start before agentic-whatsapp kills the run. The ones seen so far, such as web search, only read public information, and whatever they return is discarded with the answer.
- **Data sent to Google.** Every message that passes routing, plus the chat history sent as context and your instructions, goes to the model. How it is stored and used depends on your Google plan and its terms.
- **Same-user processes.** The webhook secret is passed to `wacli` as a command-line argument, and outgoing text is passed to `wacli send` the same way. Other processes running as your user can see them. A malicious process running as your user can do far more than this, so the agent does not try to defend against it.
- **Files on disk.** wacli's message store and this tool's state are not encrypted by this tool. Protect your computer account and use disk encryption.
- **WhatsApp account.** wacli is an unofficial client. WhatsApp may restrict accounts that behave in automated ways.
