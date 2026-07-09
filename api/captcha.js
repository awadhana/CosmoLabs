/**
 * GET /api/captcha — issue a stateless proof-of-work challenge for the intake
 * wizard's "I'm not a robot" check (used when Cloudflare Turnstile is not
 * configured). The solved challenge travels back inside the /api/intake
 * payload as the `captcha` field — see _lib/captcha.js for the scheme.
 *
 * Success: 200 {"ok":true,"algorithm":"SHA-256","challenge","salt","maxnumber","signature"}
 * Errors:  400 origin · 405 method · 429 rate limited
 */

import { createChallenge, isCaptchaSecretConfigured } from "./_lib/captcha.js";
import { checkRateLimit } from "./_lib/ratelimit.js";
import {
  checkSameOrigin,
  getClientIp,
  requireMethod,
  sendJson,
} from "./_lib/security.js";

export default async function handler(req, res) {
  if (!requireMethod(req, res, "GET")) return;
  // GET: non-browser clients may omit Origin; if present it must match Host.
  if (!checkSameOrigin(req, res, { allowMissingOrigin: true })) return;

  // Refuse to issue a forgeable challenge in production without a real secret.
  if (!isCaptchaSecretConfigured()) {
    sendJson(res, 503, { ok: false, error: "Human verification is not configured" });
    return;
  }

  const ip = getClientIp(req);
  const rate = checkRateLimit(ip, "captcha", 30, 10 * 60 * 1000);
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    sendJson(res, 429, { ok: false, error: "Too many requests. Please wait a few minutes and try again." });
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  sendJson(res, 200, { ok: true, ...createChallenge(ip) });
}
