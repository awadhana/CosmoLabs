# CosmoLabs — Intake Backend Architecture

Serverless backend for the CosmoLabs marketing site. The static `index.html`
(deployed on Vercel) submits project briefs to a set of Node.js serverless
functions under `api/`, which validate, store, and fan out notifications. A
future async pipeline (Hermes / Obsidian vault) consumes stored submissions
from Vercel Blob.

## System diagram

```
                ┌──────────────────────────── Vercel project ───────────────────────────┐
                │                                                                       │
 Browser        │  index.html (static)                                                  │
 ───────────────┼──► GET  /api/intake-config ──► env flags + upload limits              │
   intake form  │                                                                       │
                │──► POST /api/clarify ────────► Anthropic API (claude-opus-4-8)        │
                │        │ fallback questions when key unset / error                    │
                │                                                                       │
                │──► POST /api/intake ─┬───────► Cloudflare Turnstile /siteverify       │
                │                      │            (when TURNSTILE_SECRET_KEY set)     │
                │                      ├───────► Vercel Blob (private store)            │
                │                      │            intake/<id>/submission.json         │
                │                      │            intake/<id>/files/<name>            │
                │                      └───────► Resend (internal + customer email)     │
                │                                                                       │
 Pipeline       │──► GET  /api/admin/submissions ─► Blob list() under "intake/"         │
 (Hermes /      │        Authorization: Bearer <INTAKE_ADMIN_TOKEN>                     │
  Obsidian)     │                                                                       │
                └───────────────────────────────────────────────────────────────────────┘
```

Files:

| Path | Role |
|---|---|
| `api/_lib/security.js` | Guards (method/content-type/size/origin), sanitizers, validators, filename sanitizer, client IP |
| `api/_lib/ratelimit.js` | In-memory sliding-window rate limiter (best-effort per instance) |
| `api/_lib/email.js` | Resend integration — internal notification + customer confirmation, never throws |
| `api/_lib/captcha.js` | Stateless proof-of-work captcha: HMAC-signed challenges, IP-bound, 15-min TTL |
| `api/intake.js` | `POST /api/intake` — validate, anti-bot, human check (Turnstile or PoW captcha), Blob storage, email |
| `api/clarify.js` | `POST /api/clarify` — AI clarifying questions via `@anthropic-ai/sdk`, static fallback |
| `api/intake-config.js` | `GET /api/intake-config` — public form config, cached 5 min |
| `api/captcha.js` | `GET /api/captcha` — issue a proof-of-work challenge for the wizard's human check |
| `api/admin/submissions.js` | `GET /api/admin/submissions` — pipeline listing, bearer-token auth |

`api/_lib/` is underscore-prefixed so Vercel does **not** expose it as endpoints.

---

## API contract

Both the frontend and this backend must match this contract exactly.

### POST `/api/intake` (Content-Type: `application/json`)

Request body:

```jsonc
{
  "email": "string (required, valid email, <=254 chars)",
  "phone": "string (required, 7-25 chars, digits/+/-/()/spaces only)",
  "title": "string (required, 3-200 chars)",
  "description": "string (required, 10-5000 chars)",
  "references": [                       // optional, max 5
    { "url": "http/https, <=500 chars", "note": "<=300 chars" }
  ],
  "colorScheme": {                      // optional
    "mode": "light" | "dark" | "either",
    "colors": ["#AABBCC", "..."],       // up to 6 hex strings
    "notes": "<=500 chars"
  },
  "clarifications": [                   // optional, max 8
    { "question": "<=500 chars", "answer": "<=2000 chars" }
  ],
  "files": [                            // optional, max 3
    { "name": "string", "type": "string", "size": 123, "data": "<base64>" }
    // each file <=1.5MB decoded; total decoded <=3MB
    // allowed extensions: pdf png jpg jpeg webp txt md docx xlsx csv
  ],
  "website": "",                        // HONEYPOT — must be empty string
  "startedAt": 1751500000000,           // epoch ms when the form was opened
  "turnstileToken": "string",           // optional; verified when TURNSTILE_SECRET_KEY set
  "captcha": {                          // REQUIRED when TURNSTILE_SECRET_KEY is NOT set
    "challenge": "<64 hex>",            //   echoed from GET /api/captcha
    "salt": "<expires>.<iphash>.<rand>",//   echoed from GET /api/captcha
    "number": 12345,                    //   the brute-forced solution (0..maxnumber)
    "signature": "<64 hex>"             //   echoed from GET /api/captcha
  }
}
```

Anti-bot behavior (silent drop): if `website` is non-empty, or
`now - startedAt < 3000ms` (or `startedAt` is missing/invalid), the request is
accepted-but-dropped — the API responds `200 {"ok":true,"id":"int_0"}` and
stores nothing.

Responses:

| Status | Body |
|---|---|
| 200 | `{"ok":true,"id":"int_<base36 timestamp>_<6 random chars>"}` |
| 400 | `{"ok":false,"error":"<human readable>"}` (validation, origin mismatch/missing on POST, or `"Verification failed"` for Turnstile). PoW captcha failures additionally carry `"code":"captcha"` so the frontend can show a translated message and reset its widget. |
| 405 | Method not allowed |
| 413 | Payload too large (raw body > ~4.3MB — base64 of the 3MB decoded cap plus JSON envelope headroom) |
| 415 | Wrong content type |
| 429 | `{"ok":false,"error":"Too many requests..."}` + `Retry-After` header |
| 500 | `{"ok":false,"error":"Something went wrong. Please email cosmolabshq@gmail.com."}` — never leaks internals |

### POST `/api/clarify` (Content-Type: `application/json`)

Request: `{ "title", "description", "references": [...], "colorScheme": {...} }`
(same shapes as `/api/intake`; inputs are defensively truncated server-side —
title 200, description 5000, max 5 references).

Response 200:

```json
{ "ok": true, "ready": false, "questions": [{ "id": "q1", "question": "..." }], "source": "ai" }
```

- `questions` has at most 4 entries; `ready: true` implies `questions: []`.
- `source` is `"ai"` when Claude produced the result, `"fallback"` otherwise.
- If `ANTHROPIC_API_KEY` is unset **or the API call fails for any reason**
  (timeout, network, malformed output), the endpoint still returns 200 with
  `source: "fallback"` and exactly these three questions:
  - `q1` — "Who is the primary audience or user of this project, and what is the single most important thing they should be able to do?"
  - `q2` — "Do you have existing branding, content, or accounts (domain, logins, copy, images) we should build with, or are we starting from scratch?"
  - `q3` — "What is your ideal timeline and budget range for this project?"
- Same method (405) / content-type (415) / origin (400) / rate-limit (429)
  discipline as `/api/intake`; rate bucket `clarify`, 6 requests / 10 min.

AI integration details: official `@anthropic-ai/sdk`, model `claude-opus-4-8`,
`max_tokens: 1500`, structured JSON via
`output_config: { format: { type: "json_schema", schema: ... } }`, 10-second
client timeout, no retries, and **no** `temperature`/`top_p` (rejected on this
model).

### GET `/api/intake-config`

Response 200 (Cache-Control: `public, max-age=300`):

```json
{
  "turnstileSiteKey": "string or null",
  "clarifyEnabled": true,
  "maxFiles": 3,
  "maxFileBytes": 1572864,
  "maxTotalBytes": 3145728,
  "allowedExtensions": ["pdf","png","jpg","jpeg","webp","txt","md","docx","xlsx","csv"]
}
```

`turnstileSiteKey` comes from `TURNSTILE_SITE_KEY`; `clarifyEnabled` is true
when `ANTHROPIC_API_KEY` is set.

### GET `/api/captcha`

Issues a stateless proof-of-work challenge for the wizard's "I'm not a robot"
check (used whenever Turnstile is not configured — the frontend shows the PoW
widget iff `turnstileSiteKey` is null). Response 200 (Cache-Control: `no-store`):

```json
{
  "ok": true,
  "algorithm": "SHA-256",
  "challenge": "<64 hex — sha256(salt + '.' + secretNumber)>",
  "salt": "<expiresEpochSec>.<ipHash12>.<rand16hex>",
  "maxnumber": 60000,
  "signature": "<64 hex — hmacSha256(CAPTCHA_SECRET, challenge + '.' + salt)>"
}
```

The client brute-forces `secretNumber` (avg ~30k SHA-256 hashes, ~1-2s in the
browser) and submits `{challenge, salt, number, signature}` as the `captcha`
field of `POST /api/intake`. Verification is stateless: signature HMAC, 15-min
expiry and client-IP binding are all encoded in the salt. Rate limited to
30 challenges / 10 min / IP. Also returns 400 (cross-origin) / 405 / 429.

### GET `/api/admin/submissions`

Requires header `Authorization: Bearer <INTAKE_ADMIN_TOKEN>`.

| Status | Meaning |
|---|---|
| 503 | `INTAKE_ADMIN_TOKEN` env var is not configured |
| 401 | Header missing or token wrong (constant-time compare) |
| 200 | `{ "ok": true, "submissions": [{ "id", "url", "uploadedAt", "size" }] }` |

Listing comes from Vercel Blob `list()` under prefix `intake/`, filtered to
`submission.json` entries only, newest first.

---

## Blob storage layout (the async pipeline contract)

The Blob store is **private**; all writes use `access: "private"` and
`addRandomSuffix: false` so pathnames are deterministic. Consumers use the
`@vercel/blob` SDK with `BLOB_READ_WRITE_TOKEN`.

```
intake/
  <id>/
    submission.json          ← the manifest (uploaded LAST, after all files)
    files/
      <sanitized filename>   ← each uploaded document, decoded binary
```

`submission.json` shape:

```jsonc
{
  "id": "int_mcgd3k1a_x7k2pq",
  "receivedAt": "2026-07-04T12:34:56.789Z",   // ISO 8601
  "email": "client@example.com",
  "phone": "+1 (555) 123-4567",
  "title": "...",
  "description": "...",
  "references": [{ "url": "...", "note": "..." }],
  "colorScheme": { "mode": "dark", "colors": ["#AABBCC"], "notes": "..." } , // or null
  "clarifications": [{ "question": "...", "answer": "..." }],
  "files": [
    { "name": "brief.pdf", "type": "application/pdf", "size": 12345,
      "blobPath": "intake/int_.../files/brief.pdf" }
  ],
  "meta": { "ip": "...", "userAgent": "...", "turnstileVerified": true },
  "status": "new"            // lifecycle: "new" → "processing" → "done"
}
```

Because files are uploaded before `submission.json`, the presence of a
`submission.json` guarantees every `blobPath` it references already exists.

---

## Environment variables

All optional except the Blob token (provisioned automatically when a Blob
store is connected to the project). Set via Vercel → Project → Settings →
Environment Variables (or `vercel env add`).

| Variable | Used by | Purpose / setup |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | intake, admin | **Provisioned by Vercel** when the Blob store is attached. The `@vercel/blob` SDK reads it automatically. The same token is what the external pipeline uses to `list()`/fetch blobs. |
| `GMAIL_USER` | email | The Gmail address all mail is sent from (and replied to): `cosmolabshq@gmail.com`. |
| `GMAIL_APP_PASSWORD` | email | Google **App Password** for that account (regular account passwords are rejected by Gmail SMTP). Setup: enable 2-Step Verification at myaccount.google.com/security, then create one at myaccount.google.com/apppasswords. Without it, intake still succeeds and email is skipped (`{sent:false}`). Note Gmail's ~500 recipients/day sending limit — fine for intake volume; move to a transactional provider with a custom domain when that becomes a constraint. |
| `INTAKE_NOTIFY_EMAIL` | email | Internal notification recipient. Default `cosmolabshq@gmail.com`. |
| `ANTHROPIC_API_KEY` | clarify | Create at [platform.claude.com](https://platform.claude.com) → API Keys. When unset, `/api/clarify` returns fallback questions and `/api/intake-config` reports `clarifyEnabled: false`. |
| `TURNSTILE_SITE_KEY` | intake-config | Cloudflare Dashboard → Turnstile → Add widget → enter the site's domain(s) → copy the **Site Key** (public, served to the browser). |
| `TURNSTILE_SECRET_KEY` | intake | The matching **Secret Key** from the same Turnstile widget. When set, `/api/intake` verifies `turnstileToken` server-side against `https://challenges.cloudflare.com/turnstile/v0/siteverify` and rejects failures with 400 "Verification failed". When unset, verification is skipped. |
| `INTAKE_ADMIN_TOKEN` | admin | Long random secret for the pipeline. Generate: `openssl rand -base64 32` (or `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`). When unset, `/api/admin/submissions` returns 503. |
| `CAPTCHA_SECRET` | captcha, intake | HMAC key signing proof-of-work challenges (any long random string; set in all environments). Falls back to `INTAKE_ADMIN_TOKEN`, then to a dev-only constant — set it explicitly in production. |

---

## Security measures

- **Server-side validation of everything** — the client is never trusted; all
  fields are re-validated (types, lengths, formats), file sizes are measured
  from decoded bytes, and declared MIME types are shape-checked.
- **Raw body size cap** — requests over 4,500,000 bytes (via `Content-Length`,
  best-effort) are rejected with 413 before parsing (Vercel's hard limit is
  4.5MiB; the contract caps decoded files at 3MB = exactly 4,194,304 base64
  chars, so the cap leaves ~300KB of JSON-envelope headroom).
- **Same-origin enforcement** — POST endpoints require an `Origin` header that
  matches the request `Host` (400 otherwise); GET endpoints allow a missing
  `Origin` so non-browser pipeline clients work.
- **Honeypot + time gate** — bot submissions get a fake success
  (`{"ok":true,"id":"int_0"}`) and are never stored, giving bots no signal.
- **Human check (required)** — when Cloudflare Turnstile is configured, its
  token is verified server-side with the secret key and client IP. Otherwise a
  **self-hosted proof-of-work captcha** is mandatory: `/api/intake` rejects
  submissions without a valid solution (HMAC-signed challenge, 15-min TTL,
  IP-bound, ~30k SHA-256 hashes of client CPU per submission). Solutions are
  replayable from the same IP until expiry by design (stateless) — the per-IP
  rate limit bounds the blast radius.
- **Rate limiting** — sliding window per IP (`intake`: 8/10 min, `clarify`:
  6/10 min). In-memory and therefore best-effort per serverless instance;
  enable **Vercel WAF rate limiting** for hard guarantees.
- **File hygiene** — filename sanitization (basename only, `[a-zA-Z0-9._-]`
  charset, collapsed dots), extension whitelist, per-file and total size
  limits, and magic-byte sniffing (pdf/png/jpg/jpeg/webp plus ZIP header for
  docx/xlsx) so renamed payloads are rejected.
- **Private Blob store** — submissions and uploads are not publicly reachable;
  access requires the RW token.
- **Admin auth** — bearer token compared via `crypto.timingSafeEqual` over
  SHA-256 digests (constant-time; length-safe). 503 when unconfigured so the
  endpoint fails closed.
- **No internal leakage** — unexpected errors return a generic 500 message;
  real errors go to `console.error` only. Logs contain submission ids, never
  secrets or file contents.
- **Isolation of shared code** — `api/_lib/*` is not routable (underscore
  prefix).

---

## Pipeline integration (Hermes / Obsidian vault)

The intake backend is the *producer*; the pipeline is an asynchronous
*consumer*. Two supported discovery modes:

### Option A — poll the admin endpoint

```
GET https://<site>/api/admin/submissions
Authorization: Bearer $INTAKE_ADMIN_TOKEN
```

Returns every stored `submission.json` (id, blob url, uploadedAt, size). The
pipeline diffs against its own ledger to find unprocessed ids.

### Option B — list the Blob prefix directly

Using `@vercel/blob` with `BLOB_READ_WRITE_TOKEN`:

```js
import { list } from "@vercel/blob";

let cursor;
do {
  const page = await list({ prefix: "intake/", cursor, token: process.env.BLOB_READ_WRITE_TOKEN });
  for (const blob of page.blobs) {
    if (/\/submission\.json$/.test(blob.pathname)) {
      // fetch blob content, check status field
    }
  }
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);
```

### Processing convention

1. **Download** `intake/<id>/submission.json`; skip if `status !== "new"`.
2. **Claim** it by re-uploading `submission.json` with `status: "processing"`
   (same path, `access: "private"`, `addRandomSuffix: false` — the `put`
   overwrites in place). This is the documented status-PATCH convention; Blob
   has no partial update, so the whole JSON document is rewritten.
3. **Download files** listed in `files[].blobPath`.
4. **Process** — e.g. render the brief into the Obsidian vault, open a Hermes
   task, kick off the build agent.
5. **Complete** by re-uploading `submission.json` with `status: "done"` (add
   any pipeline metadata fields you need, e.g. `processedAt`, `vaultPath`).

Note: the re-upload "claim" is last-writer-wins, not a lock. Run a single
consumer, or make processing idempotent.

### Recommended next steps

- **Vercel Cron** (`vercel.json` → `crons`) hitting a pipeline-trigger
  endpoint every few minutes is the simplest scheduler for Option A.
- **Vercel Queues** (or any durable queue) would upgrade the flow from polling
  to push: `/api/intake` enqueues the id after storing, and a queue consumer
  processes it exactly-once with retries. The Blob layout above stays the
  system of record either way.
