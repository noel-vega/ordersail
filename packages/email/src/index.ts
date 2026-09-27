import nodemailer, { type Transporter } from "nodemailer";

// Two ways out. Production sends through the SES API with the process's own
// AWS credentials (the ECS task role) — no SMTP user or password anywhere
// (OS-658). Local dev sends over plain SMTP to Mailpit.
export type MailerConfig =
  | { transport: "ses" }
  | { transport: "smtp"; host: string; port: number };

export interface SendMailParams {
  to: string;
  // per-send, not baked into the mailer config — different emails from the
  // same app can need different senders (e.g. a platform-branded email vs.
  // one sent on behalf of a specific merchant). Object form lets nodemailer
  // handle quoting/escaping a display name that comes from user data (e.g.
  // a shop's own name) instead of hand-building a "Name <addr>" string.
  from: string | { name: string; address: string };
  subject: string;
  html: string;
}

// `@aws-sdk/client-sesv2` is imported on first send, not at module load, so a
// missing or broken SDK install fails that send (logged, retried) instead of
// crashing the worker at boot and silently stopping every email — the same
// reason AlertsService loads the SNS SDK lazily.
async function createTransport(config: MailerConfig): Promise<Transporter> {
  if (config.transport === "ses") {
    const { SESv2Client, SendEmailCommand } = await import(
      "@aws-sdk/client-sesv2"
    );
    // region + credentials come from the environment (AWS_REGION and the
    // task role on ECS)
    return nodemailer.createTransport({
      SES: { sesClient: new SESv2Client({}), SendEmailCommand },
    });
  }
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: false,
  });
}

export function createMailer(config: MailerConfig) {
  let transport: Promise<Transporter> | undefined;
  const getTransport = () =>
    (transport ??= createTransport(config).catch((err: unknown) => {
      transport = undefined; // let the next send retry the import
      throw err;
    }));

  return {
    sendMail: async (params: SendMailParams) =>
      (await getTransport()).sendMail({
        from: params.from,
        to: params.to,
        subject: params.subject,
        html: params.html,
      }),
  };
}
