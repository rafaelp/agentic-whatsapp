export interface TemplateOptions {
  name: string;
  language: string;
  timezone: string;
  homeChat: string;
}

/** TOML basic strings accept JSON string escapes. */
const quote = (value: string): string => JSON.stringify(value);

export function configTemplate(options: TemplateOptions): string {
  const mention = `@${options.name.toLowerCase()}`;
  return `# agentic-whatsapp configuration. Every setting is described in README.md.

[agent]
# The agent's name. Any message YOU send that contains "${mention}" goes to the
# agent as a command, in any chat.
name = ${quote(options.name)}
# Language the agent writes in.
language = ${quote(options.language)}
# Time zone for timestamps and for the daily call limit.
timezone = ${quote(options.timezone)}
# Private chat (usually a group with only you) where the agent notifies you.
# Everything you write there is a command, no "${mention}" needed.
# Find its JID with: wacli groups list
home_chat = ${quote(options.homeChat)}
# Prepended to every message the agent sends.
# message_prefix = ${quote(`🤖 ${options.name}: `)}
# Reaction the agent puts on your commands while it works on them, removed once it is
# done. "" turns it off.
working_reaction = "✨"
# Show in agentic-whatsapp stream the messages other people delete for everyone, with
# what they said. Nothing goes to the model.
stream_deleted = true
# Let the agent change [routing] when you ask in the home chat, such as
# "monitor the Family group" (Antigravity only).
settings_tools = true

[routing]
# Only the chats listed here reach the model, plus your own commands. Ask in the home
# chat to follow a chat ("follow Carol", "monitor the Family group"), or list it here.
# One-to-one chats whose messages are sent to the model (JIDs ending in
# @s.whatsapp.net or @lid).
direct_allowlist = []
# Groups whose messages are sent to the model (JIDs ending in @g.us).
group_allowlist = []
# Send every one-to-one conversation to the model, allowlisted or not.
direct_messages = false
# Chats where the agent may reply to other people without being asked.
# Empty: it only replies in chats where you invoke it with "${mention}".
auto_reply_chats = []
# Wait this long after the last message of a chat before calling the model,
# so a burst of messages costs a single call.
debounce_seconds = 15
# Ignore messages older than this, such as a backlog after the computer slept. 0 disables.
max_message_age_minutes = 60

[engine]
# "antigravity" runs Antigravity CLI (agy) on your Google AI subscription.
# "gemini-cli" runs Gemini CLI, which since June 2026 needs an API key.
kind = "antigravity"
command = "agy"
# List the models with: agy models. -low is fast (about 10 s a call); -medium
# and -high think longer (about 50 s a call) and use more of the quota.
model = "gemini-3.8-flash-low"
timeout_seconds = 120
# Stop calling the model after this many calls in a day.
max_calls_per_day = 300
# Earlier messages of the same chat sent along as context.
context_messages = 20
# Extra arguments for the engine command.
extra_args = []

[wacli]
command = "wacli"
# Store directory. Empty uses wacli's default (~/.wacli).
store = ""
# Extra arguments for "wacli sync --follow", e.g. ["--max-db-size", "4GB"].
sync_args = []

[service]
# The agent log (~/Library/Logs/agentic-whatsapp/agent.log on macOS) rotates above
# this size, keeping this many old copies.
log_max_mb = 5
log_keep = 5
# macOS notifications from the background service when WhatsApp sync or the model
# keeps failing, and when they recover.
notify = true

[costs]
# Every model call is stored with its tokens and priced at Gemini API rates. On
# Antigravity this is what the tokens would cost on the API; your plan is not billed.
# See them with: agentic-whatsapp costs
currency = "USD"
# Prices per million tokens. Known models need none; set them for any other model.
# input_per_million = 0.75
# output_per_million = 3.75
# cached_per_million = 0.075
# Stop calling the model once a day, week (Monday to Sunday) or month has cost this
# much, and tell you once in the home chat. 0 means no limit.
max_per_day = 0
max_per_week = 0
max_per_month = 0
# Warn once when a limit is this far used up. 0 never warns.
warn_percent = 80

[storage]
# The database keeps every message, decision, model call and send. false keeps
# names, IDs, tokens and costs, but no message text, descriptions, transcripts,
# prompts or answers, and deletes each image or audio file once it is read.
save_text = true
# Delete those texts, and the image and audio files, after this many days; tokens
# and costs stay. 0 keeps them.
retention_days = 0

[media]
# Images and audio of the messages the model sees are downloaded through wacli and
# read by the model first (Antigravity only): images are described, audio and voice
# notes transcribed. Each one is a model call of its own.
images = true
audio = true
# Larger files are not downloaded.
max_size_mb = 20

[cli]
# Command-line programs the agent may run for your commands, any program you choose, with
# its run_cli tool and without a shell (Antigravity only). A rule is a program, by name or
# full path, then the words a command must start with: "gh" allows every gh command,
# "gh issue list" only that one. deny wins over allow, but only blocks the words it names,
# so prefer narrow allow rules to a broad allow with denies. Empty: the agent runs nothing.
# A skill (agentic-whatsapp skills add) can teach the agent how to use a program.
# allow = ["gh issue list", "gh issue create", "joplin mknote", "joplin set", "/opt/tools/backup status"]
# deny = ["gh repo delete"]
allow = []
deny = []
# "commands": for a command you type, in any chat. "home": only in the home chat.
scope = "commands"
# A command still running after this long is stopped.
timeout_seconds = 60
`;
}

export function instructionsTemplate(name: string): string {
  const mention = `@${name.toLowerCase()}`;
  return `# Instructions for ${name}

${name} reads this file before every decision. Write the rules in any language.
Edit it by hand, or ask ${name} to change it, for example "${mention} from now on, ...".
Rules can also choose what \`agentic-whatsapp stream\` shows, for example
"${mention} highlight the messages from Carol for me".

- Tell me about messages that look urgent or that need an answer from me today.
- Ignore promotions, newsletters, automated notifications and small talk.
- Never reply to anyone on my behalf unless I ask.
`;
}
