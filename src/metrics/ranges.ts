import {
  type DayHour,
  dayBuckets,
  dayNumberFromIso,
  dayWindow,
  hourBuckets,
  monthBuckets,
  sameDayPreviousYear,
  shiftWindow,
  type TimeWindow,
  yearStartOf
} from './calendar.js';
import { DATASET_START_DAY } from './catalog.js';
import type { MetricsRange, SeriesBucket } from './types.js';

/** Windows that a range covers. */
export interface ResolvedRange {
  current: TimeWindow;
  /** Same span right before `current`; `null` for `all`. */
  previous: TimeWindow | null;
  bucket: SeriesBucket;
  buckets: TimeWindow[];
}

const ROLLING_DAYS: Readonly<Record<'today' | 'week' | 'month' | 'year', number>> = {
  today: 1,
  week: 7,
  month: 30,
  year: 365
};

/**
 * Resolves a range against the current hour.
 *
 * Every range ends at the current hour, and so does its previous period, so partial days are
 * compared with the same hours of the comparison day. `today`, `week`, `month` and `year` are
 * rolling windows of 1, 7, 30 and 365 days; `ytd` starts on January 1 and compares with the same
 * dates of the previous year; `all` starts at the dataset start and has no comparison.
 *
 * @param range - Requested range.
 * @param now - Current day and hour.
 * @returns The current and previous windows and the series buckets.
 */
export function resolveRange(range: MetricsRange, now: DayHour): ResolvedRange {
  switch (range) {
    case 'today':
    case 'week':
    case 'month':
    case 'year': {
      const days = ROLLING_DAYS[range];
      const current = dayWindow(now.day - days + 1, now.day, now.hour);
      const bucket: SeriesBucket = range === 'today' ? 'hour' : range === 'year' ? 'month' : 'day';
      return {
        current,
        previous: shiftWindow(current, -days),
        bucket,
        buckets: splitWindow(current, bucket)
      };
    }
    case 'ytd': {
      const current = dayWindow(yearStartOf(now.day), now.day, now.hour);
      const previousEnd = sameDayPreviousYear(now.day);
      return {
        current,
        previous: dayWindow(yearStartOf(previousEnd), previousEnd, now.hour),
        bucket: 'month',
        buckets: monthBuckets(current)
      };
    }
    case 'all': {
      const current = dayWindow(dayNumberFromIso(DATASET_START_DAY), now.day, now.hour);
      return { current, previous: null, bucket: 'month', buckets: monthBuckets(current) };
    }
  }
}

function splitWindow(window: TimeWindow, bucket: SeriesBucket): TimeWindow[] {
  if (bucket === 'hour') {
    return hourBuckets(window);
  }
  return bucket === 'day' ? dayBuckets(window) : monthBuckets(window);
}
