---
status: SETUP CHECKLIST
---
# Forge — Operator Setup Checklist

Take the Forge pipeline live, in order. Each box is a hard step; the earlier
boxes gate the later ones. Companion to `PIPELINE_PLAN.md` (the frozen contract).
Do these top-to-bottom — do not skip ahead, the smoke test at the end only passes
if every prior box is green.

## Live checklist

- [ ] **1. Clear the GitHub billing lock.** GitHub → Settings → Billing. This is a
  **hard blocker** — private-repo Actions will not run a single job until billing is
  in good standing. Nothing else in this list matters until this is green.

- [ ] **2. Create the PRIVATE pipeline repo** (e.g. `cosmolabs-forge`). It **must be
  private** — client PII flows through the runner and Actions logs on a public repo
  are world-readable.
  - Move `forge/workflows/*` → `.github/workflows/` in the new repo.
  - Move `forge/scripts`, `forge/prompts`, `forge/package.json`, `forge/README` → the
    repo root.
  - Verify: `gh repo view <owner>/<repo>` shows `visibility: private`.

- [ ] **3. Create the media + AI + deploy accounts/keys.** Collect these before
  touching env vars — you set them in steps 5 and 6.
  - **Pexels API key** — sign up at pexels.com/api (stock media, self-hosted).
  - **Anthropic API key** — for the headless agent build.
  - **Vercel token + org id + a `client-demos` project id** — preview deploys land in
    this project; go-live provisions per-client projects separately.
  - **Discord Incoming Webhook URL** — a channel webhook (Channel → Edit → Integrations
    → Webhooks). Plain links, not buttons — a webhook cannot render interactive buttons.

- [ ] **4. Generate `HMAC_SECRET`** — `openssl rand -hex 32`. Set the **SAME value on
  BOTH sides** (Vercel marketing env + pipeline-repo Actions secret). If the two sides
  disagree, every signed approve/skip/promote link fails verification and the loop
  silently stalls at the notify step.

- [ ] **5. Set Vercel (marketing) env vars.** Project → Settings → Environment
  Variables. `BLOB_READ_WRITE_TOKEN` is already provisioned by Vercel Blob — do not
  overwrite it. Add:
  - `HMAC_SECRET` — same value as step 4.
  - `DISCORD_WEBHOOK_URL`
  - `GITHUB_OWNER`
  - `GITHUB_PIPELINE_REPO`
  - `GITHUB_DISPATCH_TOKEN` — a **fine-grained PAT** scoped to **`actions:write` on the
    one private repo only** (least privilege — this token can trigger builds).
  - `PUBLIC_BASE_URL` — the marketing site's public origin; signed links are built from
    it, so it must exactly match where `/api/pipeline/*` is served.

- [ ] **6. Set pipeline-repo Actions secrets.** Repo → Settings → Secrets and variables
  → Actions:
  - `BLOB_READ_WRITE_TOKEN` — read the brief / write back preview fields.
  - `ANTHROPIC_API_KEY`
  - `PEXELS_API_KEY`
  - `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` (the `client-demos` project).
  - `HMAC_SECRET` — same value as step 4.
  - `DISCORD_WEBHOOK_URL`
  - `PUBLIC_BASE_URL`
  - `GITHUB_OWNER`

- [ ] **7. Vendor the `ui-ux-pro-max` skill into the pipeline repo** under
  `.claude/skills/ui-ux-pro-max/` (commit it, or install however the runner expects) so
  the headless agent can invoke it. The skill lives on the laptop, not the runner — the
  runner has only what the repo ships.

- [ ] **8. Phase 0 smoke test — end to end.** Trigger the workflow via
  `workflow_dispatch` with a test `id` and walk the full loop:
  1. Discord notify message arrives (title/description only, no PII).
  2. Click the signed **Approve** link → status `new` → `approved` → `repository_dispatch`.
  3. Actions build runs → status `building` → test gate → `preview`.
  4. Discord preview message arrives with the preview URL + signed **Promote** link.
  5. Click **Promote** → status `done` → client email fires.
  - Verify: grep the Actions logs to confirm **no email/phone/ip/userAgent** appears
    anywhere.

## How the two gates work

Forge is safe by construction because a human stands at both ends and a machine
stands in the middle — a bad build can never reach a client without you clicking twice.

- **Gate 1 — Approve-to-start (front gate).** When a brief lands, the intake fires a
  Discord message with a signed **Approve** link and a signed **Skip** link. Nothing
  spends compute until you click Approve. Approving flips status `new → approved` and
  sends `repository_dispatch` to the pipeline repo, which starts the build. Skip flips
  it to `dropped`. This is the **cost valve** — junk and off-brand briefs die here for
  free (TTL: 7 days).

- **Gate 2 — Promote-to-live (preview gate).** After the runner builds, tests, and
  deploys a **preview**, it posts a second Discord message with the preview URL and a
  signed **Promote** link. You review the actual rendered site, then click Promote to
  provision the per-client Vercel project, alias it live, flip status to `done`, and
  email the client (TTL: 30 days). Not promoting = the site never goes live; rollback is
  simply "don't click."

Between the gates, an automated **test gate** (Playwright hard checks + advisory
Lighthouse perf, 3-attempt fix loop) is the third backstop. All links are HMAC-signed
(`HMAC-SHA256(HMAC_SECRET, action + "." + id + "." + exp)`), expiry-checked, and
single-use via the status guard, so a forged or replayed link can't drain cost or
promote junk.

## Cost reality (from the T-0 spike)

- **Free-Actions ceiling ≈ ~80 builds/month.** ~2,000 free private-repo Actions
  minutes/month ÷ ~25 min/build. This is a real ceiling, not "effectively unlimited" —
  plan volume against it and watch the meter.
- **~$1–4 per build** in Anthropic tokens for a real design → build → test → 1–2 fix
  loop on Opus (the spike's single clean pass was cheaper; a real CI run with the fix
  loop is the ~$1–4 figure). Wall-clock counts as billable Actions minutes even while
  waiting on the model — the `--max-turns` + 20-min wall-clock caps bound both.
- Gate 1 is the mitigation: nothing spends until you approve, so the ceiling only
  applies to briefs you actually greenlight.
