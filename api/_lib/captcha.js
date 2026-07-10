/**
 * Self-hosted proof-of-work captcha — the "I'm not a robot" check on the
 * intake wizard's review step, used whenever Cloudflare Turnstile is not
 * configured (no third-party account or keys needed).
 *
 * Stateless by design: every challenge is HMAC-signed with the server secret,
 * so verification needs no storage — a fit for serverless. A valid solution
 * proves the client spent CPU on ~30k SHA-256 hashes per submission, which,
 * layered on the existing honeypot, 3s time gate and per-IP rate limit,
 * prices out bulk spam bots.
 *
 * Shape:
 *   challenge = sha256(`${salt}.${secretNumber}`)          — hex
 *   salt      = `${expiresEpochSec}.${ipHash12}.${rand16}` — binds TTL + IP
 *   signature = hmacSha256(secret, `${challenge}.${salt}`) — hex
 * The client brute-forces secretNumber in [0, maxnumber] and sends
 * { challenge, salt, number, signature } inside the /api/intake payload.
 *
 * Known limits: a solution can be replayed from the same IP until the salt
 * expires (15 min) — the per-IP intake rate limit (8/10 min) bounds the blast
 * radius, and IP binding stops solved challenges from being farmed out.
 */

import crypto from "node:crypto";

export const CAPTCHA_MAX_NUMBER = 60_000; // avg ~30k hashes ≈ 1-2s in-browser
const TTL_SECONDS = 15 * 60;

function isProduction() {
  return process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
}

/**
 * True when a real signing secret is available, OR when we're not in
 * production (where the dev-constant fallback is acceptable). Call sites use
 * this to fail CLOSED — refusing to issue/accept forgeable challenges signed
 * with the hardcoded dev constant on a production deployment.
 */
export function isCaptchaSecretConfigured() {
  return Boolean(process.env.CAPTCHA_SECRET || process.env.INTAKE_ADMIN_TOKEN) || !isProduction();
}

function secret() {
  const configured = process.env.CAPTCHA_SECRET || process.env.INTAKE_ADMIN_TOKEN;
  if (configured) return configured;
  // Local dev fallback only — never sign with the dev constant in production.
  // Guarded by isCaptchaSecretConfigured() at every call site, so this throw
  // is an unreachable backstop rather than a request-crashing path.
  if (isProduction()) throw new Error("CAPTCHA secret is not configured");
  return "cosmolabs-captcha-dev-only";
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmacHex(value) {
  return crypto.createHmac("sha256", secret()).update(value).digest("hex");
}

function ipHash(ip) {
  return sha256Hex(`${secret()}|ip|${ip}`).slice(0, 12);
}

export function createChallenge(ip) {
  const expires = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const salt = `${expires}.${ipHash(ip)}.${crypto.randomBytes(8).toString("hex")}`;
  const secretNumber = crypto.randomInt(0, CAPTCHA_MAX_NUMBER + 1);
  const challenge = sha256Hex(`${salt}.${secretNumber}`);
  return {
    algorithm: "SHA-256",
    challenge,
    salt,
    maxnumber: CAPTCHA_MAX_NUMBER,
    signature: hmacHex(`${challenge}.${salt}`),
  };
}

const HEX64_RE = /^[0-9a-f]{64}$/;
const SALT_RE = /^\d{1,12}\.[0-9a-f]{12}\.[0-9a-f]{16}$/;

/**
 * @returns {{verified: boolean, reason: string}} — reason is for server logs
 * only; never sent to the client.
 */
export function verifyCaptcha(raw, ip) {
  // Fail closed in production without a real secret: never accept a challenge
  // that could only have been signed with the dev constant. /api/intake turns
  // this into its normal 400 captcha error, not a 500.
  if (!isCaptchaSecretConfigured()) return { verified: false, reason: "captcha secret not configured" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { verified: false, reason: "missing" };
  const { challenge, salt, number, signature } = raw;
  if (typeof challenge !== "string" || !HEX64_RE.test(challenge)) return { verified: false, reason: "bad challenge" };
  if (typeof salt !== "string" || !SALT_RE.test(salt)) return { verified: false, reason: "bad salt" };
  if (typeof signature !== "string" || !HEX64_RE.test(signature)) return { verified: false, reason: "bad signature" };
  if (!Number.isInteger(number) || number < 0 || number > CAPTCHA_MAX_NUMBER) return { verified: false, reason: "bad number" };

  // Signature first: everything after this line trusts salt/challenge as ours.
  const expected = Buffer.from(hmacHex(`${challenge}.${salt}`), "hex");
  const given = Buffer.from(signature, "hex");
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { verified: false, reason: "signature mismatch" };
  }

  const [expiresStr, boundIpHash] = salt.split(".");
  if (Number(expiresStr) < Math.floor(Date.now() / 1000)) return { verified: false, reason: "expired" };
  if (boundIpHash !== ipHash(ip)) return { verified: false, reason: "ip mismatch" };
  if (sha256Hex(`${salt}.${number}`) !== challenge) return { verified: false, reason: "wrong solution" };

  return { verified: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// Forge pipeline signed-link HMAC.
//
// Separate concern from the captcha above: the Forge pipeline signs the
// approve / skip / promote links embedded in Discord messages so a plain URL
// click can safely mutate submission.json. These use the Forge-wide
// HMAC_SECRET (shared with the Actions runner), NOT the captcha secret() — the
// captcha's secret handling is deliberately left untouched.

function pipelineSecret() {
  const configured = process.env.HMAC_SECRET;
  if (configured) return configured;
  // Non-production fallback only — mirrors the captcha dev fallback so local
  // dev works without secrets. Never sign with a fallback in production.
  if (isProduction()) throw new Error("HMAC_SECRET is not configured");
  return process.env.INTAKE_ADMIN_TOKEN || "cosmolabs-forge-dev-only";
}

/** Generic Forge signer: HMAC-SHA256(HMAC_SECRET, payload) as hex. */
export function signHmac(payload) {
  return crypto.createHmac("sha256", pipelineSecret()).update(String(payload)).digest("hex");
}

const PIPELINE_ACTIONS = new Set(["approve", "skip", "promote"]);

/**
 * Sign a pipeline action token.
 * sig = HMAC-SHA256(HMAC_SECRET, `${action}.${id}.${exp}`) — see buildActionUrl
 * in _lib/pipeline.js for the URL shape and per-action TTLs.
 */
export function signPipelineToken(action, id, exp) {
  return signHmac(`${action}.${id}.${exp}`);
}

/**
 * Verify a signed action link. Checks the HMAC in constant time AND that the
 * link has not expired (exp >= now). Returns a boolean; callers render a single
 * generic "invalid or expired" page for every failure so nothing is leaked.
 */
export function verifyPipelineToken(action, id, exp, sig) {
  if (!PIPELINE_ACTIONS.has(action)) return false;
  if (typeof id !== "string" || id.length === 0 || id.length > 128) return false;
  if (typeof sig !== "string" || !HEX64_RE.test(sig)) return false;
  const expNum = Number(exp);
  if (!Number.isInteger(expNum) || expNum <= 0) return false;

  // Sign the exp value exactly as received so the string form matches the
  // signer's (both stringify the same integer).
  const expected = Buffer.from(signPipelineToken(action, id, exp), "hex");
  const given = Buffer.from(sig, "hex");
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;

  return expNum >= Math.floor(Date.now() / 1000);
}
