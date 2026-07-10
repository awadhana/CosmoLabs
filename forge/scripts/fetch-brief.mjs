/**
 * Forge — fetch job entry (LANE B, private repo).
 *
 * Runs in JOB "fetch", which holds ONLY BLOB_READ_WRITE_TOKEN + HMAC_SECRET
 * (no Anthropic / Vercel / Pexels tokens). Its job:
 *   1. read intake/<id>/submission.json (private Blob)
 *   2. guard + set status "building" (owned by the runner), stamp buildStartedAt
 *   3. download the client's uploaded files to ./work/files/
 *   4. write ./work/brief.json = the PII-stripped brief for the build agent
 *
 * The sanitized brief + files are then uploaded as the ONLY artifacts the build
 * job receives. This is the PII firewall: email/phone/ip/userAgent never leave
 * this job, and the brief contents are NEVER printed.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  logStage,
  readBlobBuffer,
  readSubmission,
  requireEnv,
  sanitizeBriefForAgent,
  writeSubmissionStatus,
} from "./lib.mjs";

const WORK_DIR = path.resolve("work");
const FILES_DIR = path.join(WORK_DIR, "files");

// Only download files whose names survive this basename allowlist — defence in
// depth over the intake-time sanitizer (never trust the stored path blindly).
const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,120}$/;

async function downloadFiles(submission) {
  const files = Array.isArray(submission.files) ? submission.files : [];
  let downloaded = 0;
  for (const file of files) {
    const name = typeof file?.name === "string" ? file.name.split(/[\\/]/).pop() : "";
    const blobPath = typeof file?.blobPath === "string" ? file.blobPath : "";
    if (!name || !SAFE_NAME_RE.test(name) || !blobPath.startsWith(`intake/${submission.id}/files/`)) {
      logStage("fetch", "skip-file", { reason: "unsafe file entry" });
      continue;
    }
    const buffer = await readBlobBuffer(blobPath);
    await writeFile(path.join(FILES_DIR, name), buffer);
    downloaded += 1;
  }
  return downloaded;
}

async function main() {
  const id = requireEnv("CLIENT_ID");
  requireEnv("BLOB_READ_WRITE_TOKEN"); // fail fast if unset

  const started = Date.now();
  const submission = await readSubmission(id);

  // Claim the build. Only legal from new/approved (or a re-dispatch already in
  // building, which writeSubmissionStatus treats as an idempotent no-op).
  await writeSubmissionStatus(id, "building", {
    expectedFrom: ["new", "approved"],
    meta: { buildStartedAt: new Date().toISOString() },
  });

  await mkdir(FILES_DIR, { recursive: true });
  const fileCount = await downloadFiles(submission);

  const brief = sanitizeBriefForAgent(submission);
  await writeFile(path.join(WORK_DIR, "brief.json"), JSON.stringify(brief, null, 2));

  logStage("fetch", "ok", {
    id,
    files: fileCount,
    durationMs: Date.now() - started,
  });
}

main().catch((err) => {
  // Do NOT print the error's data payload beyond its message (may reference the
  // brief). status build_failed is set by the workflow's failure() step.
  logStage("fetch", "error", { reason: err?.message || "unknown error" });
  process.exit(1);
});
