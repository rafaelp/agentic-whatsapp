import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { AgentState } from '../src/state.js';
import { TaskStore, taskResult } from '../src/tasks.js';
import { BOB, NOW } from './helpers.js';

const DUE = new Date('2026-11-11T12:00:00Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

function setup(saveText = true) {
  const state = new AgentState(Store.open(null), { saveText });
  return { state, tasks: new TaskStore(state, { saveText }) };
}

describe('TaskStore', () => {
  it('schedules tasks, and gives back those due, the oldest first', () => {
    const { tasks } = setup();
    const message = tasks.schedule({ dueAt: DUE, task: 'Dizer à Carol que precisa comprar suco', chat: BOB, chatName: 'Carol' }, NOW);
    const reminder = tasks.schedule({ dueAt: later(30), task: 'Lembrar do boleto', chat: '', chatName: '' }, NOW);
    expect(message).toEqual({
      id: 1,
      createdAt: NOW,
      dueAt: DUE,
      task: 'Dizer à Carol que precisa comprar suco',
      chat: BOB,
      chatName: 'Carol',
      status: 'pending',
      result: '',
      error: '',
    });
    expect(tasks.pending().map((task) => task.id)).toEqual([reminder.id, message.id]);
    expect(tasks.due(NOW)).toEqual([]);
    expect(tasks.due(later(30)).map((task) => task.id)).toEqual([reminder.id]);
    expect(tasks.due(DUE).map((task) => task.id)).toEqual([reminder.id, message.id]);
  });

  it('runs a task once, and records what came of it', () => {
    const { tasks } = setup();
    const { id } = tasks.schedule({ dueAt: NOW, task: 'Lembrar do boleto', chat: '', chatName: '' }, NOW);
    expect(tasks.start(id, NOW)).toBe(true);
    expect(tasks.start(id, NOW)).toBe(false);
    expect(tasks.due(NOW)).toEqual([]);
    tasks.finish(id, { status: 'done', result: '→ you: Lembrete: pagar o boleto' }, later(1));
    expect(tasks.get(id)).toMatchObject({ status: 'done', result: '→ you: Lembrete: pagar o boleto', finishedAt: later(1) });
    expect(tasks.finished(5).map((task) => task.id)).toEqual([id]);
  });

  it('cancels only tasks that have not started', () => {
    const { tasks } = setup();
    const first = tasks.schedule({ dueAt: DUE, task: 'a', chat: '', chatName: '' }, NOW);
    const second = tasks.schedule({ dueAt: DUE, task: 'b', chat: '', chatName: '' }, NOW);
    tasks.start(second.id, NOW);
    expect(tasks.cancel(first.id, NOW)).toMatchObject({ id: first.id, status: 'cancelled', error: 'cancelled by the owner' });
    expect(tasks.cancel(first.id, NOW)).toBeUndefined();
    expect(tasks.cancel(second.id, NOW)).toBeUndefined();
    expect(tasks.cancel(99, NOW)).toBeUndefined();
    expect(tasks.pending()).toEqual([]);
  });

  it('fails the tasks that were running when the agent stopped', () => {
    const { tasks } = setup();
    const { id } = tasks.schedule({ dueAt: NOW, task: 'a', chat: '', chatName: '' }, NOW);
    tasks.start(id, NOW);
    expect(tasks.failInterrupted(NOW)).toEqual([expect.objectContaining({ id, status: 'failed', error: 'the agent stopped while it ran' })]);
    expect(tasks.failInterrupted(NOW)).toEqual([]);
  });

  it('puts every change in the stream', () => {
    const { state, tasks } = setup();
    const done = tasks.schedule({ dueAt: NOW, task: 'a', chat: BOB, chatName: 'Carol' }, NOW);
    const cancelled = tasks.schedule({ dueAt: DUE, task: 'b', chat: '', chatName: '' }, NOW);
    tasks.start(done.id, NOW);
    tasks.finish(done.id, { status: 'done', result: 'ok' }, NOW);
    tasks.cancel(cancelled.id, NOW);
    expect(state.recentHighlights(10).map((entry) => [entry.kind, entry.chat, entry.chatName, entry.task])).toEqual([
      ['task', BOB, 'Carol', { id: done.id, event: 'scheduled' }],
      ['task', '', '', { id: cancelled.id, event: 'scheduled' }],
      ['task', BOB, 'Carol', { id: done.id, event: 'done' }],
      ['task', '', '', { id: cancelled.id, event: 'cancelled' }],
    ]);
  });

  it('keeps the text only until the task no longer has to run when save_text is off', () => {
    const { tasks } = setup(false);
    const { id } = tasks.schedule({ dueAt: NOW, task: 'Dizer à Carol…', chat: BOB, chatName: 'Carol' }, NOW);
    expect(tasks.get(id)?.task).toBe('Dizer à Carol…');
    tasks.start(id, NOW);
    tasks.finish(id, { status: 'done', result: '→ Carol: compra suco' }, NOW);
    expect(tasks.get(id)).toMatchObject({ task: '', result: '', status: 'done' });
  });

  it('forgets the text of finished tasks once they are older than the retention', () => {
    const { state, tasks } = setup();
    const old = tasks.schedule({ dueAt: NOW, task: 'antiga', chat: '', chatName: '' }, NOW);
    const waiting = tasks.schedule({ dueAt: DUE, task: 'para amanhã', chat: '', chatName: '' }, NOW);
    tasks.start(old.id, NOW);
    tasks.finish(old.id, { status: 'done', result: 'feito' }, NOW);
    state.pruneText(later(1));
    expect(tasks.get(old.id)).toMatchObject({ task: '', result: '' });
    expect(tasks.get(waiting.id)?.task).toBe('para amanhã');
  });
});

describe('taskResult', () => {
  it('says in a few lines what the decision sent', () => {
    expect(
      taskResult(
        [
          { type: 'reply', text: 'Carol, precisa comprar suco!' },
          { type: 'notify', text: 'Mandei.' },
          { type: 'highlight', text: 'x', ids: [] },
          { type: 'update_instructions', content: '…' },
        ],
        'Carol',
      ),
    ).toBe('→ Carol: Carol, precisa comprar suco!\n→ you: Mandei.\ninstructions updated');
    expect(taskResult([], 'Carol')).toBe('nothing to do');
  });
});
