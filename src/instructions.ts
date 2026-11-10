import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isNotFound, writeFileAtomic } from './util.js';

/**
 * The owner's standing instructions, in a Markdown file the owner can edit.
 * Every change made by the agent keeps the previous version in `historyDir`.
 */
export class InstructionsStore {
  constructor(
    readonly file: string,
    private readonly historyDir: string,
  ) {}

  async read(): Promise<string> {
    try {
      return (await readFile(this.file, 'utf8')).trim();
    } catch (error) {
      if (isNotFound(error)) return '';
      throw error;
    }
  }

  async write(content: string): Promise<void> {
    const previous = await this.read();
    if (previous !== '') {
      await mkdir(this.historyDir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await writeFile(join(this.historyDir, `${stamp}.md`), `${previous}\n`, { mode: 0o600 });
    }
    await mkdir(dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, `${content.trim()}\n`);
  }
}
