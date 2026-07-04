/**
 * In-memory sliding-window rate limiter, keyed by "<bucket>:<ip>".
 *
 * ⚠️ Serverless caveat — best-effort only:
 * On Vercel each function instance has its own memory, instances are recycled
 * at will, and concurrent traffic may be fanned out across many instances.
 * That means this limiter throttles abusive bursts hitting a warm instance but
 * provides NO hard global guarantee. For hard guarantees put Vercel WAF rate
 * limiting (or an external store such as Upstash Redis) in front of these
 * endpoints; this module is defense-in-depth, not the primary control.
 *
 * Sliding window: we keep the timestamps of recent hits per key and count how
 * many fall inside the window, so bursts right at a window boundary can't
 * double-spend the quota the way a fixed-window counter allows.
 */

const DEFAULT_LIMIT = 10;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/** @type {Map<string, number[]>} key -> sorted hit timestamps (ms) */
const hitLog = new Map();

let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_TRACKED_KEYS = 10_000; // hard memory cap for a warm instance

function sweep(now, windowMs) {
  if (now - lastSweep < SWEEP_INTERVAL_MS && hitLog.size < MAX_TRACKED_KEYS) return;
  lastSweep = now;
  for (const [key, hits] of hitLog) {
    const fresh = hits.filter((t) => now - t < windowMs);
    if (fresh.length === 0) hitLog.delete(key);
    else hitLog.set(key, fresh);
  }
  // Still over cap after sweeping? Drop oldest keys (fail-open by design).
  if (hitLog.size >= MAX_TRACKED_KEYS) {
    for (const key of hitLog.keys()) {
      hitLog.delete(key);
      if (hitLog.size < MAX_TRACKED_KEYS / 2) break;
    }
  }
}

/**
 * @param {string} ip        Client IP (first x-forwarded-for hop).
 * @param {string} bucket    Logical bucket name, e.g. "intake" or "clarify".
 * @param {number} [limit]   Max requests per window (default 10 — burst-friendly).
 * @param {number} [windowMs] Window size in ms (default 10 minutes).
 * @returns {{allowed: boolean, retryAfterSec: number}}
 */
export function checkRateLimit(ip, bucket, limit = DEFAULT_LIMIT, windowMs = DEFAULT_WINDOW_MS) {
  const now = Date.now();
  sweep(now, windowMs);

  const key = `${bucket}:${ip}`;
  const hits = (hitLog.get(key) || []).filter((t) => now - t < windowMs);

  if (hits.length >= limit) {
    hitLog.set(key, hits);
    const oldest = hits[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return { allowed: false, retryAfterSec };
  }

  hits.push(now);
  hitLog.set(key, hits);
  return { allowed: true, retryAfterSec: 0 };
}
