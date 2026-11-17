import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';

type Mail = {
  to: { email: string; name?: string };
  subject: string;
  html: string;
};

const ZEPTOMAIL_URL = 'https://api.zeptomail.com/v1.1/email';

export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

export function layout(
  heading: string,
  body: string,
  action?: { label: string; url: string },
) {
  const button = action
    ? `<p style="margin:28px 0"><a href="${escapeHtml(action.url)}" style="background:#141312;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">${escapeHtml(action.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f6f5f2;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#141312">
<div style="max-width:520px;margin:0 auto;padding:40px 24px"><p style="font-weight:800;font-size:20px;margin:0 0 32px">Cheda</p>
<h1 style="font-size:22px;margin:0 0 16px">${escapeHtml(heading)}</h1>${body}${button}
<p style="color:#8a877f;font-size:12px;margin-top:40px">You received this email because of activity on your Cheda account.</p></div></body></html>`;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  async send(mail: Mail): Promise<void> {
    // ZeptoMail's dashboard copies the token with its "Zoho-enczapikey " prefix; accept either form
    const token = this.config
      .get('ZEPTOMAIL_TOKEN', { infer: true })
      .replace(/^Zoho-enczapikey\s+/i, '');
    if (!token) {
      const text = mail.html
        .replace(/<a [^>]*href="([^"]+)"[^>]*>/g, ' [$1] ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      this.logger.log(
        `[dev mail] to=${mail.to.email} subject="${mail.subject}"\n${text}`,
      );
      return;
    }
    const res = await fetch(ZEPTOMAIL_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Zoho-enczapikey ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        from: {
          address: this.config.get('ZEPTOMAIL_FROM_EMAIL', { infer: true }),
          name: this.config.get('ZEPTOMAIL_FROM_NAME', { infer: true }),
        },
        to: [
          {
            email_address: {
              address: mail.to.email,
              name: mail.to.name ?? mail.to.email,
            },
          },
        ],
        subject: mail.subject,
        htmlbody: mail.html,
      }),
    });
    if (!res.ok)
      throw new Error(`ZeptoMail responded ${res.status}: ${await res.text()}`);
  }
}
