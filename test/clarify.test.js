/**
 * Unit tests for the pure helpers in api/clarify.js: brief construction, model
 * output sanitization, the language instruction, and the abuse gate (honeypot +
 * time-gate) that keeps the paid model call from being billed for bots.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildBrief, sanitizeQuestions, langInstruction, looksAutomated } from "../api/clarify.js";

describe("buildBrief", () => {
  it("includes the title and description", () => {
    const b = buildBrief({ title: "Site", description: "Build a site." });
    assert.match(b, /Title: Site/);
    assert.match(b, /Build a site\./);
  });

  it("drops non-http reference urls but keeps valid ones", () => {
    const b = buildBrief({
      title: "T",
      description: "D",
      references: [{ url: "javascript:alert(1)" }, { url: "https://ok.example.com" }],
    });
    assert.doesNotMatch(b, /javascript:/);
    assert.match(b, /https:\/\/ok\.example\.com/);
  });

  it("truncates an over-long description to 5000 chars", () => {
    const b = buildBrief({ title: "T", description: "x".repeat(6000) });
    assert.equal((b.match(/x/g) || []).length, 5000);
  });

  it("renders a colour scheme when present", () => {
    const b = buildBrief({ title: "T", description: "D", colorScheme: { mode: "dark", colors: ["#112233"] } });
    assert.match(b, /Color scheme:/);
    assert.match(b, /#112233/);
  });
});

describe("sanitizeQuestions", () => {
  it("caps at 4 and drops empty questions", () => {
    const parsed = {
      ready: false,
      questions: [
        { id: "a", question: "Q1" },
        { id: "b", question: "   " },
        { question: "Q3" },
        { question: "Q4" },
        { question: "Q5" },
        { question: "Q6" },
      ],
    };
    const r = sanitizeQuestions(parsed);
    assert.equal(r.ready, false);
    assert.ok(r.questions.length <= 4);
    assert.ok(r.questions.every((q) => q.question.length > 0));
  });

  it("honours ready:true", () => {
    assert.equal(sanitizeQuestions({ ready: true, questions: [] }).ready, true);
  });

  it("tolerates a malformed payload", () => {
    assert.deepEqual(sanitizeQuestions(null), { ready: false, questions: [] });
    assert.deepEqual(sanitizeQuestions({}), { ready: false, questions: [] });
  });
});

describe("langInstruction", () => {
  it("names the target language for supported locales", () => {
    assert.match(langInstruction("ar"), /Arabic/);
    assert.match(langInstruction("fr"), /French/);
    assert.match(langInstruction("en"), /English/);
  });

  it("is empty for unknown locales", () => {
    assert.equal(langInstruction("de"), "");
    assert.equal(langInstruction(undefined), "");
  });
});

describe("looksAutomated (clarify abuse gate)", () => {
  const old = Date.now() - 10_000;

  it("passes a real request", () => {
    assert.equal(looksAutomated({ website: "", startedAt: old }), false);
  });

  it("flags a filled honeypot", () => {
    assert.equal(looksAutomated({ website: "x", startedAt: old }), true);
  });

  it("flags a missing or too-recent timestamp", () => {
    assert.equal(looksAutomated({ website: "" }), true);
    assert.equal(looksAutomated({ website: "", startedAt: Date.now() }), true);
  });
});
