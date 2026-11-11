import type { Config } from './config.js';
import { dayKey } from './time.js';
import {
  formatMoney,
  formatPrice,
  formatTokens,
  type Group,
  limitFor,
  PERIOD_NAMES,
  PERIODS,
  periodsOf,
  pricesFor,
  type Totals,
  type UsageLedger,
} from './usage.js';

export type Breakdown = 'day' | 'chat' | 'model' | 'purpose';
export const BREAKDOWNS: readonly Breakdown[] = ['day', 'chat', 'model', 'purpose'];

const PURPOSES: Record<string, string> = { decision: 'decisions', image: 'images', audio: 'audio' };

export interface ReportOptions {
  /** How many days the breakdown covers, today included. */
  days: number;
  by: Breakdown;
  json: boolean;
}

const EMPTY: Totals = { calls: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0, cost: 0 };

/** The totals of the last days by one key; every day is listed, with or without calls. */
function breakdownGroups(ledger: UsageLedger | undefined, by: Breakdown, days: readonly string[], since: string): Group[] {
  const groups = ledger?.breakdown(by, since) ?? [];
  if (by === 'day') {
    const found = new Map(groups.map((group) => [group.key, group]));
    return days.map((day): Group => found.get(day) ?? { ...EMPTY, key: day, label: day });
  }
  if (by === 'purpose') return groups.map((group) => ({ ...group, label: PURPOSES[group.key] ?? group.key }));
  return groups;
}

function periodRows(config: Config, ledger: UsageLedger | undefined, now: Date) {
  const periods = periodsOf(now, config.agent.timezone);
  return PERIODS.map((period) => ({
    name: PERIOD_NAMES[period].current,
    period,
    key: periods[period],
    totals: ledger?.totals(period, periods[period]) ?? EMPTY,
    limit: limitFor(config.costs, period),
  }));
}

/** The prices, the totals of today, this week, this month and all time, and the limits. */
function costBasics(config: Config, ledger: UsageLedger | undefined, now: Date) {
  const { costs, engine } = config;
  const prices = pricesFor(engine.model, costs);
  return {
    currency: costs.currency,
    model: engine.model,
    prices: { inputPerMillion: prices.input, outputPerMillion: prices.output, cachedPerMillion: prices.cached, known: prices.known },
    periods: Object.fromEntries(
      periodRows(config, ledger, now).map((row) => [row.period, { key: row.key, ...row.totals, limit: row.limit || null }]),
    ),
    allTime: ledger?.totals('all') ?? EMPTY,
  };
}

/**
 * Every cost figure at once, for the agent's get_costs tool: the totals and limits, and the
 * last `days` days broken down by day, chat, model and purpose, each list cut at `maxGroups`.
 */
export function costSummary(
  config: Config,
  ledger: UsageLedger | undefined,
  now: Date,
  options: { days: number; maxGroups: number },
): Record<string, unknown> {
  const days = recentDays(now, config.agent.timezone, options.days);
  const since = days[0] ?? dayKey(now, config.agent.timezone);
  return {
    ...costBasics(config, ledger, now),
    billing:
      config.engine.kind === 'antigravity'
        ? 'Antigravity runs on the Google AI plan, which is not billed per call: these are what the same tokens would cost on the Gemini API'
        : 'Gemini CLI runs on an API key, billed per token at these prices',
    since,
    breakdowns: Object.fromEntries(
      BREAKDOWNS.map((by) => {
        const groups = breakdownGroups(ledger, by, days, since);
        return [by, by === 'day' ? groups : groups.slice(0, options.maxGroups)];
      }),
    ),
  };
}

/** The lines `agentic-whatsapp costs` prints. `ledger` is undefined before the agent first ran. */
export function costReport(config: Config, ledger: UsageLedger | undefined, now: Date, options: ReportOptions): string[] {
  const { costs, engine } = config;
  const zone = config.agent.timezone;
  const money = (amount: number) => formatMoney(amount, costs.currency);
  const price = (amount: number) => formatPrice(amount, costs.currency);
  const days = recentDays(now, zone, options.days);
  const since = days[0] ?? periodsOf(now, zone).day;

  const rows = periodRows(config, ledger, now);
  const allTime = ledger?.totals('all') ?? EMPTY;
  const groups = breakdownGroups(ledger, options.by, days, since);

  const prices = pricesFor(engine.model, costs);
  if (options.json) {
    return [JSON.stringify({ ...costBasics(config, ledger, now), breakdown: { by: options.by, since, groups } }, null, 2)];
  }

  const lines = [
    prices.known
      ? `Prices for ${engine.model}: ${price(prices.input)} input, ${price(prices.output)} output, ${price(prices.cached)} cached, per million tokens.`
      : `No known prices for ${engine.model}: set input_per_million and output_per_million in [costs]. Costs show as 0.`,
    engine.kind === 'antigravity'
      ? 'Antigravity runs on your Google AI plan, so these are what the same tokens would cost on the Gemini API.'
      : 'Gemini CLI runs on your API key, so these are what its calls cost at these prices.',
    '',
  ];
  const header = ['', 'calls', 'input', 'output', 'cached', 'cost'];
  lines.push(
    ...table(
      [
        [...header, 'limit'],
        ...rows.map((row) => [
          ...totalsCells(row.name, row.totals, money),
          row.limit > 0 ? `${money(row.limit)} (${Math.floor((row.totals.cost / row.limit) * 100)}%)` : '-',
        ]),
        [...totalsCells('all time', allTime, money), ''],
      ],
      [false, true, true, true, true, true, false],
    ),
    '',
    `Last ${days.length} day(s), by ${options.by}:`,
  );
  if (groups.length === 0) lines.push('  no calls');
  else {
    lines.push(
      ...table(
        [header, ...groups.map((group) => totalsCells(group.label, group, money))],
        [false, true, true, true, true, true],
      ).map((line) => `  ${line}`),
    );
  }
  return lines;
}

function totalsCells(name: string, totals: Totals, money: (amount: number) => string): string[] {
  return [
    name,
    String(totals.calls),
    formatTokens(totals.inputTokens),
    formatTokens(totals.outputTokens),
    formatTokens(totals.cachedTokens),
    money(totals.cost),
  ];
}

/** The local days of the last `count` days, oldest first, today last. */
export function recentDays(now: Date, timeZone: string, count: number): string[] {
  const days = new Set<string>();
  for (let back = Math.max(1, count) - 1; back >= 0; back--) days.add(dayKey(new Date(now.getTime() - back * 86_400_000), timeZone));
  return [...days];
}

/** Pads columns; `right` marks the ones aligned to the right. */
export function table(rows: string[][], right: boolean[]): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, index) => (widths[index] = Math.max(widths[index] ?? 0, [...cell].length)));
  return rows.map((row) =>
    row
      .map((cell, index) => {
        const pad = ' '.repeat((widths[index] ?? 0) - [...cell].length);
        return right[index] === true ? pad + cell : cell + pad;
      })
      .join('  ')
      .trimEnd(),
  );
}
