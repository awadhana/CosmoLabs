/**
 * Forge pipeline — shared marketing-side helpers (Lane A).
 *
 * The Forge pipeline turns an intake brief into a live site: a brief is
 * approved from a signed Discord link, an Actions runner builds and deploys a
 * preview, and a "promote" link flips it live and emails the client. This
 * module owns the marketing side of that flow — reading/writing the brief's
 * status on Vercel Blob, minting the signed action links, and posting the
 * Discord notifications that carry them.
 *
 * Status lifecycle on submission.json.status:
 *   new -> approved -> building -> preview -> done   (+ dropped, build_failed)
 * Marketing endpoints own new/approved/done/dropped; the Actions runner owns
 * building/preview/build_failed. Every writer re-reads, guards the transition,
 * then writes — so re-clicks and races are idempotent no-ops.
 *
 * Everything here is best-effort and never throws (except assertTransition,
 * which is a programmer-error guard). Never logs PII — submission ids contain
 * no personal data; email/phone/ip/userAgent are never logged.
 */

import { head, put } from "@vercel/blob";

import { signPipelineToken } from "./captcha.js";

// ---------------------------------------------------------------------------
// Status lifecycle

export const STATUS = {
  NEW: "new",
  APPROVED: "approved",
  BUILDING: "building",
  PREVIEW: "preview",
  DONE: "done",
  DROPPED: "dropped",
  BUILD_FAILED: "build_failed",
};

/**
 * Allowed forward transitions. Terminal states (done/dropped/build_failed)
 * have no outgoing edges, which makes every re-click a guarded no-op.
 */
export const VALID_TRANSITIONS = {
  new: ["approved", "dropped"],
  approved: ["building"],
  building: ["preview", "build_failed"],
  preview: ["done"],
  done: [],
  dropped: [],
  build_failed: [],
};

const STATUS_LABELS = {
  new: "awaiting review",
  approved: "approved",
  building: "building",
  preview: "in preview",
  done: "delivered",
  dropped: "skipped",
  build_failed: "build failed",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || String(status || "unknown");
}

export function canTransition(from, to) {
  return Array.isArray(VALID_TRANSITIONS[from]) && VALID_TRANSITIONS[from].includes(to);
}

/** Programmer-error guard — throws on an illegal transition. */
export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid Forge status transition: ${from} -> ${to}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Blob read / write (submission.json is the manifest)

function submissionPath(id) {
  return `intake/${id}/submission.json`;
}

/** Terse, PII-free log tag (ids carry no personal data). */
function tag(id) {
  return typeof id === "string" && id.length > 0 ? id : "unknown";
}

/**
 * Read intake/<id>/submission.json from the private Blob store.
 * @returns {Promise<{ok: true, submission: object} | {ok: false, reason: string}>}
 */
export async function readSubmission(id) {
  try {
    if (typeof id !== "string" || id.length === 0) return { ok: false, reason: "bad id" };
    // head() resolves a signed, time-limited download URL for the private blob.
    const meta = await head(submissionPath(id));
    const target = meta?.downloadUrl || meta?.url;
    if (!target) return { ok: false, reason: "no url" };
    const resp = await fetch(target);
    if (!resp.ok) return { ok: false, reason: `blob ${resp.status}` };
    const submission = await resp.json();
    if (!submission || typeof submission !== "object") return { ok: false, reason: "corrupt" };
    return { ok: true, submission };
  } catch (err) {
    console.error(`[pipeline] readSubmission ${tag(id)} failed:`, err?.message || err);
    return { ok: false, reason: "read failed" };
  }
}

/**
 * Re-read the brief, guard the transition, merge extraMeta into meta, and write
 * it back. An illegal transition (re-click / a concurrent writer already moved
 * it on) is an idempotent no-op: {ok:false, reason:"stale"}.
 * @returns {Promise<{ok: true, submission: object} | {ok: false, reason: string, submission?: object}>}
 */
export async function writeSubmissionStatus(id, nextStatus, extraMeta = {}) {
  const read = await readSubmission(id);
  if (!read.ok) return { ok: false, reason: read.reason };

  const submission = read.submission;
  const current = submission.status;
  if (!canTransition(current, nextStatus)) {
    return { ok: false, reason: "stale", submission };
  }

  submission.status = nextStatus;
  if (extraMeta && typeof extraMeta === "object" && !Array.isArray(extraMeta)) {
    submission.meta = { ...(submission.meta || {}), ...extraMeta };
  }

  try {
    await put(submissionPath(id), JSON.stringify(submission, null, 2), {
      access: "private",
      addRandomSuffix: false,
      contentType: "application/json",
    });
    return { ok: true, submission };
  } catch (err) {
    console.error(`[pipeline] writeSubmissionStatus ${tag(id)} -> ${nextStatus} failed:`, err?.message || err);
    return { ok: false, reason: "write failed" };
  }
}

// ---------------------------------------------------------------------------
// Signed action links

// TTLs per the frozen contract: approve/skip live a week, promote a month.
const TTL_SECONDS = {
  approve: 7 * 24 * 3600,
  skip: 7 * 24 * 3600,
  promote: 30 * 24 * 3600,
};

/**
 * <PUBLIC_BASE_URL>/api/pipeline/<action>?id=&exp=&sig=  where
 * sig = HMAC-SHA256(HMAC_SECRET, `${action}.${id}.${exp}`).
 */
export function buildActionUrl(action, id) {
  const base = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const ttl = TTL_SECONDS[action] || TTL_SECONDS.approve;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = signPipelineToken(action, id, exp);
  const params = new URLSearchParams({ id: String(id), exp: String(exp), sig });
  return `${base}/api/pipeline/${action}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Discord notifications (plain links — a webhook can't render buttons)

function truncate(value, max) {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

/** POST a webhook payload with up to 2 retries on 5xx/429/network. Never throws. */
async function postDiscord(payload) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return { ok: false, reason: "not configured" };
  const body = JSON.stringify(payload);
  let lastReason = "unknown";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (resp.ok) return { ok: true };
      lastReason = `discord ${resp.status}`;
      // 4xx (bad payload) is terminal; 429/5xx are retried.
      if (resp.status < 500 && resp.status !== 429) return { ok: false, reason: lastReason };
    } catch (err) {
      lastReason = err?.name === "AbortError" ? "timeout" : "network error";
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: lastReason };
}

/**
 * Announce a new brief with signed Approve + Skip links. Title/description are
 * truncated; email/phone are NEVER included. Best-effort, never throws.
 */
export async function notifyDiscord(submission) {
  try {
    if (!submission?.id) return { ok: false, reason: "missing submission" };
    const approveUrl = buildActionUrl("approve", submission.id);
    const skipUrl = buildActionUrl("skip", submission.id);
    const fileCount = Array.isArray(submission.files) ? submission.files.length : 0;
    const embed = {
      title: truncate(`New brief — ${submission.title || "(untitled)"}`, 240),
      description: truncate(submission.description || "(no description)", 1500),
      color: 0x8b7bff,
      fields: [
        { name: "Reference", value: truncate(submission.id, 100), inline: true },
        { name: "Files", value: String(fileCount), inline: true },
        { name: "✅ Approve → start the build", value: approveUrl },
        { name: "🗑️ Skip", value: skipUrl },
      ],
      footer: { text: "CosmoLabs Forge · links are signed and expire in 7 days" },
    };
    return await postDiscord({ embeds: [embed] });
  } catch (err) {
    console.error(`[pipeline] notifyDiscord ${tag(submission?.id)} failed:`, err?.message || err);
    return { ok: false, reason: "failed" };
  }
}

/** Announce a ready preview with a signed Promote link. Best-effort, never throws. */
export async function previewReadyDiscord(submission, previewUrl) {
  try {
    if (!submission?.id) return { ok: false, reason: "missing submission" };
    const promoteUrl = buildActionUrl("promote", submission.id);
    const embed = {
      title: truncate(`Preview ready — ${submission.title || "(untitled)"}`, 240),
      description: previewUrl ? `Preview: ${truncate(previewUrl, 400)}` : "Preview URL unavailable.",
      color: 0x45e6ff,
      fields: [
        { name: "Reference", value: truncate(submission.id, 100), inline: true },
        { name: "🚀 Promote → notify the client", value: promoteUrl },
      ],
      footer: { text: "CosmoLabs Forge · promote when the preview looks right" },
    };
    return await postDiscord({ embeds: [embed] });
  } catch (err) {
    console.error(`[pipeline] previewReadyDiscord ${tag(submission?.id)} failed:`, err?.message || err);
    return { ok: false, reason: "failed" };
  }
}

/** Plain operational alert to the Forge channel. Best-effort, never throws. */
export async function discordAlert(message) {
  try {
    return await postDiscord({ content: truncate(`⚠️ CosmoLabs Forge: ${message}`, 1900) });
  } catch (err) {
    console.error("[pipeline] discordAlert failed:", err?.message || err);
    return { ok: false, reason: "failed" };
  }
}

// ---------------------------------------------------------------------------
// GitHub repository_dispatch (triggers the Actions build)

/**
 * Fire the build_site repository_dispatch. Retries twice on 5xx/network per
 * the contract; 4xx (bad token/repo) is terminal. Never throws.
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function dispatchBuild(id) {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_PIPELINE_REPO;
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!owner || !repo || !token) return { ok: false, reason: "not configured" };

  const url = `https://api.github.com/repos/${owner}/${repo}/dispatches`;
  const body = JSON.stringify({ event_type: "build_site", client_payload: { id } });
  let lastReason = "unknown";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "cosmolabs-forge",
        },
        body,
        signal: controller.signal,
      });
      if (resp.ok) return { ok: true }; // 204 No Content on success
      lastReason = `github ${resp.status}`;
      if (resp.status < 500) return { ok: false, reason: lastReason }; // 4xx: no retry
    } catch (err) {
      lastReason = err?.name === "AbortError" ? "timeout" : "network error";
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: lastReason };
}

// ---------------------------------------------------------------------------
// Brief sanitizer for the build agent (Lane B)

/**
 * Strip a brief down to the fields the build agent may see — drops email,
 * phone, ip and userAgent. Defined here and MIRRORED in the Lane B (Actions
 * runner) codebase; keep the two copies in sync.
 */
export function sanitizeBriefForAgent(submission) {
  const s = submission && typeof submission === "object" ? submission : {};
  return {
    title: s.title ?? "",
    description: s.description ?? "",
    references: Array.isArray(s.references) ? s.references : [],
    colorScheme: s.colorScheme ?? null,
    clarifications: Array.isArray(s.clarifications) ? s.clarifications : [],
    files: Array.isArray(s.files)
      ? s.files.map((f) => ({ name: f?.name, type: f?.type, size: f?.size, blobPath: f?.blobPath }))
      : [],
  };
}

// ---------------------------------------------------------------------------
// Branded HTML responses for the GET action endpoints

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const TONE_ACCENTS = {
  violet: "#8B7BFF",
  cyan: "#45E6FF",
  muted: "#8892C0",
};

/**
 * A small, self-contained twilight-indigo confirmation page for the pipeline
 * action endpoints (approve/skip/promote). No external assets — renders under
 * the site's strict CSP. Both heading and body are escaped.
 */
export function renderPipelinePage({ heading, body, tone = "violet" }) {
  const accent = TONE_ACCENTS[tone] || TONE_ACCENTS.violet;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>CosmoLabs Forge</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
    font-family:"Sora","Manrope",system-ui,-apple-system,"Segoe UI",sans-serif;color:#F2F5FF;
    background:radial-gradient(1100px 760px at 50% -12%, #131A3D 0%, #0E1430 46%, #0A0F26 100%);}
  .card{max-width:460px;width:100%;text-align:center;padding:44px 32px;border-radius:20px;
    background:linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.015)), rgba(26,33,72,.92);
    border:1px solid rgba(139,123,255,.25);box-shadow:0 30px 80px -20px rgba(0,0,0,.6);}
  .dot{width:44px;height:44px;border-radius:50%;margin:0 auto 20px;
    background:${accent};box-shadow:0 0 0 8px ${accent}22, 0 0 34px ${accent}66;}
  .mark{font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:${accent};margin:0 0 16px}
  h1{font-size:23px;line-height:1.3;margin:0 0 12px;font-weight:700}
  p{margin:0;color:#C7CEEA;line-height:1.6;font-size:15px}
  .foot{margin-top:26px;font-size:12px;color:#7A82B0}
</style>
</head><body>
  <main class="card">
    <div class="dot"></div>
    <p class="mark">CosmoLabs Forge</p>
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(body)}</p>
    <p class="foot">You can close this tab.</p>
  </main>
</body></html>`;
}

/** Send a branded HTML page (endpoints reply in HTML, not JSON). */
export function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(html);
}

/**
 * Robustly read id/exp/sig from a GET action link, regardless of how Vercel
 * populated req.query (parses req.url so repeated params collapse to the first).
 */
export function actionParams(req) {
  let search = "";
  try {
    search = new URL(req.url, "http://localhost").search;
  } catch {
    search = "";
  }
  const p = new URLSearchParams(search);
  return { id: p.get("id") || "", exp: p.get("exp") || "", sig: p.get("sig") || "" };
}
