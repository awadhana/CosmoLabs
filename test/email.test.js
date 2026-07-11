/**
 * Unit tests for api/_lib/email.js: HTML-escaping (injection defense) and the
 * localized customer confirmation. Attacker-controlled fields (title,
 * description, filenames, clarifications) are interpolated into email HTML, so
 * escaping must hold; the confirmation must follow the submitter's language.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  escapeHtml,
  nl2br,
  customerHtml,
  internalHtml,
  confirmCopy,
  CONFIRM_COPY,
} from "../api/_lib/email.js";

function sub(over = {}) {
  return {
    id: "int_test_abcdef",
    lang: "en",
    receivedAt: "2026-07-11T00:00:00.000Z",
    title: "My project",
    description: "Line one.\nLine two.",
    email: "jane@example.com",
    phone: "+1 555 0100",
    references: [],
    clarifications: [],
    files: [],
    meta: { ip: "203.0.113.7" },
    ...over,
  };
}

describe("escapeHtml", () => {
  it("escapes HTML-significant characters", () => {
    assert.equal(escapeHtml(`<b>&"'`), "&lt;b&gt;&amp;&quot;&#39;");
  });

  it("stringifies nullish input", () => {
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(undefined), "");
  });
});

describe("nl2br", () => {
  it("escapes first, then converts newlines to <br>", () => {
    assert.equal(nl2br("a\n<b>"), "a<br>&lt;b&gt;");
  });
});

describe("confirmCopy", () => {
  it("returns per-locale copy with the right direction", () => {
    assert.equal(confirmCopy("fr").dir, "ltr");
    assert.equal(confirmCopy("ar").dir, "rtl");
    assert.ok(confirmCopy("ar").subject.length > 0);
    assert.ok(confirmCopy("fr").subject.length > 0);
  });

  it("falls back to English for unknown or missing locales", () => {
    assert.equal(confirmCopy("de"), CONFIRM_COPY.en);
    assert.equal(confirmCopy(undefined), CONFIRM_COPY.en);
  });
});

describe("customerHtml", () => {
  it("renders in the submission's language (Arabic → RTL)", () => {
    const html = customerHtml(sub({ lang: "ar" }));
    assert.match(html, /dir="rtl"/);
    assert.match(html, /استلمنا/); // Arabic heading
    assert.match(html, /int_test_abcdef/);
  });

  it("renders French copy for a French submission", () => {
    const html = customerHtml(sub({ lang: "fr" }));
    assert.match(html, /brief de projet/);
  });

  it("escapes a malicious title — no HTML injection", () => {
    const html = customerHtml(sub({ title: "<script>alert(1)</script>" }));
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  });
});

describe("internalHtml", () => {
  it("escapes attacker-controlled title and description", () => {
    const html = internalHtml(sub({ title: "<img src=x onerror=alert(1)>", description: "<b>x</b>" }));
    assert.doesNotMatch(html, /<img src=x onerror/);
    assert.doesNotMatch(html, /<b>x<\/b>/);
    assert.match(html, /&lt;img src=x onerror/);
  });

  it("escapes a malicious filename", () => {
    const html = internalHtml(sub({ files: [{ name: "<b>evil</b>.pdf", type: "application/pdf", size: 10 }] }));
    assert.doesNotMatch(html, /<b>evil<\/b>/);
  });
});
