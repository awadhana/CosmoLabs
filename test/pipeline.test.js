/**
 * Unit tests for the Forge pipeline (Lane A) — the pure crypto and status
 * logic in api/_lib/captcha.js (signed action tokens) and api/_lib/pipeline.js
 * (status lifecycle + signed link builder).
 *
 * A fixed HMAC_SECRET MUST be set BEFORE the modules are imported: captcha.js
 * signs/verifies pipeline tokens with HMAC_SECRET, so pinning it makes the HMAC
 * (and therefore this whole test) deterministic and environment-independent.
 *
 * pipeline.js statically imports "@vercel/blob", which is not installed in a
 * bare checkout (the existing tests run with no node_modules). None of the code
 * under test touches Blob — but the top-level import would still crash module
 * load. So a tiny ESM loader hook stubs "@vercel/blob" with a no-op module
 * before pipeline.js is dynamically imported. We never call the Blob-backed
 * functions (readSubmission / writeSubmissionStatus) — only the pure helpers.
 */

process.env.HMAC_SECRET = "forge-test-secret";
process.env.PUBLIC_BASE_URL = "https://cosmolabs.example";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// Intercept the bare "@vercel/blob" specifier and hand back a no-op stub, so
// pipeline.js can be imported without the package (or the network) present.
const blobStub = "data:text/javascript,export const head=()=>{};export const put=()=>{};";
const loaderHook =
  "data:text/javascript," +
  encodeURIComponent(
    `export async function resolve(specifier, context, next) {
       if (specifier === "@vercel/blob") {
         return { url: ${JSON.stringify(blobStub)}, shortCircuit: true };
       }
       return next(specifier, context);
     }`,
  );
register(loaderHook, import.meta.url);

// captcha.js only imports node:crypto; pipeline.js needs the stub above — both
// read HMAC_SECRET/PUBLIC_BASE_URL lazily at call time, so a dynamic import
// after the env is set (and the loader registered) sees the pinned values.
const { signPipelineToken, verifyPipelineToken } = await import("../api/_lib/captcha.js");
const {
  STATUS,
  VALID_TRANSITIONS,
  canTransition,
  assertTransition,
  buildActionUrl,
} = await import("../api/_lib/pipeline.js");

const HEX64_RE = /^[0-9a-f]{64}$/;
const nowSec = () => Math.floor(Date.now() / 1000);

describe("signPipelineToken / verifyPipelineToken", () => {
  const id = "brief-abc123";

  it("signs a 64-char lowercase-hex token", () => {
    const sig = signPipelineToken("approve", id, nowSec() + 3600);
    assert.match(sig, HEX64_RE);
  });

  it("round-trips: a freshly signed token verifies", () => {
    const exp = nowSec() + 3600;
    const sig = signPipelineToken("approve", id, exp);
    assert.equal(verifyPipelineToken("approve", id, exp, sig), true);
  });

  it("rejects a tampered signature", () => {
    const exp = nowSec() + 3600;
    const sig = signPipelineToken("approve", id, exp);
    // Flip the first hex nibble so it stays 64 lowercase hex chars but is wrong.
    const flipped = (sig[0] === "a" ? "b" : "a") + sig.slice(1);
    assert.equal(verifyPipelineToken("approve", id, exp, flipped), false);
  });

  it("rejects a token verified under a different action", () => {
    const exp = nowSec() + 3600;
    const sig = signPipelineToken("approve", id, exp);
    // "promote" is a valid action, so this exercises the HMAC mismatch (not the
    // unknown-action short-circuit): the payload "promote.<id>.<exp>" differs.
    assert.equal(verifyPipelineToken("promote", id, exp, sig), false);
  });

  it("rejects an unknown action outright", () => {
    const exp = nowSec() + 3600;
    const sig = signPipelineToken("approve", id, exp);
    assert.equal(verifyPipelineToken("delete", id, exp, sig), false);
  });

  it("rejects an expired token (exp < now) even with a valid signature", () => {
    const exp = nowSec() - 100; // already in the past
    const sig = signPipelineToken("skip", id, exp);
    assert.equal(verifyPipelineToken("skip", id, exp, sig), false);
  });

  it("rejects a token verified against a different id", () => {
    const exp = nowSec() + 3600;
    const sig = signPipelineToken("approve", "brief-A", exp);
    assert.equal(verifyPipelineToken("approve", "brief-B", exp, sig), false);
  });

  it("rejects a malformed signature", () => {
    const exp = nowSec() + 3600;
    assert.equal(verifyPipelineToken("approve", id, exp, "not-hex"), false);
    assert.equal(verifyPipelineToken("approve", id, exp, ""), false);
  });
});

describe("status transition guard (VALID_TRANSITIONS / assertTransition)", () => {
  it("allows new -> approved", () => {
    assert.equal(canTransition("new", "approved"), true);
    assert.equal(assertTransition("new", "approved"), true);
  });

  it("allows building -> preview", () => {
    assert.equal(canTransition("building", "preview"), true);
    assert.equal(assertTransition("building", "preview"), true);
  });

  it("allows preview -> done", () => {
    assert.equal(canTransition("preview", "done"), true);
    assert.equal(assertTransition("preview", "done"), true);
  });

  it("rejects done -> building (terminal state has no outgoing edges)", () => {
    assert.equal(canTransition("done", "building"), false);
    assert.throws(() => assertTransition("done", "building"), /Invalid Forge status transition/);
  });

  it("rejects new -> done (skips the pipeline)", () => {
    assert.equal(canTransition("new", "done"), false);
    assert.throws(() => assertTransition("new", "done"), /Invalid Forge status transition/);
  });

  it("keeps STATUS constants and VALID_TRANSITIONS keys in agreement", () => {
    // Every lifecycle state named in STATUS has an entry in VALID_TRANSITIONS,
    // and terminal states carry no outgoing edges.
    for (const state of Object.values(STATUS)) {
      assert.ok(Array.isArray(VALID_TRANSITIONS[state]), `${state} should have a transition list`);
    }
    assert.deepEqual(VALID_TRANSITIONS.done, []);
    assert.deepEqual(VALID_TRANSITIONS.dropped, []);
    assert.deepEqual(VALID_TRANSITIONS.build_failed, []);
  });
});

describe("buildActionUrl", () => {
  const id = "brief-xyz789";

  it("embeds id, a positive integer exp, and a 64-hex sig, and the token verifies", () => {
    const url = buildActionUrl("approve", id);
    const parsed = new URL(url);

    assert.equal(parsed.pathname, "/api/pipeline/approve");
    assert.equal(parsed.searchParams.get("id"), id);

    const exp = parsed.searchParams.get("exp");
    const sig = parsed.searchParams.get("sig");
    assert.match(sig, HEX64_RE);
    assert.match(exp, /^\d+$/);
    assert.ok(Number(exp) > nowSec(), "exp should be in the future");

    // The signature carried in the URL must verify under the same action/id/exp.
    assert.equal(verifyPipelineToken("approve", id, exp, sig), true);
  });

  it("uses the 7-day TTL for approve and the 30-day TTL for promote", () => {
    const before = nowSec();
    const approveExp = Number(new URL(buildActionUrl("approve", id)).searchParams.get("exp"));
    const promoteExp = Number(new URL(buildActionUrl("promote", id)).searchParams.get("exp"));
    const after = nowSec();

    const week = 7 * 24 * 3600;
    const month = 30 * 24 * 3600;
    // Allow a small window for clock movement across the two calls.
    assert.ok(approveExp >= before + week && approveExp <= after + week, "approve ~ now + 7d");
    assert.ok(promoteExp >= before + month && promoteExp <= after + month, "promote ~ now + 30d");
  });

  it("builds on top of PUBLIC_BASE_URL", () => {
    const url = buildActionUrl("skip", id);
    assert.ok(url.startsWith("https://cosmolabs.example/api/pipeline/skip?"), url);
    const parsed = new URL(url);
    const exp = parsed.searchParams.get("exp");
    const sig = parsed.searchParams.get("sig");
    assert.equal(verifyPipelineToken("skip", id, exp, sig), true);
  });
});
