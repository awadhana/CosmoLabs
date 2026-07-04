/**
 * GET /api/intake-config — public, cacheable config the intake form reads at
 * load time (Turnstile site key, whether AI clarification is enabled, upload
 * limits). Never exposes secrets — only the *site* key and feature flags.
 */

import {
  ALLOWED_EXTENSIONS,
  checkSameOrigin,
  requireMethod,
  sendJson,
} from "./_lib/security.js";

export default async function handler(req, res) {
  if (!requireMethod(req, res, "GET")) return;
  // GET: non-browser clients may omit Origin; if present it must match Host.
  if (!checkSameOrigin(req, res, { allowMissingOrigin: true })) return;

  res.setHeader("Cache-Control", "public, max-age=300");
  sendJson(res, 200, {
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
    clarifyEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
    maxFiles: 3,
    maxFileBytes: 1572864,
    maxTotalBytes: 3145728,
    allowedExtensions: ALLOWED_EXTENSIONS,
  });
}
