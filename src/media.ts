import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AgentConfig, MediaConfig } from './config.js';
import type { Attempt } from './decision.js';
import type { ChatMessage } from './types.js';
import { errorMessage } from './util.js';
import type { WacliClient } from './wacli.js';

export type MediaKind = 'image' | 'audio';

export interface MediaRequest {
  kind: MediaKind;
  /** Absolute path of the downloaded file. */
  file: string;
  /** Language of descriptions, such as "pt-BR". Transcripts keep the language spoken. */
  language: string;
  /** The agent's name, so a transcript spells it right when someone speaks to it. */
  assistant: string;
}

export interface MediaOptions {
  /** Called after every run of the engine, like for decisions. */
  onAttempt?: (attempt: Attempt) => void;
}

/** An engine that can look at an image or listen to audio and put it into words. */
export interface MediaReader {
  readMedia(request: MediaRequest, options?: MediaOptions): Promise<string>;
}

export interface MediaResult {
  kind: MediaKind;
  /** The description of the image or the transcript of the audio. */
  text?: string;
  /** Where the file is, when it is kept. */
  file?: string;
  /** Why it was not read at all, such as "too large". */
  skipped?: string;
  /** Why reading it failed. */
  error?: string;
}

/** Longest description or transcript passed on to the model. */
const MAX_TEXT_LENGTH = 8_000;

/**
 * File extensions for the formats Gemini reads, by MIME type. agy tells the model what a
 * file is from its extension, so the download is named with the right one.
 */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
  'audio/webm': 'webm',
};

/** WhatsApp sends photos as JPEG and voice notes as Ogg Opus. */
const DEFAULT_EXTENSIONS: Record<MediaKind, string> = { image: 'jpg', audio: 'ogg' };

/** The extension to save media of this MIME type with, or undefined when Gemini cannot read it. */
export function mediaExtension(mime: string, kind: MediaKind): string | undefined {
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === '') return DEFAULT_EXTENSIONS[kind];
  const extension = EXTENSIONS[base];
  return extension !== undefined && base.startsWith(`${kind}/`) ? extension : undefined;
}

/** A chat JID or message ID as a file name: no separators, no dots. */
export function safeName(value: string): string {
  return value.replace(/[^\p{L}\p{N}@_-]/gu, '_') || '_';
}

export interface MediaDeps {
  config: MediaConfig;
  agent: Pick<AgentConfig, 'name' | 'language'>;
  /** Where downloads go, one folder per chat. */
  dir: string;
  wacli: Pick<WacliClient, 'downloadMedia'>;
  reader: MediaReader;
  /** Keep the files after reading them; off deletes each one right away. */
  keepFiles: boolean;
}

/**
 * Downloads the images and audio of incoming messages through wacli and has the engine
 * describe or transcribe them, so the model that decides gets them as text.
 */
export class MediaProcessor {
  constructor(private readonly deps: MediaDeps) {}

  /** What this message carries that can be read, if anything. */
  kindOf(message: ChatMessage): MediaKind | undefined {
    const { config } = this.deps;
    if (message.mediaType === 'image' && config.images) return 'image';
    if (message.mediaType === 'audio' && config.audio) return 'audio';
    return undefined;
  }

  /** Downloads and reads the media of `message`; undefined when there is none to read. */
  async read(message: ChatMessage, options: MediaOptions = {}): Promise<MediaResult | undefined> {
    const kind = this.kindOf(message);
    if (kind === undefined) return undefined;
    const { config, keepFiles } = this.deps;
    const extension = mediaExtension(message.mediaMime ?? '', kind);
    if (extension === undefined) return { kind, skipped: `unsupported format ${message.mediaMime ?? ''}`.trim() };
    if ((message.mediaSize ?? 0) > config.maxBytes) return { kind, skipped: 'too large' };

    let file = resolve(this.deps.dir, safeName(message.chat), `${safeName(message.id)}.${extension}`);
    let keep = false;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const downloaded = await this.deps.wacli.downloadMedia(message.chat, message.id, file);
      file = downloaded.path;
      const bytes = downloaded.bytes || (await stat(file)).size;
      if (bytes > config.maxBytes) return { kind, skipped: 'too large' };
      await chmod(file, 0o600);
      keep = keepFiles;
      const { agent } = this.deps;
      const request = { kind, file, language: agent.language, assistant: agent.name };
      const text = cleanText(await this.deps.reader.readMedia(request, options));
      if (text === '') return { kind, error: 'the model returned no text', file: keep ? file : undefined };
      return { kind, text, file: keep ? file : undefined };
    } catch (error) {
      return { kind, error: errorMessage(error), file: keep ? file : undefined };
    } finally {
      if (!keep) await rm(file, { force: true });
    }
  }
}

function cleanText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_TEXT_LENGTH ? `${trimmed.slice(0, MAX_TEXT_LENGTH - 1)}…` : trimmed;
}
