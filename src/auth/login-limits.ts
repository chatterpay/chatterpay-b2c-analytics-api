import type { AppEnv } from '../config/env.js';
import type { LoginThrottle } from '../store/types.js';

/** Settings of the login code limits. */
export type LoginLimits = Pick<
  AppEnv,
  | 'OTP_RESEND_COOLDOWN_SECONDS'
  | 'OTP_LOCKOUT_STEPS_SECONDS'
  | 'OTP_MAX_LOCKOUT_SECONDS'
  | 'OTP_SENDS_PER_EMAIL_HOUR'
  | 'OTP_SENDS_PER_EMAIL_DAY'
  | 'OTP_REQUESTS_PER_IP'
  | 'OTP_VERIFICATIONS_PER_IP'
>;

const SECOND_MS = 1000;
const HOUR_MS = 60 * 60 * SECOND_MS;

/** The throttle state of an email is forgotten a day after its last code. */
export const THROTTLE_FORGET_MS: number = 24 * HOUR_MS;
/** Window of the per-IP request and verification counters; also the longest automatic wait. */
export const IP_WINDOW_MS: number = 15 * 60 * SECOND_MS;
export const SEND_HOUR_WINDOW_MS: number = HOUR_MS;
export const SEND_DAY_WINDOW_MS: number = 24 * HOUR_MS;

/** Key of the throttle state of an email. */
export function throttleKey(emailKey: string): string {
  return `login:email:${emailKey}`;
}

/** Keys of the hourly and daily code counters of an email from one client IP. */
export function sendCounterKeys(
  emailKey: string,
  originKey: string
): { hour: string; day: string } {
  return {
    hour: `login:send-hour:${emailKey}:${originKey}`,
    day: `login:send-day:${emailKey}:${originKey}`
  };
}

/** Key of the code request counter of a client IP. */
export function requestCounterKey(originKey: string): string {
  return `login:request:${originKey}`;
}

/** Key of the code verification counter of a client IP. */
export function verifyCounterKey(originKey: string): string {
  return `login:verify:${originKey}`;
}

/**
 * Penalty after the `issued`-th code: the step for that count, the last step for every count
 * past the list, never above the ceiling.
 */
function penaltyMs(issued: number, limits: LoginLimits): number {
  const steps = limits.OTP_LOCKOUT_STEPS_SECONDS;
  const step = steps[Math.min(issued, steps.length) - 1] ?? 0;
  return Math.min(step, limits.OTP_MAX_LOCKOUT_SECONDS) * SECOND_MS;
}

/**
 * State that still counts at `now`: a state past `forgetAt` is ignored even before the TTL index
 * deletes it.
 */
export function liveThrottle(throttle: LoginThrottle | null, now: Date): LoginThrottle | null {
  return throttle !== null && throttle.forgetAt.getTime() > now.getTime() ? throttle : null;
}

/**
 * Earliest instant of the next code for the email. Each wait counts from the issue of the previous
 * code, so requests refused meanwhile do not move it.
 *
 * @param throttle - Live throttle state of the email; `null` when none.
 * @param limits - Limit settings.
 * @returns The instant; `null` when a code may be issued at any time.
 */
export function nextCodeAt(throttle: LoginThrottle | null, limits: LoginLimits): Date | null {
  if (throttle === null) {
    return null;
  }
  const wait = Math.max(
    limits.OTP_RESEND_COOLDOWN_SECONDS * SECOND_MS,
    penaltyMs(throttle.issued, limits)
  );
  return new Date(throttle.lastIssuedAt.getTime() + wait);
}

/**
 * End of the automatic lockout of an email: the wait of a penalty step, as opposed to the plain
 * cooldown between two codes.
 *
 * @param throttle - Live throttle state of the email; `null` when none.
 * @param limits - Limit settings.
 * @param now - Current instant.
 * @returns The end of the lockout; `null` when the email is not locked out at `now`.
 */
export function lockoutEndsAt(
  throttle: LoginThrottle | null,
  limits: LoginLimits,
  now: Date
): Date | null {
  if (throttle === null || penaltyMs(throttle.issued, limits) === 0) {
    return null;
  }
  const next = nextCodeAt(throttle, limits);
  return next !== null && next.getTime() > now.getTime() ? next : null;
}

/** Whole seconds from `now` to `at`, at least 1. */
export function secondsUntil(at: Date, now: Date): number {
  return Math.max(1, Math.ceil((at.getTime() - now.getTime()) / SECOND_MS));
}
