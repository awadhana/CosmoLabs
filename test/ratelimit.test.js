/**
 * Unit tests for the in-memory sliding-window rate limiter.
 *
 * The hit log is module-level state shared across the whole test process, so
 * every test uses a unique ip+bucket to stay independent of the others.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkRateLimit } from "../api/_lib/ratelimit.js";

describe("checkRateLimit", () => {
  it("allows up to the limit then blocks with a positive retry-after", () => {
    const ip = "192.0.2.10";
    const bucket = "rl-block-test";
    const limit = 3;

    for (let i = 0; i < limit; i++) {
      const res = checkRateLimit(ip, bucket, limit, 60_000);
      assert.equal(res.allowed, true, `hit ${i + 1} should be allowed`);
      assert.equal(res.retryAfterSec, 0);
    }

    const blocked = checkRateLimit(ip, bucket, limit, 60_000);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSec > 0, "blocked responses report a retry delay");
  });

  it("keeps different IPs independent", () => {
    const bucket = "rl-independent-test";
    const limit = 2;

    // Exhaust the quota for one IP.
    checkRateLimit("192.0.2.20", bucket, limit, 60_000);
    checkRateLimit("192.0.2.20", bucket, limit, 60_000);
    assert.equal(checkRateLimit("192.0.2.20", bucket, limit, 60_000).allowed, false);

    // A different IP still has its full quota.
    assert.equal(checkRateLimit("192.0.2.21", bucket, limit, 60_000).allowed, true);
  });

  it("keeps different buckets independent for the same IP", () => {
    const ip = "192.0.2.30";
    const limit = 1;

    assert.equal(checkRateLimit(ip, "rl-bucket-a", limit, 60_000).allowed, true);
    assert.equal(checkRateLimit(ip, "rl-bucket-a", limit, 60_000).allowed, false);
    // Same IP, different bucket — independent quota.
    assert.equal(checkRateLimit(ip, "rl-bucket-b", limit, 60_000).allowed, true);
  });
});
