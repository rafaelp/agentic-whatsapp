import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { costReport, costSummary, recentDays, table } from '../src/report.js';
import { UsageLedger } from '../src/usage.js';
import { BOB, FAMILY, makeConfig, NOW } from './helpers.js';

const config = makeConfig({ costs: { max_per_day: 1 } });

function ledgerWithCalls(): UsageLedger {
  const ledger = new UsageLedger(Store.open(null), config.engine, config.costs, config.agent.timezone);
  const yesterday = new Date(NOW.getTime() - 86_400_000);
  for (const startedAt of [NOW, NOW, yesterday]) {
    ledger.record(
      {
        attempt: 1,
        startedAt,
        durationMs: 1,
        status: 'ok',
        usage: { inputTokens: 100_000, outputTokens: 2_000, thinkingTokens: 0, cachedTokens: 0 },
        tools: [],
      },
      { chat: BOB, chatName: 'Bob' },
    );
  }
  return ledger;
}

describe('costReport', () => {
  it('sums today, this week, this month and all time, with the limits', () => {
    const lines = costReport(config, ledgerWithCalls(), NOW, { days: 3, by: 'day', json: false });
    expect(lines[0]).toBe('Prices for gemini-3.8-flash-low: $0.75 input, $3.75 output, $0.075 cached, per million tokens.');
    expect(lines[1]).toMatch(/Gemini API/);
    expect(lines.find((line) => line.startsWith('today'))).toMatch(/^today +2 +200k +4.0k +0 +\$0\.1650 +\$1\.00 \(16%\)$/);
    expect(lines.find((line) => line.startsWith('this week'))).toMatch(/^this week +3 .* \$0\.2475 +-$/);
    expect(lines.find((line) => line.startsWith('all time'))).toMatch(/^all time +3 /);
    expect(lines).toContain('Last 3 day(s), by day:');
    expect(lines.filter((line) => /^ {2}2026-11-/.test(line)).map((line) => line.trim().split(/ +/).slice(0, 2))).toEqual([
      ['2026-11-08', '0'],
      ['2026-11-09', '1'],
      ['2026-11-10', '2'],
    ]);
  });

  it('works before the agent ever ran, and as JSON', () => {
    expect(costReport(config, undefined, NOW, { days: 7, by: 'chat', json: false }).at(-1)).toBe('  no calls');
    const json = JSON.parse(costReport(config, ledgerWithCalls(), NOW, { days: 7, by: 'chat', json: true })[0] ?? '');
    expect(json.periods.day).toMatchObject({ key: '2026-11-10', calls: 2, limit: 1 });
    expect(json.breakdown.groups).toEqual([expect.objectContaining({ key: BOB, label: 'Bob', calls: 3 })]);
  });

  it('sums up every figure at once for the agent, with each breakdown cut short', () => {
    const ledger = ledgerWithCalls();
    ledger.record(
      { attempt: 1, startedAt: NOW, durationMs: 1, status: 'ok', usage: { inputTokens: 1_000, outputTokens: 10, thinkingTokens: 0, cachedTokens: 0 }, tools: [] },
      { chat: FAMILY, chatName: 'Família', purpose: 'audio' },
    );
    const summary = costSummary(config, ledger, NOW, { days: 2, maxGroups: 1 });
    expect(summary).toMatchObject({
      currency: 'USD',
      model: 'gemini-3.8-flash-low',
      prices: { inputPerMillion: 0.75, known: true },
      periods: { day: { key: '2026-11-10', calls: 3, limit: 1 }, week: { limit: null } },
      allTime: { calls: 4 },
      billing: expect.stringMatching(/not billed per call/),
      since: '2026-11-09',
    });
    const breakdowns = summary.breakdowns as Record<string, { key: string; label: string; calls: number }[]>;
    expect(breakdowns.day?.map((group) => [group.key, group.calls])).toEqual([
      ['2026-11-09', 1],
      ['2026-11-10', 3],
    ]);
    expect(breakdowns.chat?.map((group) => group.label)).toEqual(['Bob']);
    expect(breakdowns.model).toHaveLength(1);
    expect(breakdowns.purpose?.map((group) => group.label)).toEqual(['decisions']);
    expect(costSummary(config, undefined, NOW, { days: 1, maxGroups: 5 })).toMatchObject({ allTime: { calls: 0 }, breakdowns: { chat: [] } });
  });

  it('breaks costs down by purpose', () => {
    const ledger = ledgerWithCalls();
    ledger.record(
      {
        attempt: 1,
        startedAt: NOW,
        durationMs: 1,
        status: 'ok',
        usage: { inputTokens: 20_000, outputTokens: 50, thinkingTokens: 0, cachedTokens: 0 },
        tools: [],
      },
      { chat: BOB, chatName: 'Bob', purpose: 'image' },
    );
    ledger.record(
      { attempt: 1, startedAt: NOW, durationMs: 1, status: 'ok', usage: { inputTokens: 9_000, outputTokens: 30, thinkingTokens: 0, cachedTokens: 0 }, tools: [] },
      { chat: BOB, chatName: 'Bob', purpose: 'task' },
    );
    const lines = costReport(config, ledger, NOW, { days: 7, by: 'purpose', json: false });
    expect(lines).toContain('Last 7 day(s), by purpose:');
    expect(lines.map((line) => line.trim().split(/ +/).slice(0, 2).join(' '))).toEqual(
      expect.arrayContaining(['decisions 3', 'images 1', 'scheduled tasks']),
    );
  });

  it('says when the model has no known prices', () => {
    const other = makeConfig({ engine: { model: 'gemini-9-pro' } });
    expect(costReport(other, undefined, NOW, { days: 1, by: 'day', json: false })[0]).toMatch(/No known prices for gemini-9-pro/);
  });
});

describe('helpers', () => {
  it('lists recent local days and pads tables', () => {
    expect(recentDays(NOW, 'America/Sao_Paulo', 2)).toEqual(['2026-11-09', '2026-11-10']);
    expect(table([['a', '1'], ['bbb', '22']], [false, true])).toEqual(['a     1', 'bbb  22']);
  });
});
