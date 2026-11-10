import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const script = new URL('../scripts/release-notes.mjs', import.meta.url).pathname;
const notes = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

describe('scripts/release-notes.mjs', () => {
  it('prints the CHANGELOG section of a version, without its heading or the next one', async () => {
    const result = notes('0.1.0');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('### Added');
    expect(result.stdout).not.toContain('## [0.1.0]');
    expect(result.stdout).not.toContain('[Unreleased]: ');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(notes(pkg.version).status).toBe(0);
  });

  it('turns links to other CHANGELOG sections into links that work in a release', () => {
    const result = notes('0.3.0');
    expect(result.stdout).toContain('](https://github.com/rafaelp/agentic-whatsapp/blob/main/CHANGELOG.md#');
    expect(result.stdout).not.toContain('](#');
  });

  it('fails for a version without a section, and without a version', () => {
    expect(notes('9.9.9').status).toBe(1);
    expect(notes().status).toBe(2);
  });
});
