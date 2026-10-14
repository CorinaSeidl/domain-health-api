# Decision Log — Domain Health API

Each decision is **Decided** (build against it) or **Open** (needs founder approval before the dependent work ships). Claude Code builds Open items behind interfaces with the stated default, and does not provision, purchase, or connect anything for an Open item.

---

## Decided

| ID | Decision | Rationale |
|---|---|---|
| A-1 | **Separate repo and project**, not inside TrueChoice_Index. Suggested repo: `domain-health-api`. | Keeps micro-API experiments off TrueChoice's critical path. Reusable shell for later micro-APIs. |
| A-2 | **One check endpoint** (`/v1/domain/check`) + health. No dashboard, no billing. The only additions are self-serve keys and their landing page (D-2). | Smallest thing that can be shown working on X. |
| A-3 | **DNS-only.** The service never makes HTTP requests to user-supplied domains. | Removes the SSRF surface entirely; bounds cost. |
| A-4 | **No DKIM, no deliverability, no DMARC inheritance in V0.** Each is stated in `limitations`. | Honest scope; each needs extra input or data. |
| A-5 | **Spec-first.** SPEC.md + vectors are the source of truth; tests load the vector files directly. | Spec and tests can't drift. Same contracts-first method as `truechoice-spec`. |
| A-6 | **Never log domains, raw keys, or IPs.** | The domains developers check may be their clients'; this is a trust product. |
| A-7 | **Fail open** on rate-limit/usage store outages. | A metering outage shouldn't take the API down during a launch. |
| A-8 | **Zero incremental spend** without explicit approval. | Standing rule. |
| D-1 | **Upstash Redis, free tier, added through the Vercel Marketplace**, as the durable store for rate limits and usage metrics. | Real per-key limits and 7-day metrics for the launch gate, at $0 and without SDK lock-in (thin REST adapter). |
| D-2 | **Self-serve keys: option (b)**, `POST /v1/keys` served from a landing page at `GET /`. **Revised Oct 2026: email is optional, not required**, and keys are not limited per email. | One-call signup removes the manual step between the X post and a first successful call; an email gate cost signups without adding real signal (per-key usage is the signal). Needs D-1 (Upstash) for key storage and per-IP throttling. Specified in SPEC §11 and §13. |
| D-3 | **Vercel Hobby with a `*.vercel.app` URL**, free launch only; move to Pro before any paid tier. | $0 now. Hobby is restricted to non-commercial use, so charging for the API requires Pro first. |

---

## Open — needs your call

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
