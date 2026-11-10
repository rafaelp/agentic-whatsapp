import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

export interface LogFile {
  path: string;
  maxBytes: number;
  /** Rotated copies to keep: path.1 … path.<keep>. */
  keep: number;
}

export interface LoggerOptions {
  /** Show debug lines on the terminal too. The log file always gets every level. */
  verbose?: boolean;
  /** Write to stderr (default true). Off for the launchd service, whose stderr is launchd.log. */
  stderr?: boolean;
  /** Also append every line to this file, rotated by size. */
  file?: LogFile;
  /** Replaces stderr, for tests. */
  write?: (line: string) => void;
}

/** One line per entry: `<ISO time> <LEVEL> <message> <fields as JSON>`. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const terminalMinimum = options.verbose ? LEVELS.debug : LEVELS.info;
  const terminal = options.write ?? (options.stderr === false ? undefined : (line: string) => process.stderr.write(`${line}\n`));
  const file = options.file === undefined ? undefined : fileWriter(options.file);

  const at = (level: Level) => (message: string, fields?: LogFields) => {
    const toTerminal = terminal !== undefined && LEVELS[level] >= terminalMinimum;
    if (!toTerminal && file === undefined) return;
    const line = formatLogLine(new Date(), level, message, fields);
    if (toTerminal) terminal(line);
    file?.(line);
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function formatLogLine(time: Date, level: Level, message: string, fields?: LogFields): string {
  const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
  return `${time.toISOString()} ${level.toUpperCase()} ${message}${suffix}`;
}

export interface LogEntry {
  time: Date;
  level: Level;
  message: string;
  fields: LogFields;
}

/** Reads a line written by createLogger; null for anything else. */
export function parseLogLine(line: string): LogEntry | null {
  const match = /^(\S+) (DEBUG|INFO|WARN|ERROR) (.*)$/.exec(line.trimEnd());
  if (match === null) return null;
  const time = new Date(match[1] ?? '');
  if (Number.isNaN(time.getTime())) return null;
  const level = (match[2] ?? 'INFO').toLowerCase() as Level;
  const rest = match[3] ?? '';

  // Fields are the trailing JSON object; the message itself may contain " {".
  for (let index = rest.indexOf(' {'); index !== -1; index = rest.indexOf(' {', index + 1)) {
    try {
      const fields: unknown = JSON.parse(rest.slice(index + 1));
      if (typeof fields === 'object' && fields !== null && !Array.isArray(fields)) {
        return { time, level, message: rest.slice(0, index), fields: fields as LogFields };
      }
    } catch {
      // Not the start of the fields; keep looking.
    }
  }
  return { time, level, message: rest, fields: {} };
}

/** Shifts file → file.1 → … → file.<keep>, dropping the oldest copy. */
export function rotate(file: string, keep: number): void {
  for (let index = keep - 1; index >= 1; index--) {
    try {
      renameSync(`${file}.${index}`, `${file}.${index + 1}`);
    } catch {
      // That copy does not exist yet.
    }
  }
  try {
    renameSync(file, `${file}.1`);
  } catch {
    // Nothing to rotate.
  }
}

/** Rotates `file` when it has reached `maxBytes`. Returns whether it did. */
export function rotateIfLarge(file: string, maxBytes: number, keep: number): boolean {
  if (fileSize(file) < maxBytes) return false;
  rotate(file, keep);
  return true;
}

export function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function fileWriter({ path, maxBytes, keep }: LogFile): (line: string) => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rotateIfLarge(path, maxBytes, keep);
  let size = fileSize(path);
  return (line) => {
    const data = `${line}\n`;
    const bytes = Buffer.byteLength(data);
    if (size > 0 && size + bytes > maxBytes) {
      rotate(path, keep);
      size = 0;
    }
    try {
      appendFileSync(path, data, { mode: 0o600 });
      size += bytes;
    } catch {
      // Logging must never stop the agent.
    }
  };
}
