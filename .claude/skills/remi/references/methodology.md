# ReMi methodology — frameworks, seed benchmarks, and the source-quality bar

How ReMi researches, scores, and kills recommendations. Seed data below was gathered and cited 2026-07-14; re-verify anything older than ~6 months before quoting it in a report.

## Funnel model

Map every recommendation to exactly one stage: **Attract → Engage → Trust → Act → Follow up.**
On this site: Attract = traffic/SEO/channels (mostly off-page today), Engage = hero → mid-page journey, Trust = proof sections + legal + AI framing, Act = `#start` wizard + `#contact`, Follow up = everything after `POST /api/intake` (emails, Forge pipeline, nurture — currently the thinnest stage).

## Scoring: ICE

`ICE = Impact × Confidence ÷ Effort`, each 1–10. Confidence is **capped by evidence tier** (below): Tier A caps at 9, Tier B at 7, Tier C at 4. An untestable recommendation (no way to measure its effect post-launch) loses 2 Confidence. Rank the report by ICE; ties break toward lower Effort.

## Source-quality bar

- **Tier A — primary quantitative research:** Baymard, Nielsen Norman Group, Gartner, CSA Research, W3C/WAI; official vendor docs *for facts about their own product* (pricing, data handling).
- **Tier B — benchmark reports with stated sample size and year:** First Page Sage, Ruler Analytics, Chili Piper, Demand Gen Report surveys.
- **Tier C — vendor marketing stats** (chat "23% lift", calculator "493% ROI"): directional only, never the sole justification, always labeled "hypothesis to test".

Rules: every number carries its year; single-sourced claims are marked as such; evidence measured on e-commerce/B2C does not transfer to enterprise consulting without an explicit caveat; a pattern seen at one comparator is an anecdote — cite patterns that repeat.

## Seed benchmarks (cited 2026-07-14)

- **Engineering B2B visitor→lead ≈ 1.2%** (software dev 1.1%, IT services 1.5%; data 2022–Aug 2025). The realistic baseline — not the 4–10% in listicles. — First Page Sage, [B2B Conversion Rates by Industry](https://firstpagesage.com/reports/b2b-conversion-rates-by-industry-fc/) (Sep 2025)
- **Professional services 6.1% "qualified lead" conversion, but 52.6% of those are phone calls**, not forms. — Ruler Analytics, [Conversion Rate Benchmarks](https://www.ruleranalytics.com/blog/insight/conversion-rate-by-industry/) (2026)
- **Manual follow-up books ~30% of qualified form-fillers into meetings vs 66.7% with an embedded scheduler**; ~14% of B2B form fills are spam (4M submissions, 2024). — Chili Piper, [Form Conversion Benchmark](https://www.chilipiper.com/post/form-conversion-rate-benchmark-report) (2025)
- **61% of B2B buyers prefer a rep-free experience** (67% in the 2026 wave); buyers spend ~17% of the journey with suppliers — the website carries the evidentiary load. — [Gartner sales survey](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-sales-survey-finds-61-percent-of-b2b-buyers-prefer-a-rep-free-buying-experience) (Jun 2025)
- **Case studies: 42% of B2B buyers rank them the single most influential content type**; ~73% of decision-makers say they significantly influence purchase. — Sopro, [B2B Buyer Statistics](https://sopro.io/resources/blog/b2b-buyer-statistics-and-insights/) (2025)
- **Gated content is declining** (eBook downloads −5%, report requests −26%, 2024–25); Forrester: "gate later and less". — [Factors.ai citing Forrester](https://www.factors.ai/blog/is-gated-content-dead-in-b2b-marketing-what-works-now)
- **Multi-step forms ~13.85% vs ~4.53% single-page** (aggregated vendor data — Tier B/C, treat cautiously; the driver is perceived effort and field count, not step count). — [Numinam guide](https://www.numinam.com/en/blog/multi-step-vs-single-page-forms-which-really-generates-more-leads-complete-guide-2026) (2026)
- **Wizard design:** show all steps upfront, sequence low-friction/qualifying questions first, contact details last. — NN/g, [Wizards](https://www.nngroup.com/articles/wizards/); W3C WAI, [Multi-page forms](https://www.w3.org/WAI/tutorials/forms/multi-page/)
- **Visible CAPTCHAs: 8% failure rate (29% case-sensitive), abandonment after two failures** (n=1,027); invisible/PoW challenges recommended. — Baymard, [CAPTCHAs in Checkout](https://baymard.com/blog/captchas-in-checkout)
- **~95% of users react negatively to popups**; "please-don't-go" patterns read as needy. — NN/g, [Needy Design Patterns](https://www.nngroup.com/articles/needy-design-patterns/)
- **65% of buyers prefer native-language content; 40% won't buy without it** (29 countries, 2020 wave — grounds the EN/AR/FR investment). — CSA Research, [Can't Read, Won't Buy](https://info.lionbridge.com/WB-20208-26-CantReadWontBuy_LP.html)
- **Arabic RTL: don't pure-mirror** — numerals/media controls/logos stay LTR, nav and progress mirror, Arabic glyphs need ~10% larger sizing. — [Hamrix RTL guide](https://hamrix.com/ksa/blog/arabic-rtl-ui-ux-design-guide)
- **Federal buyers triage a capability statement in ~6 seconds**: 4–6 concrete competencies, verifiable past performance, and NAICS/UEI/CAGE codes matching SAM.gov exactly — mismatches disqualify before capabilities are read. — [USFCR](https://blogs.usfcr.com/capabilities-statement) (2026), [GovCon Chamber](https://www.govconchamber.com/blog/6-second-government-contracting-capability-statement)
- **Enterprise committees read a small vendor's site as a risk document** — role-specific paths (security/compliance for the CISO, outcome-anchored case studies for evaluators) beat badges; social proof works as decision *defensibility*. — [Everything.design](https://www.everything.design/blog/trust-signals-b2b-website) (2025/26)

## Analytics tooling (evaluated 2026-07)

| Tool | Verdict for this site |
|---|---|
| **Vercel Web Analytics** | First choice: cookie-free, anonymous-aggregate, no consent banner (EU/Morocco/US), free ≤50K events/mo on Hobby (pauses at cap; Pro 100K then $3/100K). Custom events cover the wizard funnel. ([pricing](https://vercel.com/changelog/up-to-80-pricing-reduction-for-web-analytics), May 2025) |
| **Plausible (EU cloud)** | The upgrade if funnel visualization is needed: cookieless, daily salt rotation, no banner, $9/mo; script proxyable through own domain. ([data policy](https://plausible.io/data-policy)) |
| **Umami (self-hosted)** | Only if self-hosting exists — contradicts the static/serverless posture; monthly salt rotation weakens the privacy story. |
| **GA4** | **Avoid.** Cookie/identifier-based → GDPR consent banner *and* Morocco Law 09-08 CNDP obligations ([CNDP cookie rules](https://kukie.io/blog/cookie-consent-morocco-law-09-08)); the banner itself is conversion friction on this audience. |
| **PostHog** | Overpowered for now; revisit only if session-replay/experiments become central. |

Implementation constraint regardless of tool: the CSP in `vercel.json` blocks third-party beacons (`connect-src 'self' https://challenges.cloudflare.com`) — every analytics recommendation must name its CSP change **and** its `legal.html` disclosure update. Cookieless tools keep the "no advertising or cross-site tracking cookies" promise intact; verify before recommending.

## Kill list — advice that is wrong for THIS audience

Recommendations matching these die in verification regardless of how often the tactic appears in CRO content:

1. **Inflated benchmarks as targets.** The only industry-matched figure is ~1.2%; Ruler's 6.1% counts phone calls and qualified leads. Targets set off listicle numbers drive harmful "optimizations".
2. **Fake urgency, countdown timers, artificial scarcity, decoy pricing.** FTC/ICPEN swept 642 sites in 2024 (75.7% had ≥1 dark pattern); federal contracting officers buy defensibility — one detected manipulation reclassifies the vendor as risk. ([Usercentrics summary](https://usercentrics.com/knowledge-hub/dark-patterns-and-how-they-affect-consent/))
3. **Aggressive popups / exit-intent overlays.** NN/g ~95% negative; consumer-grade marketing signals on a managed federal network. If exit-intent ever: once, relevant, trivially dismissible.
4. **Gating the core evidence** (case studies, capability statement, past performance) — buyers research anonymously; gating the assets a contracting officer needs removes you from consideration silently.
5. **Over-shortening the intake form to chase raw conversion.** For high-ticket consulting a qualified 4% beats an unqualified 10%; fix length with step structure and question ordering, not by deleting qualification.
6. **Adding a second visible challenge or Google reCAPTCHA.** The existing PoW is the right pattern (keep it as invisible/automatic as possible); reCAPTCHA adds EU + Morocco consent obligations.
7. **Vendor chat/chatbot/calculator stats as proof.** Selection-biased marketing; a chatbot that can't answer technical questions damages credibility with engineers more than no chat. Experiments only, honestly labeled — and never a fake "AI assistant" posing as human.
8. **Machine-translated or CSS-mirrored Arabic.** Reads as foreign, increases drop-off; and all three dictionaries move in lockstep (test-enforced).
9. **Trust-signal theater** — stock team photos, invented awards, claims that don't match SAM.gov records. (The existing client names are real per the owner; the research question is substantiation, not removal.)
10. **Consent-banner-requiring analytics or marketing pixels** — the banner suppresses the very conversions being measured, and breaks the site's "no tracking cookies" promise in legal.html.
