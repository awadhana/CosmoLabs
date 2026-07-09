/**
 * Full round-trip tests for the self-hosted proof-of-work captcha.
 *
 * A fixed secret MUST be set BEFORE importing captcha.js: the module reads
 * CAPTCHA_SECRET when it signs/verifies, and pinning it makes the HMAC (and
 * therefore this whole test) deterministic and independent of the environment.
 */

process.env.CAPTCHA_SECRET = "test-secret-fixed";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  createChallenge,
  verifyCaptcha,
  CAPTCHA_MAX_NUMBER,
} from "../api/_lib/captcha.js";

// Hash exactly the way captcha.js does, so we can brute-force the solution.
function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Recover the secret number by searching [0, CAPTCHA_MAX_NUMBER] — the same
// work a browser client does. Averages ~30k hashes; a few ms in practice.
function solve(challenge) {
  for (let n = 0; n <= CAPTCHA_MAX_NUMBER; n++) {
    if (sha256Hex(`${challenge.salt}.${n}`) === challenge.challenge) return n;
  }
  return -1;
}

describe("captcha round-trip", () => {
  const ip = "203.0.113.7";

  it("verifies a correctly solved challenge", () => {
    const challenge = createChallenge(ip);
    const number = solve(challenge);
    assert.notEqual(number, -1, "brute force should find the secret number");

    const result = verifyCaptcha(
      {
        challenge: challenge.challenge,
        salt: challenge.salt,
        number,
        signature: challenge.signature,
      },
      ip,
    );
    assert.equal(result.verified, true);
  });

  it("rejects a tampered signature", () => {
    const challenge = createChallenge(ip);
    const number = solve(challenge);
    // Flip the first hex nibble so it stays 64 lowercase hex chars but is wrong.
    const flipped = (challenge.signature[0] === "a" ? "b" : "a") + challenge.signature.slice(1);

    const result = verifyCaptcha(
      { challenge: challenge.challenge, salt: challenge.salt, number, signature: flipped },
      ip,
    );
    assert.equal(result.verified, false);
  });

  it("rejects verification from a different IP", () => {
    const challenge = createChallenge(ip);
    const number = solve(challenge);

    const result = verifyCaptcha(
      {
        challenge: challenge.challenge,
        salt: challenge.salt,
        number,
        signature: challenge.signature,
      },
      "198.51.100.42", // different IP than the salt was bound to
    );
    assert.equal(result.verified, false);
  });

  it("rejects an out-of-range or non-integer number", () => {
    const challenge = createChallenge(ip);
    const base = {
      challenge: challenge.challenge,
      salt: challenge.salt,
      signature: challenge.signature,
    };
    assert.equal(verifyCaptcha({ ...base, number: CAPTCHA_MAX_NUMBER + 1 }, ip).verified, false);
    assert.equal(verifyCaptcha({ ...base, number: -1 }, ip).verified, false);
    assert.equal(verifyCaptcha({ ...base, number: 1.5 }, ip).verified, false);
    assert.equal(verifyCaptcha({ ...base, number: "10" }, ip).verified, false);
  });

  it("rejects a malformed salt", () => {
    const challenge = createChallenge(ip);
    const number = solve(challenge);
    const result = verifyCaptcha(
      {
        challenge: challenge.challenge,
        salt: "not-a-valid-salt",
        number,
        signature: challenge.signature,
      },
      ip,
    );
    assert.equal(result.verified, false);
  });

  it("rejects a missing or non-object payload", () => {
    assert.equal(verifyCaptcha(null, ip).verified, false);
    assert.equal(verifyCaptcha("nope", ip).verified, false);
    assert.equal(verifyCaptcha([], ip).verified, false);
  });
});
