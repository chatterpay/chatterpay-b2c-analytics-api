/** Language of an email; the codes match the site locales (`br` is Brazilian Portuguese). */
export type EmailLocale = 'en' | 'es' | 'br';

/** Locales the templates are written in. */
export const EMAIL_LOCALES: readonly EmailLocale[] = ['en', 'es', 'br'];

/** Email ready to hand to a provider. */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Key that makes the provider accept the message once: a retry of the same attempt reuses it,
   * a new attempt (a resend, a new login code) gets a new one.
   */
  idempotencyKey: string;
  /** Provider tags, for filtering in its dashboard; never personal data. */
  tags: { name: string; value: string }[];
}

/**
 * Why an attempt failed:
 * - `rejected`: the provider refused the message (invalid sender, unverified domain, invalid
 *   recipient, a reused idempotency key with another payload); retrying does not help.
 * - `rate_limited`: the provider asked to slow down (429).
 * - `unavailable`: the provider answered with a server error or asked to retry later.
 * - `network`: no answer, or the request timed out.
 */
export type EmailFailure = 'rejected' | 'rate_limited' | 'unavailable' | 'network';

/** Outcome of one request to the provider. */
export type EmailAttempt =
  | { kind: 'sent'; messageId: string }
  | {
      kind: 'failed';
      failure: EmailFailure;
      retryable: boolean;
      /** Wait the provider asked for, from `retry-after`; `null` when it gave none. */
      retryAfterMs: number | null;
    };

/** Sender of emails. The routes depend on this contract, never on a provider. */
export interface EmailProvider {
  /** `simulated` stores the messages in memory and sends nothing. */
  readonly name: 'simulated' | 'resend';
  send(message: EmailMessage): Promise<EmailAttempt>;
}

/** State of the delivery of an invite or a login code. */
export type DeliveryState = 'simulated' | 'sent' | 'failed';

/** Result of delivering one message, retries included. */
export interface DeliveryOutcome {
  state: DeliveryState;
  /** Requests made to the provider. */
  attempts: number;
  /** Id the provider gave the message; `null` when it was not accepted. */
  messageId: string | null;
  /** Failure of the last attempt; `null` unless `state` is `failed`. */
  failure: EmailFailure | null;
}
