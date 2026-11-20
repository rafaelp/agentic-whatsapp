import { execFile } from 'node:child_process';
import type { Logger } from './log.js';
import type { Pusher } from './push.js';
import { errorMessage } from './util.js';

export type Notifier = (title: string, message: string) => void;

/**
 * Native macOS notification through osascript. The text goes in argv, so it needs no
 * AppleScript escaping. Every notification is logged; when disabled, or outside macOS,
 * it is only logged. With `push`, it also goes to the owner's phone, enabled or not.
 */
export function createNotifier(log: Logger, enabled: boolean, push?: Pusher): Notifier {
  return (title, message) => {
    log.warn(`notification: ${title}`, { message });
    // A pusher never rejects.
    if (push !== undefined) void push({ title, text: message });
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
