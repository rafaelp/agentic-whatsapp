import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { ConfigError, defaultConfigPath, defaultStateDir, loadConfig, parseConfig } from '../src/config.js';
import { configTemplate } from '../src/templates.js';
import { tempDir } from './helpers.js';

const location = { configFile: '/home/me/.config/agentic-whatsapp/config.toml', stateDir: '/home/me/.local/state/aw' };

describe('parseConfig', () => {
  it('fills in defaults from just a name', () => {
    const config = parseConfig({ agent: { name: 'Ane' } }, location);
    expect(config.agent).toMatchObject({ name: 'Ane', language: 'en', homeChat: '', messagePrefix: '🤖 Ane: ' });
    expect(config.routing).toEqual({
      directMessages: true,
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
    expect(config.paths.instructionsFile).toBe('/home/me/.config/agentic-whatsapp/instructions.md');
  });

  it('requires a valid agent name', () => {
    expect(() => parseConfig({}, location)).toThrow(/agent.name is required/);
    expect(() => parseConfig({ agent: { name: 'a' } }, location)).toThrow(ConfigError);
    expect(() => parseConfig({ agent: { name: 'Ane Maria' } }, location)).toThrow(ConfigError);
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
  });
});
