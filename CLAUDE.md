# CLAUDE.md

Guidance for Claude Code in this repository. README.md describes the project, SECURITY.md its
guarantees, and CONTRIBUTING.md how to work on it.

## Working here

- Everything in the repository is written in English: code, docs, comments and commit messages.
- Every change in behaviour comes with a test for it. Run `npm run check` (typecheck and the whole
  suite) before committing, and `claude plugin validate .` after changing the plugin.
- Never put personal data in the repository, tests or examples: real phone numbers, chat IDs,
  names or message text. Tests use the fake JIDs in `tests/helpers.ts`.
- Anything that widens what the agent can do on its own must keep the guarantees in SECURITY.md and
  update that file.
- Add a line to CHANGELOG.md under "Unreleased" for every user-visible change.

## Code notes

- State lives in SQLite (`src/db.ts`, on `node:sqlite`). Change the schema only by appending a new
  migration that bumps `PRAGMA user_version`; never edit a migration that has shipped.
- Every run of the engine goes through `onAttempt` and is recorded by `UsageLedger` in
  `src/usage.ts`, failed and retried runs included, so costs and limits stay right. A new engine
  must report its tokens the same way.
- Skills and MCP servers (`src/tools.ts`) reach the model only in Antigravity's tools workspace.
  Tool permissions are enforced twice: by agy's settings (`toolSessionSettings`) and by the
  watchdog in `src/antigravity.ts`. Keep both in step, and keep `mcp_config.json`, which holds
  credentials, unreadable to the model.
- The agent's own settings server (`src/settings-mcp.ts`) is offered only for commands typed in
  the home chat (`Agent.toolsFor`). A tool that writes must stay inside `[routing]`, or SECURITY.md
  has to say why; it edits the file through `ConfigFile` in `src/settings.ts`, which checks the
  result and keeps the previous version. Only `[routing]` is read again while running (`LiveRouting`).
  `get_costs` and `agentic-whatsapp costs --json` share `src/report.ts`; change both together.
- Commands run only through `run_cli` (`src/commands.ts`): no shell, checked against `[cli]` by
  `checkCommand` (deny first), recorded in the `commands` table. agy's `command(*)` stays denied in
  every run; never allow it, because agy runs commands through a shell and its rules cannot be
  matched safely against shell syntax.

## Releasing

Every version published to npm must have a matching `vX.Y.Z` tag and a GitHub release with its
CHANGELOG.md notes. Always follow the steps in
[CONTRIBUTING.md › Releasing](CONTRIBUTING.md#releasing), in order, whenever a release or an npm
publish is asked for.

- `npm publish` needs the maintainer's one-time password. Do every other step, then ask the
  maintainer to run `npm publish` in the project folder, and wait for them to confirm.
- Publish the GitHub release (it starts as a draft) only after
  `npm view @rafaelp-aios/agentic-whatsapp version` shows the new version.
