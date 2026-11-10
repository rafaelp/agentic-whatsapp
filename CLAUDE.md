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

## Releasing

Every version published to npm must have a matching `vX.Y.Z` tag and a GitHub release with its
CHANGELOG.md notes. Always follow the steps in
[CONTRIBUTING.md › Releasing](CONTRIBUTING.md#releasing), in order, whenever a release or an npm
publish is asked for.

- `npm publish` needs the maintainer's one-time password. Do every other step, then ask the
  maintainer to run `npm publish` in the project folder, and wait for them to confirm.
- Publish the GitHub release (it starts as a draft) only after
  `npm view @rafaelp-aios/agentic-whatsapp version` shows the new version.
