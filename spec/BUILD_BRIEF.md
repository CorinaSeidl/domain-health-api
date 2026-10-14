# Build Brief — Domain Health API V0 (for Claude Code)

Hand this file to Claude Code together with the rest of this folder. It says **how** to build. `SPEC.md` says **what** to build and wins any conflict.

---

## Objective

Implement `SPEC.md` V0 exactly, with every vector passing and every rule ID covered by a test. Do not deploy, provision services, or purchase anything. Stop at a green PR. Deployment waits on `DECISIONS.md` D-1 and D-3.

## Ground rules

1. **Spec is the source of truth.** If the spec is ambiguous or seems wrong, **stop and ask** (or open a GitHub issue labeled `spec-question`). Do not decide silently. Never edit `spec/` to make a test pass.
2. **Tests load `spec/vectors/*.json` directly.** Do not copy vectors into test files.
3. **Every test name includes its rule ID(s) or vector ID**, e.g. `SPF-V24 [SPF-16] lookup count over 10 is invalid`.
4. **No network in tests.** All DNS goes through the injectable resolver (DNS-1). CI must pass offline.
5. **Open decisions are built behind interfaces with their stated defaults** (`DECISIONS.md`). Don't wire real third-party accounts.
6. **Minimal dependencies.** Prefer Node built-ins (`node:dns/promises`, `node:crypto`, `node:net`, `node:url`). Each added runtime dependency needs a one-line justification in the PR.

## Environments

| Stage | Where | Why |
|---|---|---|
| Build (M1–M3) | **Claude Code cloud sessions** against the `domain-health-api` GitHub repo, one session per milestone issue | The test suite is offline by design (DNS-1), so the sandbox's network limits don't matter. Work lands as PRs. |
| Quality gate | **GitHub Actions CI** on every PR: typecheck, lint, tests, `check-rule-coverage` | Same gate as the rest of the pipeline. |
| Live smoke test (Acceptance #4) | **Manual `workflow_dispatch` GitHub Actions job** (`.github/workflows/smoke.yml`), or a local machine. **Never in a Claude Code cloud sandbox.** | Sandbox DNS is filtered: real domains such as `google.com` come back `ENOTFOUND`. Run there, the API would report every real domain as nonexistent. |
| Production | Vercel Functions (pending D-3) | Normal public DNS. |

**Rule for the implementer:** do not run live DNS queries from the build sandbox, and never change code because of what live DNS returns there. If a live check seems necessary, stop and ask.

## Stack

| Concern | Choice |
|---|---|
| Runtime | Node 22, TypeScript (strict), ESM |
| Hosting target | Vercel Functions using **Web-standard** handlers (`export async function GET(request: Request): Promise<Response>`). Keep the core framework-agnostic so the host can change (D-3). |
| DNS | `node:dns/promises` `Resolver` with timeout/tries per DNS-3, wrapped by the DNS-1 interface |
| Tests | Vitest (or `node:test`; pick one and stay consistent) |
| Contract validation | Ajv (2020-12) compiled from `spec/openapi.yaml` component schemas; every handler test validates the response body against them (Acceptance #3) |
| Lint/format | ESLint + Prettier, defaults |

## Repo layout

```
domain-health-api/
  spec/                      ← this folder, copied verbatim (SPEC.md, openapi.yaml, vectors/, DECISIONS.md)
  src/
    core/
      normalize.ts           § 2  IN-*
      dns.ts                 § 3  DNS-* (resolver interface, classification, budget, query cap)
      spf.ts                 § 4  SPF-*
      dmarc.ts               § 5  DM-*
      mx.ts                  § 6  MX-*
      check.ts               § 7  orchestration, RES-*, SCOPE-*
      issues.ts              § 9  issue code registry + message builders
    http/
      handler.ts             § 8  routing, envelope, headers (framework-agnostic)
      auth.ts                AUTH-*
      ratelimit.ts           RL-*
      usage.ts               USE-*
      store/                 interface + memory.ts + upstash-rest.ts (D-1, not wired)
  api/v1/domain/check.ts     thin Vercel adapter → http/handler
  api/v1/health.ts
  test/
    harness/fake-dns.ts      builds a resolver from the vectors' zone format (vectors/README.md)
    vectors.*.test.ts        one file per vector file
    http.*.test.ts           HTTP-*, AUTH-*, RL-*, USE-* behavior + OpenAPI validation
  scripts/
    issue-key.ts             AUTH-6
    usage-report.ts          USE-4
    check-rule-coverage.ts   Acceptance #2: fails CI if any rule ID is untested
    smoke.ts                 Acceptance #4: live run against real domains (run only via smoke.yml or locally)
  .github/workflows/
    ci.yml                   PR gate: typecheck, lint, test, check-rule-coverage
    smoke.yml                workflow_dispatch only; runs scripts/smoke.ts on a GitHub runner
  README.md                  public docs: what it does, curl example, response example, limits, limitations
```

## Milestones (one PR each; each must leave CI green)

Suggested as GitHub Issues. Each issue body links the SPEC sections it implements.

**M1: Core checks (no HTTP).** `normalize`, `dns`, `spf`, `dmarc`, `mx`, `check`, plus the fake-DNS harness and the vector tests. Done when all vectors in `normalize.json`, `spf.json`, `dmarc.json`, `mx.json`, `check.json` pass.

**M2: HTTP layer.** Handler, error envelope, headers, auth (env-var hash list), in-memory rate limiter, usage log lines, Vercel adapters, health endpoint. Done when HTTP-*, AUTH-*, RL-*, USE-1/2/5 have tests and every response is validated against `openapi.yaml`.

**M3: Release tooling.** `issue-key`, `usage-report` (against the store interface), `check-rule-coverage` wired into CI, `smoke.ts` + `smoke.yml`, and the README. Done when `check-rule-coverage` passes in CI and the README curl example is correct for a placeholder host.

**M4: Gated, do not start without approval.** Upstash-REST store adapter wired in (D-1), and self-serve keys per SPEC §11 and the landing page per SPEC §13 (D-2). Both decided.

## Implementation notes (traps to avoid)

- **SPF lookup counting (SPF-14..22)** is the most valuable and most error-prone part. Keep one shared evaluation context per request with `visited`, `count`, `exact`, `queriesUsed`, and depth, and stop recursing the moment `count > 10`.
- **The query cap (DNS-4) and the time budget (DNS-3)** are per request and shared across SPF, DMARC, and MX. Put them in the resolver wrapper, not in each check.
- **`nxdomain` on `_dmarc.<domain>`** is the normal "no DMARC" case, not a failure (DM-2). Don't emit `DNS_LOOKUP_FAILED` for it.
- **Null MX:** Node returns the exchange as `""` for `0 .`. Handle both `""` and `"."` (MX-3).
- **IDN:** `url.domainToASCII` returns `""` on failure (IN-4). Run IN-3 before IDN conversion so URLs fail with the clearer message.
- **Key lookup (AUTH-3):** hash the presented key with SHA-256 and look it up in a `Set` of stored hashes. Because the comparison runs on a hash of attacker-supplied input, its timing reveals nothing usable about stored keys, so `timingSafeEqual` is not needed.
- **Determinism (RES-7):** sort MX records and any record lists whose order comes from the resolver.
- **Messages:** plain sentences, no markdown. Never claim a domain "will deliver" or "is compliant" (SCOPE-2).

## Definition of done (V0 code-complete)

- [ ] All vectors pass; tests reference vector and rule IDs.
- [ ] `check-rule-coverage` passes in CI.
- [ ] Every handler test validates its body against `openapi.yaml`.
- [ ] No test touches the network; CI green offline.
- [ ] No domains, raw keys, or IPs in any log line (a test asserts this for USE-2).
- [ ] README has a copyable curl example, a sample response, limits, and the limitations list.
- [ ] PR description lists any spec questions raised and how they were resolved.

**Then stop.** Deployment and the X post follow SPEC §12 (Acceptance) once D-1 and D-3 are decided.
