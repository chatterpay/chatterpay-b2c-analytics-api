import { randomUUID } from 'node:crypto';
import type { EmailAttempt, EmailMessage, EmailProvider } from './types.js';

/** Messages kept; older ones are dropped. */
const OUTBOX_LIMIT = 100;

/**
 * Provider that sends nothing: it keeps the last messages in memory so tests can read them. It is
 * the default while `EMAIL_PROVIDER` is not `resend`. Nothing is logged, since a message can carry
 * a login code.
 */
export class SimulatedEmailProvider implements EmailProvider {
  readonly name = 'simulated' as const;
  /** Messages accepted, oldest first. */
  readonly outbox: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<EmailAttempt> {
    this.outbox.push(message);
    if (this.outbox.length > OUTBOX_LIMIT) {
      this.outbox.shift();
    }
    return { kind: 'sent', messageId: `simulated-${randomUUID()}` };
  }
}
