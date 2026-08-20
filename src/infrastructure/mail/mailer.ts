/**
 * Email sender — routes through channel-service, the platform's single email
 * egress. data-board no longer talks to SMTP/Mailgun directly: it POSTs a
 * generic payload to channel-service `POST /internal/v1/emails/send`, which
 * delivers via the environment's configured provider. No SMTP/provider
 * credentials live in data-board anymore.
 *
 * Throws on failure (the export-email caller relies on a throw to record failed
 * recipients) — same contract as the previous nodemailer implementation.
 */

import config from "../../config";
import logger from "../logging/logger";

export async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
  fromName?: string;
  fromEmail?: string;
}): Promise<void> {
  const res = await fetch(`${config.channelServiceUrl}/internal/v1/emails/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-proxy": "data-board" },
    body: JSON.stringify({
      to: params.to,
      subject: params.subject,
      html: params.html,
      from: params.fromEmail,
      fromName: params.fromName,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`channel-service email send failed (${res.status}): ${body}`);
  }
  logger.info(`Email sent to ${params.to}: "${params.subject}"`);
}
