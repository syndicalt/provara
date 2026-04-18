import { Resend } from "resend";

/**
 * Resend wrapper — lazy singleton, graceful no-op when unconfigured.
 *
 * Self-hosters without email keys see a warning log once and all
 * downstream notifications silently succeed (returns `{ sent: false }`).
 * Email delivery failures NEVER block signup or invite creation — the
 * invite row is still persisted, the user can resend manually via the
 * dashboard.
 *
 * Cloud deployments set `RESEND_API_KEY` and `PROVARA_EMAIL_FROM` on
 * Railway. Self-host installs can skip both; the dashboard's "copy
 * invite link" button works without email.
 */

let client: Resend | null = null;
let initialized = false;

function getResend(): Resend | null {
  if (initialized) return client;
  initialized = true;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  client = new Resend(key);
  return client;
}

/** Reset the module singleton between tests so key rotation is observable. */
export function __resetResendForTests(): void {
  client = null;
  initialized = false;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** ReplyTo header. Defaults to the from address. */
  replyTo?: string;
}

export interface SendEmailResult {
  sent: boolean;
  messageId?: string;
  skippedReason?: "not_configured" | "send_failed";
  error?: string;
}

function defaultFrom(): string {
  return process.env.PROVARA_EMAIL_FROM || "Provara <noreply@provara.xyz>";
}

/**
 * Send a transactional email. Returns a result instead of throwing so
 * callers can continue with the rest of their workflow regardless of
 * email-provider state. Use `result.sent` to decide whether to tell the
 * user "we sent an email" vs "here's a copy of the link to share."
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const resend = getResend();
  if (!resend) {
    // Log once per process lifecycle — downstream paths are expected to
    // fall back to on-screen copy-paste links when email isn't wired.
    console.warn("[email] Skipped send — RESEND_API_KEY not configured");
    return { sent: false, skippedReason: "not_configured" };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: defaultFrom(),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      replyTo: input.replyTo ?? defaultFrom(),
    });
    if (error) {
      console.warn(`[email] Resend rejected send to ${input.to}: ${error.message}`);
      return { sent: false, skippedReason: "send_failed", error: error.message };
    }
    return { sent: true, messageId: data?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[email] Resend call failed for ${input.to}: ${msg}`);
    return { sent: false, skippedReason: "send_failed", error: msg };
  }
}
