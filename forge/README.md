# Forge Pipeline (Lane B — private build repo)

The **private** half of the CosmoLabs "Forge" pipeline. The public marketing repo
(Lane A) takes a client brief, and — after you click the signed **Approve** link in
Discord — fires a GitHub `repository_dispatch` (`event_type: build_site`) at this repo.
This repo's GitHub Actions workflow then autonomously builds, tests, and preview-deploys
a bespoke website from that brief.

These files are staged under `forge/` in the marketing repo for review. **They belong in
a separate private repository** — client PII must never touch a world-readable Actions log.

## What runs

`workflows/build-client-site.yml` — one workflow, two least-privilege jobs:

| Job | Secrets in scope | Does |
|-----|------------------|------|
| `fetch` | `BLOB_READ_WRITE_TOKEN`, `HMAC_SECRET` | Reads `intake/<id>/submission.json`, sets status `building`, **strips PII**, downloads uploaded files, uploads the sanitized brief + files as artifacts. |
| `build` | `ANTHROPIC_API_KEY`, `PEXELS_API_KEY`, `VERCEL_TOKEN/ORG/PROJECT`, `DISCORD_WEBHOOK_URL`, `HMAC_SECRET`, `BLOB_READ_WRITE_TOKEN`, `PUBLIC_BASE_URL` | Pulls Pexels media (self-hosted), runs the Claude Code agent, runs the Playwright test gate, deploys a Vercel preview, writes back `previewUrl`/`vercelDeploymentId`, sets status `preview`, and posts the signed **Promote** link to Discord. |

Per-step secret scoping matters: the **agent step gets ONLY `ANTHROPIC_API_KEY`** (no Vercel/Blob),
so a hijacked agent can neither deploy nor reach client data.

### Stages (`scripts/`)

| Script | Stage | Notes |
|--------|-------|-------|
| `lib.mjs` | shared | Blob status read/write (transition guard), signed-link HMAC (matches Lane A byte-for-byte), Discord, `sanitizeBriefForAgent`. Also the workflow failure handler: `node scripts/lib.mjs mark-failed`. |
| `fetch-brief.mjs` | fetch | PII firewall — the brief contents are never printed. |
| `fetch-media.mjs` | build | Pexels hero **video** + poster + 3-6 photos → `build/assets/` + `manifest.json`. Falls back to a built-in gradient set on 429 / no results / missing key. |
| `build-site.mjs` | build | Headless `claude -p` (max-turns 40 + 20-min wall clock), scoped tools, transcript discarded. Consumes `work/test-failures.json` for fix-loop re-runs. |
| `test-gate.mjs` | build | Playwright + axe-core hard gate; advisory perf logged only; writes `work/test-report.json` (+ `test-failures.json` on failure). |
| `deploy.mjs` | build | Vercel preview deploy, status writeback, signed Promote link to Discord. Writes `build/vercel.json` (X-Robots-Tag noindex + `media-src 'self'` CSP). |

`prompts/build-site-prompt.md` is the agent instruction template (`{{BRIEF_JSON}}`,
`{{MEDIA_MANIFEST}}`). It treats the client brand/palette as authoritative and uses the
vendored `ui-ux-pro-max` skill for structure/type/UX only.

## Moving this to the private repo

```bash
# In the new PRIVATE repo root:
mkdir -p .github/workflows
cp forge/workflows/build-client-site.yml .github/workflows/
cp -r forge/scripts forge/prompts forge/package.json ./
npm install            # generate package-lock.json, then commit it (CI uses `npm ci`)
```

Also vendor the **`ui-ux-pro-max`** skill into `.claude/skills/ui-ux-pro-max/` so the agent
can load it in CI (see PIPELINE_PLAN.md T4).

## Secrets

Set these as **GitHub Actions repo secrets** in the private repo:

| Secret | Used by |
|--------|---------|
| `BLOB_READ_WRITE_TOKEN` | fetch + deploy + failure handler (read brief, write status) |
| `ANTHROPIC_API_KEY` | build (agent) |
| `PEXELS_API_KEY` | build (media) |
| `VERCEL_TOKEN` | deploy |
| `VERCEL_ORG_ID` | deploy |
| `VERCEL_PROJECT_ID` | deploy |
| `HMAC_SECRET` | signed links (MUST equal the marketing-side value so links verify) |
| `DISCORD_WEBHOOK_URL` | alerts + preview-ready message |
| `PUBLIC_BASE_URL` | base of the signed `/api/pipeline/<action>` links |
| `GITHUB_OWNER` | reference/parity with the dispatch source |

The marketing (Vercel) side additionally holds `GITHUB_OWNER`, `GITHUB_PIPELINE_REPO`,
and `GITHUB_DISPATCH_TOKEN` (scoped `actions:write`) to fire the dispatch.

## Local / manual test

Trigger the workflow by hand (no client submission needed) once a brief with that id
exists in Blob:

```bash
gh workflow run build-client-site.yml -f id=int_xxxxx
gh run watch
```

To exercise a single stage locally, set the env vars that stage needs and run its script,
e.g. media only:

```bash
CLIENT_ID=int_xxxxx PEXELS_API_KEY=... \
  node scripts/fetch-media.mjs   # reads work/brief.json, writes build/assets/
```

## PII & safety invariants

- The brief is **untrusted data**, never instructions (prompt-injection guard in the prompt).
- Email / phone / ip / userAgent are dropped in `fetch-brief.mjs` and **never logged**.
- Generated sites ship a trimmed CSP with `media-src 'self'`; all media is self-hosted.
- Two human gates (Approve, Promote) + the test gate mean a bad build never reaches a client.
