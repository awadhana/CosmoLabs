/**
 * GET /api/admin/submissions — list stored submissions for the async pipeline
 * (Hermes / Obsidian vault). Requires "Authorization: Bearer <INTAKE_ADMIN_TOKEN>".
 *
 *   503 — INTAKE_ADMIN_TOKEN not configured
 *   401 — missing or wrong token
 *   200 — { ok: true, submissions: [{ id, url, uploadedAt, size }] }
 *
 * Only intake/<id>/submission.json blobs are returned; uploaded files are
 * discoverable through each submission's `files[].blobPath` manifest.
 */

import crypto from "node:crypto";
import { list } from "@vercel/blob";

import { requireMethod, sendJson } from "../_lib/security.js";

const SUBMISSION_PATH_RE = /^intake\/([^/]+)\/submission\.json$/;

/**
 * Constant-time-ish comparison: hash both sides to fixed-length buffers first
 * so timingSafeEqual can be used regardless of input lengths.
 */
function tokenMatches(provided, expected) {
  const a = crypto.createHash("sha256").update(provided, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  try {
    if (!requireMethod(req, res, "GET")) return;

    const expected = process.env.INTAKE_ADMIN_TOKEN;
    if (!expected) {
      sendJson(res, 503, { ok: false, error: "Admin access is not configured" });
      return;
    }

    const auth = String(req.headers.authorization || "");
    const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
    if (!provided || !tokenMatches(provided, expected)) {
      sendJson(res, 401, { ok: false, error: "Unauthorized" });
      return;
    }

    const submissions = [];
    let cursor;
    do {
      const page = await list({ prefix: "intake/", cursor, limit: 1000 });
      for (const blob of page.blobs) {
        const match = SUBMISSION_PATH_RE.exec(blob.pathname);
        if (match) {
          submissions.push({
            id: match[1],
            url: blob.url,
            uploadedAt: blob.uploadedAt,
            size: blob.size,
          });
        }
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);

    // Newest first — convenient for pollers.
    submissions.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

    sendJson(res, 200, { ok: true, submissions });
  } catch (err) {
    console.error("[admin/submissions] unexpected error:", err);
    sendJson(res, 500, { ok: false, error: "Something went wrong." });
  }
}
