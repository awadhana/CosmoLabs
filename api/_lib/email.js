/**
 * Gmail SMTP email integration for the intake flow (nodemailer).
 *
 * All mail is sent from the company Gmail account (GMAIL_USER, authenticated
 * with a Google App Password in GMAIL_APP_PASSWORD — regular account passwords
 * are rejected by Gmail SMTP). Sends (a) an internal notification with the
 * full submission, (b) a customer confirmation, and (c) a "your site is ready"
 * email when the Forge pipeline promotes a build to the client. Every send is
 * best-effort: this module NEVER throws and returns {sent:false, reason} when
 * email is unavailable or fails — an email outage must not fail the pipeline.
 */

import nodemailer from "nodemailer";

const DEFAULT_NOTIFY = "cosmolabshq@gmail.com";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function nl2br(value) {
  return escapeHtml(value).replaceAll("\n", "<br>");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function row(label, valueHtml) {
  return `<tr>
    <td style="padding:6px 12px 6px 0;vertical-align:top;color:#64748b;font-size:13px;white-space:nowrap">${escapeHtml(label)}</td>
    <td style="padding:6px 0;vertical-align:top;font-size:14px;color:#0f172a">${valueHtml}</td>
  </tr>`;
}

function internalHtml(submission) {
  const refs = (submission.references || [])
    .map(
      (r, i) =>
        `${i + 1}. <a href="${escapeHtml(r.url)}">${escapeHtml(r.url)}</a>${
          r.note ? ` — ${escapeHtml(r.note)}` : ""
        }`
    )
    .join("<br>");

  const cs = submission.colorScheme;
  const colorScheme = cs
    ? [
        `Mode: ${escapeHtml(cs.mode)}`,
        cs.colors?.length ? `Colors: ${cs.colors.map(escapeHtml).join(", ")}` : null,
        cs.notes ? `Notes: ${nl2br(cs.notes)}` : null,
      ]
        .filter(Boolean)
        .join("<br>")
    : "";

  const clarifications = (submission.clarifications || [])
    .map(
      (c, i) =>
        `<p style="margin:0 0 8px 0"><strong>Q${i + 1}: ${escapeHtml(c.question)}</strong><br>${nl2br(
          c.answer
        )}</p>`
    )
    .join("");

  const files = (submission.files || [])
    .map((f) => `${escapeHtml(f.name)} (${escapeHtml(f.type || "unknown")}, ${formatBytes(f.size)})`)
    .join("<br>");

  return `
  <div style="font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:640px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 4px 0;color:#0f172a">New project brief</h2>
    <p style="margin:0 0 16px 0;color:#64748b;font-size:13px">Reference <code>${escapeHtml(submission.id)}</code> · received ${escapeHtml(submission.receivedAt)}</p>
    <table style="border-collapse:collapse;width:100%">
      ${row("Title", `<strong>${escapeHtml(submission.title)}</strong>`)}
      ${row("Email", `<a href="mailto:${escapeHtml(submission.email)}">${escapeHtml(submission.email)}</a>`)}
      ${row("Phone", escapeHtml(submission.phone))}
      ${row("Description", nl2br(submission.description))}
      ${refs ? row("References", refs) : ""}
      ${colorScheme ? row("Color scheme", colorScheme) : ""}
      ${files ? row("Files", files) : ""}
      ${row("Turnstile", submission.meta?.turnstileVerified ? "verified" : "not verified / not configured")}
      ${row("IP", escapeHtml(submission.meta?.ip || "unknown"))}
    </table>
    ${clarifications ? `<h3 style="color:#0f172a;margin:20px 0 8px 0">Clarifications</h3>${clarifications}` : ""}
    <p style="margin:20px 0 0 0;color:#64748b;font-size:12px">Stored at <code>intake/${escapeHtml(submission.id)}/submission.json</code> in Vercel Blob.</p>
  </div>`;
}

function customerHtml(submission) {
  return `
  <div style="font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 12px 0;color:#0f172a">We received your project brief</h2>
    <p style="margin:0 0 12px 0;color:#334155;line-height:1.6">
      Thanks for reaching out to CosmoLabs. Your brief is in our queue and a senior
      engineer will follow up within one business day.
    </p>
    <p style="margin:0 0 16px 0;color:#334155;line-height:1.6">
      Your reference id is <strong>${escapeHtml(submission.id)}</strong> — keep it handy
      if you want to add anything later.
    </p>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px">
      <p style="margin:0 0 6px 0;font-size:13px;color:#64748b">Summary</p>
      <p style="margin:0 0 6px 0;color:#0f172a"><strong>${escapeHtml(submission.title)}</strong></p>
      <p style="margin:0;color:#334155;font-size:14px;line-height:1.5">${nl2br(
        submission.description.length > 400
          ? `${submission.description.slice(0, 400)}…`
          : submission.description
      )}</p>
    </div>
    <p style="margin:16px 0 0 0;color:#64748b;font-size:13px">
      Questions in the meantime? Just reply to this email or write to cosmolabshq@gmail.com.
    </p>
  </div>`;
}

function siteLiveHtml(submission, url) {
  const safeUrl = escapeHtml(url);
  return `
  <div style="font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 12px 0;color:#0f172a">Your site is ready</h2>
    <p style="margin:0 0 12px 0;color:#334155;line-height:1.6">
      Great news — the first build of your project is live and ready for you to
      explore. Have a look, click around, and tell us what you'd like to refine.
    </p>
    <p style="margin:0 0 20px 0;color:#334155;line-height:1.6">
      Reference <strong>${escapeHtml(submission.id)}</strong> · <strong>${escapeHtml(submission.title)}</strong>
    </p>
    <p style="margin:0 0 24px 0">
      <a href="${safeUrl}" style="display:inline-block;background:linear-gradient(135deg,#8B7BFF,#45E6FF);color:#0A0F26;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px">View your site →</a>
    </p>
    <p style="margin:0 0 16px 0;color:#64748b;font-size:13px;word-break:break-all">
      Or paste this link into your browser:<br><a href="${safeUrl}" style="color:#6366f1">${safeUrl}</a>
    </p>
    <p style="margin:16px 0 0 0;color:#64748b;font-size:13px">
      Questions or changes? Just reply to this email or write to cosmolabshq@gmail.com.
    </p>
  </div>`;
}

/**
 * Build the shared Gmail SMTP transporter. Returns null when credentials are
 * absent so callers can degrade gracefully. Reused by every send below.
 * @returns {{ transporter: import("nodemailer").Transporter, user: string } | null}
 */
function makeTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return { transporter, user };
}

/**
 * @param {{ submission: object, notifyEmail?: string }} args
 * @returns {Promise<{sent: boolean, reason?: string, internalId?: string|null, confirmationId?: string|null}>}
 */
export async function sendIntakeEmails({ submission, notifyEmail }) {
  try {
    const mailer = makeTransporter();
    if (!mailer) return { sent: false, reason: "GMAIL_USER / GMAIL_APP_PASSWORD not configured" };
    const { transporter, user } = mailer;
    const from = `"CosmoLabs" <${user}>`;
    const notify = notifyEmail || process.env.INTAKE_NOTIFY_EMAIL || DEFAULT_NOTIFY;

    let internalId = null;
    let confirmationId = null;

    // Each send is isolated so one failing doesn't skip the other.
    try {
      const info = await transporter.sendMail({
        from,
        to: notify,
        replyTo: submission.email,
        subject: `New project brief ${submission.id}: ${submission.title}`,
        html: internalHtml(submission),
      });
      internalId = info?.messageId ?? null;
    } catch (err) {
      console.error(`[email] internal notification failed for ${submission.id}:`, err?.message || err);
    }

    try {
      const info = await transporter.sendMail({
        from,
        to: submission.email,
        subject: "We received your project brief — CosmoLabs",
        html: customerHtml(submission),
      });
      confirmationId = info?.messageId ?? null;
    } catch (err) {
      console.error(`[email] confirmation failed for ${submission.id}:`, err?.message || err);
    }

    const sent = internalId !== null || confirmationId !== null;
    return sent
      ? { sent: true, internalId, confirmationId }
      : { sent: false, reason: "all sends failed" };
  } catch (err) {
    // Belt and braces — this function must never throw.
    console.error(`[email] unexpected failure for ${submission?.id}:`, err?.message || err);
    return { sent: false, reason: "unexpected failure" };
  }
}

/**
 * Notify the client that their build is live (Forge "promote" step). Sent to
 * the brief's own email with the preview/live URL and reference id. Like the
 * intake sends, this NEVER throws and returns {sent, reason?}.
 *
 * @param {{ submission: object, url: string }} args
 * @returns {Promise<{sent: boolean, reason?: string, messageId?: string|null}>}
 */
export async function sendSiteLiveEmail({ submission, url }) {
  try {
    if (!submission || typeof submission !== "object") return { sent: false, reason: "missing submission" };
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return { sent: false, reason: "missing or invalid url" };
    if (typeof submission.email !== "string" || submission.email.length === 0) {
      return { sent: false, reason: "no recipient" };
    }

    const mailer = makeTransporter();
    if (!mailer) return { sent: false, reason: "GMAIL_USER / GMAIL_APP_PASSWORD not configured" };
    const { transporter, user } = mailer;

    try {
      const info = await transporter.sendMail({
        from: `"CosmoLabs" <${user}>`,
        to: submission.email,
        subject: "Your site is ready — CosmoLabs",
        html: siteLiveHtml(submission, url),
      });
      return { sent: true, messageId: info?.messageId ?? null };
    } catch (err) {
      console.error(`[email] site-live send failed for ${submission.id}:`, err?.message || err);
      return { sent: false, reason: "send failed" };
    }
  } catch (err) {
    console.error(`[email] unexpected site-live failure for ${submission?.id}:`, err?.message || err);
    return { sent: false, reason: "unexpected failure" };
  }
}
