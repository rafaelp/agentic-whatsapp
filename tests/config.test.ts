import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  defaultConfigPath,
  defaultLogDir,
  defaultStateDir,
  loadConfig,
  parseConfig,
} from '../src/config.js';
import { configTemplate } from '../src/templates.js';
import { tempDir } from './helpers.js';

const location = { configFile: '/home/me/.config/agentic-whatsapp/config.toml', stateDir: '/home/me/.local/state/aw' };

describe('parseConfig', () => {
  it('fills in defaults from just a name', () => {
    const config = parseConfig({ agent: { name: 'Ane' } }, location);
    expect(config.agent).toMatchObject({ name: 'Ane', language: 'en', homeChat: '', messagePrefix: '🤖 Ane: ', settingsTools: true });
    expect(parseConfig({ agent: { name: 'Ane', settings_tools: false } }, location).agent.settingsTools).toBe(false);
    expect(config.cli).toEqual({ allow: [], deny: [], scope: 'commands', timeoutSeconds: 60 });
    expect(config.agent.workingReaction).toBe('✨');
    expect(config.agent.streamDeleted).toBe(true);
    expect(config.media.transcribe).toBe('none');
    expect(parseConfig({ agent: { name: 'Ane' }, media: { audio_transcribe: 'both' } }, location).media.transcribe).toBe('both');
    expect(() => parseConfig({ agent: { name: 'Ane' }, media: { audio_transcribe: 'all' } }, location)).toThrow(
      /media.audio_transcribe must be "none", "direct", "group" or "both"/,
    );
    expect(parseConfig({ agent: { name: 'Ane', working_reaction: '' } }, location).agent.workingReaction).toBe('');
    expect(config.routing).toEqual({
      directMessages: false,
      directAllowlist: [],
      groupAllowlist: [],
      autoReplyChats: [],
      debounceSeconds: 15,
      maxMessageAgeMinutes: 60,
    });
    expect(config.engine).toMatchObject({
      kind: 'antigravity',
      command: 'agy',
      model: 'gemini-3.8-flash-low',
      maxCallsPerDay: 300,
    });
    expect(config.wacli).toMatchObject({ command: 'wacli', listenHost: '127.0.0.1', listenPort: 0 });
    expect(config.service).toEqual({ logMaxBytes: 5 * 1024 * 1024, logKeep: 5, notify: true });
    expect(config.paths).toMatchObject({
      instructionsFile: '/home/me/.config/agentic-whatsapp/instructions.md',
      healthFile: '/home/me/.local/state/aw/health.json',
      agentLog: '/home/me/.local/state/aw/logs/agent.log',
      launchdLog: '/home/me/.local/state/aw/logs/launchd.log',
    });
  });

  it('reads the service settings and an explicit log folder', () => {
    const config = parseConfig(
      { agent: { name: 'Ane' }, service: { log_max_mb: 2, log_keep: 3, notify: false } },
      { ...location, logDir: '/home/me/Library/Logs/agentic-whatsapp' },
    );
    expect(config.service).toEqual({ logMaxBytes: 2 * 1024 * 1024, logKeep: 3, notify: false });
    expect(config.paths.agentLog).toBe('/home/me/Library/Logs/agentic-whatsapp/agent.log');
    expect(() => parseConfig({ agent: { name: 'Ane' }, service: { log_keep: 0 } }, location)).toThrow(/whole number/);
  });

  it('requires a valid agent name', () => {
    expect(() => parseConfig({}, location)).toThrow(/agent.name is required/);
    expect(() => parseConfig({ agent: { name: 'a' } }, location)).toThrow(ConfigError);
    expect(() => parseConfig({ agent: { name: 'Ane Maria' } }, location)).toThrow(ConfigError);
  });

  it('accepts only contact JIDs in the direct allowlist', () => {
    const routing = (direct_allowlist: string[]) => parseConfig({ agent: { name: 'Ane' }, routing: { direct_allowlist } }, location).routing;
    expect(routing(['5521999990001@s.whatsapp.net', '86088878149676@lid']).directAllowlist).toHaveLength(2);
    expect(() => routing(['Carol'])).toThrow(/direct_allowlist takes contact JIDs/);
    expect(() => routing(['120363000000000002@g.us'])).toThrow(/direct_allowlist takes contact JIDs/);
  });

  it('accepts only group JIDs in the allowlist', () => {
    expect(() => parseConfig({ agent: { name: 'Ane' }, routing: { group_allowlist: ['Família'] } }, location)).toThrow(
      /group JIDs/,
    );
    const config = parseConfig(
      { agent: { name: 'Ane' }, routing: { group_allowlist: ['120363000000000002@g.us'] } },
      location,
    );
    expect(config.routing.groupAllowlist).toEqual(['120363000000000002@g.us']);
  });

  it('rejects misspelled settings', () => {
    expect(() => parseConfig({ agent: { name: 'Ane' }, routing: { group_alowlist: [] } }, location)).toThrow(
      /Unknown setting in \[routing\]: group_alowlist/,
    );
    expect(() => parseConfig({ agent: { name: 'Ane' }, extra: {} }, location)).toThrow(/Unknown setting/);
  });

  it('rejects wrong types and out-of-range numbers', () => {
    expect(() => parseConfig({ agent: { name: 'Ane' }, routing: { direct_messages: 'yes' } }, location)).toThrow(
      /true or false/,
    );
    expect(() => parseConfig({ agent: { name: 'Ane' }, engine: { max_calls_per_day: 0 } }, location)).toThrow(
      /whole number/,
    );
  });

  it('uses the defaults of the chosen engine', () => {
    const config = parseConfig({ agent: { name: 'Ane' }, engine: { kind: 'gemini-cli' } }, location);
    expect(config.engine).toMatchObject({ kind: 'gemini-cli', command: 'gemini', model: 'gemini-3.8-flash' });
    expect(() => parseConfig({ agent: { name: 'Ane' }, engine: { kind: 'openai' } }, location)).toThrow(
      /engine.kind/,
    );
  });

  it('keeps the webhook receiver on a loopback address', () => {
    expect(() => parseConfig({ agent: { name: 'Ane' }, wacli: { listen_host: '0.0.0.0' } }, location)).toThrow(
      /loopback/,
    );
  });

  it('reads costs and storage, with no limits and every text kept by default', () => {
    const defaults = parseConfig({ agent: { name: 'Ane' } }, location);
    expect(defaults.costs).toEqual({
      currency: 'USD',
      inputPerMillion: undefined,
      outputPerMillion: undefined,
      cachedPerMillion: undefined,
      maxPerDay: 0,
      maxPerWeek: 0,
      maxPerMonth: 0,
      warnPercent: 80,
    });
    expect(defaults.storage).toEqual({ saveText: true, retentionDays: 0 });
    expect(defaults.paths).toMatchObject({
      database: '/home/me/.local/state/aw/agentic-whatsapp.db',
      skillsDir: '/home/me/.local/state/aw/skills',
    });

    const config = parseConfig(
      {
        agent: { name: 'Ane' },
        costs: { currency: 'BRL', input_per_million: 4, output_per_million: 20.5, max_per_day: 1.5, max_per_month: 30, warn_percent: 0 },
        storage: { save_text: false, retention_days: 30 },
      },
      location,
    );
    expect(config.costs).toMatchObject({ currency: 'BRL', inputPerMillion: 4, outputPerMillion: 20.5, maxPerDay: 1.5, maxPerMonth: 30, warnPercent: 0 });
    expect(config.storage).toEqual({ saveText: false, retentionDays: 30 });
    expect(() => parseConfig({ agent: { name: 'Ane' }, costs: { max_per_day: -1 } }, location)).toThrow(/number from 0/);
    expect(() => parseConfig({ agent: { name: 'Ane' }, costs: { max_per_week: '5' } }, location)).toThrow(/number from 0/);
    expect(() => parseConfig({ agent: { name: 'Ane' }, storage: { keep: true } }, location)).toThrow(/Unknown setting in \[storage\]/);
  });

  it('reads images and audio by default, up to 20 MB', () => {
    const defaults = parseConfig({ agent: { name: 'Ane' } }, location);
    expect(defaults.media).toEqual({ images: true, audio: true, maxBytes: 20 * 1024 * 1024, transcribe: 'none', transcribeTo: 'home' });
    expect(defaults.paths.mediaDir).toBe('/home/me/.local/state/aw/media');
    const off = parseConfig({ agent: { name: 'Ane' }, media: { images: false, audio: false, max_size_mb: 5 } }, location);
    expect(off.media).toMatchObject({ images: false, audio: false, maxBytes: 5 * 1024 * 1024 });
    expect(parseConfig({ agent: { name: 'Ane' }, media: { audio_transcribe_to: 'both' } }, location).media.transcribeTo).toBe('both');
    expect(() => parseConfig({ agent: { name: 'Ane' }, media: { audio_transcribe_to: 'email' } }, location)).toThrow(
      /media.audio_transcribe_to must be "home", "stream" or "both"/,
    );
    expect(() => parseConfig({ agent: { name: 'Ane' }, media: { max_size_mb: 0 } }, location)).toThrow(/media.max_size_mb/);
    expect(() => parseConfig({ agent: { name: 'Ane' }, media: { video: true } }, location)).toThrow(/Unknown setting in \[media\]/);
  });

  it('reads [cli] rules as a program and the words a command starts with', () => {
    const cli = parseConfig(
      { agent: { name: 'Ane' }, cli: { allow: ['joplin  mknote', '/opt/bin/notes'], deny: ['joplin rmnote'], scope: 'home', timeout_seconds: 5 } },
      location,
    ).cli;
    expect(cli).toEqual({
      allow: [
        { text: 'joplin mknote', program: 'joplin', args: ['mknote'] },
        { text: '/opt/bin/notes', program: '/opt/bin/notes', args: [] },
      ],
      deny: [{ text: 'joplin rmnote', program: 'joplin', args: ['rmnote'] }],
      scope: 'home',
      timeoutSeconds: 5,
    });
    expect(() => parseConfig({ agent: { name: 'Ane' }, cli: { deny: ['bin/joplin'] } }, location)).toThrow(/cli.deny: "bin\/joplin" must be/);
    expect(() => parseConfig({ agent: { name: 'Ane' }, cli: { scope: 'all' } }, location)).toThrow(/cli.scope must be "commands" or "home"/);
  });

  it('validates the time zone and the home chat', () => {
    expect(() => parseConfig({ agent: { name: 'Ane', timezone: 'Mars/Base' } }, location)).toThrow(/time zone/);
    expect(() => parseConfig({ agent: { name: 'Ane', home_chat: 'Ane' } }, location)).toThrow(/JIDs/);
  });
});

describe('configTemplate', () => {
  it('produces a config that parses back to the chosen values', () => {
    const text = configTemplate({
      name: 'Ane',
      language: 'pt-BR',
      timezone: 'America/Sao_Paulo',
      homeChat: '120363000000000001@g.us',
    });
    const config = parseConfig(parse(text), location);
    expect(config.agent).toMatchObject({
      name: 'Ane',
      language: 'pt-BR',
      timezone: 'America/Sao_Paulo',
      homeChat: '120363000000000001@g.us',
    });
    expect(config.engine).toMatchObject({ kind: 'antigravity', command: 'agy', model: 'gemini-3.8-flash-low' });
    expect(config.costs).toMatchObject({ currency: 'USD', maxPerDay: 0, warnPercent: 80 });
    expect(config.storage).toEqual({ saveText: true, retentionDays: 0 });
    expect(text).toContain('"@ane"');
  });
});

describe('loadConfig', () => {
  it('explains how to create a missing config', async () => {
    const dir = await tempDir();
    await expect(loadConfig(join(dir, 'config.toml'), {})).rejects.toThrow(/agentic-whatsapp init/);
  });

  it('reports invalid TOML with the file name', async () => {
    const dir = await tempDir();
    const file = join(dir, 'config.toml');
    await writeFile(file, '[agent\nname = ');
    await expect(loadConfig(file, {})).rejects.toThrow(/Invalid TOML/);
  });

  it('honors the XDG and AGENTIC_WHATSAPP environment variables', () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: '/x' })).toBe('/x/agentic-whatsapp/config.toml');
    expect(defaultConfigPath({ AGENTIC_WHATSAPP_CONFIG: '/y.toml' })).toBe('/y.toml');
    expect(defaultStateDir({ XDG_STATE_HOME: '/s' })).toBe('/s/agentic-whatsapp');
    expect(defaultStateDir({ AGENTIC_WHATSAPP_STATE_DIR: '/t' })).toBe('/t');
    expect(defaultLogDir({ AGENTIC_WHATSAPP_LOG_DIR: '/l' }, 'darwin')).toBe('/l');
    expect(defaultLogDir({}, 'darwin')).toMatch(/Library\/Logs\/agentic-whatsapp$/);
    expect(defaultLogDir({ XDG_STATE_HOME: '/s' }, 'linux')).toBe('/s/agentic-whatsapp/logs');
  });
});
