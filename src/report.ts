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

export type Breakdown = 'day' | 'chat' | 'model';

export interface ReportOptions {
  /** How many days the breakdown covers, today included. */
  days: number;
  by: Breakdown;
  json: boolean;
}

const EMPTY: Totals = { calls: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0, cost: 0 };

/** The lines `agentic-whatsapp costs` prints. `ledger` is undefined before the agent first ran. */
export function costReport(config: Config, ledger: UsageLedger | undefined, now: Date, options: ReportOptions): string[] {
  const { costs, engine } = config;
  const zone = config.agent.timezone;
  const money = (amount: number) => formatMoney(amount, costs.currency);
  const price = (amount: number) => formatPrice(amount, costs.currency);
  const periods = periodsOf(now, zone);
  const days = recentDays(now, zone, options.days);
  const since = days[0] ?? periods.day;

  const rows = PERIODS.map((period) => {
    const totals = ledger?.totals(period, periods[period]) ?? EMPTY;
    const limit = limitFor(costs, period);
    return { name: PERIOD_NAMES[period].current, period, totals, limit };
  });
  const allTime = ledger?.totals('all') ?? EMPTY;
  let groups = ledger?.breakdown(options.by, since) ?? [];
  if (options.by === 'day') {
    const found = new Map(groups.map((group) => [group.key, group]));
    groups = days.map((day): Group => found.get(day) ?? { ...EMPTY, key: day, label: day });
  }

  const prices = pricesFor(engine.model, costs);
  if (options.json) {
    return [
      JSON.stringify(
        {
          currency: costs.currency,
          model: engine.model,
          prices: { inputPerMillion: prices.input, outputPerMillion: prices.output, cachedPerMillion: prices.cached, known: prices.known },
          periods: Object.fromEntries(rows.map((row) => [row.period, { key: periods[row.period], ...row.totals, limit: row.limit || null }])),
          allTime,
          breakdown: { by: options.by, since, groups },
        },
        null,
        2,
      ),
    ];
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
