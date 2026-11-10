import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Notifier } from './notify.js';
import { isRecord, writeFileAtomic } from './util.js';

export type Component = 'wacli' | 'engine';

/** Failures in a row before the first notification, then between reminders. */
export const NOTIFY_AFTER = 3;
export const RENOTIFY_EVERY = 10;

const SAVE_DELAY_MS = 1_000;

export interface ComponentHealth {
  failures: number;
  lastError?: string;
  lastErrorAt?: string;
  lastOkAt?: string;
  notified?: boolean;
}

export interface HealthSnapshot {
  pid: number;
  startedAt: string;
  stoppedAt?: string;
  lastMessageAt?: string;
  lastDecisionAt?: string;
  wacli: ComponentHealth;
  engine: ComponentHealth;
}

const TITLES: Record<Component, { failing: string; recovered: string }> = {
  wacli: { failing: 'WhatsApp sync is failing', recovered: 'WhatsApp sync is back' },
  engine: { failing: 'model calls are failing', recovered: 'model calls are back' },
};

/**
 * Whether wacli and the engine are working, for `agentic-whatsapp status`. When one keeps
 * failing, it raises a notification after NOTIFY_AFTER failures in a row, then every
 * RENOTIFY_EVERY more, and once more when it recovers.
 */
export class Health {
  private readonly data: HealthSnapshot;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly file: string | null,
    private readonly notify: Notifier,
    private readonly agentName: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.data = {
      pid: process.pid,
      startedAt: this.now().toISOString(),
      wacli: { failures: 0 },
      engine: { failures: 0 },
    };
    this.scheduleSave();
  }

  failed(component: Component, message: string): void {
    const health = this.data[component];
    health.failures += 1;
    health.lastError = message;
    health.lastErrorAt = this.now().toISOString();
    const due =
      health.failures === NOTIFY_AFTER ||
      (health.failures > NOTIFY_AFTER && (health.failures - NOTIFY_AFTER) % RENOTIFY_EVERY === 0);
    if (due) {
      health.notified = true;
      this.notify(`${this.agentName}: ${TITLES[component].failing}`, `${health.failures} times in a row. ${message}`);
    }
    this.scheduleSave();
  }

  succeeded(component: Component): void {
    const health = this.data[component];
    if (health.notified) {
      this.notify(
        `${this.agentName}: ${TITLES[component].recovered}`,
        `Working again after ${health.failures} failure(s) in a row.`,
      );
    }
    const { lastError, lastErrorAt } = health;
    this.data[component] = { failures: 0, lastOkAt: this.now().toISOString(), lastError, lastErrorAt };
    this.scheduleSave();
  }

  messageQueued(): void {
    this.data.lastMessageAt = this.now().toISOString();
    this.scheduleSave();
  }

  decided(): void {
    this.data.lastDecisionAt = this.now().toISOString();
    this.scheduleSave();
  }

  stopped(): void {
    this.data.stoppedAt = this.now().toISOString();
    this.scheduleSave();
  }

  snapshot(): HealthSnapshot {
    return structuredClone(this.data);
  }

  async save(): Promise<void> {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.file === null) return;
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  static async read(file: string): Promise<HealthSnapshot | null> {
    try {
      const value: unknown = JSON.parse(await readFile(file, 'utf8'));
      return isRecord(value) && typeof value.startedAt === 'string' ? (value as unknown as HealthSnapshot) : null;
    } catch {
      // Missing or unreadable: the agent has not run yet, or is writing it right now.
      return null;
    }
  }

  private scheduleSave(): void {
    if (this.file === null || this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save().catch(() => {
        // Health is informational; the next change saves it again.
      });
    }, SAVE_DELAY_MS);
    this.saveTimer.unref();
  }
}
