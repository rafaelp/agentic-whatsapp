import { execFile } from 'node:child_process';
import type { Logger } from './log.js';
import { errorMessage } from './util.js';

export type Notifier = (title: string, message: string) => void;

/**
 * Native macOS notification through osascript. The text goes in argv, so it needs no
 * AppleScript escaping. Every notification is logged; when disabled, or outside macOS,
 * it is only logged.
 */
export function createNotifier(log: Logger, enabled: boolean): Notifier {
  return (title, message) => {
    log.warn(`notification: ${title}`, { message });
    if (!enabled || process.platform !== 'darwin') return;
    execFile(
      '/usr/bin/osascript',
      [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv) sound name "Basso"',
        '-e',
        'end run',
        title,
        message.slice(0, 240),
      ],
      { timeout: 10_000 },
      (error) => {
        if (error) log.warn('notification failed', { error: errorMessage(error) });
      },
    );
  };
}
