/**
 * Unit tests for the intake money-path logic (api/intake.js): input validation,
 * the honeypot/time-gate bot filter, and the human-verification gate decision.
 *
 * These exercise the exported pure functions directly — the mutation trust
 * check previously flagged this handler as untested. Importing intake.js pulls
 * in its deps (installed via `npm install`), but nothing here hits the network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateSubmission,
  validateReferences,
  validateColorScheme,
  validateClarifications,
  validateFiles,
  isBot,
  humanCheckResult,
  newSubmissionId,
  normalizeLang,
} from "../api/intake.js";

function validBody(overrides = {}) {
  return {
    email: "jane@example.com",
    phone: "+1 (404) 555-0100",
    title: "Telemetry dashboard",
    description: "We need a telemetry dashboard for our ground-station network.",
    ...overrides,
  };
}

describe("validateSubmission", () => {
  it("accepts a well-formed brief", () => {
    const r = validateSubmission(validBody());
    assert.equal(r.error, undefined);
    assert.equal(r.value.email, "jane@example.com");
    assert.equal(r.value.title, "Telemetry dashboard");
  });

  it("rejects a bad email", () => {
    assert.match(validateSubmission(validBody({ email: "nope" })).error, /email/i);
  });

  it("rejects a bad phone", () => {
    assert.match(validateSubmission(validBody({ phone: "abc" })).error, /phone/i);
  });

  it("rejects a too-short title", () => {
    assert.match(validateSubmission(validBody({ title: "ab" })).error, /title/i);
  });

  it("rejects a too-short description", () => {
    assert.match(validateSubmission(validBody({ description: "short" })).error, /description/i);
  });

  it("rejects too many references", () => {
    const refs = Array.from({ length: 6 }, () => ({ url: "https://example.com" }));
    assert.ok(validateSubmission(validBody({ references: refs })).error);
  });

  it("rejects a non-http reference url", () => {
    assert.ok(validateSubmission(validBody({ references: [{ url: "javascript:alert(1)" }] })).error);
  });

  it("rejects an invalid colour mode", () => {
    assert.ok(validateSubmission(validBody({ colorScheme: { mode: "rainbow" } })).error);
  });

  it("rejects a non-hex colour", () => {
    assert.ok(validateSubmission(validBody({ colorScheme: { mode: "dark", colors: ["red"] } })).error);
  });
});

describe("validateReferences / validateColorScheme / validateClarifications", () => {
  it("treats missing references/colours/clarifications as empty", () => {
    assert.deepEqual(validateReferences(undefined), { value: [] });
    assert.deepEqual(validateColorScheme(null), { value: null });
    assert.deepEqual(validateClarifications(undefined), { value: [] });
  });

  it("keeps a valid clarification pair", () => {
    const r = validateClarifications([{ question: "Who is the user?", answer: "Ops team" }]);
    assert.equal(r.value.length, 1);
    assert.equal(r.value[0].answer, "Ops team");
  });

  it("rejects an over-long clarification answer", () => {
    assert.ok(validateClarifications([{ question: "Q", answer: "x".repeat(2001) }]).error);
  });

  it("rejects more than 8 clarifications", () => {
    assert.ok(validateClarifications(Array.from({ length: 9 }, () => ({ question: "Q", answer: "A" }))).error);
  });
});

describe("validateFiles", () => {
  const PDF = Buffer.from("%PDF-1.4 hello world").toString("base64");

  it("accepts a valid pdf", () => {
    const r = validateFiles([{ name: "brief.pdf", data: PDF }]);
    assert.equal(r.error, undefined);
    assert.equal(r.value[0].name, "brief.pdf");
  });

  it("rejects a disallowed extension", () => {
    assert.ok(validateFiles([{ name: "payload.exe", data: PDF }]).error);
  });

  it("rejects a file whose magic bytes don't match its extension", () => {
    const notPdf = Buffer.from("this is plain text, not a pdf").toString("base64");
    assert.ok(validateFiles([{ name: "fake.pdf", data: notPdf }]).error);
  });

  it("rejects invalid base64", () => {
    assert.ok(validateFiles([{ name: "x.pdf", data: "@@@not-base64@@@" }]).error);
  });

  it("rejects more than 3 files", () => {
    assert.ok(validateFiles(Array.from({ length: 4 }, () => ({ name: "a.pdf", data: PDF }))).error);
  });
});

describe("isBot", () => {
  const old = Date.now() - 10_000;

  it("passes a real submission (empty honeypot, old startedAt)", () => {
    assert.equal(isBot({ website: "", startedAt: old }), false);
  });

  it("flags a filled honeypot", () => {
    assert.equal(isBot({ website: "http://spam", startedAt: old }), true);
  });

  it("flags a non-string honeypot value a bot might send", () => {
    assert.equal(isBot({ website: 0, startedAt: old }), true);
  });

  it("flags a missing timestamp", () => {
    assert.equal(isBot({ website: "" }), true);
  });

  it("flags a sub-3s submission", () => {
    assert.equal(isBot({ website: "", startedAt: Date.now() - 100 }), true);
  });
});

describe("humanCheckResult", () => {
  it("accepts a verified Turnstile and marks pow false", () => {
    assert.deepEqual(
      humanCheckResult({ required: true, verified: true }, { verified: false }),
      { ok: true, powVerified: false }
    );
  });

  it("rejects a failed Turnstile", () => {
    assert.deepEqual(
      humanCheckResult({ required: true, verified: false }, { verified: false }),
      { ok: false, code: "turnstile" }
    );
  });

  it("REQUIRES a solved captcha when Turnstile is not configured", () => {
    assert.deepEqual(
      humanCheckResult({ required: false, verified: false }, { verified: false }),
      { ok: false, code: "captcha" }
    );
  });

  it("accepts a solved captcha and marks pow true", () => {
    assert.deepEqual(
      humanCheckResult({ required: false, verified: false }, { verified: true }),
      { ok: true, powVerified: true }
    );
  });
});

describe("newSubmissionId", () => {
  it("matches the documented shape and is unique across calls", () => {
    const a = newSubmissionId();
    const b = newSubmissionId();
    assert.match(a, /^int_[a-z0-9]+_[a-z0-9]{6}$/);
    assert.notEqual(a, b);
  });
});

describe("normalizeLang", () => {
  it("passes through supported languages", () => {
    for (const l of ["en", "ar", "fr"]) assert.equal(normalizeLang(l), l);
  });

  it("defaults anything else to en", () => {
    assert.equal(normalizeLang("de"), "en");
    assert.equal(normalizeLang(undefined), "en");
    assert.equal(normalizeLang("<script>"), "en");
  });
});
