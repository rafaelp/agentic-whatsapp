import { readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
import { ConfigFile, LiveRouting, routingChange, setTomlKey, tomlList } from '../src/settings.js';
import { configTemplate } from '../src/templates.js';
import { FAMILY, HOME, makeConfig, MemoryLogger, OTHER_GROUP, tempDir } from './helpers.js';

const TEMPLATE = configTemplate({ name: 'Ane', language: 'pt-BR', timezone: 'America/Sao_Paulo', homeChat: HOME });

describe('setTomlKey', () => {
  it('replaces a key in its table only, keeping comments and other tables', () => {
    const text = '[agent]\nname = "Ane"\n\n[routing]\n# Groups to read.\ngroup_allowlist = []\ndebounce_seconds = 15\n\n[other]\ngroup_allowlist = ["x"]\n';
    expect(setTomlKey(text, 'routing', 'group_allowlist', '["a@g.us"]')).toBe(
      '[agent]\nname = "Ane"\n\n[routing]\n# Groups to read.\ngroup_allowlist = ["a@g.us"]\ndebounce_seconds = 15\n\n[other]\ngroup_allowlist = ["x"]\n',
    );
  });

  it('replaces a value written over several lines, with comments and brackets in strings', () => {
    const text = '[routing]\ngroup_allowlist = [\n  "a@g.us", # family\n  "b@g.us", # "]" work\n]\ndirect_messages = true\n';
    expect(setTomlKey(text, 'routing', 'group_allowlist', '[]')).toBe('[routing]\ngroup_allowlist = []\ndirect_messages = true\n');
  });

  it('adds a missing key under its commented-out example, at the end of its table, or in a new table', () => {
    expect(setTomlKey('[routing]\n# direct_messages = false\ndebounce_seconds = 5\n', 'routing', 'direct_messages', 'true')).toBe(
      '[routing]\n# direct_messages = false\ndirect_messages = true\ndebounce_seconds = 5\n',
    );
    expect(setTomlKey('[routing]\ndebounce_seconds = 5\n\n[engine]\n', 'routing', 'direct_messages', 'false')).toBe(
      '[routing]\ndebounce_seconds = 5\ndirect_messages = false\n\n[engine]\n',
    );
    expect(setTomlKey('[agent]\nname = "Ane"\n', 'routing', 'direct_messages', 'false')).toBe(
      '[agent]\nname = "Ane"\n\n[routing]\ndirect_messages = false\n',
    );
  });
});

describe('tomlList', () => {
  it('writes short lists on one line and long ones one item per line', () => {
    expect(tomlList([])).toBe('[]');
    expect(tomlList([FAMILY])).toBe(`["${FAMILY}"]`);
    expect(tomlList([FAMILY, OTHER_GROUP, HOME])).toBe(`[\n  "${FAMILY}",\n  "${OTHER_GROUP}",\n  "${HOME}",\n]`);
  });
});

async function configFile(text = TEMPLATE) {
  const dir = await tempDir();
  const file = join(dir, 'config.toml');
  await writeFile(file, text);
  const location = { configFile: file, stateDir: join(dir, 'state') };
  return { dir, file, location, config: new ConfigFile(location, join(dir, 'history')) };
}

describe('ConfigFile', () => {
  it('changes [routing] in place and keeps the previous file', async () => {
    const { dir, file, config } = await configFile();
    const updated = await config.updateRouting({ groupAllowlist: [FAMILY], directMessages: true });
    expect(updated.routing).toMatchObject({ groupAllowlist: [FAMILY], directMessages: true });

    const text = await readFile(file, 'utf8');
    expect(text).toBe(
      TEMPLATE.replace('group_allowlist = []', `group_allowlist = ["${FAMILY}"]`).replace('direct_messages = false', 'direct_messages = true'),
    );
    const history = await readdir(join(dir, 'history'));
    expect(history).toHaveLength(1);
    expect(await readFile(join(dir, 'history', history[0] ?? ''), 'utf8')).toBe(TEMPLATE);
    expect((await config.read()).routing.groupAllowlist).toEqual([FAMILY]);
  });

  it('writes nothing when nothing changes, or when the result would not be valid', async () => {
    const { dir, file, config } = await configFile();
    await config.updateRouting({ directMessages: false });
    await expect(readdir(join(dir, 'history'))).rejects.toThrow();

    await expect(config.updateRouting({ groupAllowlist: ['Família'] })).rejects.toThrow(ConfigError);
    expect(await readFile(file, 'utf8')).toBe(TEMPLATE);
  });
});

describe('LiveRouting', () => {
  it('reads [routing] again when the file changes, and logs what changed', async () => {
    const { file, location, config } = await configFile();
    const log = new MemoryLogger();
    const live = new LiveRouting(location, (await config.read()).routing, log);
    expect(live.current().groupAllowlist).toEqual([]);

    await config.updateRouting({ groupAllowlist: [FAMILY], autoReplyChats: [FAMILY] });
    await utimes(file, new Date(), new Date(Date.now() + 5_000));
    expect(live.current().groupAllowlist).toEqual([FAMILY]);
    expect(log.entries).toEqual([
      { level: 'info', message: 'settings changed', fields: { monitoring: [FAMILY], autoReplyOn: [FAMILY] } },
    ]);
  });

  it('keeps the settings it had when the new file is broken', async () => {
    const { file, location, config } = await configFile();
    const log = new MemoryLogger();
    const live = new LiveRouting(location, (await config.read()).routing, log);
    await writeFile(file, `${TEMPLATE}\n[routing\n`);
    expect(live.current().directMessages).toBe(false);
    expect(log.has('warn', 'config file changed but could not be read; keeping the settings it had')).toBe(true);
  });
});

describe('routingChange', () => {
  it('lists the chats added and removed, and the switches that changed', () => {
    const before = makeConfig().routing;
    const after = makeConfig({ routing: { group_allowlist: [OTHER_GROUP], direct_messages: false, debounce_seconds: 5 } }).routing;
    expect(routingChange(before, after)).toEqual({
      monitoring: [OTHER_GROUP],
      stoppedMonitoring: [FAMILY],
      directMessages: false,
      debounceSeconds: 5,
    });
    expect(routingChange(before, before)).toEqual({});
  });
});
