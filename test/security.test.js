/**
 * Unit tests for the pure helpers in api/_lib/security.js.
 *
 * These modules import only node:crypto, so no node_modules are needed to run
 * them — `node --test test/` works on a bare checkout.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  cleanString,
  isValidEmail,
  isValidPhone,
  isValidHttpUrl,
  isValidHexColor,
  sanitizeFilename,
  magicBytesOk,
  tokenMatches,
} from "../api/_lib/security.js";

describe("isValidEmail", () => {
  it("accepts a normal address", () => {
    assert.equal(isValidEmail("user@example.com"), true);
    assert.equal(isValidEmail("a.b+tag@sub.example.co"), true);
  });

  it("rejects malformed addresses", () => {
    assert.equal(isValidEmail("plainaddress"), false);
    assert.equal(isValidEmail("@example.com"), false);
    assert.equal(isValidEmail("user@@example.com"), false);
    assert.equal(isValidEmail("a@b.c"), false); // TLD must be >= 2 chars
    assert.equal(isValidEmail("with space@example.com"), false);
  });

  it("rejects non-strings", () => {
    assert.equal(isValidEmail(123), false);
    assert.equal(isValidEmail(null), false);
    assert.equal(isValidEmail(undefined), false);
  });

  it("rejects addresses longer than 254 chars", () => {
    const tooLong = "a".repeat(250) + "@example.com"; // 262 chars, otherwise well-formed
    assert.ok(tooLong.length > 254);
    assert.equal(isValidEmail(tooLong), false);
  });
});

describe("isValidPhone", () => {
  it("accepts a formatted international number", () => {
    assert.equal(isValidPhone("+1 (555) 123-4567"), true);
  });

  it("rejects digit-free input with the right charset", () => {
    assert.equal(isValidPhone("() () ()"), false);
  });

  it("rejects too-short numbers", () => {
    assert.equal(isValidPhone("12345"), false); // fails the {7,25} length gate
    assert.equal(isValidPhone("+1 234"), false); // charset ok but only 4 digits
  });

  it("rejects non-strings and out-of-charset input", () => {
    assert.equal(isValidPhone(5551234567), false);
    assert.equal(isValidPhone("555.123.4567"), false); // '.' not in the allowed charset
  });
});

describe("isValidHexColor", () => {
  it("accepts 6-digit hex with a leading #", () => {
    assert.equal(isValidHexColor("#aabbcc"), true);
    assert.equal(isValidHexColor("#FF00AA"), true);
  });

  it("rejects everything else", () => {
    assert.equal(isValidHexColor("#fff"), false); // 3-digit shorthand not allowed
    assert.equal(isValidHexColor("aabbcc"), false); // missing #
    assert.equal(isValidHexColor("#gggggg"), false); // non-hex chars
    assert.equal(isValidHexColor("#aabbccdd"), false); // too long
    assert.equal(isValidHexColor(0xaabbcc), false); // non-string
  });
});

describe("isValidHttpUrl", () => {
  it("accepts http and https", () => {
    assert.equal(isValidHttpUrl("http://example.com"), true);
    assert.equal(isValidHttpUrl("https://example.com/path?q=1"), true);
  });

  it("rejects other protocols", () => {
    assert.equal(isValidHttpUrl("ftp://example.com"), false);
    assert.equal(isValidHttpUrl("javascript:alert(1)"), false);
    assert.equal(isValidHttpUrl("not a url"), false);
  });

  it("rejects URLs longer than the max length", () => {
    const tooLong = "https://example.com/" + "a".repeat(600);
    assert.ok(tooLong.length > 500);
    assert.equal(isValidHttpUrl(tooLong), false);
  });

  it("rejects non-strings", () => {
    assert.equal(isValidHttpUrl(null), false);
  });
});

describe("cleanString", () => {
  it("strips control characters but keeps tab/newline/carriage-return", () => {
    assert.equal(cleanString("hello\x00\x01\x07world"), "helloworld");
    assert.equal(cleanString("a\tb\nc\rd"), "a\tb\nc\rd");
    assert.equal(cleanString("bell\x07"), "bell");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(cleanString("  spaced  "), "spaced");
  });

  it("returns null for non-strings", () => {
    assert.equal(cleanString(123), null);
    assert.equal(cleanString(null), null);
    assert.equal(cleanString(undefined), null);
    assert.equal(cleanString({}), null);
  });
});

describe("sanitizeFilename", () => {
  it("strips path traversal and directory components", () => {
    const out = sanitizeFilename("../../etc/report.pdf");
    assert.equal(out, "report.pdf");
    assert.ok(!out.includes("/"));
    assert.ok(!out.includes(".."));

    // Backslash separators are handled too.
    assert.equal(sanitizeFilename("..\\folder\\photo.png"), "photo.png");
  });

  it("keeps an allowed extension and preserves the base name", () => {
    assert.equal(sanitizeFilename("report.pdf"), "report.pdf");
    // Only the extension is lowercased for the allowlist check; the returned
    // base name keeps its original casing.
    assert.equal(sanitizeFilename("Photo.PNG"), "Photo.PNG");
  });

  it("rejects a disallowed extension", () => {
    assert.equal(sanitizeFilename("malware.exe"), null);
    assert.equal(sanitizeFilename("archive.zip"), null);
  });

  it("rejects a name with no extension", () => {
    assert.equal(sanitizeFilename("README"), null);
    assert.equal(sanitizeFilename("../../etc/passwd"), null);
  });

  it("rejects non-strings", () => {
    assert.equal(sanitizeFilename(123), null);
    assert.equal(sanitizeFilename(null), null);
  });
});

describe("magicBytesOk", () => {
  it("accepts a real PDF header and rejects the wrong bytes", () => {
    assert.equal(magicBytesOk("pdf", Buffer.from("%PDF-1.7\n")), true);
    assert.equal(magicBytesOk("pdf", Buffer.from("XXXX-not-a-pdf")), false);
    assert.equal(magicBytesOk("pdf", Buffer.from("%PD")), false); // too short
  });

  it("sniffs a PNG signature", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(magicBytesOk("png", png), true);
    assert.equal(magicBytesOk("png", Buffer.from("not a png")), false);
  });

  it("always passes signature-less text formats", () => {
    assert.equal(magicBytesOk("txt", Buffer.from("anything at all")), true);
    assert.equal(magicBytesOk("csv", Buffer.alloc(0)), true);
    assert.equal(magicBytesOk("md", Buffer.from("# heading")), true);
  });
});

describe("tokenMatches", () => {
  it("returns true for identical tokens", () => {
    assert.equal(tokenMatches("s3cret-token", "s3cret-token"), true);
  });

  it("returns false for differing tokens", () => {
    assert.equal(tokenMatches("s3cret-token", "wrong-token"), false);
    // Different lengths are handled (both sides are hashed to 32 bytes first).
    assert.equal(tokenMatches("short", "a-much-longer-token-value"), false);
  });
});
