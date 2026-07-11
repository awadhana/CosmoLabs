# CosmoLabs — Code Review Summary

**Scope:** entire repository (front end `index.html`, `api/` serverless backend, config & docs)
**Date:** 2026-07-09
**Method:** multi-agent review — four subsystem surveys, three defect hunts, adversarial verification of every candidate finding (17 of 19 confirmed), and synthesis.

> **Update — 2026-07-11 (historical note).** This document is a snapshot from 2026-07-09 and several of its findings have since been resolved. `package.json` now has a `scripts.test` and pinned dependencies; a Node test suite (96 tests) covers the security helpers, captcha round-trip, rate limiting, **intake validation + captcha-gate enforcement (end-to-end handler test)**, clarify helpers, email HTML-escaping, and EN/AR/FR dictionary parity; the CSP, `engines`, and `license` are set in `vercel.json`/`package.json`; the clarify endpoint is now captcha-gated and language-aware; server errors and the confirmation email are localized; captcha state changes are announced to screen readers; a Privacy Policy & Terms page (`legal.html`) was added; and `robots.txt`/`sitemap.xml` now exist. Read the sections below as the *2026-07-09* state, not today's.

---

## Verdict

CosmoLabs is a **mature, security-conscious codebase that punches well above the weight of a marketing site.** The serverless intake backend is the standout: a genuinely well-layered, never-trust-the-client design with defense-in-depth anti-abuse, fail-closed auth on its security boundary, and disciplined graceful degradation on every optional integration. The single-file trilingual front end is equally deliberate — true progressive enhancement, real RTL, and client validation kept in lock-step with the server so users rarely hit surprise `400`s.

Adversarial review surfaced **no critical or high-severity defects.** Every confirmed finding is low, nit, or medium, and they cluster in predictable "last-mile" areas: no automated tests/CI, a few production-hardening gaps (secrets, external-call timeouts), screen-reader announcement of error states, and some stale documentation.

> ### Overall grade: **A−**
> Architecturally strong, security-conscious, and production-capable, with genuinely elegant anti-abuse and graceful-degradation work. Held back from an A only by the complete absence of automated tests/CI and a handful of low-to-medium production-hardening and accessibility gaps.

---

## What the project is

A one-file marketing landing page plus a small Vercel serverless backend for **CosmoLabs**, a computing / aerospace / nuclear engineering consultancy. Its centerpiece is a 4-step *"What can we do for you?"* project-intake wizard: **brief → references/colors/documents → AI clarifying questions → review + human-check + submit.** Submissions are validated server-side, stored in a private Vercel Blob store, and emailed to staff; a future async pipeline (Hermes / Obsidian vault) consumes them.

**Stack:** static HTML/CSS/JS (no build step, no framework) + Node.js ESM serverless functions on Vercel. Three runtime deps: `@vercel/blob` (private storage), `@anthropic-ai/sdk` (`claude-opus-4-8` clarifying questions), `nodemailer` (Gmail SMTP). Design ethos throughout: *never trust the client; fail closed on auth; fail open (gracefully) on non-critical services.*

### At a glance

| | |
|---|---|
| Front end | `index.html` — 3,996 lines, fully self-contained (inline CSS ~1,157 lines, two inline scripts ~1,850 lines) |
| Backend | 9 files, ~1,236 LOC — 5 endpoints + 4 non-routable `_lib/` modules |
| Endpoints | `POST /api/intake`, `POST /api/clarify`, `GET /api/intake-config`, `GET /api/captcha`, `GET /api/admin/submissions` |
| i18n | EN / AR (RTL) / FR — 236 keys × 3 languages (~708 strings), hand-rolled runtime |
| Docs | `ARCHITECTURE.md` (355 lines, high quality), `README.md` (44 lines) |
| Tests / CI | **none** |

---

## Highlights — what's done well

- **Stateless proof-of-work captcha** is an elegant serverless fit: HMAC-signed and IP-bound with everything encoded in the salt, so verification needs no storage. `verifyCaptcha` checks the signature **first** via `crypto.timingSafeEqual` before trusting any salt/challenge contents.
- **Rigorous never-trust-the-client file handling:** size is measured from decoded bytes (never the declared size); base64 *length* is checked against the cap **before** `Buffer.from` allocates, so oversized payloads never materialize; filenames are basename-only with a charset whitelist and `..` collapsing (path-traversal-proof); magic-byte sniffing rejects renamed payloads.
- **Storage write-ordering is a real correctness guarantee**, not just convention: files are written to Blob *before* `submission.json`, so the manifest's presence atomically signals "ready" to the pipeline and can never reference a missing blob.
- **Disciplined graceful degradation:** email is fully best-effort with per-send isolation and a hard no-throw guarantee; `/api/clarify` returns `200` with static fallback questions on *any* failure (missing key, timeout, malformed model output) so the wizard never stalls.
- **Fail-closed security boundary:** the admin endpoint returns `503` when `INTAKE_ADMIN_TOKEN` is unset and `401` otherwise, using a length-safe constant-time compare (SHA-256 digests + `timingSafeEqual`).
- **True progressive enhancement:** final metric numbers, hero imagery, and all copy render without JS; a `<noscript>` block routes the wizard to email; JS-only controls (marquee pause, clarify spinner) appear only once JS runs — no dead controls.
- **Complete trilingual coverage** with genuine RTL handling (dir flip, logical CSS properties, Cairo font) rather than machine-translation stubs.
- **Honest self-documentation:** the in-memory rate limiter, the captcha same-IP replay window, and the Content-Length pre-check are all explicitly labelled best-effort with the recommended hardening path — exactly what a reviewer wants to see.
- **Correct, current Anthropic SDK usage:** structured `json_schema` output, no sampling params the model rejects, a bounded 10s timeout, `maxRetries: 0` to respect the serverless request budget.

---

## Findings

17 findings confirmed after adversarial verification (deduplicated to 15 unique below; two were reported by more than one reviewer). **No critical or high-severity issues.**

| # | Severity | Area | Finding | Location |
|---|----------|------|---------|----------|
| 1 | 🟠 Medium | Security | PoW captcha HMAC secret silently falls back to a repo-committed constant in production | `api/_lib/captcha.js:33` |
| 2 | 🟠 Medium | Accessibility | `role="alert"` error regions are `display:none`/`hidden` when their text is set — screen readers may not announce ref/file/submit errors (WCAG 4.1.3) | `index.html:757` |
| 3 | 🟠 Medium | Testing | No tests and no CI over security-critical validation / captcha / auth logic | `package.json` |
| 4 | 🟡 Low | Robustness | Turnstile `siteverify` fetch has no timeout — a hung Cloudflare request can stall intake into a platform 504 instead of the intended graceful 400 | `api/intake.js:248` |
| 5 | 🟡 Low | Correctness | Phone validation accepts zero digits; error copy misleadingly promises "7-25 digits" | `api/_lib/security.js:145` |
| 6 | 🟡 Low | Correctness | Late `/api/intake-config` never re-runs `setupCaptcha()`, so a Turnstile key arriving after step 4 double-renders both human checks | `index.html:3232` |
| 7 | 🟡 Low | Correctness | Language switch after a successful submission throws an uncaught `TypeError` in `renderCaptcha()` (detached card) | `index.html:3659` |
| 8 | 🟡 Low | i18n | Dynamic wizard strings (fallback clarify questions, color-swatch aria-labels) aren't re-translated on language change | `index.html:3840` |
| 9 | 🟡 Low | Security | All three deps pinned to `"latest"` — reproducible only because the lockfile constrains them; any regen floats them (incl. pre-1.0 SDK) | `package.json:6` |
| 10 | 🟡 Low | Security | CSP is scoped to exact path `/`, so `/index.html` is served with no CSP | `vercel.json:15` |
| 11 | 🟡 Low | Security | CSP relies on `'unsafe-inline'` for scripts/styles (by-design single-file tradeoff) | `vercel.json:19` |
| 12 | 🟡 Low | Config | No `license` and no `engines.node` pin, despite `@vercel/blob` requiring Node ≥20 | `package.json:3` |
| 13 | 🟡 Low | Docs | `ARCHITECTURE.md` diagram & file table say email uses "Resend"; code is Gmail SMTP via nodemailer | `ARCHITECTURE.md:25,39` |
| 14 | ⚪ Nit | Docs | `submission.json` meta schema omits the `powVerified` field the code writes | `ARCHITECTURE.md:226` |
| 15 | ⚪ Nit | Accessibility | Mobile-menu auto-close on resize can drop keyboard focus to `<body>` | `index.html:3041` |

### Findings grouped by theme

**1 · Testing & verification infrastructure** *(the single most material gap)*
`package.json` has no `scripts` section and the repo has no CI, so the security-critical surface — server-side validators, captcha HMAC/PoW verification, magic-byte sniffing, filename sanitization, timing-safe token compare, rate limiter — has **zero automated coverage.** A regression in validation or auth would ship silently. *(Finding 3.)*

**2 · Production hardening of security defaults**
A few controls fail open or unbounded rather than refusing. The PoW captcha HMAC secret silently falls back to the repo-committed constant `"cosmolabs-captcha-dev-only"` when both `CAPTCHA_SECRET` and `INTAKE_ADMIN_TOKEN` are unset — with Turnstile off, that makes the "mandatory" human check offline-forgeable (blast radius bounded by the per-IP rate limit; partly documented as "set in prod"). The Turnstile `siteverify` fetch has no timeout, deviating from the codebase's own 10s bound in `clarify.js`. The strong CSP is scoped to exact path `/` (missing `/index.html`) and leans on `'unsafe-inline'`. *(Findings 1, 4, 10, 11.)*

**3 · Accessibility of error & focus states**
The core intake flow is strongly accessible, but its error feedback is not: `role="alert"` regions for reference/file/submit errors are `display:none`/`hidden` at the moment their text is set, so the insertion event that triggers a screen-reader announcement is unreliable — and unlike step-1 field errors, these paths neither move focus nor are referenced by any `aria-describedby`. The mobile menu's resize auto-close can drop keyboard focus with no relocation. Both are inconsistent with the author's own good focus-management patterns elsewhere. *(Findings 2, 15.)*

**4 · Front-end wizard state edge cases**
Several narrow but real client-state bugs: a late-resolving config double-renders both human checks; a post-submit language switch throws an uncaught `TypeError` against the now-detached card; and dynamic wizard strings aren't re-translated on language change. All low impact (server-side enforcement is unaffected), but each is a genuine oversight. *(Findings 6, 7, 8.)*

**5 · Documentation & message accuracy**
Small, concrete code/doc drift: `ARCHITECTURE.md`'s diagram and file table say email uses "Resend" while the code is Gmail SMTP via nodemailer (the same doc's env table is already correct); the `submission.json` meta schema omits the `powVerified` field; and the phone-validation error copy promises "digits" while the regex counts characters. *(Findings 5, 13, 14.)*

**6 · Supply-chain & config reproducibility**
All three runtime deps are pinned to the literal string `"latest"` — today's builds are reproducible only because the committed lockfile constrains them (`@vercel/blob 2.5.0`, `@anthropic-ai/sdk 0.110.0`, `nodemailer 9.0.3`). No `engines.node` pin despite Node ≥20 requirement; no license. *(Findings 9, 12.)*

---

## Prioritized recommendations

1. **Add tests + CI.** A `node --test`/vitest suite for the validators, captcha verify, magic-byte checks, filename sanitization, and token compare, plus a GitHub Actions workflow on every PR. *(Closes the biggest gap.)*
2. **Fix screen-reader announcement of wizard errors** — keep `role="alert"` containers rendered and toggle only their text, or move focus to a control that references each error via `aria-describedby`.
3. **Harden the captcha secret** — refuse to issue/verify challenges in production (`VERCEL_ENV`/`NODE_ENV`) when neither `CAPTCHA_SECRET` nor `INTAKE_ADMIN_TOKEN` is set, instead of using the hardcoded constant.
4. **Bound the Turnstile fetch** — wrap it in an `AbortController` with a ~10s timeout and treat an abort like the existing catch branch.
5. **Extend the CSP to all HTML routes** — move it into the `/(.*)` block (or add `/index.html`).
6. **Pin dependencies to caret ranges** of their locked versions and add `engines.node: ">=20"` (and a `license` field).
7. **Resolve the front-end wizard edge cases** — call `setupCaptcha()` alongside `setupTurnstile()` in the config `.then`, guard `renderCaptcha()`'s label/button lookups against the detached card, and re-render dynamic i18n strings on language change.
8. **Correct the docs** — relabel the two `ARCHITECTURE.md` "Resend" references to "Gmail SMTP (nodemailer)", add `powVerified` to the `submission.json` meta schema, and align the phone-validation error copy with the actual rule.

---

## Subsystem notes

**Backend (`api/`)** — Fixed guard chain on every endpoint (`method → content-type → size → same-origin → rate-limit → validate`). Anti-abuse on `/api/intake` is genuinely defense-in-depth: honeypot + 3s time-gate (silent drop, zero signal to bots) → per-IP sliding-window rate limit → full server-side validation → mandatory human check (Turnstile server-verified *or* PoW captcha) → magic-byte file sniffing. Rate buckets: intake 8 / clarify 6 / captcha 30 per 10 min. Clean layering, accurate header comments, correct crypto primitives.

**Front end (`index.html`)** — 12 sections plus a 4-step intake wizard, all in one dependency-free file. Client validation mirrors the server (URL parsing, filename sanitization, byte/extension caps sourced from `/api/intake-config`). Heavy but tastefully gated animation (page-wide starfield, video hero) with thorough `prefers-reduced-motion`/`reduced-data` fallbacks. Hand-rolled i18n runtime with a `cosmolabs:langchange` event bus and a fully keyboard-navigable listbox language switcher.

**Security posture** — Strong. Private-by-default Blob store, fail-closed admin auth, no secret/internal leakage (generic `500`s, ids-only logs), hardened site-wide headers (nosniff, `X-Frame-Options: DENY`, 2-year HSTS, COOP, Permissions-Policy) plus a strict CSP. Stated known limits (best-effort in-memory rate limit, replayable-until-expiry captcha) are honestly documented and bounded.

**Config & docs** — Zero-build Vercel deploy; all env vars optional with graceful degradation; secrets kept out of git. `ARCHITECTURE.md` is high quality (system diagram, exact API contract with all status codes, Blob layout, env-var table, runnable pipeline-integration guide). Main gaps are the missing tests/CI and the minor doc drift above.
