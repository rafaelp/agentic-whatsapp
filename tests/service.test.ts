import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { buildPlist, LABEL, plistFor, resolveExecutable, servicePath, statusLines } from '../src/service.js';
import { UsageLedger } from '../src/usage.js';
import { BOB, makeConfig, NOW, tempDir } from './helpers.js';

async function executable(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, '#!/bin/sh\nexit 0\n');
  await chmod(file, 0o755);
  return file;
}

describe('buildPlist', () => {
  const plist = buildPlist({
    node: '/opt/node/bin/node',
    script: '/opt/agentic-whatsapp/dist/cli.js',
    configFile: '/Users/me/.config/agentic-whatsapp/config.toml',
    path: '/opt/node/bin:/opt/homebrew/bin:/usr/bin:/bin',
    env: { AGENTIC_WHATSAPP_STATE_DIR: '/tmp/state' },
    launchdLog: '/Users/me/Library/Logs/agentic-whatsapp/launchd.log',
  });

  it('runs the agent as a service with this config', () => {
    expect(plist).toContain(`<string>${LABEL}</string>`);
    expect(plist).toContain(
      [
        '    <string>/opt/node/bin/node</string>',
        '    <string>/opt/agentic-whatsapp/dist/cli.js</string>',
        '    <string>run</string>',
        '    <string>--service</string>',
        '    <string>--config</string>',
        '    <string>/Users/me/.config/agentic-whatsapp/config.toml</string>',
      ].join('\n'),
    );
  });

  it('restarts only after a crash, never in a fast loop', () => {
    expect(plist).toContain('<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>');
    expect(plist).toContain('<key>ThrottleInterval</key>\n  <integer>30</integer>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
  });

  it('sets PATH, copied variables and the launchd log', () => {
    expect(plist).toContain('<key>PATH</key>\n    <string>/opt/node/bin:/opt/homebrew/bin:/usr/bin:/bin</string>');
    expect(plist).toContain('<key>AGENTIC_WHATSAPP_STATE_DIR</key>\n    <string>/tmp/state</string>');
    expect(plist).toContain('<key>StandardErrorPath</key>\n  <string>/Users/me/Library/Logs/agentic-whatsapp/launchd.log</string>');
  });

  it('escapes XML', () => {
    const escaped = buildPlist({ node: '/a&b/node', script: '/<x>.js', configFile: '/c', path: '/p', env: {}, launchdLog: '/l' });
    expect(escaped).toContain('/a&amp;b/node');
    expect(escaped).toContain('/&lt;x&gt;.js');
  });
});

describe('resolveExecutable', () => {
  it('finds a command on PATH, or a path as given', async () => {
    const dir = await tempDir();
    const wacli = await executable(join(dir, 'bin'), 'wacli');
    await writeFile(join(dir, 'not-executable'), 'x');
    expect(resolveExecutable('wacli', `${join(dir, 'empty')}:${join(dir, 'bin')}`)).toBe(wacli);
    expect(resolveExecutable(wacli, '')).toBe(wacli);
    expect(resolveExecutable('agy', join(dir, 'bin'))).toBeNull();
    expect(resolveExecutable(join(dir, 'not-executable'), '')).toBeNull();
  });
});

describe('plistFor', () => {
  it('puts the folders of wacli and the engine on PATH and copies only the variables that are set', async () => {
    const dir = await tempDir();
    await executable(join(dir, 'homebrew'), 'wacli');
    await executable(join(dir, 'local'), 'agy');
    const config = makeConfig({}, dir);
    const plist = plistFor(config, {
      PATH: `${join(dir, 'homebrew')}:${join(dir, 'local')}`,
      AGENTIC_WHATSAPP_LOG_DIR: '/tmp/logs',
      XDG_STATE_HOME: '',
    });
    const path = /<key>PATH<\/key>\n\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? '';
    expect(path.split(':')).toEqual(
      expect.arrayContaining([join(dir, 'homebrew'), join(dir, 'local'), '/usr/bin', '/bin']),
    );
    expect(plist).toContain('<key>AGENTIC_WHATSAPP_LOG_DIR</key>');
    expect(plist).not.toContain('<key>XDG_STATE_HOME</key>');
    expect(plist).toContain(`<string>${config.paths.configFile}</string>`);
    expect(plist).toContain(`<string>${config.paths.launchdLog}</string>`);
  });

  it('adds the folders of the programs [cli] allows by name, after the others', async () => {
    const dir = await tempDir();
    await executable(join(dir, 'homebrew'), 'wacli');
    await executable(join(dir, 'homebrew'), 'agy');
    await executable(join(dir, 'node22'), 'joplin');
    const config = makeConfig({ cli: { allow: ['joplin mknote', 'joplin ls', 'missing', '/opt/x/tool'] } }, dir);
    const plist = plistFor(config, { PATH: `${join(dir, 'homebrew')}:${join(dir, 'node22')}` });
    const path = (/<key>PATH<\/key>\n\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? '').split(':');
    expect(path.slice(1, 3)).toEqual([join(dir, 'homebrew'), join(dir, 'node22')]);
    expect(path).not.toContain('/opt/x');
    expect(servicePath(join(dir, 'none.plist'))).toBeUndefined();
    const file = join(dir, 'agent.plist');
    await writeFile(file, plist);
    expect(servicePath(file)).toBe(path.join(':'));
  });

  it('explains a missing command', async () => {
    const dir = await tempDir();
    await executable(join(dir, 'bin'), 'wacli');
    expect(() => plistFor(makeConfig({}, dir), { PATH: join(dir, 'bin') })).toThrow(/agy was not found on PATH.*engine\.command/);
  });
});

describe('statusLines', () => {
  it('reports an agent that never ran', async () => {
    const dir = await tempDir();
    const lines = await statusLines(makeConfig({}, dir), NOW);
    expect(lines).toContain('agent     has not run yet');
    expect(lines.find((line) => line.startsWith('calls'))).toBe('calls     0 of 300 today');
    expect(lines.find((line) => line.startsWith('cost'))).toBe('cost      $0.0000 today · $0.0000 this week · $0.0000 this month');
    expect(lines.find((line) => line.startsWith('log'))).toContain(join(dir, 'logs', 'agent.log'));
    expect(existsSync(makeConfig({}, dir).paths.database)).toBe(false);
  });

  it('reports today’s calls and the health the agent saved', async () => {
    const dir = await tempDir();
    const config = makeConfig({}, dir);
    const store = Store.open(config.paths.database);
    new UsageLedger(store, config.engine, config.costs, config.agent.timezone).record(
      {
        attempt: 1,
        startedAt: NOW,
        durationMs: 9_000,
        status: 'ok',
        usage: { inputTokens: 10_000, outputTokens: 100, thinkingTokens: 0, cachedTokens: 0 },
        tools: [],
      },
      { chat: BOB, chatName: 'Bob' },
    );
    store.close();
    await writeFile(
      config.paths.healthFile,
      JSON.stringify({
        pid: process.pid,
        startedAt: NOW.toISOString(),
        lastMessageAt: NOW.toISOString(),
        wacli: { failures: 2, lastError: 'not authenticated', lastErrorAt: NOW.toISOString() },
        engine: { failures: 0 },
      }),
    );

    const lines = await statusLines(config, NOW);
    expect(lines.find((line) => line.startsWith('agent'))).toMatch(/up since 2026-11-10 12:00 · last message 2026-11-10 12:00/);
    expect(lines.find((line) => line.startsWith('calls'))).toBe('calls     1 of 300 today');
    // 10,000 × $0.75 + 100 × $3.75 per million
    expect(lines.find((line) => line.startsWith('cost'))).toBe('cost      $0.0079 today · $0.0079 this week · $0.0079 this month');
    expect(lines).toContain(`database  ${config.paths.database}`);
    expect(lines.find((line) => line.startsWith('wacli'))).toContain('failing, 2 in a row');
    expect(lines.find((line) => line.startsWith('engine'))).toBe('engine    ok (antigravity, gemini-3.8-flash-low)');
  });
});
