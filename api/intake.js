/**
 * POST /api/intake — receive a project brief, validate it server-side, store
 * files + submission.json in Vercel Blob (private store), notify by email.
 *
 * Success: 200 {"ok":true,"id":"int_<base36 ts>_<6 random chars>"}
 * Errors:  400 validation/origin · 405 method · 413 too large ·
 *          415 content type · 429 rate limited · 500 generic (never leaks internals)
 */

import crypto from "node:crypto";
import { put } from "@vercel/blob";

import { verifyCaptcha } from "./_lib/captcha.js";
import { checkRateLimit } from "./_lib/ratelimit.js";
import { sendIntakeEmails } from "./_lib/email.js";
import { notifyDiscord } from "./_lib/pipeline.js";
import {
  ALLOWED_EXTENSIONS,
  MAX_RAW_BODY_BYTES,
  checkSameOrigin,
  cleanString,
  getClientIp,
  isValidEmail,
  isValidHexColor,
  isValidHttpUrl,
  isValidPhone,
  magicBytesOk,
  rejectOversizedBody,
  requireJsonContentType,
  requireMethod,
  sanitizeFilename,
  sanitizeText,
  sendJson,
} from "./_lib/security.js";

const MAX_FILES = 3;
const MAX_FILE_BYTES = 1_572_864; // 1.5MB decoded per file
// Max base64 length that can decode to MAX_FILE_BYTES — checked BEFORE
// decoding so oversized payloads are rejected without allocating the buffer.
const MAX_FILE_B64_CHARS = Math.ceil(MAX_FILE_BYTES / 3) * 4; // 2,097,152
const MAX_TOTAL_BYTES = 3_145_728; // 3MB decoded total
const MIN_FORM_FILL_MS = 3000; // time-gate: humans take longer than 3s

const GENERIC_500 = "Something went wrong. Please email cosmolabshq@gmail.com.";

// UI languages we localize the customer confirmation email for; anything else
// (or missing) falls back to English.
const SUPPORTED_LANGS = ["en", "ar", "fr"];
export function normalizeLang(value) {
  return SUPPORTED_LANGS.includes(value) ? value : "en";
}

// ---------------------------------------------------------------------------
// Validation

function fail(message) {
  return { error: message };
}

export function validateReferences(raw) {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw) || raw.length > 5) return fail("References must be a list of at most 5 links.");
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return fail("Each reference must be an object.");
    const url = cleanString(item.url);
    if (!url || !isValidHttpUrl(url, 500)) return fail("Reference links must be valid http(s) URLs (max 500 characters).");
    const note = item.note === undefined || item.note === null ? "" : cleanString(item.note);
    if (note === null || note.length > 300) return fail("Reference notes must be text of at most 300 characters.");
    out.push({ url, note });
  }
  return { value: out };
}

export function validateColorScheme(raw) {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return fail("Color scheme must be an object.");
  const mode = raw.mode;
  if (!["light", "dark", "either"].includes(mode)) return fail("Color scheme mode must be light, dark, or either.");
  let colors = [];
  if (raw.colors !== undefined && raw.colors !== null) {
    if (!Array.isArray(raw.colors) || raw.colors.length > 6) return fail("Color scheme may include at most 6 colors.");
    for (const c of raw.colors) {
      if (!isValidHexColor(c)) return fail('Colors must be hex strings like "#AABBCC".');
    }
    colors = raw.colors.map((c) => c.toUpperCase());
  }
  const notes = raw.notes === undefined || raw.notes === null ? "" : cleanString(raw.notes);
  if (notes === null || notes.length > 500) return fail("Color scheme notes must be text of at most 500 characters.");
  return { value: { mode, colors, notes } };
}

export function validateClarifications(raw) {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw) || raw.length > 8) return fail("At most 8 clarification answers are allowed.");
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return fail("Each clarification must be an object.");
    const question = cleanString(item.question);
    const answer = item.answer === undefined || item.answer === null ? "" : cleanString(item.answer);
    if (question === null || question.length === 0 || question.length > 500) {
      return fail("Clarification questions must be text of at most 500 characters.");
    }
    if (answer === null || answer.length > 2000) {
      return fail("Clarification answers must be text of at most 2000 characters.");
    }
    out.push({ question, answer });
  }
  return { value: out };
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function validateFiles(raw) {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw) || raw.length > MAX_FILES) return fail(`At most ${MAX_FILES} files are allowed.`);

  const out = [];
  const usedNames = new Set();
  let totalBytes = 0;

  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== "object") return fail("Each file must be an object.");

    let name = sanitizeFilename(item.name);
    if (!name) {
      return fail(`File ${i + 1} has an invalid name or unsupported type. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}.`);
    }
    // Avoid collisions inside intake/<id>/files/ when two uploads sanitize to
    // the same name.
    if (usedNames.has(name)) name = `${i + 1}-${name}`;
    usedNames.add(name);

    if (typeof item.data !== "string" || item.data.length === 0) return fail(`File "${name}" is missing its data.`);
    const b64 = item.data.replace(/\s/g, "");
    if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) return fail(`File "${name}" is not valid base64 data.`);
    // Pre-decode size check: reject before Buffer.from materializes the bytes.
    if (b64.length > MAX_FILE_B64_CHARS) return fail(`File "${name}" exceeds the 1.5MB per-file limit.`);

    const buffer = Buffer.from(b64, "base64");
    if (buffer.length === 0) return fail(`File "${name}" is empty.`);
    if (buffer.length > MAX_FILE_BYTES) return fail(`File "${name}" exceeds the 1.5MB per-file limit.`);
    totalBytes += buffer.length;
    if (totalBytes > MAX_TOTAL_BYTES) return fail("Uploaded files exceed the 3MB total limit.");

    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    if (!magicBytesOk(ext, buffer)) return fail(`File "${name}" does not look like a valid .${ext} file.`);

    // Never trust the client's declared size/type: size comes from the decoded
    // bytes; type is only kept as a hint after a strict shape check.
    const declaredType = typeof item.type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(item.type)
      ? item.type
      : "application/octet-stream";

    out.push({ name, type: declaredType, size: buffer.length, buffer });
  }
  return { value: out };
}

export function validateSubmission(body) {
  const email = cleanString(body.email);
  if (!email || !isValidEmail(email)) return fail("Please provide a valid email address.");

  const phone = cleanString(body.phone);
  if (!phone || !isValidPhone(phone)) return fail("Please provide a valid phone number (at least 7 digits; +, -, parentheses and spaces allowed).");

  const title = cleanString(body.title);
  if (!title || title.length < 3 || title.length > 200) return fail("Project title must be between 3 and 200 characters.");

  const description = cleanString(body.description);
  if (!description || description.length < 10 || description.length > 5000) {
    return fail("Project description must be between 10 and 5000 characters.");
  }

  const references = validateReferences(body.references);
  if (references.error) return references;

  const colorScheme = validateColorScheme(body.colorScheme);
  if (colorScheme.error) return colorScheme;

  const clarifications = validateClarifications(body.clarifications);
  if (clarifications.error) return clarifications;

  const files = validateFiles(body.files);
  if (files.error) return files;

  return {
    value: {
      email,
      phone,
      title,
      description,
      references: references.value,
      colorScheme: colorScheme.value,
      clarifications: clarifications.value,
      files: files.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Anti-abuse

export function isBot(body) {
  // Honeypot: the browser always submits the visually hidden "website" field
  // as an empty string. Any present value that isn't exactly "" — including
  // non-string types (0, null, [], {}) a bot might send to dodge the check —
  // is a bot signal.
  if ("website" in body && body.website !== "") return true;
  // Time gate: forms submitted within 3s of opening (or with a missing/bogus
  // timestamp) are treated as automated.
  const startedAt = typeof body.startedAt === "number" ? body.startedAt : 0;
  if (!startedAt || Date.now() - startedAt < MIN_FORM_FILL_MS) return true;
  return false;
}

/**
 * The human-verification gate decision, factored out of the handler so it can
 * be unit-tested directly (the handler wiring around blob storage/email is not
 * easily exercised). Whenever Turnstile is configured it is authoritative;
 * otherwise a solved proof-of-work captcha is REQUIRED.
 *
 * @param {{required: boolean, verified: boolean}} turnstile
 * @param {{verified: boolean, reason?: string}} captchaResult
 * @returns {{ok: true, powVerified: boolean} | {ok: false, code: "turnstile"|"captcha"}}
 */
export function humanCheckResult(turnstile, captchaResult) {
  if (turnstile.required) {
    return turnstile.verified ? { ok: true, powVerified: false } : { ok: false, code: "turnstile" };
  }
  return captchaResult.verified ? { ok: true, powVerified: true } : { ok: false, code: "captcha" };
}

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { required: false, verified: false };
  // 10s budget (mirrors clarify.js): a hung siteverify must not stall intake
  // into a platform 504 — abort and fail closed as "verification failed".
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const params = new URLSearchParams({
      secret,
      response: typeof token === "string" ? token : "",
      remoteip: ip,
    });
    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: params,
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => null);
    return { required: true, verified: data?.success === true };
  } catch (err) {
    console.error("[intake] Turnstile verification error:", err?.message || err);
    return { required: true, verified: false };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------

export function newSubmissionId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let random = "";
  for (const byte of crypto.randomBytes(6)) random += alphabet[byte % alphabet.length];
  return `int_${Date.now().toString(36)}_${random}`;
}

export default async function handler(req, res) {
  try {
    if (!requireMethod(req, res, "POST")) return;
    if (!requireJsonContentType(req, res)) return;
    if (!rejectOversizedBody(req, res)) return;
    if (!checkSameOrigin(req, res)) return; // browser POST: Origin required + must match Host

    const ip = getClientIp(req);
    const rate = checkRateLimit(ip, "intake", 8, 10 * 60 * 1000);
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfterSec));
      sendJson(res, 429, { ok: false, code: "rate_limit", error: "Too many requests. Please wait a few minutes and try again." });
      return;
    }

    // Vercel auto-parses JSON bodies; tolerate a raw string just in case.
    let body = req.body;
    if (typeof body === "string") {
      // Backstop for the header-based pre-check: measure the actual bytes.
      if (Buffer.byteLength(body, "utf8") > MAX_RAW_BODY_BYTES) {
        sendJson(res, 413, { ok: false, code: "too_large", error: "Payload too large" });
        return;
      }
      try {
        body = JSON.parse(body);
      } catch {
        sendJson(res, 400, { ok: false, code: "bad_json", error: "Request body must be valid JSON." });
        return;
      }
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, code: "bad_json", error: "Request body must be a JSON object." });
      return;
    }

    // Bots get a fake success and nothing is stored ("silent drop").
    if (isBot(body)) {
      sendJson(res, 200, { ok: true, id: "int_0" });
      return;
    }

    const validated = validateSubmission(body);
    if (validated.error) {
      sendJson(res, 400, { ok: false, code: "validation", error: validated.error });
      return;
    }

    // Human check: Turnstile is authoritative when configured; otherwise a
    // solved proof-of-work captcha (issued by GET /api/captcha) is REQUIRED.
    // code:"captcha" lets the frontend show a translated message and reset its
    // widget; code:"turnstile" maps to a generic localized failure.
    const turnstile = await verifyTurnstile(body.turnstileToken, ip);
    const captchaResult = turnstile.required
      ? { verified: false, reason: "turnstile path" }
      : verifyCaptcha(body.captcha, ip);
    const human = humanCheckResult(turnstile, captchaResult);
    if (!human.ok) {
      if (human.code === "captcha") console.log(`[intake] captcha rejected (${captchaResult.reason}) from ${ip}`);
      sendJson(res, 400, human.code === "captcha"
        ? { ok: false, code: "captcha", error: "Human verification failed. Please redo the check and try again." }
        : { ok: false, code: "turnstile", error: "Verification failed" });
      return;
    }
    const powVerified = human.powVerified;

    const id = newSubmissionId();
    const data = validated.value;

    // Store binaries first so submission.json only ever references blobs that
    // exist (the async pipeline treats submission.json as the manifest).
    const storedFiles = [];
    for (const file of data.files) {
      const blobPath = `intake/${id}/files/${file.name}`;
      await put(blobPath, file.buffer, {
        access: "private", // private store — pipeline reads via RW token
        addRandomSuffix: false,
        contentType: file.type,
      });
      storedFiles.push({ name: file.name, type: file.type, size: file.size, blobPath });
    }

    const submission = {
      id,
      receivedAt: new Date().toISOString(),
      lang: normalizeLang(body.lang),
      email: data.email,
      phone: data.phone,
      title: data.title,
      description: data.description,
      references: data.references,
      colorScheme: data.colorScheme,
      clarifications: data.clarifications,
      files: storedFiles,
      meta: {
        ip,
        userAgent: sanitizeText(req.headers["user-agent"], 300) || "",
        turnstileVerified: turnstile.verified,
        powVerified,
      },
      status: "new",
    };

    await put(`intake/${id}/submission.json`, JSON.stringify(submission, null, 2), {
      access: "private",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    // Best-effort notifications — sendIntakeEmails never throws.
    const emailResult = await sendIntakeEmails({ submission });

    // Best-effort Forge ping with signed approve/skip links. notifyDiscord is
    // already non-throwing; the extra guard makes doubly sure a webhook outage
    // can never fail an otherwise-successful intake.
    try {
      await notifyDiscord(submission);
    } catch (err) {
      console.error(`[intake] Discord notify failed for ${id}:`, err?.message || err);
    }

    console.log(`[intake] stored ${id} (${storedFiles.length} files, email sent: ${emailResult.sent})`);
    sendJson(res, 200, { ok: true, id });
  } catch (err) {
    console.error("[intake] unexpected error:", err);
    sendJson(res, 500, { ok: false, code: "server", error: GENERIC_500 });
  }
}
