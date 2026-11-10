import { describe, expect, it } from 'vitest';
import type { Attempt } from '../src/decision.js';
import { Store } from '../src/db.js';
import {
  callCost,
  formatMoney,
  formatPrice,
  formatTokens,
  isoWeek,
  modelFamily,
  periodsOf,
  pricesFor,
  UsageLedger,
} from '../src/usage.js';
import { BOB, FAMILY, makeConfig, NOW } from './helpers.js';

const attempt = (overrides: Partial<Attempt> = {}): Attempt => ({
  attempt: 1,
  startedAt: NOW,
  durationMs: 8_000,
  status: 'ok',
  usage: { inputTokens: 100_000, outputTokens: 1_000, thinkingTokens: 200, cachedTokens: 0 },
  tools: [],
  ...overrides,
});

const ledgerFor = (costs: Record<string, unknown> = {}, engine: Record<string, unknown> = {}) => {
  const config = makeConfig({ costs, engine });
  return new UsageLedger(Store.open(null), config.engine, config.costs, config.agent.timezone);
};

describe('prices', () => {
  it('knows Gemini 3.8 Flash whatever its thinking level', () => {
    expect(modelFamily('gemini-3.8-flash-low')).toBe('gemini-3.8-flash');
    expect(modelFamily('gemini-3.8-flash')).toBe('gemini-3.8-flash');
    const config = makeConfig();
    expect(pricesFor('gemini-3.8-flash-medium', config.costs)).toEqual({ input: 0.75, output: 3.75, cached: 0.075, known: true });
  });

  it('lets [costs] override them, and says when a model has none', () => {
    const custom = makeConfig({ costs: { input_per_million: 2, output_per_million: 12 } }).costs;
    expect(pricesFor('gemini-9-pro', custom)).toEqual({ input: 2, output: 12, cached: 2, known: true });
    expect(pricesFor('gemini-9-pro', makeConfig().costs)).toMatchObject({ input: 0, output: 0, known: false });
  });

  it('bills cached input at the cached price and thinking as output', () => {
    const prices = { input: 1, output: 10, cached: 0.1 };
    // 600k fresh input + 400k cached + 100k output (thinking included)
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, thinkingTokens: 60_000, cachedTokens: 400_000 };
    expect(callCost(usage, prices)).toBeCloseTo(0.6 + 0.04 + 1, 10);
  });
});

describe('periods', () => {
  it('uses ISO weeks, Monday to Sunday, across year ends', () => {
    expect(isoWeek('2026-11-10')).toBe('2026-W46');
    expect(isoWeek('2026-11-15')).toBe('2026-W46');
    expect(isoWeek('2026-11-16')).toBe('2026-W47');
    expect(isoWeek('2027-01-01')).toBe('2026-W53');
    expect(isoWeek('2024-12-30')).toBe('2025-W01');
  });

  it('takes the day, week and month in the agent time zone', () => {
    // 01:30 UTC on Monday is still Sunday evening in São Paulo.
    expect(periodsOf(new Date('2026-11-16T01:30:00Z'), 'America/Sao_Paulo')).toEqual({
      day: '2026-11-15',
      week: '2026-W46',
      month: '2026-11',
    });
  });
});

describe('UsageLedger', () => {
  it('records each attempt with its tokens and cost', () => {
    const ledger = ledgerFor();
    const cost = ledger.record(attempt({ tools: ['notes/search'], response: '{"actions":[]}' }), {
      batchId: 3,
      chat: BOB,
      chatName: 'Bob',
      prompt: 'PROMPT',
    });
    expect(cost).toBeCloseTo(0.075 + 0.00375, 10);
    expect(ledger.callsOn('2026-11-10')).toBe(1);
    expect(ledger.totals('day', '2026-11-10')).toEqual({
      calls: 1,
      inputTokens: 100_000,
      outputTokens: 1_000,
      thinkingTokens: 200,
      cachedTokens: 0,
      cost,
    });
  });

  it('reports the first limit reached and the ones close to it', () => {
    const ledger = ledgerFor({ max_per_day: 0.1, max_per_month: 1, warn_percent: 50 });
    ledger.record(attempt(), { chat: BOB, chatName: '' }); // $0.07875
    expect(ledger.limitReached(NOW)).toBeUndefined();
    expect(ledger.nearLimits(NOW).map((limit) => limit.period)).toEqual(['day']);
    ledger.record(attempt(), { chat: BOB, chatName: '' });
    expect(ledger.limitReached(NOW)).toMatchObject({ period: 'day', key: '2026-11-10', limit: 0.1 });
    expect(ledger.nearLimits(NOW)).toEqual([]);
    // The next day starts fresh, while the month keeps counting.
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    expect(ledger.limitReached(tomorrow)).toBeUndefined();
    expect(ledger.limits(tomorrow).find((limit) => limit.period === 'month')?.spent).toBeCloseTo(0.1575, 10);
  });

  it('never warns when warn_percent is 0, and has no limits by default', () => {
    expect(ledgerFor({ max_per_day: 0.1, warn_percent: 0 }).nearLimits(NOW)).toEqual([]);
    expect(ledgerFor().limits(NOW)).toEqual([]);
  });

  it('breaks the costs down by chat, model and day', () => {
    const ledger = ledgerFor();
    ledger.record(attempt(), { chat: BOB, chatName: 'Bob' });
    ledger.record(attempt(), { chat: BOB, chatName: 'Bob' });
    ledger.record(attempt({ usage: { inputTokens: 10, outputTokens: 1, thinkingTokens: 0, cachedTokens: 0 } }), {
      chat: FAMILY,
      chatName: 'Família',
    });
    expect(ledger.breakdown('chat', '2026-11-01').map((group) => [group.label, group.calls])).toEqual([
      ['Bob', 2],
      ['Família', 1],
    ]);
    expect(ledger.breakdown('model', '2026-11-01').map((group) => group.key)).toEqual(['gemini-3.8-flash-low']);
    expect(ledger.breakdown('day', '2026-11-11')).toEqual([]);
  });

  it('keeps the prompt and answer only when save_text is on', () => {
    const config = makeConfig();
    const store = Store.open(null);
    new UsageLedger(store, config.engine, config.costs, config.agent.timezone, false).record(attempt({ response: 'R' }), {
      chat: BOB,
      chatName: '',
      prompt: 'P',
    });
    expect(store.get('SELECT prompt, response FROM calls')).toEqual({ prompt: null, response: null });
  });
});

describe('formatting', () => {
  it('shows money and token counts compactly', () => {
    expect(formatMoney(0.0072, 'USD')).toBe('$0.0072');
    expect(formatMoney(1.5, 'usd')).toBe('$1.50');
    expect(formatMoney(0.5, 'BRL')).toBe('0.5000 BRL');
    expect(formatPrice(0.075, 'USD')).toBe('$0.075');
    expect(formatPrice(2, 'USD')).toBe('$2.00');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(9_400)).toBe('9.4k');
    expect(formatTokens(110_200)).toBe('110k');
    expect(formatTokens(1_250_000)).toBe('1.25M');
  });
});
