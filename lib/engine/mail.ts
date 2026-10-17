// Outgoing mail for platform alerts. Resend's HTTP API (free tier: 3000 mails/month), no SDK.
export interface Mail {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

export interface Mailer {
  send(m: Mail): Promise<void>;
}

export class ResendMailer implements Mailer {
  constructor(
    private apiKey: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async send(m: Mail) {
    const res = await this.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(m),
    });
    if (!res.ok) throw new Error(`mail not sent: ${res.status} ${await res.text()}`);
  }
}

/** RESEND_API_KEY from env, or null (alerts are then only logged and shown in the admin). */
export function mailerFromEnv(): Mailer | null {
  return process.env.RESEND_API_KEY ? new ResendMailer(process.env.RESEND_API_KEY) : null;
}
