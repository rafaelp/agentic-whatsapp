export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

export interface LoggerOptions {
  verbose?: boolean;
  write?: (line: string) => void;
}

/** Plain-text logger on stderr: one line per entry, fields as JSON. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const minimum = options.verbose ? LEVELS.debug : LEVELS.info;
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const at = (level: Level) => (message: string, fields?: LogFields) => {
    if (LEVELS[level] < minimum) return;
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
    write(`${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}`);
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
