const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A point in the dataset timeline: a UTC day number (days since epoch) and an hour 0-23. */
export interface DayHour {
  day: number;
  hour: number;
}

/** Inclusive span of hours, from `start` to `end`. */
export interface TimeWindow {
  start: DayHour;
  end: DayHour;
}

/**
 * Converts an instant to its UTC day number.
 *
 * @param date - Instant to convert.
 * @returns Days since 1970-01-01 UTC.
 */
export function dayNumberOf(date: Date): number {
  return Math.floor(date.getTime() / DAY_MS);
}

/**
 * Parses a `YYYY-MM-DD` UTC day.
 *
 * @param isoDay - Day in ISO-8601 calendar format.
 * @returns Days since 1970-01-01 UTC.
 */
export function dayNumberFromIso(isoDay: string): number {
  return Math.floor(Date.parse(`${isoDay}T00:00:00.000Z`) / DAY_MS);
}

/**
 * Formats a day number as `YYYY-MM-DD`.
 *
 * @param day - Days since 1970-01-01 UTC.
 * @returns The ISO-8601 calendar day.
 */
export function isoDayOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Formats the start of an hour as an ISO-8601 UTC instant. Hour 24 is the start of the next day.
 *
 * @param day - Days since 1970-01-01 UTC.
 * @param hour - Hour 0-24.
 * @returns The instant, e.g. `2026-01-31T13:00:00.000Z`.
 */
export function isoInstantOf(day: number, hour: number): string {
  return new Date(day * DAY_MS + hour * HOUR_MS).toISOString();
}

/**
 * Returns the current position in the timeline: today and the current hour.
 *
 * @param now - Current instant.
 * @returns Day and hour of `now` in UTC.
 */
export function dayHourOf(now: Date): DayHour {
  return { day: dayNumberOf(now), hour: now.getUTCHours() };
}

/**
 * Builds the window of whole days `[startDay, endDay]`, cut at `endHour` on the last day.
 *
 * @param startDay - First day.
 * @param endDay - Last day.
 * @param endHour - Last hour included on `endDay`, 23 for the whole day.
 * @returns The window.
 */
export function dayWindow(startDay: number, endDay: number, endHour = 23): TimeWindow {
  return { start: { day: startDay, hour: 0 }, end: { day: endDay, hour: endHour } };
}

/**
 * Moves a window by a number of days, keeping its hours.
 *
 * @param window - Window to move.
 * @param days - Days to add; negative moves back.
 * @returns The moved window.
 */
export function shiftWindow(window: TimeWindow, days: number): TimeWindow {
  return {
    start: { day: window.start.day + days, hour: window.start.hour },
    end: { day: window.end.day + days, hour: window.end.hour }
  };
}

/**
 * Number of calendar days a window touches.
 *
 * @param window - Window to measure.
 * @returns Days from the first to the last, inclusive.
 */
export function daysTouched(window: TimeWindow): number {
  return window.end.day - window.start.day + 1;
}

/**
 * Formats the window as a half-open ISO-8601 interval.
 *
 * @param window - Window to format.
 * @returns `start` (inclusive) and `end` (exclusive) instants.
 */
export function periodOf(window: TimeWindow): { start: string; end: string } {
  return {
    start: isoInstantOf(window.start.day, window.start.hour),
    end: isoInstantOf(window.end.day, window.end.hour + 1)
  };
}

/**
 * Splits a window into one window per hour.
 *
 * @param window - Window to split.
 * @returns Hour windows in order.
 */
export function hourBuckets(window: TimeWindow): TimeWindow[] {
  const buckets: TimeWindow[] = [];
  for (let day = window.start.day; day <= window.end.day; day += 1) {
    const firstHour = day === window.start.day ? window.start.hour : 0;
    const lastHour = day === window.end.day ? window.end.hour : 23;
    for (let hour = firstHour; hour <= lastHour; hour += 1) {
      buckets.push({ start: { day, hour }, end: { day, hour } });
    }
  }
  return buckets;
}

/**
 * Splits a window into one window per day, the first and last cut to the window bounds.
 *
 * @param window - Window to split.
 * @returns Day windows in order.
 */
export function dayBuckets(window: TimeWindow): TimeWindow[] {
  const buckets: TimeWindow[] = [];
  for (let day = window.start.day; day <= window.end.day; day += 1) {
    buckets.push({
      start: { day, hour: day === window.start.day ? window.start.hour : 0 },
      end: { day, hour: day === window.end.day ? window.end.hour : 23 }
    });
  }
  return buckets;
}

function startOfNextMonthDay(day: number): number {
  const date = new Date(day * DAY_MS);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / DAY_MS;
}

function startOfNextYearDay(day: number): number {
  return Date.UTC(new Date(day * DAY_MS).getUTCFullYear() + 1, 0, 1) / DAY_MS;
}

/**
 * First day of the calendar month that contains `day`.
 *
 * @param day - Days since 1970-01-01 UTC.
 * @returns Day number of the first of that month.
 */
export function monthStartOf(day: number): number {
  const date = new Date(day * DAY_MS);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / DAY_MS;
}

/**
 * Moves to the first day of a month relative to the month of `day`.
 *
 * @param day - Reference day.
 * @param months - Months to add; negative moves back.
 * @returns Day number of the first of the target month.
 */
export function addMonths(day: number, months: number): number {
  const date = new Date(day * DAY_MS);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1) / DAY_MS;
}

/**
 * First day of the calendar year that contains `day`.
 *
 * @param day - Days since 1970-01-01 UTC.
 * @returns Day number of January 1 of that year.
 */
export function yearStartOf(day: number): number {
  return Date.UTC(new Date(day * DAY_MS).getUTCFullYear(), 0, 1) / DAY_MS;
}

/**
 * Same calendar date one year earlier; February 29 maps to February 28.
 *
 * @param day - Days since 1970-01-01 UTC.
 * @returns Day number one year earlier.
 */
export function sameDayPreviousYear(day: number): number {
  const date = new Date(day * DAY_MS);
  const year = date.getUTCFullYear() - 1;
  const month = date.getUTCMonth();
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(date.getUTCDate(), lastDayOfMonth)) / DAY_MS;
}

/**
 * Formats the month that contains `day` as `YYYY-MM`.
 *
 * @param day - Days since 1970-01-01 UTC.
 * @returns The ISO-8601 month.
 */
export function isoMonthOf(day: number): string {
  return isoDayOf(day).slice(0, 7);
}

function splitBy(window: TimeWindow, nextBoundary: (day: number) => number): TimeWindow[] {
  const buckets: TimeWindow[] = [];
  let startDay = window.start.day;
  while (startDay <= window.end.day) {
    const endDay = Math.min(nextBoundary(startDay) - 1, window.end.day);
    buckets.push({
      start: { day: startDay, hour: startDay === window.start.day ? window.start.hour : 0 },
      end: { day: endDay, hour: endDay === window.end.day ? window.end.hour : 23 }
    });
    startDay = endDay + 1;
  }
  return buckets;
}

/**
 * Splits a window by calendar month, the first and last cut to the window bounds.
 *
 * @param window - Window to split.
 * @returns Month windows in order.
 */
export function monthBuckets(window: TimeWindow): TimeWindow[] {
  return splitBy(window, startOfNextMonthDay);
}

/**
 * Splits a window by calendar year, the first and last cut to the window bounds.
 *
 * @param window - Window to split.
 * @returns Year windows in order.
 */
export function yearBuckets(window: TimeWindow): TimeWindow[] {
  return splitBy(window, startOfNextYearDay);
}
