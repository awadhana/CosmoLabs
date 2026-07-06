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

function secret() {
  return (
    process.env.CAPTCHA_SECRET ||
    process.env.INTAKE_ADMIN_TOKEN ||
    "cosmolabs-captcha-dev-only" // local dev fallback — never rely on in prod
  );
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
