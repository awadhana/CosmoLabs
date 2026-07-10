/**
 * GET /api/pipeline/promote — take a previewed build live and notify the client.
 *
 * Flow: verify the signed token (invalid/expired -> 400 branded page) ->
 * re-read the brief -> require status "preview" (else friendly "already
 * handled" / "not ready" page) -> flip status preview->done -> email the client
 * their live URL (meta.previewUrl, set by the runner) -> branded confirmation.
 *
 * Per-client Vercel provisioning/aliasing is the runner's job; here we only
 * flip the status and send the "your site is ready" email. Never leaks
 * internals; the email send is best-effort and never blocks the status flip.
 */

import { requireMethod } from "../_lib/security.js";
import { verifyPipelineToken } from "../_lib/captcha.js";
import { sendSiteLiveEmail } from "../_lib/email.js";
import {
  STATUS,
  actionParams,
  readSubmission,
  renderPipelinePage,
  sendHtml,
  statusLabel,
  writeSubmissionStatus,
} from "../_lib/pipeline.js";

export default async function handler(req, res) {
  if (!requireMethod(req, res, "GET")) return;

  try {
    const { id, exp, sig } = actionParams(req);
    if (!verifyPipelineToken("promote", id, exp, sig)) {
      sendHtml(res, 400, renderPipelinePage({
        tone: "muted",
        heading: "Link invalid or expired",
        body: "This promote link is no longer valid. Open the brief in the Forge channel for a fresh one.",
      }));
      return;
    }

    const read = await readSubmission(id);
    if (!read.ok) {
      sendHtml(res, 404, renderPipelinePage({
        tone: "muted",
        heading: "Brief not found",
        body: "We couldn't find that brief. It may have been removed.",
      }));
      return;
    }

    const status = read.submission.status;
    if (status === STATUS.DONE) {
      sendHtml(res, 200, renderPipelinePage({
        tone: "cyan",
        heading: "Already promoted",
        body: `${id} is already live and the client has been notified — no action needed.`,
      }));
      return;
    }
    if (status !== STATUS.PREVIEW) {
      sendHtml(res, 200, renderPipelinePage({
        heading: "Not ready to promote",
        body: `This brief is ${statusLabel(status)}. It can only be promoted once a preview is ready.`,
      }));
      return;
    }

    const write = await writeSubmissionStatus(id, STATUS.DONE);
    if (!write.ok) {
      sendHtml(res, 200, renderPipelinePage({
        tone: "cyan",
        heading: "Already promoted",
        body: "This brief was just promoted from another click — no action needed.",
      }));
      return;
    }

    const submission = write.submission;
    const url = submission.meta?.previewUrl;
    const emailResult = await sendSiteLiveEmail({ submission, url });

    if (emailResult.sent) {
      sendHtml(res, 200, renderPipelinePage({
        tone: "cyan",
        heading: "Promoted — client notified",
        body: `${id} is live and the client has been emailed their link.`,
      }));
    } else {
      // Status is already "done"; only the notification fell through. Surface
      // that honestly so the team can email the client manually.
      sendHtml(res, 200, renderPipelinePage({
        tone: "muted",
        heading: "Promoted — email not sent",
        body: `${id} is marked live, but we couldn't email the client automatically. Please reach out to them directly.`,
      }));
    }
  } catch (err) {
    console.error("[pipeline/promote] unexpected error:", err?.message || err);
    sendHtml(res, 500, renderPipelinePage({
      tone: "muted",
      heading: "Something went wrong",
      body: "Please try again in a moment.",
    }));
  }
}
