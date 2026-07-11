/**
 * Integration test for the POST /api/intake handler — the money path — with
 * blob storage and email mocked out. This exercises the wiring the pure-unit
 * tests can't reach: the captcha gate is actually enforced end-to-end, and the
 * honeypot silently drops without storing. This is the exact regression guard
 * that would have caught the mutation-trust failure (captcha gate flipped off).
 *
 * Requires Node's module mocking — the npm test script passes
 * --experimental-test-module-mocks. If that flag is absent the whole file
 * skips rather than failing a bare `node --test` run.
 */

import { test, describe, mock, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// Deterministic environment: no Turnstile (→ PoW captcha required), no real
// captcha secret and not production (→ captcha signs with the dev constant, so
// the test can mint and solve a valid challenge). Read at call time, so setting
// these before invoking the handler is enough.
delete process.env.TURNSTILE_SECRET_KEY;
delete process.env.CAPTCHA_SECRET;
delete process.env.INTAKE_ADMIN_TOKEN;
delete process.env.VERCEL_ENV;
process.env.NODE_ENV = "test";

const moduleMockingAvailable = typeof mock.module === "function";

function solvePow(ch) {
  for (let n = 0; n <= ch.maxnumber; n++) {
    if (crypto.createHash("sha256").update(`${ch.salt}.${n}`).digest("hex") === ch.challenge) return n;
  }
  return null;
}

function makeReq(body, ip) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://x.test",
      host: "x.test",
      "x-real-ip": ip,
    },
    body,
    socket: {},
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(s) { this.body = s; },
  };
}

function baseBrief(over = {}) {
  return {
    email: "jane@example.com",
    phone: "+1 (404) 555-0100",
    title: "Telemetry dashboard",
    description: "We need a telemetry dashboard for our ground-station network.",
    website: "",
    startedAt: Date.now() - 10_000,
    lang: "en",
    ...over,
  };
}

describe("POST /api/intake handler", { skip: moduleMockingAvailable ? false : "module mocking not enabled" }, () => {
  let handler, createChallenge, putCalls;

  before(async () => {
    putCalls = [];
    mock.module("@vercel/blob", {
      namedExports: { put: async (path) => { putCalls.push(path); return { url: `blob://${path}` }; } },
    });
    mock.module("../api/_lib/email.js", {
      namedExports: { sendIntakeEmails: async () => ({ sent: true }) },
    });
    handler = (await import("../api/intake.js")).default;
    createChallenge = (await import("../api/_lib/captcha.js")).createChallenge;
  });

  test("stores a valid brief with a solved captcha and returns ok", async () => {
    const ip = "1.2.3.4";
    const ch = createChallenge(ip);
    const number = solvePow(ch);
    const captcha = { challenge: ch.challenge, salt: ch.salt, number, signature: ch.signature };

    const res = makeRes();
    await handler(makeReq(baseBrief({ captcha }), ip), res);

    assert.equal(res.statusCode, 200);
    const d = JSON.parse(res.body);
    assert.equal(d.ok, true);
    assert.match(d.id, /^int_[a-z0-9]+_[a-z0-9]{6}$/);
    assert.ok(putCalls.some((p) => p.endsWith("submission.json")), "submission.json should be stored");
  });

  test("rejects a submission with NO captcha (code:captcha) and stores nothing", async () => {
    const before = putCalls.length;
    const res = makeRes();
    await handler(makeReq(baseBrief(), "1.2.3.5"), res);

    assert.equal(res.statusCode, 400);
    const d = JSON.parse(res.body);
    assert.equal(d.code, "captcha");
    assert.equal(putCalls.length, before, "nothing should be stored when the captcha gate rejects");
  });

  test("silently drops a bot (honeypot filled) without storing", async () => {
    const before = putCalls.length;
    const res = makeRes();
    await handler(makeReq(baseBrief({ website: "http://spam.example" }), "1.2.3.6"), res);

    assert.equal(res.statusCode, 200);
    const d = JSON.parse(res.body);
    assert.equal(d.id, "int_0");
    assert.equal(putCalls.length, before, "a honeypot hit must not be stored");
  });

  test("rejects an invalid brief with code:validation before any storage", async () => {
    const before = putCalls.length;
    const res = makeRes();
    await handler(makeReq(baseBrief({ email: "not-an-email" }), "1.2.3.7"), res);

    assert.equal(res.statusCode, 400);
    const d = JSON.parse(res.body);
    assert.equal(d.code, "validation");
    assert.equal(putCalls.length, before);
  });
});
