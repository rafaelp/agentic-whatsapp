import { rename, writeFile } from 'node:fs/promises';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

export function lastLines(text: string, count = 5): string {
  return text.trim().split(/\r?\n/).slice(-count).join('\n');
}

/** Writes through a temporary file so a crash never leaves a half-written file behind. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, file);
}
