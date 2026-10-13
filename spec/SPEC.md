# Domain Health API — Behavior Specification

**Version:** 0.1.0 (V0)
**Status:** Ready for implementation
**Date:** 2026-10-13
**Owner:** Corina (decisions) · Implementer: Claude Code

This is the source of truth. Every rule has an ID. Every rule must be covered by at least one test in the implementation, and each test must name the rule ID(s) it covers. Where this document and the code disagree, the code is wrong.

Companion files:
- `openapi.yaml` is the HTTP contract (shapes, status codes, headers).
- `vectors/*.json` are the test vectors, with input → expected output. They are normative.
- `DECISIONS.md` covers what is settled and what still needs founder approval.
- `BUILD_BRIEF.md` covers how to build it (stack, milestones, definition of done).

---

## 1. Product scope

### 1.1 What V0 does

One endpoint, `GET /v1/domain/check?domain=<domain>`. It inspects public DNS for one domain and returns structured diagnostics for:

- **SPF:** the TXT record at the domain apex
- **DMARC:** the TXT record at `_dmarc.<domain>`
- **MX:** the domain's mail exchangers and whether they resolve

### 1.2 What V0 does not do

Each of these is a separate future decision, not an omission.

- No DKIM. A selector must be known, so this comes later as an optional `dkim_selector` parameter.
- No deliverability, inbox placement, blacklist, or reputation checks.
- No DMARC aggregate report (`rua`) ingestion or analysis.
- No organizational-domain DMARC inheritance. This needs the Public Suffix List, and is deferred.
- No bulk checks, monitoring, webhooks, dashboard, or billing.
- No HTTP requests to the target domain. **DNS queries only.**

### 1.3 Honesty requirements

| ID | Rule |
|---|---|
| **SCOPE-1** | Every successful response includes a `limitations` array stating at minimum that DKIM was not checked and that this is not a deliverability test. |
| **SCOPE-2** | No response field, message, or doc may state or imply that a domain "will deliver", "is safe", or "is compliant" with any provider's requirements. Messages describe what was found in DNS and why it matters. Enforced by a test that scans every issue message template for the words `deliver`, `safe`, `compliant`, `guarantee`. The only exception is the fixed limitation sentence "not an email deliverability test". |

---

## 2. Input handling — `domain` parameter

Normalization happens in this order. A failure at any step returns `400` with the listed error code. See `vectors/normalize.json`.

| ID | Rule | Failure code |
|---|---|---|
| **IN-1** | `domain` query parameter is required and non-empty after trimming whitespace. | `missing_domain` |
| **IN-2** | Trim leading/trailing whitespace. Lowercase. Strip one trailing dot. | — |
| **IN-3** | Reject input containing a scheme (`://`), path (`/`), query (`?`), fragment (`#`), port (`:`), userinfo (`@`), or internal whitespace. Do **not** try to extract a domain from a URL; tell the caller to send a bare domain. | `invalid_domain` |
| **IN-4** | Convert internationalized names to ASCII (punycode) using a standards-compliant IDNA conversion (e.g. Node `url.domainToASCII`). If conversion yields an empty string, reject. The response `domain` field returns the ASCII form. | `invalid_domain` |
| **IN-5** | Reject IPv4 or IPv6 literals. | `invalid_domain` |
| **IN-6** | Syntax: total length ≤ 253; at least 2 labels; each label 1–63 chars of `[a-z0-9-]`; no label starts or ends with `-`; final label (TLD) is not all-numeric. | `invalid_domain` |
| **IN-7** | Reject special-use and non-public names: the TLDs `localhost`, `local`, `internal`, `invalid`, `test`, `onion`, `lan`, `home`, `corp`; any name ending in `.home.arpa`; and the name `localhost`. (`example.com`/`.net`/`.org` are allowed. They are real public domains.) | `invalid_domain` |
| **IN-8** | The `400` error message names the specific problem, e.g. "Send a bare domain like example.com, not a URL". | — |

---

## 3. DNS layer

| ID | Rule |
|---|---|
| **DNS-1** | All lookups go through one injectable resolver interface (`resolveTxt`, `resolveMx`, `resolve4`, `resolve6`), so tests never touch the network. |
| **DNS-2** | Each lookup is classified into exactly one outcome: `found` (records returned), `no_records` (name exists, no records of that type, i.e. `ENODATA`), `nxdomain` (name does not exist, i.e. `ENOTFOUND`), or `error` (timeout, `SERVFAIL`, refused, anything else). Only a rejection carrying a string `code` is a DNS outcome. A rejection without one is a programming error: it propagates and becomes 500 internal_error (HTTP-8). |
| **DNS-3** | Per-query timeout: 3 seconds, at most 1 retry. Total DNS budget per request: 8 seconds. When the budget is exhausted, remaining lookups resolve as `error`. |
| **DNS-4** | Hard cap of **40 DNS queries per request** across all checks. This bounds cost and prevents abuse through deep SPF include chains. Lookups beyond the cap resolve as `error` with reason `query_cap`. |
| **DNS-5** | TXT records arrive as arrays of strings. Join the strings of a single record with no separator before parsing (RFC 7208 §3.3). |
| **DNS-6** | Independent top-level lookups (apex TXT, `_dmarc` TXT, MX) run concurrently. |
| **DNS-7** | **Domain existence:** if the apex TXT lookup and the MX lookup both return `nxdomain`, the domain does not exist. The response is still `200`, with `domain_exists: false`, every check `status: "not_evaluated"`, and a single issue `DOMAIN_NOT_FOUND` (error). |
| **DNS-8** | When any lookup a check depends on returns `error`, that check's `status` is `"error"`, and an issue `DNS_LOOKUP_FAILED` (warning) is added naming the record that failed. Never report a record as missing when the lookup actually failed. This applies to each check's primary lookup (apex TXT for SPF, `_dmarc` TXT for DMARC, apex MX for MX). Failures of secondary lookups are governed by SPF-20 (include/redirect targets) and MX-6 (exchange A/AAAA). |

---

## 4. SPF check

Source: RFC 7208. Vectors: `vectors/spf.json`.

### 4.1 Record discovery

| ID | Rule |
|---|---|
| **SPF-1** | An SPF record is an apex TXT record whose joined text, trimmed, matches case-insensitively `^v=spf1( |$)`. Other TXT records are ignored. |
| **SPF-2** | 0 SPF records → `status: "missing"`, issue `SPF_MISSING` (**warning**). |
| **SPF-3** | More than 1 SPF record → `status: "invalid"`, issue `SPF_MULTIPLE_RECORDS` (**error**). Do not evaluate further. RFC 7208 treats this as a permerror. Return all found records in `records`. |

### 4.2 Parsing

| ID | Rule |
|---|---|
| **SPF-4** | Split terms on whitespace. Recognized mechanisms: `all`, `include`, `a`, `mx`, `ptr`, `ip4`, `ip6`, `exists`, each with an optional qualifier (`+ - ~ ?`, default `+`). Recognized modifiers: `redirect=`, `exp=`. Any other `name=value` term is an unknown modifier and is ignored without error. Any other term → `status: "invalid"`, issue `SPF_SYNTAX_ERROR` (**error**) naming the term. An invalid term is reported and skipped; the remaining terms are still evaluated. |
| **SPF-5** | `ip4:` values must be a valid IPv4 address or CIDR (`/0`–`/32`). `ip6:` values must be a valid IPv6 address or CIDR (`/0`–`/128`). Invalid → `SPF_SYNTAX_ERROR`. |
| **SPF-6** | `include:` and `exists:` require a domain-spec. `redirect=` requires a value. Missing → `SPF_SYNTAX_ERROR`. |
| **SPF-7** | More than one `redirect=` or more than one `exp=` → `SPF_SYNTAX_ERROR`. |

### 4.3 Policy findings (top-level record only)

| ID | Rule |
|---|---|
| **SPF-8** | `+all` (or bare `all`) → issue `SPF_ALLOW_ALL` (**error**). This authorizes any sender. |
| **SPF-9** | `?all` → issue `SPF_NEUTRAL_ALL` (**warning**). |
| **SPF-10** | No `all` mechanism and no `redirect=` → issue `SPF_NO_ALL` (**warning**). The result for non-matching senders defaults to neutral. |
| **SPF-11** | `-all` or `~all` produce no issue. Report the qualifier in `all_qualifier` (`"-"`, `"~"`, `"?"`, `"+"`, or `null` if absent). |
| **SPF-12** | Any `ptr` mechanism → issue `SPF_PTR_USED` (**warning**). It is deprecated by RFC 7208 §5.5. |
| **SPF-13** | If `redirect=` is present together with an `all` mechanism, the redirect is ignored by receivers. Issue `SPF_REDIRECT_IGNORED` (**info**), do not follow the redirect, and do not count it toward `lookup_count`. |

### 4.4 DNS lookup count (the main real-world failure)

| ID | Rule |
|---|---|
| **SPF-14** | Count DNS-querying terms per RFC 7208 §4.6.4: `include`, `a`, `mx`, `ptr`, `exists`, `redirect`. `ip4`, `ip6`, `all`, and `exp` do not count. |
| **SPF-15** | Recursively resolve `include:` targets and the `redirect=` target (unless SPF-13 applies). Fetch each target's SPF record (applying SPF-1 to it) and add its counted terms to the total. Each include/redirect itself counts as 1. |
| **SPF-16** | Total count > 10 → issue `SPF_TOO_MANY_LOOKUPS` (**error**) with the count in the message, and `status: "invalid"`. Report the total in `lookup_count`. Once the count passes 10, stop recursing: set `lookup_count` to the count reached at that point and `lookup_count_exact: false`. If evaluation completed without stopping early, `lookup_count_exact: true`. |
| **SPF-17** | An include/redirect target that has 0 SPF records, or returns `nxdomain` → issue `SPF_INCLUDE_NO_RECORD` (**error**, a permerror at receivers) naming the target. A target with >1 SPF record → same issue code. |
| **SPF-18** | Loop detection: a target that is already on the current include/redirect path (an ancestor of the record being evaluated) is not fetched again. Issue `SPF_INCLUDE_LOOP` (**error**). A target reached again through a different path (a "diamond", e.g. two includes that both include the same provider) is not a loop. Evaluate it and count its terms again toward `lookup_count`, as receivers do. A repeated target's DNS response may be cached within the request. Cached responses still count toward `lookup_count`, but not toward the DNS-4 query cap. |
| **SPF-19** | `include:`/`redirect=` targets containing macros (`%{`) cannot be resolved statically (macros in `exists:` are normal and produce no issue). Count them (1 each) but do not recurse. Issue `SPF_MACRO_UNRESOLVED` (**info**) and set `lookup_count_exact: false`. |
| **SPF-20** | An include/redirect target lookup that returns `error` (DNS-2) → issue `DNS_LOOKUP_FAILED` (warning) and set `lookup_count_exact: false`. Do not mark the record invalid on that basis alone. |
| **SPF-21** | Syntax errors inside an included record → issue `SPF_INCLUDE_INVALID` (**error**) naming the target. Do not surface the included record's individual syntax issues. |
| **SPF-22** | Maximum include depth: 10. Deeper chains → `SPF_TOO_MANY_LOOKUPS` (the count necessarily exceeds 10). |

### 4.5 Status

| ID | Rule |
|---|---|
| **SPF-23** | `status` is one of: `valid`, `invalid`, `missing`, `error`, `not_evaluated`. A record is `invalid` if it has any SPF **error**-severity issue. A record with only warnings and info is `valid`. |

---

## 5. DMARC check

Source: RFC 7489. Vectors: `vectors/dmarc.json`.

| ID | Rule |
|---|---|
| **DM-1** | Query TXT at `_dmarc.<domain>`. A DMARC record is a TXT record whose joined text, trimmed, begins with `v=DMARC1` (tag name case-insensitive; the value `DMARC1` is matched exactly), followed by `;`, whitespace, or end of string. Other TXT records at that name are ignored. |
| **DM-2** | 0 records (including `nxdomain` on `_dmarc.<domain>`, which is normal and **not** a DNS failure) → `status: "missing"`, issue `DMARC_MISSING` (**warning**). The message notes that if this is a subdomain, a parent-domain policy may apply, and that V0 does not evaluate inheritance. |
| **DM-3** | More than 1 record → `status: "invalid"`, issue `DMARC_MULTIPLE_RECORDS` (**error**). Do not parse further. |
| **DM-4** | Parse tags: split on `;`, trim each, skip empties, split each on the first `=`, trim name and value, lowercase tag names. Unknown tags are ignored. A duplicate known tag → `DMARC_SYNTAX_ERROR` (**error**). For a duplicate tag, the first value is used. |
| **DM-5** | `p` must be present and one of `none`, `quarantine`, `reject` (case-insensitive). Missing or invalid → `status: "invalid"`, issue `DMARC_INVALID_POLICY` (**error**). |
| **DM-6** | `sp` (if present) must be `none`/`quarantine`/`reject`. `adkim`/`aspf` (if present) must be `r`/`s`. `pct` (if present) must be an integer 0–100. `fo` and `rf` are ignored in V0. Violations → `DMARC_SYNTAX_ERROR` (**error**) naming the tag. An invalid `sp`, `adkim`, `aspf` or `pct` value is reported as `null`, not as its default. |
| **DM-7** | `p=none` → issue `DMARC_POLICY_NONE` (**info**). It is monitoring only, with no enforcement. |
| **DM-8** | `pct` < 100 → issue `DMARC_PARTIAL_PCT` (**info**) with the value. |
| **DM-9** | No `rua` tag → issue `DMARC_NO_RUA` (**info**). No aggregate reports are being collected. |
| **DM-10** | `rua`/`ruf` values: split on `,`, trim. Each must begin with `mailto:` (case-insensitive) or `https:`. Otherwise → `DMARC_SYNTAX_ERROR`. Report parsed URIs in `rua`/`ruf` arrays. V0 does not verify external-destination authorization records. |
| **DM-11** | Report `policy`, `subdomain_policy` (the `sp` value, or `null` if absent; do not infer), `pct` (default 100), `adkim` (default `"r"`), `aspf` (default `"r"`). Effective defaults are reported as values, with no separate "defaulted" flag in V0. Tag values for `p`, `sp`, `adkim`, `aspf` are reported lowercased. When `status` is `missing`, `invalid` from DM-3, or `error`, all of these fields are `null` and `rua`/`ruf` are `[]`. |
| **DM-12** | `status` is one of: `valid`, `invalid`, `missing`, `error`, `not_evaluated`. Same severity logic as SPF-23. |

---

## 6. MX check

Source: RFC 5321, RFC 7505. Vectors: `vectors/mx.json`.

| ID | Rule |
|---|---|
| **MX-1** | Query MX at the apex. Return records sorted by ascending priority, then exchange name, as `{ priority, exchange, resolves }`. Strip any trailing dot from `exchange`. |
| **MX-2** | `no_records` → `status: "missing"`, issue `MX_MISSING` (**warning**). The message notes the domain cannot receive mail and that this may be intentional for send-only domains. (RFC 5321 implicit-MX fallback to the A record is **not** evaluated in V0. The message says receiving relies on implicit A-record fallback at best.) |
| **MX-3** | **Null MX:** exactly one record with exchange `""` or `"."` → `status: "null_mx"`, issue `MX_NULL` (**info**): the domain explicitly declares it accepts no mail. Do not resolve hosts. |
| **MX-4** | A null MX (`.`) alongside other MX records → issue `MX_NULL_MIXED` (**error**), `status: "invalid"`. |
| **MX-5** | An exchange that is an IP literal → issue `MX_TARGET_IS_IP` (**error**), `status: "invalid"`. MX targets must be hostnames. |
| **MX-6** | For up to **5** exchanges (lowest priority values first), resolve A and AAAA. `resolves: true` if either returns `found`. `resolves: false` if both return `nxdomain`/`no_records`. `resolves: null` if not checked (beyond 5) or a lookup returned `error`. |
| **MX-7** | Any exchange with `resolves: false` → issue `MX_TARGET_UNRESOLVABLE` (**error**) naming it. If **every** checked exchange is unresolvable, `status: "invalid"`. If at least one resolves, `status: "valid"` with the error still reported. |
| **MX-8** | `status` is one of: `valid`, `invalid`, `missing`, `null_mx`, `error`, `not_evaluated`. |

---

## 7. Response assembly

| ID | Rule |
|---|---|
| **RES-1** | The response shape is defined by `openapi.yaml` → `DomainCheckResult`. Fields are always present. Use `null` for unknown or absent values, never omit them. |
| **RES-2** | Each check object has its own `issues` array. The top-level `issues` array is the concatenation of all check issues plus domain-level issues (DNS-7), in order: domain, spf, dmarc, mx, then within each check in the order produced. |
| **RES-3** | Every issue is `{ code, severity, check, message }`. `severity` ∈ `error`, `warning`, `info`. `check` ∈ `domain`, `spf`, `dmarc`, `mx`. `code` is from the closed list in §9. Messages are one or two plain sentences, with no markdown. Within a check, an issue with the same code and message is reported only once. |
| **RES-4** | `summary.status`: `fail` if any error-severity issue, else `incomplete` if any check has `status: "error"`, else `warn` if any warning, else `pass`. `summary` also carries `errors`, `warnings`, `info` counts. |
| **RES-5** | `checked_at` is an ISO-8601 UTC timestamp. `domain` is the normalized ASCII domain. |
| **RES-6** | Raw records are returned verbatim, joined per DNS-5: `spf.records` (array of strings), `dmarc.records` (array of strings). `spf.record`/`dmarc.record` is the single record when exactly one exists, else `null`. |
| **RES-7** | Determinism: the same DNS data produces byte-identical output apart from `checked_at` and `request_id`. No randomness and no ordering that depends on resolver response order (sort where needed). |

---

## 8. HTTP layer

Contract details are in `openapi.yaml`.

### 8.1 Endpoints

| ID | Rule |
|---|---|
| **HTTP-1** | `GET /v1/domain/check`, authenticated. A method other than GET/HEAD → `405` `method_not_allowed` with an `Allow: GET` header. |
| **HTTP-2** | `GET /v1/health`, unauthenticated. Returns `200 {"status":"ok","version":"<semver>"}`. It performs no DNS lookups. |
| **HTTP-3** | Unknown paths → `404` `not_found` in the standard error envelope. |

### 8.2 Responses

| ID | Rule |
|---|---|
| **HTTP-4** | All responses are JSON (`Content-Type: application/json; charset=utf-8`), including errors. |
| **HTTP-5** | Error envelope: `{ "error": { "code": "<code>", "message": "<human sentence>" }, "request_id": "<id>" }`. Codes are from the closed list in `openapi.yaml`. |
| **HTTP-6** | Every response carries an `X-Request-Id` header (a random 16-byte hex string, or a sanitized `X-Request-Id` supplied by the client: `[A-Za-z0-9-]{1,64}`). Successful bodies also include `request_id`. |
| **HTTP-7** | `Cache-Control: no-store` on all responses. |
| **HTTP-8** | Unhandled exceptions → `500` `internal_error`. Never leak stack traces, resolver internals, or key material in responses. |
| **HTTP-9** | A completed check is always `200`, even when the domain fails every check or does not exist. HTTP status reflects the API call, not the domain's health. |

### 8.3 Authentication

| ID | Rule |
|---|---|
| **AUTH-1** | API keys are sent as `Authorization: Bearer <key>`. Also accept the `X-API-Key: <key>` header. Never accept keys in the query string: a `?api_key=` or `?key=` parameter → `400` `key_in_query`, telling the caller to use the header (keys in URLs leak into logs). |
| **AUTH-2** | Key format: `dh_` + 32 base62 characters. Generated with a CSPRNG. |
| **AUTH-3** | The server stores **SHA-256 hashes** of keys only, never plaintext. Validation hashes the presented key and looks up the hash. Plaintext keys are never compared or held beyond the request. |
| **AUTH-4** | `key_id` = the first 12 hex characters of the key's SHA-256. This is the only key identifier that may appear in logs and metrics. |
| **AUTH-5** | Missing key → `401` `missing_api_key`. Unknown or revoked key → `401` `invalid_api_key`. Both include a `WWW-Authenticate: Bearer` header. |
| **AUTH-6** | The source of valid key hashes is pluggable (see `DECISIONS.md` D-2). V0 minimum: an env var `API_KEY_HASHES` holding comma-separated SHA-256 hex values, plus a CLI script `scripts/issue-key` that prints a new key once and its hash. |
| **AUTH-7** | Authentication runs before input validation and before rate limiting is charged. The order is: method → key-in-query check → auth → rate limit → input validation → check. A key-in-query rejection happens before authentication, so it carries no rate-limit headers and is not counted against any limit. A request rejected for invalid input still counts against the rate limit. |

### 8.4 Rate limiting

| ID | Rule |
|---|---|
| **RL-1** | Limits are per `key_id`. Free tier V0 values: **10 requests/minute** and **200 requests/day** (UTC day). Values are config, not code constants. |
| **RL-2** | Exceeded → `429` `rate_limited` with a `Retry-After` header (seconds until the earliest window resets). |
| **RL-3** | Every authenticated response includes `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (Unix seconds) for the **daily** window. When the store is unavailable (RL-4), these headers are omitted rather than guessed. |
| **RL-4** | The rate-limit store is behind an interface with an in-memory implementation (for tests and local dev) and a durable implementation (see `DECISIONS.md` D-1). If the durable store is unreachable, **fail open** (allow the request) and log `store_unavailable`. A store outage must not take the API down. |

### 8.5 Usage tracking

The launch success metric depends on this.

| ID | Rule |
|---|---|
| **USE-1** | Every authenticated request emits one structured JSON log line: `{ "event": "request", "ts", "request_id", "key_id", "endpoint", "status", "summary_status" (or null), "latency_ms", "dns_queries" }`. |
| **USE-2** | **Never log** the queried domain, the raw key, the client IP, or the `Authorization` header. The domains people check may be their clients'. |
| **USE-3** | Persist counters in the durable store: per `key_id` per UTC day, the count of successful (`200`) checks, plus the set of active days per `key_id`. |
| **USE-4** | Provide `scripts/usage-report` that prints, for a date range: unique active keys, total successful checks, and **repeat keys**, meaning keys active on ≥ 2 distinct UTC days. This answers the launch gate ("10 qualified signups, 3 repeat users in 7 days"). |
| **USE-5** | Usage tracking failures never fail the request (fail open, log `usage_write_failed`). |

---

## 9. Issue code registry (closed list)

| Code | Check | Severity | Rule |
|---|---|---|---|
| `DOMAIN_NOT_FOUND` | domain | error | DNS-7 |
| `DNS_LOOKUP_FAILED` | any | warning | DNS-8, SPF-20 |
| `SPF_MISSING` | spf | warning | SPF-2 |
| `SPF_MULTIPLE_RECORDS` | spf | error | SPF-3 |
| `SPF_SYNTAX_ERROR` | spf | error | SPF-4–7 |
| `SPF_ALLOW_ALL` | spf | error | SPF-8 |
| `SPF_NEUTRAL_ALL` | spf | warning | SPF-9 |
| `SPF_NO_ALL` | spf | warning | SPF-10 |
| `SPF_PTR_USED` | spf | warning | SPF-12 |
| `SPF_REDIRECT_IGNORED` | spf | info | SPF-13 |
| `SPF_TOO_MANY_LOOKUPS` | spf | error | SPF-16, SPF-22 |
| `SPF_INCLUDE_NO_RECORD` | spf | error | SPF-17 |
| `SPF_INCLUDE_LOOP` | spf | error | SPF-18 |
| `SPF_MACRO_UNRESOLVED` | spf | info | SPF-19 |
| `SPF_INCLUDE_INVALID` | spf | error | SPF-21 |
| `DMARC_MISSING` | dmarc | warning | DM-2 |
| `DMARC_MULTIPLE_RECORDS` | dmarc | error | DM-3 |
| `DMARC_SYNTAX_ERROR` | dmarc | error | DM-4, DM-6, DM-10 |
| `DMARC_INVALID_POLICY` | dmarc | error | DM-5 |
| `DMARC_POLICY_NONE` | dmarc | info | DM-7 |
| `DMARC_PARTIAL_PCT` | dmarc | info | DM-8 |
| `DMARC_NO_RUA` | dmarc | info | DM-9 |
| `MX_MISSING` | mx | warning | MX-2 |
| `MX_NULL` | mx | info | MX-3 |
| `MX_NULL_MIXED` | mx | error | MX-4 |
| `MX_TARGET_IS_IP` | mx | error | MX-5 |
| `MX_TARGET_UNRESOLVABLE` | mx | error | MX-7 |

Adding a code is a spec change: bump the minor version and update this table and `openapi.yaml`.

---

## 10. Versioning

| ID | Rule |
|---|---|
| **VER-1** | The URL path carries the major version (`/v1`). Within v1, changes are additive only: new fields, new issue codes, new optional params. Removing or renaming a field, or changing an issue's severity, requires `/v2`. |
| **VER-2** | `GET /v1/health` reports the implementation's semver, which matches this spec's version at release. |

---

## 11. Self-serve keys (DECISIONS.md D-2)

Active rules. D-2 is decided as option (b): developers get a key by posting an email to `POST /v1/keys`, from the landing page in §13. Keys issued this way are valid alongside the hashes in `API_KEY_HASHES` (AUTH-6). They are stored in the durable store (D-1) as hashes (AUTH-3).

| ID | Rule |
|---|---|
| **KEY-1** | `POST /v1/keys`, unauthenticated, JSON body `{ "email": "<address>" }`. Returns `201 { "api_key": "dh_...", "key_id": "...", "limits": { "per_minute": 10, "per_day": 200 } }`. The plaintext key is returned exactly once and never stored. |
| **KEY-2** | Email: trimmed, lowercased, ≤ 254 chars, one `@`, and a domain part passing IN-6. Invalid → `400 invalid_email`. No verification email in V0. |
| **KEY-3** | One active key per email. A repeat request for the same email → `409 key_exists`, and no new key is issued. (Key recovery is out of scope.) |
| **KEY-4** | Signup throttle: 5 signups per hour per client IP. The IP is taken from `x-real-ip`, falling back to the first entry of `x-forwarded-for`. It is used only as a hashed throttle key with a 1-hour TTL, and is never logged (USE-2) or persisted beyond the throttle window. Every `POST /v1/keys` counts against the throttle, including requests rejected as invalid or as `key_exists`, so the endpoint cannot be used to probe which emails have keys. Over the limit → `429 rate_limited` with a `Retry-After` header. If neither header is present, requests share one throttle bucket. If the store is unavailable the throttle fails open (A-7). |
| **KEY-5** | Store `{ key_hash, key_id, email, created_at, status }`. The email is stored for contact only and never logged. `status` is `active` or `revoked`; a revoked key is rejected with `invalid_api_key` (AUTH-5). |

---

## 12. Acceptance — release gate for V0

V0 ships, meaning it gets deployed and the X post goes out, only when all of these hold:

1. Every vector in `vectors/*.json` passes.
2. Every rule ID in this document is referenced by at least one test or vector. This is checked by `scripts/check-rule-coverage`, which extracts rule IDs from `SPEC.md` and greps them in `test/` and `spec/vectors/`.
3. The `openapi.yaml` response shapes are validated against real handler output in tests.
4. A live smoke run against these real domains returns `200` with plausible results, reviewed by a human: `google.com`, `github.com`, `example.com` (expected: null MX, SPF `-all`), a known nonexistent domain (expected: `DOMAIN_NOT_FOUND`), and one domain Corina controls.
5. The README curl example, copied verbatim, works against the deployed URL.
6. A grep of logs from the smoke run shows no domains, raw keys, or IPs (USE-2).

---

## 13. Landing page (DECISIONS.md D-2)

`GET /` serves one static HTML page where a developer can read what the API does and get a key.

| ID | Rule |
|---|---|
| **LP-1** | `GET /` returns an HTML page (`Content-Type: text/html; charset=utf-8`) with no authentication. The page loads no third-party scripts, fonts, stylesheets, images or analytics, and a Content-Security-Policy header enforces that. Everything except the key form reads correctly with JavaScript off. JavaScript is used only for the key form. |
| **LP-2** | The page contains: a one-sentence description of the API; a `curl` example that uses the host the page was served from; a sample response excerpt; the free limits (10 requests/minute and 200 requests/day, taken from the configured limits, RL-1); the SCOPE-1 limitations; and a link to the GitHub repository. |
| **LP-3** | An email form posts to `/v1/keys`. On `201` it shows the key once, with a copy button and the warning "Save this now — it won’t be shown again." On `409` it says a key already exists for that email and links to `CONTACT_URL`, an environment variable (the link is omitted when it is unset). On `429` it says "try again later". On `400` it shows the API's message. |
| **LP-4** | The page shows the privacy line: "We store your email only to contact you about this API. The API doesn’t save the domains you check." |
| **LP-5** | SCOPE-2 applies to all page copy, including text set by the page's script. |
