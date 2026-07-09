/**
 * Shared security helpers for the CosmoLabs intake API.
 *
 * Files under api/_lib/ are NOT exposed as serverless endpoints (Vercel skips
 * underscore-prefixed directories) — keep all shared code here.
 *
 * Guard helpers follow one convention: they either return `true` (request may
 * proceed) or send a terminating JSON response on `res` and return `false`,
 * so handlers can `if (!guard(...)) return;`.
 */

import crypto from "node:crypto";

// Raw request body cap. The contract caps decoded file payloads at 3MB total,
// which is exactly 4,194,304 characters as base64 — so the cap must leave
// headroom for base64 expansion PLUS the JSON envelope (field names, email,
// title, description, clarifications, ...). 4,500,000 bytes gives ~300KB of
// envelope headroom while staying under Vercel's 4.5MiB (4,718,592-byte)
// platform hard limit.
export const MAX_RAW_BODY_BYTES = 4_500_000;

export const ALLOWED_EXTENSIONS = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "txt",
  "md",
  "docx",
  "xlsx",
  "csv",
];

export function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function requireMethod(req, res, method) {
  if (req.method === method) return true;
  res.setHeader("Allow", method);
  sendJson(res, 405, { ok: false, error: "Method not allowed" });
  return false;
}

export function requireJsonContentType(req, res) {
  const contentType = String(req.headers["content-type"] || "");
  if (contentType.toLowerCase().startsWith("application/json")) return true;
  sendJson(res, 415, { ok: false, error: "Content-Type must be application/json" });
  return false;
}

/**
 * Size-guard BEFORE touching req.body — reject oversized payloads early.
 *
 * Best-effort only: it trusts the Content-Length header (absent or spoofed
 * headers pass), so it is a cheap pre-filter, not the real guard. The real
 * limits are Vercel's platform 4.5MiB cap plus the per-file/total decoded-byte
 * checks in the intake validator (which pre-check base64 length before
 * decoding, so oversized files are rejected without materializing them).
 */
export function rejectOversizedBody(req, res) {
  const contentLength = Number(req.headers["content-length"] || 0);
  if (!Number.isFinite(contentLength) || contentLength <= MAX_RAW_BODY_BYTES) return true;
  sendJson(res, 413, { ok: false, error: "Payload too large" });
  return false;
}

/**
 * Same-origin check. If an Origin header is present it must match the request
 * Host, otherwise the request is rejected with 400 (the API contract's error
 * set for these endpoints is 400/405/413/415/429/500 — no 403). A missing
 * Origin header is only tolerated when `allowMissingOrigin` is set — used on
 * GET endpoints so non-browser pipeline clients (curl, the Hermes poller,
 * etc.) can call them.
 */
export function checkSameOrigin(req, res, { allowMissingOrigin = false } = {}) {
  const origin = req.headers.origin;
  if (!origin) {
    if (allowMissingOrigin) return true;
    sendJson(res, 400, { ok: false, error: "Cross-origin requests are not allowed." });
    return false;
  }
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  try {
    if (host && new URL(origin).host === host) return true;
  } catch {
    // fall through — malformed Origin is rejected below
  }
  sendJson(res, 400, { ok: false, error: "Cross-origin requests are not allowed." });
  return false;
}

/**
 * Client IP for rate limiting and audit metadata. Prefers the platform-set
 * x-real-ip header; otherwise uses the RIGHTMOST x-forwarded-for hop (the one
 * appended by the trusted edge — leftmost entries can be prepended by the
 * client, which would let an attacker rotate rate-limit buckets and poison
 * the IP stored in submission.meta); else falls back to the socket address.
 */
export function getClientIp(req) {
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim().length > 0) {
    return realIp.trim();
  }
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    const hops = forwarded.split(",");
    return hops[hops.length - 1].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

/**
 * Strip control characters (keeps \t, \n, \r) and trim. Returns null when the
 * value is not a string, so callers can distinguish "missing" from "empty".
 */
export function cleanString(value) {
  if (typeof value !== "string") return null;
  let out = "";
  for (const ch of value) {
    const c = ch.codePointAt(0);
    const isControl = (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127;
    if (!isControl) out += ch;
  }
  return out.trim();
}

/** Clean + hard-truncate — for defensive length enforcement. */
export function sanitizeText(value, maxLen) {
  const cleaned = cleanString(value);
  if (cleaned === null) return null;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

export function isValidEmail(value) {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
  );
}

export function isValidPhone(value) {
  if (typeof value !== "string" || !/^[0-9+\-() ]{7,25}$/.test(value)) return false;
  // Charset+length alone accepts digit-free input like "() () ()" — also
  // require at least 7 actual numeric digits.
  return value.replace(/[^0-9]/g, "").length >= 7;
}

export function isValidHttpUrl(value, maxLen = 500) {
  if (typeof value !== "string" || value.length > maxLen) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isValidHexColor(value) {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

/**
 * Filename sanitizer: basename only (no path traversal), whitelist charset,
 * collapsed dots (no ".." sequences), non-empty stem, and an extension on the
 * allowed list. Returns the sanitized name or null when unusable.
 */
export function sanitizeFilename(name) {
  if (typeof name !== "string") return null;
  // Basename: drop any directory components (both separators).
  let base = name.split(/[\\/]/).pop() || "";
  base = base.replace(/[^a-zA-Z0-9._-]/g, "");
  base = base.replace(/\.{2,}/g, ".").replace(/^[.\-]+/, "");
  if (base.length > 120) base = base.slice(-120).replace(/^[.\-]+/, "");
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or empty stem
  const ext = base.slice(dot + 1).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) return null;
  return base;
}

/** Minimal magic-byte sniffing so a renamed executable can't pose as a document. */
export function magicBytesOk(ext, buf) {
  switch (ext) {
    case "pdf":
      return buf.length >= 4 && buf.toString("latin1", 0, 4) === "%PDF";
    case "png":
      return (
        buf.length >= 8 &&
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
        buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
      );
    case "jpg":
    case "jpeg":
      return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "webp":
      return (
        buf.length >= 12 &&
        buf.toString("latin1", 0, 4) === "RIFF" &&
        buf.toString("latin1", 8, 12) === "WEBP"
      );
    case "docx":
    case "xlsx":
      // Office Open XML files are ZIP containers.
      return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
    default:
      // txt / md / csv have no reliable signature.
      return true;
  }
}

/**
 * Constant-time-ish comparison: hash both sides to fixed-length buffers first
 * so timingSafeEqual can be used regardless of input lengths.
 */
export function tokenMatches(provided, expected) {
  const a = crypto.createHash("sha256").update(provided, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}
