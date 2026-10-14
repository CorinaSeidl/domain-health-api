# Domain Health API — Spec Package (V0.2.0)

A contracts-first spec for a micro-API that returns structured SPF, DMARC, and MX diagnostics for a domain. Built to ship on X as the first micro-API experiment.

## Files

| File | Purpose | Who reads it |
|---|---|---|
| `SPEC.md` | Behavior rules with IDs. **Source of truth.** | Claude Code, reviewers |
| `openapi.yaml` | HTTP contract: request, response shapes, status codes, headers | Claude Code; later the public docs |
| `vectors/` | Normative test vectors (input → expected output). Tests load these directly. | Claude Code's test suite |
| `DECISIONS.md` | What's settled, and **5 open decisions that need your call** before deploy | Corina |
| `BUILD_BRIEF.md` | Stack, repo layout, milestones, traps, definition of done | Claude Code |

## Handing off to Claude Code

1. Create the repo `domain-health-api` (separate from TrueChoice).
2. Copy this folder into it as `spec/`.
3. Give Claude Code this prompt:

   > Read `spec/BUILD_BRIEF.md`, then `spec/SPEC.md`. Implement milestones M1–M3 as separate PRs, in order. Spec is the source of truth. Ask before deviating, and do not deploy or provision anything.

## Before deploy (your decisions)

Answer D-1 (usage store) and D-3 (hosting plan/URL) in `DECISIONS.md`. Code can be completed without them, but the launch can't be measured or hosted without them.

## Coverage at a glance

- 95 numbered V0 rules (plus 5 proposed `KEY-*` rules pending D-2), **every one covered by at least one vector or scenario**
- 27 issue codes in a closed registry, consistent between `SPEC.md` §9 and `openapi.yaml`
- 145 vectors: 108 data vectors (normalization, SPF, DMARC, MX, orchestration) + 37 HTTP/behavior scenarios
- The OpenAPI response examples validate against their own schemas
