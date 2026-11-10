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

[routing]
# Send one-to-one conversations to the model.
direct_messages = true
# Groups whose messages are sent to the model (JIDs ending in @g.us).
group_allowlist = []
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
`;
}

export function instructionsTemplate(name: string): string {
  const mention = `@${name.toLowerCase()}`;
  return `# Instructions for ${name}

${name} reads this file before every decision. Write the rules in any language.
Edit it by hand, or ask ${name} to change it, for example "${mention} from now on, ...".

- Tell me about messages that look urgent or that need an answer from me today.
- Ignore promotions, newsletters, automated notifications and small talk.
- Never reply to anyone on my behalf unless I ask.
`;
}
