import { Injectable } from '@nestjs/common';
import { createMailer } from 'email';
import { env } from '../../env';

const FROM = env.EMAIL_FROM;

// this app is now the only consumer of `email`'s createMailer — the two
// APIs enqueue jobs instead of sending mail themselves
@Injectable()
export class MailerService {
  private readonly mailer = createMailer(
    env.EMAIL_TRANSPORT === 'ses'
      ? { transport: 'ses' }
      : { transport: 'smtp', host: env.SMTP_HOST, port: env.SMTP_PORT },
  );

  sendMail(params: {
    to: string;
    from?: string | { name: string; address: string };
    subject: string;
    html: string;
  }) {
    return this.mailer.sendMail({ ...params, from: params.from ?? FROM });
  }
}
