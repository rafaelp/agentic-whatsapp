#!/usr/bin/env node
// Prints the CHANGELOG.md section of one version, for its GitHub release notes:
//   node scripts/release-notes.mjs 0.3.0 | gh release create v0.3.0 --notes-file - …
import { readFileSync } from 'node:fs';

const version = process.argv[2];
if (version === undefined || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error('usage: node scripts/release-notes.mjs <version>');
  process.exit(2);
}

const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split('\n');
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
// The section ends at the next version heading, or at the link references at the bottom.
const end = lines.findIndex((line, index) => index > start && (line.startsWith('## [') || /^\[[^\]]+\]: /.test(line)));
const notes = lines
  .slice(start + 1, end === -1 ? undefined : end)
  .join('\n')
  .trim()
  // In-page anchors only work inside CHANGELOG.md; point them at the file on GitHub.
  .replace(/\]\(#/g, '](https://github.com/rafaelp/agentic-whatsapp/blob/main/CHANGELOG.md#');
if (notes === '') {
  console.error(`The ${version} section of CHANGELOG.md is empty`);
  process.exit(1);
}
console.log(notes);
