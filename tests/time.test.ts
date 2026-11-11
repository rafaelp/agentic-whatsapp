import { describe, expect, it } from 'vitest';
import { localHour, previousDay } from '../src/time.js';

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
