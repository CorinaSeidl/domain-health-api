# Test vectors

The vectors in this folder are **normative**. The implementation's test suite must load these files directly and run every vector, rather than copying them into test code, so the spec and the tests cannot drift apart.

Each vector has:

- `id`: a unique, stable identifier. Test names must include it.
- `rules`: the SPEC.md rule IDs it covers.
- `input`: what goes in.
- `expect`: what must come out (see matching semantics below).

## Files

| File | Kind | Covers |
|---|---|---|
| `normalize.json` | data vectors | §2 input handling |
| `spf.json`, `dmarc.json`, `mx.json` | data vectors (fake DNS) | §4–6 |
| `check.json` | data vectors (fake DNS) | §3, §7 orchestration and assembly |
| `http.json` | **scenario specs**, where `input`/`expect` are prose | §8 HTTP/auth/rate limit/usage, plus behavioral DNS/RES rules |

For `http.json`, each scenario becomes one hand-written test named with its `id`. The prose is the acceptance criterion.

## Fake DNS zone format (`spf.json`, `dmarc.json`, `mx.json`, `check.json`)

The `dns` object is the complete DNS universe for that vector. The test harness builds a fake resolver from it (DNS-1):

```json
"dns": {
  "example.com": {
    "TXT": [["v=spf1 include:_spf.mail.test ", "-all"]],
    "MX":  [{ "priority": 10, "exchange": "mx1.example.com" }]
  },
  "mx1.example.com": { "A": ["192.0.2.10"] },
  "broken.test":     { "TXT": "ERROR" }
}
```

| Situation | How it's written | Resolver outcome (DNS-2) |
|---|---|---|
| Name not listed at all | *(omit the name)* | `nxdomain` |
| Name listed, record type not listed | `"name": { }` or other types only | `no_records` |
| Record type set to `"ERROR"` | `"TXT": "ERROR"` | `error` |
| Records present | arrays as shown | `found` |

TXT values are an array of **records**, and each record is an array of **strings**. The strings of one record are joined with no separator (DNS-5). `["v=spf1 include:a.test ", "-all"]` is one record: `v=spf1 include:a.test -all`.

## Matching semantics for `expect`

- Scalar fields listed in `expect` must be strictly equal to the output field of the same name.
- `issue_codes` is the **exact ordered list** of issue `code` values on that check, so no extra issues are allowed.
- `issue_severities` (when present) is the exact ordered list of severities, parallel to `issue_codes`.
- `records` (when present) is compared exactly, element by element. `records_last` (when present) is compared to the final element only.
- `message_contains` (when present) is a list of substrings that must each appear in the first issue's message.
- Fields not listed in `expect` are not asserted by the vector. They are still covered by OpenAPI schema validation of the full response.
