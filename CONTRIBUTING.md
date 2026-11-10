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

## Releasing

Every version published to npm has a matching `vX.Y.Z` tag and a GitHub release whose notes are its
CHANGELOG.md section. Never publish to npm without the tag, and never publish a GitHub release for a
version that is not on npm. Follow these steps in order, with `X.Y.Z` as the new version:

1. In CHANGELOG.md, move the "Unreleased" entries under a new `## [X.Y.Z] - YYYY-MM-DD` heading,
   leave "Unreleased" empty, and update the compare links at the bottom.
2. Bump the version and run the checks:
   ```sh
   npm version X.Y.Z --no-git-tag-version
   npm run check
   node scripts/release-notes.mjs X.Y.Z    # prints the release notes; fails if the section is missing
   ```
3. Commit, tag and push:
   ```sh
   git commit -am "chore: release X.Y.Z"
   git tag -a vX.Y.Z -m "agentic-whatsapp X.Y.Z"
   git push origin main vX.Y.Z
   ```
4. Wait for CI to pass on that commit: `gh run watch`.
5. Draft the GitHub release from the tag:
   ```sh
   node scripts/release-notes.mjs X.Y.Z | gh release create vX.Y.Z --draft --verify-tag --title "vX.Y.Z" --notes-file -
   ```
6. Publish to npm. It asks for the maintainer's one-time password:
   ```sh
   npm publish
   ```
7. Once `npm view @rafaelp-aios/agentic-whatsapp version` shows `X.Y.Z`, publish the release:
   ```sh
   gh release edit vX.Y.Z --draft=false --latest
   ```

If `npm publish` fails, fix the problem and publish again from the same tag. If the fix needs a code
change, release it as the next patch version instead of moving the tag.
