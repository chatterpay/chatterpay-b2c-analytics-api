import type { EmailAttempt, EmailMessage, EmailProvider } from './types.js';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 10_000;

/** Configuration of {@link ResendEmailProvider}. */
export interface ResendOptions {
  /** Sending-only API key of the Resend account, restricted to the sender domain. */
  apiKey: string;
  /** Sender as `Name <address@verified-domain>`. */
  from: string;
  /** Replaceable for tests; `fetch` by default. */
  fetch?: typeof fetch;
}

/**
 * Reads `retry-after` in seconds, as Resend sends it.
 *
 * @param header - Header value.
 * @returns The wait in milliseconds; `null` when absent or not a number.
 */
function retryAfterMs(header: string | null): number | null {
  if (header === null) {
    return null;
  }
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
}

/**
 * Error name of a Resend error body, such as `invalid_idempotent_request`.
 *
 * @param response - Failed response.
 * @returns The name; `null` when the body is not the documented error object.
 */
async function errorName(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { name?: unknown };
    return typeof body.name === 'string' ? body.name : null;
  } catch {
    return null;
  }
}

/**
 * Sends through the Resend REST API (`POST /emails`) with `fetch`, so the adapter needs no SDK
 * and reads `retry-after` itself. The `Idempotency-Key` header makes Resend accept each key once
 * for 24 hours.
 *
 * Classification of the answers: 2xx is sent; 429 and 5xx are retryable; 409
 * `concurrent_idempotent_requests` (the same key is still being processed) is retryable; any
 * other 4xx, `invalid_idempotent_request` included, is a rejection. Neither the key nor the
 * message is logged.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend' as const;
  private readonly apiKey: string;
  private readonly from: string;
  private readonly fetch: typeof fetch;

  constructor(options: ResendOptions) {
    this.apiKey = options.apiKey;
    this.from = options.from;
    this.fetch = options.fetch ?? fetch;
  }

  async send(message: EmailMessage): Promise<EmailAttempt> {
    let response: Response;
    try {
      response = await this.fetch(RESEND_EMAILS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': message.idempotencyKey
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          tags: message.tags
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      return { kind: 'failed', failure: 'network', retryable: true, retryAfterMs: null };
    }

    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
      return { kind: 'sent', messageId: typeof body?.id === 'string' ? body.id : '' };
    }
    const wait = retryAfterMs(response.headers.get('retry-after'));
    if (response.status === 429) {
      return { kind: 'failed', failure: 'rate_limited', retryable: true, retryAfterMs: wait };
    }
    if (response.status >= 500) {
      return { kind: 'failed', failure: 'unavailable', retryable: true, retryAfterMs: wait };
    }
    if (
      response.status === 409 &&
      (await errorName(response)) === 'concurrent_idempotent_requests'
    ) {
      return { kind: 'failed', failure: 'unavailable', retryable: true, retryAfterMs: wait };
    }
    return { kind: 'failed', failure: 'rejected', retryable: false, retryAfterMs: null };
  }
}
