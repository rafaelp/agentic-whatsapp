# Contributing

Thanks for helping. Bug reports, fixes and ideas are all welcome.

## Before you start

- For a bug, open an issue with what you did, what you expected and what happened. Leave out message content and phone numbers.
- For a new feature, open an issue first, so we can agree on the approach before you write code.
- For a security problem, do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Development

You need Node.js 22.12 or newer.

```sh
npm install
npm run check    # typecheck and the whole test suite
npm run build    # compiles src/ to dist/
```

The tests never touch WhatsApp or a real model: wacli, Antigravity CLI and Gemini CLI are replaced with small fake executables and in-memory fakes. To try a change against your real account, use `node dist/cli.js run --dry-run --verbose`, which decides but only logs what it would send.

## Guidelines

- Every change in behaviour comes with a test for that behaviour.
- Keep runtime dependencies to a minimum. Anything new needs a good reason.
- Anything that widens what the agent can do on its own, such as new actions, new routing rules or tool access for Gemini, must keep the guarantees in SECURITY.md and update that file.
- Write code, comments and docs in English. The agent itself can speak any language.
- Add a line to [CHANGELOG.md](CHANGELOG.md) under "Unreleased".

## Pull requests

Keep each pull request to one change, explain why it is needed, and make sure `npm run check` passes. By contributing, you agree that your work is released under the [MIT License](LICENSE).
