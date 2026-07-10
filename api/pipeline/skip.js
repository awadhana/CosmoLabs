/**
 * GET /api/pipeline/skip — drop a brief from a signed Discord link.
 *
 * Flow: verify the signed token (invalid/expired -> 400 branded page) ->
 * re-read the brief -> if not "new", show a friendly "already handled" page
 * (idempotent) -> flip status new->dropped -> branded "Skipped" page. Nothing
 * is deleted; the brief just leaves the queue. Never leaks internals.
 */

import { requireMethod } from "../_lib/security.js";
import { verifyPipelineToken } from "../_lib/captcha.js";
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
    if (!verifyPipelineToken("skip", id, exp, sig)) {
      sendHtml(res, 400, renderPipelinePage({
        tone: "muted",
        heading: "Link invalid or expired",
        body: "This link is no longer valid. Open the brief in the Forge channel for a fresh one.",
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
    if (status !== STATUS.NEW) {
      sendHtml(res, 200, renderPipelinePage({
        heading: "Already handled",
        body: `This brief is already ${statusLabel(status)} — no action needed.`,
      }));
      return;
    }

    const write = await writeSubmissionStatus(id, STATUS.DROPPED);
    if (!write.ok) {
      sendHtml(res, 200, renderPipelinePage({
        heading: "Already handled",
        body: "This brief was just handled from another click — no action needed.",
      }));
      return;
    }

    sendHtml(res, 200, renderPipelinePage({
      tone: "muted",
      heading: "Skipped",
      body: `${id} has been removed from the build queue. Nothing was sent to the client.`,
    }));
  } catch (err) {
    console.error("[pipeline/skip] unexpected error:", err?.message || err);
    sendHtml(res, 500, renderPipelinePage({
      tone: "muted",
      heading: "Something went wrong",
      body: "Please try again in a moment.",
    }));
  }
}
