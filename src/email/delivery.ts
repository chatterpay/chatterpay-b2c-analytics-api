import type { DeliveryOutcome, EmailMessage, EmailProvider } from './types.js';

/** Retries of one message inside a request. */
export interface RetryPolicy {
  /** Requests made at most, the first one included. */
  maxAttempts: number;
  /** Wait before the second request; it doubles on each further one. */
  baseDelayMs: number;
  /**
   * Longest wait between two requests. A `retry-after` beyond it ends the delivery as failed
   * instead of holding the HTTP request open.
   */
  maxDelayMs: number;
}

/**
 * Policy of the API: three requests, 0.5 s and 1 s apart, or the `retry-after` of the provider up
 * to 5 s. The worst case stays below the request timeout of the API.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000
};

/**
 * Sends a message, retrying network errors, rate limits and server errors with exponential
 * backoff. Every retry reuses the idempotency key, so the provider delivers the message at most
 * once even when an earlier request reached it but its answer was lost. A rejection is not retried.
 *
 * @param provider - Email provider.
 * @param message - Message with its idempotency key.
 * @param policy - Retry policy.
 * @param sleep - Waits the given milliseconds; replaced in tests.
 * @returns The outcome; `simulated` when the provider sends nothing.
 */
export async function deliver(
  provider: EmailProvider,
  message: EmailMessage,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<DeliveryOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    const result = await provider.send(message);
    if (result.kind === 'sent') {
      return {
        state: provider.name === 'simulated' ? 'simulated' : 'sent',
        attempts: attempt,
        messageId: result.messageId,
        failure: null
      };
    }
    const delay = result.retryAfterMs ?? policy.baseDelayMs * 2 ** (attempt - 1);
    if (!result.retryable || attempt >= policy.maxAttempts || delay > policy.maxDelayMs) {
      return { state: 'failed', attempts: attempt, messageId: null, failure: result.failure };
    }
    await sleep(delay);
  }
}
