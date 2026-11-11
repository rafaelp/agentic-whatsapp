import { num, type Row, type Store, text } from './db.js';
import type { AgentState, TaskEvent } from './state.js';
import type { Action } from './types.js';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'missed' | 'cancelled';

/** Something the owner asked the agent to do later, at a given time. */
export interface Task {
  id: number;
  createdAt: Date;
  dueAt: Date;
  /** What to do, in the owner's words; empty once it ran when no text is kept. */
  task: string;
  /** The chat the task is about, where a reply goes; empty for a task for the owner. */
  chat: string;
  chatName: string;
  status: TaskStatus;
  finishedAt?: Date;
  /** What it did, kept like other texts. */
  result: string;
  /** Why it failed, was missed or was cancelled. */
  error: string;
}

export interface NewTask {
  dueAt: Date;
  task: string;
  chat: string;
  chatName: string;
}

/** Tasks waiting at once, so a misunderstanding cannot fill the queue. */
export const MAX_PENDING_TASKS = 100;
/** The longest a task's text may be. */
export const MAX_TASK_LENGTH = 2_000;

/**
 * The scheduled tasks, in the database: the settings server adds and cancels them, and the
 * running agent runs them when they are due. Every change also goes to the stream.
 */
export class TaskStore {
  constructor(
    private readonly state: AgentState,
    private readonly options: { saveText: boolean } = { saveText: true },
  ) {}

  private get store(): Store {
    return this.state.store;
  }

  schedule(input: NewTask, at: Date = new Date()): Task {
    return this.store.transaction(() => {
      const { id } = this.store.run(
        'INSERT INTO tasks (created_at, due_at, task, chat, chat_name) VALUES (?, ?, ?, ?, ?)',
        at.toISOString(),
        input.dueAt.toISOString(),
        input.task,
        input.chat,
        input.chatName,
      );
      this.state.recordTaskEvent({ id, chat: input.chat, chatName: input.chatName }, 'scheduled', at);
      return this.get(id) as Task;
    });
  }

  get(id: number): Task | undefined {
    const row = this.store.get('SELECT * FROM tasks WHERE id = ?', id);
    return row === undefined ? undefined : taskOf(row);
  }

  /** The tasks still to run, the next one first. */
  pending(): Task[] {
    return this.store.all("SELECT * FROM tasks WHERE status = 'pending' ORDER BY due_at, id").map(taskOf);
  }

  /** The last tasks that ran, failed, were missed or were cancelled, the latest first. */
  finished(limit: number): Task[] {
    return this.store
      .all("SELECT * FROM tasks WHERE status NOT IN ('pending', 'running') ORDER BY finished_at DESC, id DESC LIMIT ?", limit)
      .map(taskOf);
  }

  /** The pending tasks due at `now` or before, the oldest first. */
  due(now: Date): Task[] {
    return this.store
      .all("SELECT * FROM tasks WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, id", now.toISOString())
      .map(taskOf);
  }

  /** Cancels a task that has not run yet; undefined when there is no such pending task. */
  cancel(id: number, at: Date = new Date()): Task | undefined {
    return this.store.transaction(() => {
      const { changes } = this.store.run(
        "UPDATE tasks SET status = 'cancelled', finished_at = ?, error = 'cancelled by the owner' WHERE id = ? AND status = 'pending'",
        at.toISOString(),
        id,
      );
      if (changes === 0) return undefined;
      this.forgetText(id);
      const task = this.get(id) as Task;
      this.state.recordTaskEvent(task, 'cancelled', at);
      return task;
    });
  }

  /** Marks a task as running; false when it is no longer pending, such as cancelled meanwhile. */
  start(id: number, at: Date = new Date()): boolean {
    return (
      this.store.run("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'", at.toISOString(), id)
        .changes > 0
    );
  }

  finish(id: number, outcome: { status: 'done' | 'failed' | 'missed'; result?: string; error?: string }, at: Date = new Date()): void {
    this.store.transaction(() => {
      this.store.run(
        'UPDATE tasks SET status = ?, finished_at = ?, result = ?, error = ? WHERE id = ?',
        outcome.status,
        at.toISOString(),
        this.options.saveText ? outcome.result : undefined,
        outcome.error,
        id,
      );
      this.forgetText(id);
      const task = this.get(id);
      if (task !== undefined) this.state.recordTaskEvent(task, outcome.status, at);
    });
  }

  /**
   * Fails the tasks that were running when the agent stopped and returns them. They are not run
   * again: what they did before stopping is unknown, and a message must not go out twice.
   */
  failInterrupted(at: Date = new Date()): Task[] {
    const running = this.store.all("SELECT id FROM tasks WHERE status = 'running'").map((row) => num(row.id));
    for (const id of running) this.finish(id, { status: 'failed', error: 'the agent stopped while it ran' }, at);
    return running.map((id) => this.get(id) as Task);
  }

  /** Without kept texts, a task's text goes once it no longer has to run. */
  private forgetText(id: number): void {
    if (!this.options.saveText) this.store.run('UPDATE tasks SET task = NULL WHERE id = ?', id);
  }
}

/** What a task's decision did, in a few lines for the stream: "→ Carol: …". */
export function taskResult(actions: readonly Action[], chatLabel: string): string {
  const lines = actions.flatMap((action) => {
    switch (action.type) {
      case 'reply':
        return [`→ ${chatLabel}: ${action.text}`];
      case 'notify':
        return [`→ you: ${action.text}`];
      case 'update_instructions':
        return ['instructions updated'];
      case 'highlight':
        return [];
    }
  });
  return lines.length === 0 ? 'nothing to do' : lines.join('\n');
}

function taskOf(row: Row): Task {
  const finished = text(row.finished_at);
  return {
    id: num(row.id),
    createdAt: new Date(text(row.created_at)),
    dueAt: new Date(text(row.due_at)),
    task: text(row.task),
    chat: text(row.chat),
    chatName: text(row.chat_name),
    status: text(row.status) as TaskStatus,
    ...(finished === '' ? {} : { finishedAt: new Date(finished) }),
    result: text(row.result),
    error: text(row.error),
  };
}
