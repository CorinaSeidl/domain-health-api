# Domain Health API

Structured SPF, DMARC and MX diagnostics for a domain, from public DNS, as JSON.

`GET /v1/domain/check?domain=<domain>` looks up three things and reports what it found, with a plain-sentence issue for each problem:

- **SPF**: the TXT record at the domain apex, including a count of the DNS lookups it triggers (the usual way SPF breaks in practice).
- **DMARC**: the TXT record at `_dmarc.<domain>`.
- **MX**: the mail exchangers and whether each one resolves.

It makes DNS queries only. It never makes HTTP requests to the domain you ask about.

> The host below is a placeholder. Replace `REPLACE_WITH_DEPLOYED_HOST` with the real host once the API is deployed.

## Quick start

```sh
curl -s "https://REPLACE_WITH_DEPLOYED_HOST/v1/domain/check?domain=example.com" \
  -H "Authorization: Bearer $DH_API_KEY"
```

## Get a key

Open the landing page (`GET /`) and click **Get a key**, or ask for one from a terminal:

```sh
curl -s -X POST "https://REPLACE_WITH_DEPLOYED_HOST/v1/keys"
```

The reply is `201` with `api_key`, `key_id` and your `limits`. **The key is shown once and cannot be recovered**, so save it; if you lose it, request a new one. Each network address can ask for 5 keys per hour (`429 rate_limited`).

Email is optional. To hear about breaking changes, send `-H "Content-Type: application/json" -d '{"email":"you@example.com"}'` with the request. If you add one, we store it only to contact you about this API.

Send your key as `Authorization: Bearer <key>` or as an `X-API-Key: <key>` header. Keys look like `dh_` followed by 32 letters and digits. Never put a key in the query string: a `?api_key=` or `?key=` parameter is rejected with `400 key_in_query`, because URLs end up in logs.

Send a bare domain such as `example.com`, not a URL. Internationalized names are converted to ASCII (punycode) and the response returns the ASCII form.

## Sample response

```json
{
  "request_id": "8812af81b03825ae232e19a53da2d66a",
  "domain": "example.com",
  "domain_exists": true,
  "checked_at": "2026-10-13T08:00:00.000Z",
  "summary": {
    "status": "pass",
    "errors": 0,
    "warnings": 0,
    "info": 2
  },
  "spf": {
    "status": "valid",
    "record": "v=spf1 ip4:192.0.2.0/24 ~all",
    "records": ["v=spf1 ip4:192.0.2.0/24 ~all"],
    "all_qualifier": "~",
    "lookup_count": 0,
    "lookup_count_exact": true,
    "issues": []
  },
  "dmarc": {
    "status": "valid",
    "record": "v=DMARC1; p=none",
    "records": ["v=DMARC1; p=none"],
    "policy": "none",
    "subdomain_policy": null,
    "pct": 100,
    "adkim": "r",
    "aspf": "r",
    "rua": [],
    "ruf": [],
    "issues": [
      {
        "code": "DMARC_POLICY_NONE",
        "severity": "info",
        "check": "dmarc",
        "message": "The DMARC policy is p=none, which is monitoring only and asks receivers to take no action on mail that fails."
      },
      {
        "code": "DMARC_NO_RUA",
        "severity": "info",
        "check": "dmarc",
        "message": "No rua tag, so no DMARC aggregate reports are being collected for this domain."
      }
    ]
  },
  "mx": {
    "status": "valid",
    "records": [
      { "priority": 10, "exchange": "mail.example.com", "resolves": true }
    ],
    "issues": []
  },
  "issues": [
    {
      "code": "DMARC_POLICY_NONE",
      "severity": "info",
      "check": "dmarc",
      "message": "The DMARC policy is p=none, which is monitoring only and asks receivers to take no action on mail that fails."
    },
    {
      "code": "DMARC_NO_RUA",
      "severity": "info",
      "check": "dmarc",
      "message": "No rua tag, so no DMARC aggregate reports are being collected for this domain."
    }
  ],
  "limitations": [
    "DKIM was not checked; it requires a selector.",
    "This is a DNS configuration check, not an email deliverability test.",
    "DMARC policy inheritance from a parent domain is not evaluated."
  ]
}
```

`summary.status` is `fail` if any issue has severity `error`, otherwise `incomplete` if a lookup failed, otherwise `warn` if there is a warning, otherwise `pass`. Every field is always present; unknown values are `null`.

A completed check is always HTTP `200`, even when the domain fails every check or does not exist. The status code describes the API call, not the domain's health. A nonexistent domain returns `200` with `domain_exists: false` and a `DOMAIN_NOT_FOUND` issue.

The full contract, including every issue code, is in [`spec/openapi.yaml`](spec/openapi.yaml).

## Health endpoint

`GET /v1/health` needs no key, makes no DNS lookups, and returns `{"status":"ok","version":"<semver>"}`.

## Errors

Errors use one envelope and a code from a closed list:

```json
{
  "error": {
    "code": "invalid_domain",
    "message": "Send a bare domain like example.com, not a URL."
  },
  "request_id": "8812af81b03825ae232e19a53da2d66a"
}
```

| Status | Code                                 | Meaning                                                    |
| ------ | ------------------------------------ | ---------------------------------------------------------- |
| 400    | `missing_domain`, `invalid_domain`   | The `domain` parameter is absent or not a bare public name |
| 400    | `key_in_query`                       | A key was sent in the URL; use a header                    |
| 401    | `missing_api_key`, `invalid_api_key` | No key, or an unknown or revoked key                       |
| 400    | `invalid_email`                      | `POST /v1/keys` got a malformed email or body              |
| 404    | `not_found`                          | Unknown path                                               |
| 405    | `method_not_allowed`                 | Only `GET` and `HEAD` are accepted (`POST` for `/v1/keys`) |
| 429    | `rate_limited`                       | Over a limit; wait `Retry-After` seconds                   |
| 500    | `internal_error`                     | Unexpected failure                                         |

Every response carries an `X-Request-Id` header. You may supply your own (1 to 64 characters of `A-Z`, `a-z`, `0-9` and `-`); otherwise one is generated. All responses are `Cache-Control: no-store`.

## Limits

The free tier allows **10 requests per minute** and **200 requests per UTC day** for each key. Requests rejected for invalid input still count.

Every authenticated response includes `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (Unix seconds) for the daily window. When a limit is exceeded you get `429` with a `Retry-After` header.

Each request also has a DNS time budget of 8 seconds and a cap of 40 DNS queries. Lookups past either limit count as failed, and the affected check reports a `DNS_LOOKUP_FAILED` issue instead of guessing.

## Limitations

- No DKIM check. A selector is needed, so it may come later as an optional parameter.
- Not a deliverability, inbox placement, blacklist or reputation test. The API reports what DNS contains and why it matters, and does not say whether mail will be delivered.
- No DMARC policy inheritance from a parent domain.
- No analysis or ingestion of DMARC aggregate (`rua`) reports.
- One domain per request. No bulk checks, monitoring or webhooks.
- DNS only. The service never makes HTTP requests to the domain you check.

## Privacy

The API never logs the domain you check, your key, your IP address, your email address or your `Authorization` header. If you give an email, it is stored only to contact you about this API. A signup's IP address is kept as a one-way hash for at most an hour, to limit signups. A key appears in logs only as `key_id`, the first 12 hex characters of its SHA-256.

## For operators

Scripts run with `npm run <name> -- <args>`. Only `smoke` (live DNS) and `usage-report` (Upstash) touch the network.

- `issue-key` creates a key and prints it once, with its SHA-256 and `key_id`. Add the hash to the `API_KEY_HASHES` environment variable (comma-separated). Only hashes are ever stored.
- `usage-report -- --from 2026-10-07 --to 2026-10-13` prints unique active keys, total successful checks and repeat keys (active on two or more distinct UTC days) for the range. It reads the Upstash store named by the environment variables below. To report from a saved dump instead, add `--usage-file usage.json` (`[{"keyId":"…","counts":{"2026-10-07":3}}]`).
- `check-rule-coverage` fails if any rule ID in `spec/SPEC.md` has no test. It runs in CI.
- `smoke` runs the live check against real domains. It needs real public DNS, so run it from the manual **Smoke** GitHub Actions workflow or a local machine, with `SMOKE_OWN_DOMAIN` set to a domain you control.

Configuration:

- `API_KEY_HASHES`: comma-separated SHA-256 hashes of valid keys. Keys issued by `POST /v1/keys` are valid as well; they live in the Upstash store (set the variables below, or issued keys are lost on restart).
- `RATE_LIMIT_PER_MINUTE` and `RATE_LIMIT_PER_DAY`: optional overrides.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, or `KV_REST_API_URL` and `KV_REST_API_TOKEN` (what the Vercel Marketplace integration sets): the Upstash Redis store for rate limits and usage counters. Usage is kept for 100 days. If neither pair is set, the API falls back to an in-memory store, logs `store_unconfigured` once, and limits and counters are then per instance and not durable. If the store is unreachable, requests are still served (the rate-limit headers are left off).

`vercel.json` rewrites `/v1/domain/check` and `/v1/health` to the functions and sends every other path to a JSON 404. The Node version comes from `engines` in `package.json` (22.x).

## Development

```sh
npm ci
npm run typecheck && npm run lint && npm run format:check
npm test
npm run check-rule-coverage
```

Tests are offline: all DNS goes through an injectable resolver, and responses are validated against `spec/openapi.yaml`. `spec/SPEC.md` is the source of truth for behavior.
