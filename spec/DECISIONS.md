# Decision Log — Domain Health API

Each decision is **Decided** (build against it) or **Open** (needs founder approval before the dependent work ships). Claude Code builds Open items behind interfaces with the stated default, and does not provision, purchase, or connect anything for an Open item.

---

## Decided

| ID | Decision | Rationale |
|---|---|---|
| A-1 | **Separate repo and project**, not inside TrueChoice_Index. Suggested repo: `domain-health-api`. | Keeps micro-API experiments off TrueChoice's critical path. Reusable shell for later micro-APIs. |
| A-2 | **One endpoint** (`/v1/domain/check`) + health. No dashboard, no signup UI, no billing. | Smallest thing that can be shown working on X. |
| A-3 | **DNS-only.** The service never makes HTTP requests to user-supplied domains. | Removes the SSRF surface entirely; bounds cost. |
| A-4 | **No DKIM, no deliverability, no DMARC inheritance in V0.** Each is stated in `limitations`. | Honest scope; each needs extra input or data. |
| A-5 | **Spec-first.** SPEC.md + vectors are the source of truth; tests load the vector files directly. | Spec and tests can't drift. Same contracts-first method as `truechoice-spec`. |
| A-6 | **Never log domains, raw keys, or IPs.** | The domains developers check may be their clients'; this is a trust product. |
| A-7 | **Fail open** on rate-limit/usage store outages. | A metering outage shouldn't take the API down during a launch. |
| A-8 | **Zero incremental spend** without explicit approval. | Standing rule. |

---

## Open — needs your call

### D-1 · Durable store for rate limits and usage metrics
**Why it matters:** The launch gate ("10 signups, 3 repeat users in 7 days") requires remembering usage for at least 7 days. Vercel runtime logs are kept for **1 hour on Hobby and 1 day on Pro**, so logs alone can't measure a 7-day window. In-memory rate limits also reset per serverless instance.

| Option | Cost | Trade-off |
|---|---|---|
| **(a) Upstash Redis via Vercel Marketplace — free tier** *(recommended)* | $0 at launch volumes; new third-party account | Real per-key limits and 7-day metrics. Implementation uses its REST API through a thin adapter (no SDK lock-in). |
| (b) No durable store for launch | $0 | Rate limits are per-instance only (weak). No repeat-user metric. You would be measuring the launch blind. |
| (c) Another free store you already use (e.g. an existing database) | $0 | Fine if one exists and is separate from TrueChoice prod data. |

**Default if undecided:** build the store interface with in-memory + Upstash-REST adapters; ship with (b) and flag that metrics are not being captured.

### D-2 · How developers get API keys
**Why it matters:** The X post says "Free to try". Every manual step between the post and a first successful call loses people.

| Option | Trade-off |
|---|---|
| (a) Manual: you DM/email keys from `scripts/issue-key` | Zero build, zero abuse surface. High friction; doesn't scale past a few dozen. |
| **(b) Self-serve `POST /v1/keys` with email** *(recommended once D-1 = a)* | One-call signup, so a key appears instantly. Needs D-1, per-IP signup throttling, and one email-format check. No email verification in V0. Adds ~half a day. |
| (c) Public shared demo key, low limit (e.g. 20/day total) | Lowest friction for a first try, but can't count unique users. Best combined with (a) or (b). |

**Default if undecided:** (a) only. (b) is specced as a follow-on in BUILD_BRIEF.md Milestone 4 and is not built until approved.

### D-3 · Hosting plan and URL
**Why it matters:** Vercel's Hobby plan is restricted to non-commercial, personal use under its fair-use guidelines. A free experiment is arguably fine there; **charging for the API is not**.

| Option | Trade-off |
|---|---|
| (a) Hobby + `*.vercel.app` URL for the free launch; move to Pro before any paid tier | $0 now. A `vercel.app` URL looks less credible on X. Migration needed before monetizing. |
| (b) Your existing Pro team (if you have one), with a subdomain of a domain you already own | No new spend if Pro already exists. Credible URL. Commercial use is allowed. |
| (c) Buy a new domain for the micro-API brand | ~$10–15/yr. Requires purchase approval. |

**Default if undecided:** build is host-agnostic (Web-standard `Request`/`Response` handlers). Do not deploy until D-3 is answered.

### D-4 · Free-tier limits
Spec default (RL-1): **10/min, 200/day per key.** That's generous enough for real testing and low enough that one key can't run a bulk audit for free (the future paid feature). Confirm or adjust.

### D-5 · Name
Working name: **Domain Health API**. The X post and URL need a final name. No dependency on the build.

---

## Deferred (not V0, recorded so they aren't re-litigated)

- Bulk checks, scheduled monitoring, drift alerts, webhooks: the paid-tier hypothesis and the MSP angle. Build only after the launch gate is met.
- DKIM with a caller-supplied selector (`?dkim_selector=`): first candidate for V0.1.
- DMARC organizational-domain inheritance (needs the Public Suffix List).
- Implicit-MX (A-record fallback) evaluation.
- SPF void-lookup limit (RFC 7208 §4.6.4, max 2) and per-`mx` A-lookup limit.
- RapidAPI listing.
