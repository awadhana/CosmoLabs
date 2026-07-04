# CosmoLabs

Marketing site + project-intake platform for **CosmoLabs** — a multidisciplinary consulting firm providing professional services in:

- **Computer Science & Software** — software engineering, cloud & DevOps, AI/ML systems, cybersecurity, data engineering
- **Aerospace Engineering** — mission & systems engineering, GNC, propulsion & structures analysis, avionics & flight software
- **Nuclear Engineering** — reactor safety analysis, NRC licensing support, thermal-hydraulics, radiation shielding, decommissioning

Trusted by leading firms including Amazon, The Home Depot, Microsoft, Delta Air Lines, and more.

## What's here

- `index.html` — the site: single self-contained static page (inline CSS/JS), with moving NASA-photography hero backgrounds and a 4-step **"What can we do for you?"** intake wizard (brief → references/colors/documents → AI clarifying questions → review + captcha + submit).
- `api/` — Vercel serverless functions:
  - `POST /api/intake` — validated, spam-hardened brief submission → Vercel Blob + email notifications
  - `POST /api/clarify` — Claude-generated clarifying questions (graceful fallback without an API key)
  - `GET /api/intake-config` — public client config (captcha site key, upload limits)
  - `GET /api/admin/submissions` — token-gated listing for the async build pipeline
- `assets/` — public-domain NASA imagery (JWST Carina Nebula, ISS Earth horizon, night launch)
- `ARCHITECTURE.md` — full API contract, Blob storage layout, env vars, security measures, and the Hermes/Obsidian pipeline integration guide

## Stack

Static front end + Node.js (ESM) serverless functions on Vercel. Dependencies: `@vercel/blob` (private submission storage), `@anthropic-ai/sdk` (clarifying questions, `claude-opus-4-8`), `nodemailer` (Gmail SMTP from cosmolabshq@gmail.com).

## Security

Layered anti-spam/abuse: Cloudflare Turnstile (env-gated), honeypot field, minimum-fill-time gate, per-IP rate limiting, request size caps, file extension + magic-byte validation, same-origin enforcement, security headers via `vercel.json`, timing-safe admin auth. See `ARCHITECTURE.md` for the complete list.

## Run locally

```sh
npm install
vercel dev
```

## Deploy

```sh
vercel deploy --prod
```

Environment variables are documented in `ARCHITECTURE.md`. Without any of the optional ones set, the site still works: submissions are stored in Blob; email/captcha/AI-questions simply switch off gracefully.
