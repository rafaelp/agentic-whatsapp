import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MediaProcessor, mediaExtension, safeName } from '../src/media.js';
import { FAMILY, FakeReader, FakeWacli, makeConfig, message, tempDir } from './helpers.js';

describe('mediaExtension', () => {
  it('names files by MIME type, ignoring parameters', () => {
    expect(mediaExtension('audio/ogg; codecs=opus', 'audio')).toBe('ogg');
    expect(mediaExtension('audio/mp4', 'audio')).toBe('m4a');
    expect(mediaExtension('image/jpeg', 'image')).toBe('jpg');
    expect(mediaExtension('IMAGE/PNG', 'image')).toBe('png');
  });

  it('falls back to what WhatsApp sends when the type is unknown', () => {
    expect(mediaExtension('', 'image')).toBe('jpg');
    expect(mediaExtension('', 'audio')).toBe('ogg');
  });

  it('refuses formats Gemini cannot read, or of the other kind', () => {
    expect(mediaExtension('audio/amr', 'audio')).toBeUndefined();
    expect(mediaExtension('image/jpeg', 'audio')).toBeUndefined();
  });
});

describe('safeName', () => {
  it('keeps JIDs and IDs readable and free of separators and dots', () => {
    expect(safeName(FAMILY)).toBe('120363000000000002@g_us');
    expect(safeName('../../etc/passwd')).toBe('______etc_passwd');
    expect(safeName('3EB0ABC')).toBe('3EB0ABC');
  });
});

describe('MediaProcessor', () => {
  let dir: string;
  let wacli: FakeWacli;
  let reader: FakeReader;

  beforeEach(async () => {
    dir = await tempDir();
    wacli = new FakeWacli();
    reader = new FakeReader();
  });

  const processor = (media: Record<string, unknown> = {}, keepFiles = true) =>
    new MediaProcessor({
      config: makeConfig({ media }).media,
      agent: { name: 'Ane', language: 'pt-BR' },
      dir,
      wacli,
      reader,
      keepFiles,
    });

  it('reads only images and audio, as configured', () => {
    const both = processor();
    expect(both.kindOf(message({ mediaType: 'image' }))).toBe('image');
    expect(both.kindOf(message({ mediaType: 'audio' }))).toBe('audio');
    expect(both.kindOf(message({ mediaType: 'video' }))).toBeUndefined();
    expect(both.kindOf(message())).toBeUndefined();
    expect(processor({ audio: false }).kindOf(message({ mediaType: 'audio' }))).toBeUndefined();
    expect(processor({ images: false }).kindOf(message({ mediaType: 'image' }))).toBeUndefined();
  });

  it('downloads the file into a folder per chat, reads it and keeps it', async () => {
    const voice = message({ chat: FAMILY, id: 'AUDIO1', mediaType: 'audio', mediaMime: 'audio/ogg; codecs=opus' });
    const attempts: unknown[] = [];
    const result = await processor().read(voice, { onAttempt: (attempt) => attempts.push(attempt) });

    const file = join(dir, '120363000000000002@g_us', 'AUDIO1.ogg');
    expect(wacli.downloads).toEqual([{ chat: FAMILY, id: 'AUDIO1', output: file }]);
    expect(reader.requests).toEqual([{ kind: 'audio', file, language: 'pt-BR', assistant: 'Ane' }]);
    expect(reader.contents).toEqual(['MEDIA BYTES']);
    expect(result).toEqual({ kind: 'audio', text: 'Uma foto de um boleto de R$ 120,00.', file });
    expect(attempts).toHaveLength(1);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('deletes the file after reading it when files are not kept', async () => {
    const result = await processor({}, false).read(message({ mediaType: 'image' }));
    expect(result?.text).toBeDefined();
    expect(result?.file).toBeUndefined();
    expect(await readdir(join(dir, safeName(message().chat)))).toEqual([]);
  });

  it('skips files that are too large or in a format it cannot read, without downloading', async () => {
    const large = message({ mediaType: 'image', mediaSize: 2 * 1024 * 1024 });
    expect(await processor({ max_size_mb: 1 }).read(large)).toEqual({ kind: 'image', skipped: 'too large' });
    const amr = message({ mediaType: 'audio', mediaMime: 'audio/amr' });
    expect(await processor().read(amr)).toEqual({ kind: 'audio', skipped: 'unsupported format audio/amr' });
    expect(wacli.downloads).toEqual([]);
  });

  it('skips a download larger than the limit, and deletes it', async () => {
    wacli.media = 'x'.repeat(1024 * 1024 + 1);
    const result = await processor({ max_size_mb: 1 }).read(message({ chat: FAMILY, mediaType: 'image' }));
    expect(result).toEqual({ kind: 'image', skipped: 'too large' });
    expect(reader.requests).toEqual([]);
    expect(await readdir(join(dir, safeName(FAMILY)))).toEqual([]);
  });

  it('reports a failed download or reading', async () => {
    wacli.media = null;
    expect(await processor().read(message({ mediaType: 'image' }))).toEqual({ kind: 'image', error: 'media expired' });

    wacli.media = 'bytes';
    reader.error = new Error('Antigravity did not answer within 120s');
    const failed = await processor().read(message({ chat: FAMILY, id: 'IMG2', mediaType: 'image' }));
    expect(failed).toEqual({
      kind: 'image',
      error: 'Antigravity did not answer within 120s',
      file: join(dir, safeName(FAMILY), 'IMG2.jpg'),
    });
  });

  it('does nothing for a message without readable media', async () => {
    expect(await processor().read(message({ mediaType: 'document' }))).toBeUndefined();
    expect(wacli.downloads).toEqual([]);
  });
});
