/**
 * Trilingual integrity tests for index.html — no dependencies, pure string
 * parsing. Guards CUJ1 (browse in EN/AR/FR): the three dictionaries must carry
 * exactly the same keys, and every static data-i18n* attribute in the markup
 * must resolve to a real EN dictionary entry (t() otherwise falls back to the
 * raw key and leaks a key name into the UI).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function blockBounds() {
  // Anchor inside `var I18N = { ... }` — there is an earlier `var LANG_META`
  // whose `en: {` / `ar: {` / `fr: {` blocks must not be mistaken for the dicts.
  const i18nStart = src.indexOf("var I18N = {");
  assert.ok(i18nStart >= 0, "could not locate the I18N object");
  const enIdx = src.indexOf("en: {", i18nStart);
  const arIdx = src.indexOf("ar: {", enIdx);
  const frIdx = src.indexOf("fr: {", arIdx);
  const endIdx = src.indexOf("\n      };", frIdx);
  assert.ok(enIdx >= 0 && arIdx > enIdx && frIdx > arIdx && endIdx > frIdx, "could not locate the three i18n dict blocks");
  return {
    en: src.slice(enIdx, arIdx),
    ar: src.slice(arIdx, frIdx),
    fr: src.slice(frIdx, endIdx),
  };
}

function keysOf(block) {
  const re = /^\s+"([\w.]+)"\s*:/gm;
  const set = new Set();
  let m;
  while ((m = re.exec(block))) set.add(m[1]);
  return set;
}

const blocks = blockBounds();
const en = keysOf(blocks.en);
const ar = keysOf(blocks.ar);
const fr = keysOf(blocks.fr);

describe("i18n dictionary parity", () => {
  it("has a non-trivial EN dictionary", () => {
    assert.ok(en.size > 100, `expected a populated EN dict, got ${en.size} keys`);
  });

  it("AR has exactly the same keys as EN", () => {
    const missing = [...en].filter((k) => !ar.has(k));
    const extra = [...ar].filter((k) => !en.has(k));
    assert.deepEqual(missing, [], `AR is missing keys: ${missing.join(", ")}`);
    assert.deepEqual(extra, [], `AR has extra keys: ${extra.join(", ")}`);
  });

  it("FR has exactly the same keys as EN", () => {
    const missing = [...en].filter((k) => !fr.has(k));
    const extra = [...fr].filter((k) => !en.has(k));
    assert.deepEqual(missing, [], `FR is missing keys: ${missing.join(", ")}`);
    assert.deepEqual(extra, [], `FR has extra keys: ${extra.join(", ")}`);
  });
});

describe("i18n markup coverage", () => {
  it("every static data-i18n* attribute resolves to an EN key", () => {
    const attrRe = /\bdata-i18n(?:-html|-ph|-aria)?="([^"]+)"/g;
    const used = new Set();
    let m;
    while ((m = attrRe.exec(src))) used.add(m[1]);
    assert.ok(used.size > 20, `expected many i18n-bound elements, found ${used.size}`);
    const missing = [...used].filter((k) => !en.has(k));
    assert.deepEqual(missing, [], `markup binds i18n keys absent from the EN dict: ${missing.join(", ")}`);
  });
});
