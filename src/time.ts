export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Calendar day in the given zone, as YYYY-MM-DD. */
export function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** The calendar day before a YYYY-MM-DD day. */
export function previousDay(day: string): string {
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}

/** The hour of the day in the given zone, from 0 to 23. */
export function localHour(date: Date, timeZone: string): number {
  return Number(formatClock(date, timeZone).slice(0, 2));
}

/** Local time of day in the given zone, as HH:MM:SS. */
export function formatClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

/** Local date and time in the given zone, as YYYY-MM-DD HH:MM. */
export function formatLocalTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

/**
 * The moment a local date and time, "YYYY-MM-DD HH:MM" (seconds allowed and dropped), happens in
 * the given zone. Undefined when the text is not one, or the time does not exist there, such as
 * an hour skipped by a daylight saving change.
 */
export function parseLocalTime(value: string, timeZone: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (match === null) return undefined;
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0] = match.slice(1).map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  // The zone's offset at a first guess, then again in case a daylight saving change lies between.
  const guess = wanted - zoneOffset(new Date(wanted), timeZone);
  const date = new Date(wanted - zoneOffset(new Date(guess), timeZone));
  return formatLocalTime(date, timeZone) === `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}` ? date : undefined;
}

/** How far the zone's clock is ahead of UTC at `date`, in milliseconds. */
function zoneOffset(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? 0);
  const local = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return local - Math.floor(date.getTime() / 1000) * 1000;
}

/** The day of the week in the given zone, such as "Thu". */
export function weekday(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
}
