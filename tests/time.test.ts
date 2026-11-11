import { describe, expect, it } from 'vitest';
import { formatLocalTime, localHour, parseLocalTime, previousDay, weekday } from '../src/time.js';

describe('previousDay', () => {
  it('goes back one calendar day, across months and years', () => {
    expect(previousDay('2026-11-10')).toBe('2026-11-09');
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
    expect(previousDay('2028-03-01')).toBe('2028-02-29');
    expect(previousDay('2027-01-01')).toBe('2026-12-31');
  });
});

describe('localHour', () => {
  it('reads the hour in the given time zone', () => {
    expect(localHour(new Date('2026-11-10T04:00:00Z'), 'America/Sao_Paulo')).toBe(1);
    expect(localHour(new Date('2026-11-10T03:00:00Z'), 'America/Sao_Paulo')).toBe(0);
    expect(localHour(new Date('2026-11-10T23:30:00Z'), 'UTC')).toBe(23);
  });
});

describe('parseLocalTime', () => {
  it('reads a local date and time in the given zone', () => {
    expect(parseLocalTime('2026-11-12 09:00', 'America/Sao_Paulo')).toEqual(new Date('2026-11-12T12:00:00Z'));
    expect(parseLocalTime('2026-11-12T09:00:30', 'America/Sao_Paulo')).toEqual(new Date('2026-11-12T12:00:00Z'));
    expect(parseLocalTime(' 2026-07-01 23:59 ', 'UTC')).toEqual(new Date('2026-07-01T23:59:00Z'));
  });

  it('follows daylight saving time, and refuses a time the clock skips', () => {
    expect(parseLocalTime('2026-01-15 09:00', 'America/New_York')).toEqual(new Date('2026-01-15T14:00:00Z'));
    expect(parseLocalTime('2026-07-15 09:00', 'America/New_York')).toEqual(new Date('2026-07-15T13:00:00Z'));
    expect(parseLocalTime('2026-03-08 02:30', 'America/New_York')).toBeUndefined();
    const date = parseLocalTime('2026-03-08 03:30', 'America/New_York') as Date;
    expect(formatLocalTime(date, 'America/New_York')).toBe('2026-03-08 03:30');
  });

  it('refuses anything that is not a whole date and time', () => {
    for (const value of ['amanhã 9h', '2026-11-12', '2026-11-12 9:00', '2026-02-30 09:00', '2026-11-12 24:00', '']) {
      expect(parseLocalTime(value, 'America/Sao_Paulo')).toBeUndefined();
    }
  });
});

describe('weekday', () => {
  it('names the day of the week in the given zone', () => {
    expect(weekday(new Date('2026-11-12T12:00:00Z'), 'America/Sao_Paulo')).toBe('Thu');
    expect(weekday(new Date('2026-11-12T02:00:00Z'), 'America/Sao_Paulo')).toBe('Wed');
  });
});
