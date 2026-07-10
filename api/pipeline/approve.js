/**
 * GET /api/pipeline/approve — approve a brief from a signed Discord link and
 * kick off the build.
 *
 * Flow: verify the signed token (invalid/expired -> 400 branded page) ->
 * re-read the brief -> if not "new", show a friendly "already handled" page
 * (idempotent) -> flip status new->approved -> fire the repository_dispatch.
 * If the dispatch fails the status stays "approved" and the Forge channel is
 * alerted so the team can retry. Never leaks internals.
 */

import { requireMethod } from "../_lib/security.js";
import { verifyPipelineToken } from "../_lib/captcha.js";
import {
  STATUS,
  actionParams,
  dispatchBuild,
  discordAlert,
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
    if (!verifyPipelineToken("approve", id, exp, sig)) {
      sendHtml(res, 400, renderPipelinePage({
        tone: "muted",
        heading: "Link invalid or expired",
        body: "This approval link is no longer valid. Open the brief in the Forge channel for a fresh one.",
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

    const write = await writeSubmissionStatus(id, STATUS.APPROVED);
    if (!write.ok) {
      // Lost a race with another click, or the write failed — either way don't
      // dispatch. A stale guard means it was just handled elsewhere.
      sendHtml(res, 200, renderPipelinePage({
        heading: "Already handled",
        body: "This brief was just approved from another click — no action needed.",
      }));
      return;
    }

    const dispatch = await dispatchBuild(id);
    if (!dispatch.ok) {
      // Status stays "approved"; alert the team so they can retry the build.
      await discordAlert(`Build dispatch failed for ${id} — status left at "approved". Please retry.`);
      sendHtml(res, 200, renderPipelinePage({
        tone: "muted",
        heading: "Approved — build not started",
        body: `We approved ${id}, but couldn't start the build automatically. The team has been alerted and will retry shortly.`,
      }));
      return;
    }

    sendHtml(res, 200, renderPipelinePage({
      tone: "cyan",
      heading: "Build started",
      body: `Build started for ${id}. A preview link will appear in the Forge channel when it's ready.`,
    }));
  } catch (err) {
    console.error("[pipeline/approve] unexpected error:", err?.message || err);
    sendHtml(res, 500, renderPipelinePage({
      tone: "muted",
      heading: "Something went wrong",
      body: "Please try again in a moment.",
    }));
  }
}
