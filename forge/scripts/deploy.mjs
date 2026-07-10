/**
 * Forge — Vercel preview deploy (LANE B, private repo).
 *
 * Runs in JOB "build" with VERCEL_TOKEN/ORG/PROJECT + BLOB (status writeback) +
 * HMAC + DISCORD + PUBLIC_BASE_URL. Deploys ./build to Vercel as a PREVIEW via
 * the Vercel CLI, captures deploymentId + previewUrl, writes those back into
 * submission.json.meta, flips status to "preview", and posts the preview +
 * signed Promote link to Discord.
 *
 * The generated project ships a vercel.json with X-Robots-Tag: noindex (preview
 * privacy belongs in the deployed project's config, not a runner env var) plus
 * the trimmed, self-hosted-media CSP (media-src 'self').
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  TTL_PROMOTE,
  buildActionUrl,
  discordMessage,
  logStage,
  requireEnv,
  sleep,
  writeSubmissionStatus,
} from "./lib.mjs";

const BUILD_DIR = path.resolve("build");
const VERCEL_URL_RE = /https:\/\/[a-z0-9-]+\.vercel\.app/gi;

const GENERATED_VERCEL_JSON = {
  headers: [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        {
          key: "Content-Security-Policy",
          value:
            "default-src 'self'; img-src 'self' data:; media-src 'self'; " +
            "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
            "font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; " +
            "frame-ancestors 'none'",
        },
      ],
    },
  ],
};

async function ensureVercelJson() {
  const target = path.join(BUILD_DIR, "vercel.json");
  if (existsSync(target)) return; // respect an agent-authored config if present
  await writeFile(target, JSON.stringify(GENERATED_VERCEL_JSON, null, 2));
}

/** Run `vercel deploy` with retries on transient (429/5xx) failures. Returns
 *  { url, stdout } or throws after exhausting retries. */
async function vercelDeploy(token) {
  const args = ["vercel", "deploy", BUILD_DIR, "--yes", "--token", token];
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await new Promise((resolve) => {
      const child = spawn("npx", args, {
        env: {
          ...process.env,
          VERCEL_ORG_ID: requireEnv("VERCEL_ORG_ID"),
          VERCEL_PROJECT_ID: requireEnv("VERCEL_PROJECT_ID"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c.toString()));
      child.stderr.on("data", (c) => (stderr += c.toString()));
      child.on("error", (err) => resolve({ code: 1, stdout, stderr: err.message }));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

    const combined = `${result.stdout}\n${result.stderr}`;
    const match = combined.match(VERCEL_URL_RE);
    if (result.code === 0 && match) {
      return { url: match[match.length - 1], stdout: result.stdout };
    }
    const transient = /429|5\d\d|rate limit|timeout|ETIMEDOUT|ECONNRESET/i.test(combined);
    logStage("deploy", "retry", { attempt: attempt + 1, transient });
    if (!transient && attempt >= 1) break;
    await sleep(2000 * (attempt + 1));
  }
  throw new Error("vercel deploy failed");
}

/** Resolve a deployment id from the preview host via the Vercel REST API. */
async function resolveDeploymentId(previewUrl, token) {
  try {
    const host = new URL(previewUrl).host;
    const org = requireEnv("VERCEL_ORG_ID");
    const api = `https://api.vercel.com/v13/deployments/${encodeURIComponent(host)}?teamId=${encodeURIComponent(org)}`;
    const res = await fetch(api, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const data = await res.json();
    return data.id || data.uid || null;
  } catch {
    return null;
  }
}

async function previewReadyDiscord(submission, previewUrl) {
  const promoteUrl = buildActionUrl("promote", submission.id, TTL_PROMOTE);
  const title = typeof submission.title === "string" && submission.title.trim() ? submission.title.trim() : submission.id;
  await discordMessage({
    content:
      `:white_check_mark: **Preview ready** — ${title}\n` +
      `Preview: ${previewUrl}\n` +
      `Promote to production (link valid 30 days): ${promoteUrl}`,
  });
}

async function main() {
  const id = requireEnv("CLIENT_ID");
  const token = requireEnv("VERCEL_TOKEN");
  const projectId = requireEnv("VERCEL_PROJECT_ID");
  requireEnv("BLOB_READ_WRITE_TOKEN");

  if (!existsSync(path.join(BUILD_DIR, "index.html"))) {
    throw new Error("build/index.html missing — nothing to deploy");
  }

  const started = Date.now();
  await ensureVercelJson();

  const { url: previewUrl } = await vercelDeploy(token);
  const deploymentId = await resolveDeploymentId(previewUrl, token);

  const { submission, changed } = await writeSubmissionStatus(id, "preview", {
    expectedFrom: ["building", "preview"],
    meta: {
      previewUrl,
      vercelDeploymentId: deploymentId,
      vercelProjectId: projectId,
      buildFinishedAt: new Date().toISOString(),
    },
  });

  // Only announce on a real transition — a re-run must not re-ping Discord.
  if (changed) await previewReadyDiscord(submission, previewUrl);

  logStage("deploy", "ok", {
    id,
    hasDeploymentId: Boolean(deploymentId),
    announced: changed,
    durationMs: Date.now() - started,
  });
}

main().catch((err) => {
  logStage("deploy", "error", { reason: err?.message || "unknown error" });
  process.exit(1);
});
