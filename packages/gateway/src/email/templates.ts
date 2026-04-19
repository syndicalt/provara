/**
 * Transactional email templates. Intentionally inline HTML strings
 * rather than a full templating engine — the message count is small,
 * the HTML is simple, and dependencies are kept minimal.
 *
 * All templates share a common shell (`emailShell`) that renders a
 * centered card with the Provara wordmark and a dark theme matching
 * the dashboard. Clients that strip CSS (some webmail) fall back to
 * the text version which every template also provides.
 */

function emailShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0; padding:0; background:#09090b; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif; color:#e4e4e7;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#09090b;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px; background:#18181b; border:1px solid #27272a; border-radius:12px;">
          <tr>
            <td style="padding:24px 28px; border-bottom:1px solid #27272a;">
              <div style="font-size:18px; font-weight:700; letter-spacing:-0.01em; color:#fafafa;">Provara</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px; font-size:14px; line-height:1.6; color:#d4d4d8;">
              ${body}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px; border-top:1px solid #27272a; font-size:12px; color:#71717a; text-align:center;">
              <div>Provara &middot; operated by CoreLumen, LLC</div>
              <div style="margin-top:6px;">
                <a href="https://www.provara.xyz" style="color:#60a5fa; text-decoration:none;">provara.xyz</a>
                &nbsp;&middot;&nbsp;
                <a href="https://www.provara.xyz/pricing" style="color:#60a5fa; text-decoration:none;">Pricing</a>
                &nbsp;&middot;&nbsp;
                <a href="mailto:support@corelumen.io" style="color:#60a5fa; text-decoration:none;">Contact</a>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface InviteEmailParams {
  inviteUrl: string;
  inviterName: string;
  inviterEmail: string;
  invitedEmail: string;
  role: "owner" | "member";
  expiresAt: Date;
}

export function inviteEmail(params: InviteEmailParams): { subject: string; html: string; text: string } {
  const expires = params.expiresAt.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const subject = `${escapeHtml(params.inviterName)} invited you to a Provara team`;
  const body = `
    <p style="font-size:16px; color:#fafafa; margin:0 0 18px;">You've been invited to join a Provara team.</p>
    <p style="margin:0 0 14px;"><strong style="color:#fafafa;">${escapeHtml(params.inviterName)}</strong> (${escapeHtml(params.inviterEmail)}) added <strong style="color:#fafafa;">${escapeHtml(params.invitedEmail)}</strong> as a <strong>${params.role}</strong>.</p>
    <p style="margin:0 0 22px;">Provara is an intelligent LLM gateway — adaptive routing, silent-regression detection, cost migrations. Sign in with Google or GitHub to accept the invite and start collaborating.</p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;">
      <tr>
        <td style="background:#2563eb; border-radius:8px;">
          <a href="${escapeHtml(params.inviteUrl)}" style="display:inline-block; padding:12px 22px; color:#ffffff; font-weight:600; text-decoration:none; font-size:14px;">Accept invite &rarr;</a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 8px; color:#a1a1aa; font-size:13px;">Or paste this link into your browser:</p>
    <p style="margin:0 0 20px; word-break:break-all; font-size:12px; color:#60a5fa;"><a href="${escapeHtml(params.inviteUrl)}" style="color:#60a5fa;">${escapeHtml(params.inviteUrl)}</a></p>
    <p style="margin:0; font-size:12px; color:#71717a;">This invite expires on ${escapeHtml(expires)}. If you weren't expecting this, you can safely ignore the email.</p>
  `;
  const text = [
    `${params.inviterName} (${params.inviterEmail}) invited you to join a Provara team as a ${params.role}.`,
    "",
    `Accept the invite: ${params.inviteUrl}`,
    "",
    `This invite expires on ${expires}. If you weren't expecting this, you can safely ignore the email.`,
    "",
    "Provara · operated by CoreLumen, LLC",
    "https://www.provara.xyz",
  ].join("\n");
  return { subject, html: emailShell(subject, body), text };
}

export interface MagicLinkEmailParams {
  verifyUrl: string;
  email: string;
  isNewUser: boolean;
  expiresAt: Date;
}

export function magicLinkEmail(params: MagicLinkEmailParams): { subject: string; html: string; text: string } {
  const expiresLabel = "15 minutes";
  const subject = params.isNewUser
    ? "Finish signing up for Provara"
    : "Your Provara sign-in link";
  const headline = params.isNewUser
    ? "One click away from your new Provara account"
    : "Sign in to Provara";
  const intro = params.isNewUser
    ? `Click the button below to finish creating your account on <strong style="color:#fafafa;">${escapeHtml(params.email)}</strong>. The link expires in ${expiresLabel}.`
    : `Click the button below to sign in as <strong style="color:#fafafa;">${escapeHtml(params.email)}</strong>. The link expires in ${expiresLabel}.`;
  const body = `
    <p style="font-size:16px; color:#fafafa; margin:0 0 18px;">${headline}</p>
    <p style="margin:0 0 22px;">${intro}</p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;">
      <tr>
        <td style="background:#2563eb; border-radius:8px;">
          <a href="${escapeHtml(params.verifyUrl)}" style="display:inline-block; padding:12px 22px; color:#ffffff; font-weight:600; text-decoration:none; font-size:14px;">${params.isNewUser ? "Finish signing up" : "Sign in"} &rarr;</a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 8px; color:#a1a1aa; font-size:13px;">Or paste this link into your browser:</p>
    <p style="margin:0 0 20px; word-break:break-all; font-size:12px; color:#60a5fa;"><a href="${escapeHtml(params.verifyUrl)}" style="color:#60a5fa;">${escapeHtml(params.verifyUrl)}</a></p>
    <p style="margin:0; font-size:12px; color:#71717a;">If you didn't request this, you can ignore this email — nothing happens until the link is clicked.</p>
  `;
  const text = [
    headline,
    "",
    params.isNewUser
      ? `Finish creating your Provara account for ${params.email}. Link expires in ${expiresLabel}.`
      : `Sign in to Provara as ${params.email}. Link expires in ${expiresLabel}.`,
    "",
    params.verifyUrl,
    "",
    "If you didn't request this, ignore this email.",
    "",
    "Provara · operated by CoreLumen, LLC",
  ].join("\n");
  return { subject, html: emailShell(subject, body), text };
}

export interface BudgetAlertEmailParams {
  tenantId: string;
  threshold: number;
  spendUsd: number;
  capUsd: number;
  period: "monthly" | "quarterly";
  periodStart: Date;
  periodEnd: Date;
  dashboardUrl: string;
}

export function budgetAlertEmail(params: BudgetAlertEmailParams): { subject: string; html: string; text: string } {
  const money = (n: number) => `$${n.toFixed(2)}`;
  const pct = Math.min(100, Math.round((params.spendUsd / Math.max(params.capUsd, 0.0001)) * 100));
  const subject = params.threshold >= 100
    ? `Provara budget exceeded (${money(params.spendUsd)} of ${money(params.capUsd)})`
    : `Provara budget at ${params.threshold}% (${money(params.spendUsd)} of ${money(params.capUsd)})`;
  const headline = params.threshold >= 100
    ? "Your spend has reached 100% of your budget"
    : `Your spend has crossed ${params.threshold}% of your budget`;
  const periodLabel = params.period === "monthly" ? "this month" : "this quarter";
  const body = `
    <p style="font-size:16px; color:#fafafa; margin:0 0 18px;">${headline}</p>
    <p style="margin:0 0 14px;">${periodLabel[0].toUpperCase() + periodLabel.slice(1)} you've spent <strong style="color:#fafafa;">${escapeHtml(money(params.spendUsd))}</strong> of a <strong style="color:#fafafa;">${escapeHtml(money(params.capUsd))}</strong> cap (${pct}%).</p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 22px;">
      <tr>
        <td style="background:#2563eb; border-radius:8px;">
          <a href="${escapeHtml(params.dashboardUrl)}" style="display:inline-block; padding:12px 22px; color:#ffffff; font-weight:600; text-decoration:none; font-size:14px;">View spend dashboard &rarr;</a>
        </td>
      </tr>
    </table>
    <p style="margin:0; font-size:12px; color:#71717a;">Turn off or adjust this alert from your budget settings.</p>
  `;
  const text = [
    headline,
    "",
    `${periodLabel[0].toUpperCase() + periodLabel.slice(1)} you've spent ${money(params.spendUsd)} of a ${money(params.capUsd)} cap (${pct}%).`,
    "",
    `Dashboard: ${params.dashboardUrl}`,
    "",
    "Turn off or adjust this alert from your budget settings.",
  ].join("\n");
  return { subject, html: emailShell(subject, body), text };
}

export interface WelcomeEmailParams {
  name: string;
  dashboardUrl: string;
}

export function welcomeEmail(params: WelcomeEmailParams): { subject: string; html: string; text: string } {
  const subject = "Welcome to Provara";
  const body = `
    <p style="font-size:16px; color:#fafafa; margin:0 0 18px;">Welcome aboard${params.name ? ", " + escapeHtml(params.name) : ""}!</p>
    <p style="margin:0 0 14px;">Provara is an intelligent LLM gateway — you bring your API keys, we handle routing, observability, quality scoring, and cost optimization.</p>
    <p style="margin:0 0 18px;">Three things to try first:</p>
    <ul style="margin:0 0 22px; padding-left:20px; color:#d4d4d8;">
      <li style="margin-bottom:8px;"><strong style="color:#fafafa;">Add a provider key</strong> — Google, OpenAI, Anthropic, or any OpenAI-compatible endpoint.</li>
      <li style="margin-bottom:8px;"><strong style="color:#fafafa;">Send a chat completion</strong> through the gateway's OpenAI-compatible endpoint. Any SDK works.</li>
      <li style="margin-bottom:8px;"><strong style="color:#fafafa;">Open the Playground</strong> and rate a few responses to seed adaptive routing.</li>
    </ul>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
      <tr>
        <td style="background:#2563eb; border-radius:8px;">
          <a href="${escapeHtml(params.dashboardUrl)}" style="display:inline-block; padding:12px 22px; color:#ffffff; font-weight:600; text-decoration:none; font-size:14px;">Open the dashboard &rarr;</a>
        </td>
      </tr>
    </table>
    <p style="margin:22px 0 0; font-size:13px; color:#a1a1aa;">Reply to this email if you hit any snags — it goes straight to us.</p>
  `;
  const text = [
    `Welcome to Provara${params.name ? ", " + params.name : ""}!`,
    "",
    "Three things to try first:",
    "  - Add a provider key (OpenAI, Anthropic, Google, or compatible)",
    "  - Send a chat completion through the gateway",
    "  - Open the Playground and rate a few responses",
    "",
    `Dashboard: ${params.dashboardUrl}`,
    "",
    "Reply to this email if you hit any snags.",
    "",
    "Provara · operated by CoreLumen, LLC",
  ].join("\n");
  return { subject, html: emailShell(subject, body), text };
}
