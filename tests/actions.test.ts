import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ActionContext, defuseMention, executePlan, formatOutgoing, planActions } from '../src/actions.js';
import { InstructionsStore } from '../src/instructions.js';
import { BOB, FakeWacli, HOME, MemoryLogger, memoryStore, tempDir } from './helpers.js';

const context = (overrides: Partial<ActionContext> = {}): ActionContext => ({
  chat: BOB,
  chatName: 'Bob',
  replyAllowed: false,
  ownerCommand: false,
  ...overrides,
});

describe('planActions', () => {
  it('sends notifications to the home chat', () => {
    expect(planActions([{ type: 'notify', text: 'oi' }], context(), HOME)).toEqual([
      { kind: 'send', to: HOME, text: 'oi', purpose: 'notify' },
    ]);
  });

  it('only logs notifications when there is no home chat', () => {
    expect(planActions([{ type: 'notify', text: 'oi' }], context(), '')).toEqual([
      { kind: 'log', text: 'oi', reason: 'agent.home_chat is not set' },
    ]);
  });

  it('replies in the chat when replies are allowed', () => {
    expect(planActions([{ type: 'reply', text: 'Já vou!' }], context({ replyAllowed: true }), HOME)).toEqual([
      { kind: 'send', to: BOB, text: 'Já vou!', purpose: 'reply' },
    ]);
  });

  it('turns a reply that is not allowed into a suggestion for the owner', () => {
    expect(planActions([{ type: 'reply', text: 'Já vou!' }], context(), HOME)).toEqual([
      { kind: 'send', to: HOME, text: '↩️ Bob\nJá vou!', purpose: 'suggestion' },
    ]);
  });

  it('changes instructions only on a command the owner typed', () => {
    const update = [{ type: 'update_instructions' as const, content: '- nova regra' }];
    expect(planActions(update, context({ ownerCommand: true }), HOME)).toEqual([
      { kind: 'write_instructions', content: '- nova regra' },
    ]);
    expect(planActions(update, context(), HOME)).toMatchObject([{ kind: 'drop' }]);
  });
});

describe('outgoing text', () => {
  it('removes the @ before the agent name so it cannot trigger itself', () => {
    expect(defuseMention('Sou a @Ane, prazer. @anelise fica.', 'Ane')).toBe('Sou a Ane, prazer. @anelise fica.');
    expect(formatOutgoing('oi @ane', 'Ane', '🤖 Ane: ')).toBe('🤖 Ane: oi ane');
  });
});

describe('executePlan', () => {
  const runtime = async (overrides: { dryRun?: boolean } = {}) => {
    const dir = await tempDir();
    const wacli = new FakeWacli();
    const { state } = memoryStore();
    const instructions = new InstructionsStore(join(dir, 'instructions.md'), join(dir, 'history'));
    const log = new MemoryLogger();
    return {
      wacli,
      state,
      instructions,
      log,
      run: { wacli, state, instructions, log, agentName: 'Ane', messagePrefix: '🤖 Ane: ', dryRun: overrides.dryRun ?? false },
    };
  };

  it('sends with the prefix and remembers what it sent', async () => {
    const { wacli, state, run } = await runtime();
    await executePlan([{ kind: 'send', to: HOME, text: 'resumo', purpose: 'notify' }], { ...run, batchId: 7 });
    expect(wacli.sent).toEqual([{ to: HOME, text: '🤖 Ane: resumo' }]);
    expect(state.isAgentSent('SENT1')).toBe(true);
    expect(state.isRecentOutgoing(HOME, '🤖 Ane: resumo')).toBe(true);
    expect(state.store.all('SELECT batch_id, chat, purpose, status, message_id, text FROM sent')).toEqual([
      { batch_id: 7, chat: HOME, purpose: 'notify', status: 'sent', message_id: 'SENT1', text: '🤖 Ane: resumo' },
    ]);
  });

  it('writes instructions', async () => {
    const { instructions, run } = await runtime();
    await executePlan([{ kind: 'write_instructions', content: '- regra' }], run);
    expect(await instructions.read()).toBe('- regra');
  });

  it('sends and writes nothing in dry-run mode', async () => {
    const { wacli, instructions, log, run } = await runtime({ dryRun: true });
    await executePlan(
      [
        { kind: 'send', to: HOME, text: 'resumo', purpose: 'notify' },
        { kind: 'write_instructions', content: '- regra' },
      ],
      run,
    );
    expect(wacli.sent).toEqual([]);
    expect(await instructions.read()).toBe('');
    expect(log.has('info', 'dry run: would send')).toBe(true);
    expect(run.state.store.get('SELECT status FROM sent')).toEqual({ status: 'dry_run' });
  });

  it('logs a failed send and carries on', async () => {
    const { wacli, state, log, run } = await runtime();
    wacli.failSends = true;
    await executePlan([{ kind: 'send', to: HOME, text: 'a', purpose: 'notify' }], run);
    expect(log.has('error', 'send failed')).toBe(true);
    expect(state.store.get('SELECT status, error FROM sent')).toEqual({ status: 'failed', error: 'send failed' });
  });
});
