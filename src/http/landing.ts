import { createHash } from "node:crypto";
import { LIMITATIONS } from "../core/issues.js";
import { KEY_FORM_SCRIPT } from "./landing-script.js";
import type { RateLimits } from "./ratelimit.js";

export { KEY_FORM_SCRIPT };

/** LP-4. The wording is fixed by the spec. */
export const PRIVACY_LINE =
  "We store your email only to contact you about this API. The API doesn’t save the domains you check.";

/** LP-3. The wording is fixed by the spec. */
export const SAVE_WARNING = "Save this now — it won’t be shown again.";

export const DESCRIPTION =
  "Structured SPF, DMARC and MX diagnostics for a domain, read from public DNS and returned as JSON.";

/** LP-2: an excerpt of a real response shape (spec/openapi.yaml DomainCheckResult). */
export const SAMPLE_EXCERPT = {
  domain: "example.com",
  domain_exists: true,
  summary: { status: "pass", errors: 0, warnings: 0, info: 0 },
  spf: {
    status: "valid",
    record: "v=spf1 ip4:192.0.2.0/24 ~all",
    all_qualifier: "~",
    lookup_count: 0,
    lookup_count_exact: true,
    issues: [],
  },
  dmarc: {
    status: "valid",
    record: "v=DMARC1; p=reject; rua=mailto:reports@example.com",
    policy: "reject",
    rua: ["mailto:reports@example.com"],
    issues: [],
  },
  mx: {
    status: "valid",
    records: [{ priority: 10, exchange: "mail.example.com", resolves: true }],
    issues: [],
  },
};

const STYLE = `
:root { color-scheme: light dark; }
body { font: 16px/1.55 system-ui, sans-serif; max-width: 46rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
h1 { font-size: 1.8rem; margin-bottom: 0.25rem; }
h2 { font-size: 1.15rem; margin-top: 2rem; }
pre, code { font: 0.9em ui-monospace, monospace; }
pre { background: rgba(127, 127, 127, 0.15); padding: 0.8rem 1rem; overflow-x: auto; border-radius: 6px; }
code { background: rgba(127, 127, 127, 0.15); padding: 0.1em 0.3em; border-radius: 4px; }
pre code { background: none; padding: 0; }
input, button { font: inherit; padding: 0.45rem 0.7rem; }
input { min-width: 15rem; }
#key-value { font-size: 1.05rem; word-break: break-all; }
.warn { font-weight: 600; }
`;

const sha = (text: string) =>
  `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/** LP-1: nothing loads from anywhere but this origin, and only these two inline blocks run. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `script-src ${sha(KEY_FORM_SCRIPT)}`,
  `style-src ${sha(STYLE)}`,
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** CONTACT_URL is operator config, but it ends up in an href, so only these schemes pass. */
export function safeContactUrl(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return ["https:", "http:", "mailto:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export interface LandingOptions {
  /** The origin the page was served from, e.g. https://domain-health-api.vercel.app. */
  origin: string;
  limits: RateLimits;
  contactUrl: string | null;
}

/** LP-1..LP-5. One static page; the only per-request parts are the host, limits and contact link. */
export function renderLanding(options: LandingOptions): string {
  const origin = escapeHtml(options.origin);
  const contact = safeContactUrl(options.contactUrl);
  const contactLink = contact
    ? ` <a href="${escapeHtml(contact)}">Contact us</a> if you need help with it.`
    : "";
  const checkCurl = `curl -s "${origin}/v1/domain/check?domain=example.com" \\
  -H "Authorization: Bearer $DH_API_KEY"`;
  const keyCurl = `curl -s -X POST "${origin}/v1/keys" \\
  -H "Content-Type: application/json" \\
  -d '{"email":"you@example.com"}'`;
  const limitations = LIMITATIONS.map((l) => `<li>${escapeHtml(l)}</li>`).join(
    "\n      ",
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Domain Health API</title>
<meta name="description" content="${escapeHtml(DESCRIPTION)}">
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>Domain Health API</h1>
  <p>${escapeHtml(DESCRIPTION)}</p>

  <h2>Get a free key</h2>
  <form id="key-form" action="/v1/keys" method="post" hidden>
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required autocomplete="email">
    <button id="key-submit" type="submit">Get a key</button>
  </form>
  <noscript>
    <p>The key form needs JavaScript. Without it, request a key from a terminal:</p>
    <pre><code>${keyCurl}</code></pre>
  </noscript>
  <p id="key-status" role="status"></p>
  <div id="key-result" hidden>
    <p>Your API key:</p>
    <p><code id="key-value"></code></p>
    <p><button id="key-copy" type="button">Copy</button></p>
    <p class="warn">${escapeHtml(SAVE_WARNING)}</p>
  </div>
  <p id="key-exists" hidden>A key already exists for that email.${contactLink}</p>
  <p>${escapeHtml(PRIVACY_LINE)}</p>

  <h2>Try it</h2>
  <pre><code>${checkCurl}</code></pre>
  <p>Send the key as <code>Authorization: Bearer &lt;key&gt;</code> or in an <code>X-API-Key</code> header. Send a bare domain such as <code>example.com</code>.</p>

  <h2>Sample response (excerpt)</h2>
  <pre><code>${escapeHtml(JSON.stringify(SAMPLE_EXCERPT, null, 2))}</code></pre>

  <h2>Free limits</h2>
  <p>${options.limits.perMinute} requests per minute and ${options.limits.perDay} requests per day for each key.</p>

  <h2>Limitations</h2>
  <ul>
      ${limitations}
  </ul>
</main>
<script>${KEY_FORM_SCRIPT}</script>
</body>
</html>
`;
}
