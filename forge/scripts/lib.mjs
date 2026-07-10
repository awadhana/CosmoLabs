/**
 * Forge pipeline — shared runner helpers (LANE B, private repo).
 *
 * Runs inside GitHub Actions, NOT as a Vercel serverless function. Mirrors the
 * marketing side's pipeline.js semantics for the parts the runner owns:
 *   - readSubmission / writeSubmissionStatus (with a transition guard)
 *   - signPipelineToken / buildActionUrl (MUST match the frozen HMAC scheme so
 *     the Discord links verify on the marketing endpoints)
 *   - discordMessage (best-effort webhook post, retries on 5xx, never throws)
 *   - markBuildFailed (the workflow's always()/failure() handler)
 *   - sanitizeBriefForAgent (PII stripper handed to the build agent)
 *
 * The status field on intake/<id>/submission.json is the job state. The runner
 * OWNS building/preview/build_failed; marketing owns new/approved/done/dropped.
 * Every writer re-reads, checks status, then writes (idempotent; re-runs no-op).
 *
 * PII rule: NEVER log email/phone/ip/userAgent, and never write them into any
 * artifact the agent or Actions logs can see. The submission id, status, stage,
 * and durations are safe to log.
 *
 * CLI: `node scripts/lib.mjs mark-failed` reads CLIENT_ID + FAILED_STAGE from
 * env and marks the build failed + alerts Discord. Used by the workflow's
 * failure() step so the whole failure path lives in one audited file.
 */

import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { list, put } from "@vercel/blob";

// TTLs for the signed Discord action links (seconds). Frozen contract.
export const TTL_APPROVE = 7 * 24 * 60 * 60;
export const TTL_SKIP = 7 * 24 * 60 * 60;
export const TTL_PROMOTE = 30 * 24 * 60 * 60;

// Forge status lifecycle. Runner-owned targets: building / preview /
// build_failed. Anything the runner might legally transition FROM -> TO.
const ALLOWED_TRANSITIONS = {
  new: ["approved", "dropped", "building", "build_failed"],
  approved: ["building", "dropped", "build_failed"],
  building: ["preview", "build_failed", "approved"],
  preview: ["done", "building", "build_failed"],
  build_failed: ["building", "approved", "build_failed"],
  dropped: [],
  done: [],
};

// --------------------------------------------------------------------------
// Small utils

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

/** Structured, PII-free log line. Only ever pass id/stage/outcome/metrics. */
export function logStage(stage, outcome, extra = {}) {
  const line = { at: new Date().toISOString(), stage, outcome, ...extra };
  console.log(`[forge] ${JSON.stringify(line)}`);
}

/** Run a best-effort side effect; swallow + log (scrubbed) any failure. */
async function safe(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[forge] ${label} failed: ${err?.message || "unknown error"}`);
    return null;
  }
}

// --------------------------------------------------------------------------
// Signed action links (must match the marketing-side verifier byte-for-byte)

export function signPipelineToken(action, id, exp) {
  const secret = requireEnv("HMAC_SECRET");
  return crypto
    .createHmac("sha256", secret)
    .update(`${action}.${id}.${exp}`)
    .digest("hex");
}

export function buildActionUrl(action, id, ttlSeconds) {
  const base = requireEnv("PUBLIC_BASE_URL").replace(/\/+$/, "");
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = signPipelineToken(action, id, exp);
  const query = new URLSearchParams({ id, exp: String(exp), sig });
  return `${base}/api/pipeline/${action}?${query.toString()}`;
}

// --------------------------------------------------------------------------
// Discord

export async function discordMessage(payload) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.warn("[forge] DISCORD_WEBHOOK_URL not configured; skipping alert");
    return false;
  }
  const body = typeof payload === "string" ? { content: payload } : payload;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return true;
      // Client errors are our fault (bad payload/url) — do not retry.
      if (res.status >= 400 && res.status < 500) {
        console.warn(`[forge] discord rejected message (${res.status})`);
        return false;
      }
      // 5xx -> retry with backoff.
    } catch {
      // network error -> retry
    }
    await sleep(500 * (attempt + 1));
  }
  console.warn("[forge] discord message failed after retries");
  return false;
}

// --------------------------------------------------------------------------
// Blob access (private store; reads via the RW token)

const SUBMISSION_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

function assertId(id) {
  if (typeof id !== "string" || !SUBMISSION_ID_RE.test(id)) {
    throw new Error("Invalid submission id");
  }
  return id;
}

function blobToken() {
  return requireEnv("BLOB_READ_WRITE_TOKEN");
}

export function submissionPath(id) {
  return `intake/${assertId(id)}/submission.json`;
}

async function locateBlob(pathname, token) {
  const { blobs } = await list({ prefix: pathname, token, limit: 100 });
  const match = blobs.find((b) => b.pathname === pathname);
  if (!match) throw new Error(`Blob not found: ${pathname}`);
  return match;
}

/** Fetch a private blob's bytes. Prefers the signed downloadUrl; falls back to
 *  an authorized fetch of the canonical url. */
async function fetchBlobResponse(pathname, token) {
  const ref = await locateBlob(pathname, token);
  const target = ref.downloadUrl || ref.url;
  let res = await fetch(target);
  if (!res.ok) {
    res = await fetch(target, { headers: { authorization: `Bearer ${token}` } });
  }
  if (!res.ok) throw new Error(`Blob download failed (${res.status}) for ${pathname}`);
  return res;
}

export async function readBlobBuffer(pathname) {
  const res = await fetchBlobResponse(pathname, blobToken());
  return Buffer.from(await res.arrayBuffer());
}

export async function readSubmission(id) {
  const res = await fetchBlobResponse(submissionPath(id), blobToken());
  const submission = await res.json();
  if (!submission || typeof submission !== "object" || Array.isArray(submission)) {
    throw new Error("submission.json is not an object");
  }
  if (typeof submission.status !== "string") {
    throw new Error("submission.json is missing a status");
  }
  return submission;
}

function applyUpdate(submission, to, meta) {
  return {
    ...submission,
    status: to,
    meta: { ...(submission.meta || {}), ...meta },
  };
}

async function putSubmission(id, submission) {
  await put(submissionPath(id), JSON.stringify(submission, null, 2), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    token: blobToken(),
  });
}

/**
 * Re-read, guard the transition, then write. Idempotent:
 *   - from === to      -> merge any writeback meta, return { changed: false }
 *   - expectedFrom set  -> throws if the current status is not in that set
 *   - transition table  -> throws on an illegal FROM -> TO
 * Callers key side effects (Discord) off the returned `changed` flag so a
 * re-run never double-fires.
 */
export async function writeSubmissionStatus(id, to, { meta = {}, expectedFrom } = {}) {
  const submission = await readSubmission(id);
  const from = submission.status;

  if (from === to) {
    const merged = applyUpdate(submission, to, meta);
    await putSubmission(id, merged);
    return { submission: merged, from, to, changed: false };
  }

  const allowedFrom = expectedFrom ? [].concat(expectedFrom) : null;
  if (allowedFrom && !allowedFrom.includes(from)) {
    throw new Error(`Unexpected status "${from}" (expected one of ${allowedFrom.join(", ")})`);
  }
  if (!(ALLOWED_TRANSITIONS[from] || []).includes(to)) {
    throw new Error(`Illegal status transition ${from} -> ${to}`);
  }

  const merged = applyUpdate(submission, to, meta);
  await putSubmission(id, merged);
  return { submission: merged, from, to, changed: true };
}

/** Failure handler: Discord alert + best-effort build_failed. Never throws. */
export async function markBuildFailed(id, stage) {
  await safe("discord alert", () =>
    discordMessage({
      content: `:warning: Forge build failed — id \`${id}\` at stage \`${stage || "unknown"}\`. The job is re-runnable.`,
    })
  );
  await safe("status build_failed", async () => {
    const submission = await readSubmission(id);
    const canFail = ["new", "approved", "building", "preview", "build_failed"];
    if (!canFail.includes(submission.status)) return;
    await writeSubmissionStatus(id, "build_failed", {
      meta: { buildFailedAt: new Date().toISOString(), failedStage: stage || null },
    });
  });
}

// --------------------------------------------------------------------------
// Brief sanitizer — the ONLY shape the build agent is ever handed. No PII.

export function sanitizeBriefForAgent(submission) {
  const files = Array.isArray(submission.files)
    ? submission.files.map((f) => ({
        name: f?.name,
        type: f?.type,
        size: f?.size,
      }))
    : [];
  return {
    id: submission.id,
    title: submission.title ?? null,
    description: submission.description ?? null,
    references: Array.isArray(submission.references) ? submission.references : [],
    colorScheme: submission.colorScheme ?? null,
    clarifications: Array.isArray(submission.clarifications) ? submission.clarifications : [],
    files,
  };
}

// --------------------------------------------------------------------------
// CLI entry (workflow failure step): node scripts/lib.mjs mark-failed

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const command = process.argv[2];
  if (command === "mark-failed") {
    const id = process.env.CLIENT_ID;
    const stage = process.env.FAILED_STAGE;
    if (!id) {
      console.warn("[forge] mark-failed: CLIENT_ID not set; nothing to do");
      process.exit(0);
    }
    markBuildFailed(id, stage).finally(() => process.exit(0));
  } else {
    console.error(`[forge] unknown lib.mjs command: ${command || "(none)"}`);
    process.exit(1);
  }
}
