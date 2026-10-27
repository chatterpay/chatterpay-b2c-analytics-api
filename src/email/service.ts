import type { Invite } from '../store/types.js';
import { DEFAULT_RETRY_POLICY, deliver, type RetryPolicy } from './delivery.js';
import { renderInviteEmail, renderLoginCodeEmail } from './templates.js';
import type { DeliveryOutcome, EmailLocale, EmailProvider } from './types.js';

/** Configuration of {@link EmailService}. */
export interface EmailServiceOptions {
  provider: EmailProvider;
  /** Login page of the site, the link of the invitations. */
  loginUrl: string;
  retryPolicy?: RetryPolicy;
  /** Replaceable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Emails of the API: invitations and login codes. It renders the templates, derives the
 * idempotency keys and applies the retry policy, so the routes depend on neither the provider nor
 * the copy.
 */
export class EmailService {
  readonly provider: EmailProvider;
  private readonly loginUrl: string;
  private readonly retryPolicy: RetryPolicy;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(options: EmailServiceOptions) {
    this.provider = options.provider;
    this.loginUrl = options.loginUrl;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.sleep = options.sleep;
  }

  /**
   * Sends the invitation. The key is the invite id and its send number (`resendCount`), so a
   * retry of one send is accepted once and every resend is a new message.
   *
   * @param invite - Pending invite, after its creation or resend was stored.
   * @returns The delivery outcome.
   */
  sendInvite(invite: Invite): Promise<DeliveryOutcome> {
    const email = renderInviteEmail({
      locale: invite.locale,
      role: invite.role,
      loginUrl: this.loginUrl,
      expiresAt: invite.expiresAt
    });
    return deliver(
      this.provider,
      {
        to: invite.email,
        ...email,
        idempotencyKey: `invite/${invite.id}/${invite.resendCount}`,
        tags: [{ name: 'category', value: 'invite' }]
      },
      this.retryPolicy,
      this.sleep
    );
  }

  /**
   * Sends a login code. The key is the challenge id: one challenge, one code, one message.
   *
   * @param input - Recipient, challenge, code, language and minutes until the code expires.
   * @returns The delivery outcome.
   */
  sendLoginCode(input: {
    email: string;
    challengeId: string;
    code: string;
    locale: EmailLocale;
    expiresInMinutes: number;
  }): Promise<DeliveryOutcome> {
    const email = renderLoginCodeEmail({
      locale: input.locale,
      code: input.code,
      expiresInMinutes: input.expiresInMinutes
    });
    return deliver(
      this.provider,
      {
        to: input.email,
        ...email,
        idempotencyKey: `login-code/${input.challengeId}`,
        tags: [{ name: 'category', value: 'login_code' }]
      },
      this.retryPolicy,
      this.sleep
    );
  }
}
