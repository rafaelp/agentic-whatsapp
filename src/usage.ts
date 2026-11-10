import type { CostsConfig, EngineConfig } from './config.js';
import { type Row, type Store, num, text } from './db.js';
import type { Attempt } from './decision.js';
import { dayKey } from './time.js';

/** Tokens of one model call. `outputTokens` includes `thinkingTokens`, as agy reports them. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  /** Input tokens read from the cache, part of `inputTokens` and billed at the cached price. */
  cachedTokens: number;
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
  };
}

/** Prices per million tokens. */
export interface Prices {
  input: number;
  output: number;
  cached: number;
}

/**
 * Gemini API list prices in USD, by model family, used when [costs] does not set them.
 * Gemini 3.8 Flash: the introductory rates announced until 2026-12-31.
 */
export const KNOWN_PRICES: Record<string, Prices> = {
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cached: 0.075 },
};

/** "gemini-3.8-flash-low" → "gemini-3.8-flash": the suffix only sets the thinking level. */
export function modelFamily(model: string): string {
  return model.trim().toLowerCase().replace(/-(minimal|low|medium|high|xhigh|max)$/, '');
}

export interface ResolvedPrices extends Prices {
  /** False when the model has no known prices and [costs] does not set all of them. */
  known: boolean;
}

export function pricesFor(model: string, costs: CostsConfig): ResolvedPrices {
  const listed = KNOWN_PRICES[modelFamily(model)];
  const input = costs.inputPerMillion ?? listed?.input;
  const output = costs.outputPerMillion ?? listed?.output;
  const cached = costs.cachedPerMillion ?? listed?.cached ?? input;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cached: cached ?? 0,
    known: input !== undefined && output !== undefined,
  };
}

export function callCost(usage: Usage, prices: Prices): number {
  const cached = Math.min(usage.cachedTokens, usage.inputTokens);
  return ((usage.inputTokens - cached) * prices.input + cached * prices.cached + usage.outputTokens * prices.output) / 1e6;
}

export type Period = 'day' | 'week' | 'month';
export const PERIODS: readonly Period[] = ['day', 'week', 'month'];

export interface Periods {
  /** YYYY-MM-DD */
  day: string;
  /** ISO week, YYYY-Www, Monday to Sunday */
  week: string;
  /** YYYY-MM */
  month: string;
}

/** The day, week and month a moment falls in, in the given time zone. */
export function periodsOf(date: Date, timeZone: string): Periods {
  const day = dayKey(date, timeZone);
  return { day, week: isoWeek(day), month: day.slice(0, 7) };
}

export function isoWeek(day: string): string {
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date));
  // The ISO year of a week is the year of its Thursday.
  utc.setUTCDate(utc.getUTCDate() + 3 - ((utc.getUTCDay() + 6) % 7));
  const isoYear = utc.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  const week = 1 + Math.round((utc.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function limitFor(costs: CostsConfig, period: Period): number {
  return period === 'day' ? costs.maxPerDay : period === 'week' ? costs.maxPerWeek : costs.maxPerMonth;
}

export interface Totals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedTokens: number;
  cost: number;
}

export interface Group extends Totals {
  key: string;
  label: string;
}

export interface LimitState {
  period: Period;
  key: string;
  spent: number;
  limit: number;
}

export interface CallContext {
  batchId?: number;
  chat: string;
  chatName: string;
  prompt?: string;
}

const TOTALS = `count(*) AS calls, total(input_tokens) AS input, total(output_tokens) AS output,
  total(thinking_tokens) AS thinking, total(cached_tokens) AS cached, total(cost) AS cost`;

/**
 * Every model call, with its tokens and what it costs at the configured prices. The cost is
 * computed when the call is recorded, so a later price change does not rewrite history.
 */
export class UsageLedger {
  constructor(
    private readonly store: Store,
    private readonly engine: Pick<EngineConfig, 'kind' | 'model'>,
    readonly costs: CostsConfig,
    private readonly timeZone: string,
    private readonly saveText = true,
  ) {}

  get prices(): ResolvedPrices {
    return pricesFor(this.engine.model, this.costs);
  }

  /** Stores one attempt and returns its cost. */
  record(attempt: Attempt, context: CallContext): number {
    const cost = callCost(attempt.usage, this.prices);
    const periods = periodsOf(attempt.startedAt, this.timeZone);
    const { usage } = attempt;
    this.store.run(
      `INSERT INTO calls (batch_id, chat, chat_name, started_at, day, week, month, duration_ms, engine, model, attempt,
        status, error, input_tokens, output_tokens, thinking_tokens, cached_tokens, cost, currency, tools, conversation_id,
        prompt, response)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      context.batchId,
      context.chat,
      context.chatName,
      attempt.startedAt.toISOString(),
      periods.day,
      periods.week,
      periods.month,
      Math.round(attempt.durationMs),
      this.engine.kind,
      this.engine.model,
      attempt.attempt,
      attempt.status,
      attempt.error,
      usage.inputTokens,
      usage.outputTokens,
      usage.thinkingTokens,
      usage.cachedTokens,
      cost,
      this.costs.currency,
      attempt.tools.length === 0 ? undefined : JSON.stringify(attempt.tools),
      attempt.conversationId,
      this.saveText ? context.prompt : undefined,
      this.saveText ? attempt.response : undefined,
    );
    return cost;
  }

  /** Model calls made on a local day (YYYY-MM-DD). */
  callsOn(day: string): number {
    return num(this.store.get('SELECT count(*) AS calls FROM calls WHERE day = ?', day)?.calls);
  }

  totals(period: Period | 'all', key = ''): Totals {
    const row =
      period === 'all'
        ? this.store.get(`SELECT ${TOTALS} FROM calls`)
        : this.store.get(`SELECT ${TOTALS} FROM calls WHERE ${period} = ?`, key);
    return totalsOf(row);
  }

  spent(period: Period, key: string): number {
    return num(this.store.get(`SELECT total(cost) AS cost FROM calls WHERE ${period} = ?`, key)?.cost);
  }

  /** The configured limits with what was spent in the current day, week and month. */
  limits(now: Date): LimitState[] {
    const periods = periodsOf(now, this.timeZone);
    return PERIODS.filter((period) => limitFor(this.costs, period) > 0).map((period) => ({
      period,
      key: periods[period],
      spent: this.spent(period, periods[period]),
      limit: limitFor(this.costs, period),
    }));
  }

  /** The first limit that has been reached, if any. */
  limitReached(now: Date): LimitState | undefined {
    return this.limits(now).find((state) => state.spent >= state.limit);
  }

  /** Limits past `costs.warn_percent` but not reached yet. */
  nearLimits(now: Date): LimitState[] {
    if (this.costs.warnPercent === 0) return [];
    return this.limits(now).filter(
      (state) => state.spent < state.limit && state.spent >= (state.limit * this.costs.warnPercent) / 100,
    );
  }

  /** Totals per day, chat or model, for calls made on `since` (YYYY-MM-DD) or later. */
  breakdown(by: 'day' | 'chat' | 'model', since: string): Group[] {
    const key = by === 'day' ? 'day' : by === 'chat' ? 'chat' : 'model';
    const label = by === 'chat' ? `max(chat_name)` : key;
    const order = by === 'day' ? 'key' : 'cost DESC, key';
    return this.store
      .all(`SELECT ${key} AS key, ${label} AS label, ${TOTALS} FROM calls WHERE day >= ? GROUP BY ${key} ORDER BY ${order}`, since)
      .map((row) => ({ ...totalsOf(row), key: text(row.key), label: text(row.label) || text(row.key) }));
  }
}

function totalsOf(row: Row | undefined): Totals {
  return {
    calls: num(row?.calls),
    inputTokens: num(row?.input),
    outputTokens: num(row?.output),
    thinkingTokens: num(row?.thinking),
    cachedTokens: num(row?.cached),
    cost: num(row?.cost),
  };
}

/** "$0.0072", "$1.52", or "0.0072 BRL" for other currencies. */
export function formatMoney(amount: number, currency: string): string {
  const value = Math.abs(amount) < 1 ? amount.toFixed(4) : amount.toFixed(2);
  return currency.toUpperCase() === 'USD' ? `$${value}` : `${value} ${currency}`;
}

/** A price per million tokens, with only the decimals it needs: "$0.75", "$0.075", "$2.00". */
export function formatPrice(amount: number, currency: string): string {
  const [whole = '0', decimals = ''] = amount.toFixed(4).replace(/0+$/, '').split('.');
  const value = `${whole}.${decimals.padEnd(2, '0')}`;
  return currency.toUpperCase() === 'USD' ? `$${value}` : `${value} ${currency}`;
}

/** 950, 9.4k, 1.25M */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

export const PERIOD_NAMES: Record<Period, { adjective: string; until: string; current: string }> = {
  day: { adjective: 'Daily', until: 'until tomorrow', current: 'today' },
  week: { adjective: 'Weekly', until: 'until Monday', current: 'this week' },
  month: { adjective: 'Monthly', until: 'until next month', current: 'this month' },
};
