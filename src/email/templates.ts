import type { Role } from '../auth/principal.js';
import type { EmailLocale } from './types.js';

/** Subject and bodies of an email. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const PRODUCT = 'ChatterPay Analytics';

const LANGUAGE_TAGS: Readonly<Record<EmailLocale, string>> = {
  en: 'en-US',
  es: 'es-AR',
  br: 'pt-BR'
};

const ROLE_LABELS: Readonly<Record<EmailLocale, Record<Role, string>>> = {
  en: { admin: 'Admin', viewer: 'Viewer' },
  es: { admin: 'Admin', viewer: 'Lector' },
  br: { admin: 'Admin', viewer: 'Leitor' }
};

interface InviteCopy {
  subject: string;
  intro: (role: string) => string;
  action: string;
  steps: string;
  expires: (date: string) => string;
  ignore: string;
}

const INVITE_COPY: Readonly<Record<EmailLocale, InviteCopy>> = {
  en: {
    subject: `You are invited to ${PRODUCT}`,
    intro: (role) => `You were invited to ${PRODUCT} with the ${role} role.`,
    action: 'Sign in',
    steps: 'Sign in with this email address. We will send you a code to confirm it.',
    expires: (date) => `The invitation expires on ${date}.`,
    ignore: 'If you did not expect this invitation, you can ignore this email.'
  },
  es: {
    subject: `Te invitaron a ${PRODUCT}`,
    intro: (role) => `Te invitaron a ${PRODUCT} con el rol ${role}.`,
    action: 'Ingresar',
    steps: 'Ingresá con esta dirección de email. Te vamos a enviar un código para confirmarla.',
    expires: (date) => `La invitación vence el ${date}.`,
    ignore: 'Si no esperabas esta invitación, podés ignorar este email.'
  },
  br: {
    subject: `Você foi convidado para o ${PRODUCT}`,
    intro: (role) => `Você foi convidado para o ${PRODUCT} com a função ${role}.`,
    action: 'Entrar',
    steps: 'Entre com este endereço de email. Vamos enviar um código para confirmá-lo.',
    expires: (date) => `O convite expira em ${date}.`,
    ignore: 'Se você não esperava este convite, pode ignorar este email.'
  }
};

interface LoginCodeCopy {
  subject: (code: string) => string;
  intro: string;
  expires: (minutes: number) => string;
  ignore: string;
}

const LOGIN_CODE_COPY: Readonly<Record<EmailLocale, LoginCodeCopy>> = {
  en: {
    subject: (code) => `${code} is your ${PRODUCT} code`,
    intro: `Use this code to sign in to ${PRODUCT}:`,
    expires: (minutes) => `It expires in ${minutes} minutes and works once.`,
    ignore: 'If you did not try to sign in, you can ignore this email.'
  },
  es: {
    subject: (code) => `${code} es tu código de ${PRODUCT}`,
    intro: `Usá este código para ingresar a ${PRODUCT}:`,
    expires: (minutes) => `Vence en ${minutes} minutos y sirve una sola vez.`,
    ignore: 'Si no intentaste ingresar, podés ignorar este email.'
  },
  br: {
    subject: (code) => `${code} é o seu código do ${PRODUCT}`,
    intro: `Use este código para entrar no ${PRODUCT}:`,
    expires: (minutes) => `Ele expira em ${minutes} minutos e só pode ser usado uma vez.`,
    ignore: 'Se você não tentou entrar, pode ignorar este email.'
  }
};

/**
 * Escapes text for HTML element content and quoted attribute values.
 *
 * @param value - Raw text.
 * @returns The escaped text.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Wraps paragraphs in a minimal HTML document with inline styles, which email clients keep.
 *
 * @param locale - Language of the document.
 * @param body - HTML of the content, already escaped.
 * @returns The HTML document.
 */
function layout(locale: EmailLocale, body: string): string {
  return [
    '<!doctype html>',
    `<html lang="${LANGUAGE_TAGS[locale]}">`,
    '<body style="margin:0;padding:24px;background:#f6f6f7;font-family:Arial,Helvetica,sans-serif;color:#18181b">',
    '<div style="max-width:480px;margin:0 auto;padding:32px;background:#ffffff;border-radius:12px">',
    `<p style="margin:0 0 24px;font-size:14px;font-weight:bold">${PRODUCT}</p>`,
    body,
    '</div>',
    '</body>',
    '</html>'
  ].join('');
}

function paragraph(
  text: string,
  style = 'margin:0 0 16px;font-size:15px;line-height:22px'
): string {
  return `<p style="${style}">${escapeHtml(text)}</p>`;
}

/**
 * Invitation to join with a role. It links to the login page of the site; the invited account is
 * created when that email confirms the login code, never by the link itself.
 *
 * @param input - Locale, role, login URL of the site and expiry of the invite.
 * @returns The email.
 */
export function renderInviteEmail(input: {
  locale: EmailLocale;
  role: Role;
  loginUrl: string;
  expiresAt: Date;
}): RenderedEmail {
  const copy = INVITE_COPY[input.locale];
  const role = ROLE_LABELS[input.locale][input.role];
  const date = new Intl.DateTimeFormat(LANGUAGE_TAGS[input.locale], {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC'
  }).format(input.expiresAt);
  const expires = copy.expires(`${date} UTC`);
  const html = layout(
    input.locale,
    [
      paragraph(copy.intro(role)),
      paragraph(copy.steps),
      `<p style="margin:24px 0"><a href="${escapeHtml(input.loginUrl)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#18181b;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none">${escapeHtml(copy.action)}</a></p>`,
      paragraph(expires),
      paragraph(copy.ignore, 'margin:0;font-size:13px;line-height:20px;color:#71717a')
    ].join('')
  );
  const text = [
    copy.intro(role),
    copy.steps,
    `${copy.action}: ${input.loginUrl}`,
    expires,
    copy.ignore
  ].join('\n\n');
  return { subject: copy.subject, html, text };
}

/**
 * One-time login code.
 *
 * @param input - Locale, code and minutes until the code expires.
 * @returns The email.
 */
export function renderLoginCodeEmail(input: {
  locale: EmailLocale;
  code: string;
  expiresInMinutes: number;
}): RenderedEmail {
  const copy = LOGIN_CODE_COPY[input.locale];
  const expires = copy.expires(input.expiresInMinutes);
  const html = layout(
    input.locale,
    [
      paragraph(copy.intro),
      `<p style="margin:0 0 16px;font-size:32px;font-weight:bold;letter-spacing:6px">${escapeHtml(input.code)}</p>`,
      paragraph(expires),
      paragraph(copy.ignore, 'margin:0;font-size:13px;line-height:20px;color:#71717a')
    ].join('')
  );
  const text = [copy.intro, input.code, expires, copy.ignore].join('\n\n');
  return { subject: copy.subject(input.code), html, text };
}
