import { describe, expect, it } from "vitest";
import { LIMITATIONS } from "../src/core/issues.js";
import {
  CONTENT_SECURITY_POLICY,
  DESCRIPTION,
  KEY_FORM_SCRIPT,
  PRIVACY_LINE,
  SAMPLE_EXCERPT,
  SAVE_WARNING,
  renderLanding,
} from "../src/http/landing.js";
import { createHash } from "node:crypto";
import { fakeBrowser } from "./harness/fake-dom.js";
import { makeApp } from "./harness/http.js";
import { loadOpenApi } from "./harness/openapi.js";

const ORIGIN = "https://api.test";

async function page(
  options: Parameters<typeof makeApp>[0] = {},
  init: Parameters<ReturnType<typeof makeApp>["request"]>[1] = {},
): Promise<{ res: Response; html: string }> {
  const res = await makeApp(options).request("/", { key: null, ...init });
  return { res, html: await res.text() };
}

const withoutScript = (html: string) =>
  html.replace(/<script>[\s\S]*?<\/script>/g, "");
const textOf = (html: string) =>
  withoutScript(html)
    .replace(/<style>[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

describe("Landing page (SPEC.md §13)", () => {
  it("LP-1 GET / is 200 HTML with no authentication", async () => {
    const { res, html } = await page();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toMatch(/^[A-Za-z0-9-]{1,64}$/);
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  it("LP-1 HEAD / is 200 with no body, and other methods are 405", async () => {
    const app = makeApp();
    const head = await app.request("/", { method: "HEAD", key: null });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await app.request("/", { method, key: null });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    }
  });

  it("LP-1 a landing page request is not authenticated, counted or logged against a key", async () => {
    const app = makeApp();
    await app.request("/", { key: null });
    await app.request("/", { key: "dh_notakey" });
    expect(app.logs).toEqual([]);
  });

  it("LP-1 the page loads nothing from outside: no src, no link, no @import, no url()", async () => {
    const { html } = await page();
    const markup = withoutScript(html);
    expect(markup).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(markup).not.toMatch(/<link\b/i);
    expect(markup).not.toMatch(
      /<(img|iframe|embed|object|video|audio|source)\b/i,
    );
    expect(markup).not.toMatch(/@import|url\(/i);
    expect(markup).not.toMatch(/\ssrc=|\ssrcset=/i);
    // Every absolute URL is this origin.
    const urls = [...html.matchAll(/https?:\/\/[^\s"'<)\\]+/g)].map(
      (m) => m[0],
    );
    for (const url of urls) {
      expect(url.startsWith(ORIGIN), url).toBe(true);
    }
    // No analytics or font hosts, however they might be named.
    expect(html).not.toMatch(
      /google|gstatic|googletagmanager|analytics|fonts\.|cdn|plausible|segment|hotjar/i,
    );
  });

  it("LP-1 the Content-Security-Policy allows only this origin, the page's own script and style by hash", async () => {
    const { res, html } = await page();
    const csp = res.headers.get("content-security-policy");
    expect(csp).toBe(CONTENT_SECURITY_POLICY);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-|https?:|\*/);
    const hash = (text: string) =>
      `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
    expect(script).toBe(KEY_FORM_SCRIPT);
    expect(csp).toContain(`script-src ${hash(script!)}`);
    expect(csp).toContain(`style-src ${hash(style!)}`);
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it("LP-1 everything but the key form reads without JavaScript", async () => {
    const { html } = await page();
    const text = textOf(html);
    for (const needle of [
      DESCRIPTION,
      "curl -s",
      "Sample response",
      "Free limits",
      "Limitations",
      PRIVACY_LINE,
    ]) {
      expect(text).toContain(needle);
    }
    // The form stays hidden until the script reveals it, and a terminal fallback is in <noscript>.
    expect(html).toMatch(/<form id="key-form"[^>]*\shidden>/);
    expect(html).toMatch(/<noscript>[\s\S]*curl -s -X POST[\s\S]*<\/noscript>/);
    // The script touches only the form's own elements.
    const ids = [
      ...KEY_FORM_SCRIPT.matchAll(/getElementById\("([^"]+)"\)/g),
    ].map((m) => m[1]!);
    expect(new Set(ids)).toEqual(
      new Set([
        "key-form",
        "email",
        "key-submit",
        "key-status",
        "key-result",
        "key-value",
        "key-copy",
      ]),
    );
    for (const id of ids) expect(html).toContain(`id="${id}"`);
  });

  it("LP-2 the page has a one-sentence description", async () => {
    const { html } = await page();
    expect(DESCRIPTION.match(/[.!?](\s|$)/g)).toHaveLength(1);
    expect(html).toContain(`<p>${DESCRIPTION}</p>`);
  });

  it("LP-2 the curl example uses the host the page was served from", async () => {
    const { html } = await page();
    expect(html).toContain(
      `curl -s "${ORIGIN}/v1/domain/check?domain=example.com" \\\n  -H "Authorization: Bearer $DH_API_KEY"`,
    );
    expect(html).not.toContain("REPLACE_WITH_DEPLOYED_HOST");
    const other = renderLanding({
      origin: "https://checks.example.org",
      limits: { perMinute: 10, perDay: 200 },
    });
    expect(other).toContain(
      'curl -s "https://checks.example.org/v1/domain/check',
    );
  });

  it("LP-2 the host is HTML-escaped", () => {
    const html = renderLanding({
      origin: 'https://x.test/"><script>alert(1)</script>',
      limits: { perMinute: 10, perDay: 200 },
    });
    expect(html).not.toContain("<script>alert(1)");
    expect(html.match(/<script>/g)).toHaveLength(1);
  });

  it("LP-2 the sample response excerpt only uses fields from the DomainCheckResult schema", async () => {
    const { html } = await page();
    const shown = /Sample response[\s\S]*?<code>([\s\S]*?)<\/code>/.exec(
      html,
    )?.[1];
    expect(
      JSON.parse(shown!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")),
    ).toEqual(SAMPLE_EXCERPT);
    const schemas = loadOpenApi().components.schemas as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    const known = (schema: string, obj: object) => {
      const allowed = Object.keys(schemas[schema]?.properties ?? {});
      expect(allowed.length, schema).toBeGreaterThan(0);
      for (const key of Object.keys(obj))
        expect(allowed, `${schema}.${key}`).toContain(key);
    };
    known("DomainCheckResult", SAMPLE_EXCERPT);
    known("SpfResult", SAMPLE_EXCERPT.spf);
    known("DmarcResult", SAMPLE_EXCERPT.dmarc);
    known("MxResult", SAMPLE_EXCERPT.mx);
  });

  it("LP-2 the free limits come from the configured limits", async () => {
    expect(textOf((await page()).html)).toContain(
      "10 requests per minute and 200 requests per day",
    );
    const custom = await page({ limits: { perMinute: 3, perDay: 7 } });
    expect(textOf(custom.html)).toContain(
      "3 requests per minute and 7 requests per day",
    );
  });

  it("LP-2 [SCOPE-1] the page lists every limitation", async () => {
    const text = textOf((await page()).html);
    expect(LIMITATIONS.length).toBeGreaterThanOrEqual(2);
    for (const limitation of LIMITATIONS) expect(text).toContain(limitation);
    expect(text).toMatch(/DKIM was not checked/);
  });

  it("LP-2 the page does not link to the source repository", async () => {
    expect((await page()).html).not.toMatch(/github\.com/i);
  });

  it("LP-3 the key form posts to /v1/keys with an optional email field", async () => {
    const { html } = await page();
    expect(html).toMatch(
      /<form id="key-form" action="\/v1\/keys" method="post"/,
    );
    const input = /<input id="email"[^>]*>/.exec(html)![0];
    expect(input).toContain('type="email"');
    expect(input).not.toMatch(/\srequired/);
    expect(html).toMatch(/<label for="email">Optional:/);
    // The button comes before the email field, so it reads as the main action.
    expect(html.indexOf('id="key-submit"')).toBeLessThan(
      html.indexOf('<input id="email"'),
    );
    expect(textOf(html)).toContain("No signup needed.");
    const browser = fakeBrowser(() =>
      Promise.resolve(Response.json({}, { status: 500 })),
    );
    browser.run();
    expect(browser.el["key-form"].hidden).toBe(false);
    await browser.submit("dev@example.com");
    expect(browser.fetchCalls).toHaveLength(1);
    const call = browser.fetchCalls[0]!;
    expect(call.url).toBe("/v1/keys");
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(String(call.init.body))).toEqual({
      email: "dev@example.com",
    });
  });

  it("LP-3 on 201 the key is shown once with a copy button and the warning", async () => {
    const { html } = await page();
    expect(html).toContain(SAVE_WARNING);
    expect(SAVE_WARNING).toBe("Save this now — it won’t be shown again.");
    expect(html).toMatch(
      /<div id="key-result" hidden>[\s\S]*id="key-copy"[\s\S]*<\/div>/,
    );
    // The warning sits inside the hidden result block, so it shows only with the key.
    const block = /<div id="key-result" hidden>([\s\S]*?)<\/div>/.exec(
      html,
    )![1]!;
    expect(block).toContain(SAVE_WARNING);

    const browser = fakeBrowser(() =>
      Promise.resolve(
        Response.json(
          {
            api_key: `dh_${"K".repeat(32)}`,
            key_id: "abc",
            limits: {},
            request_id: "r",
          },
          { status: 201 },
        ),
      ),
    );
    browser.run();
    await browser.submit("dev@example.com");
    expect(browser.el["key-result"].hidden).toBe(false);
    expect(browser.el["key-value"].textContent).toBe(`dh_${"K".repeat(32)}`);
    expect(browser.el["email"].value).toBe("");
    expect(browser.el["key-submit"].disabled).toBe(true); // no second request for the same email
    browser.el["key-copy"].fire("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(browser.copied).toEqual([`dh_${"K".repeat(32)}`]);
    expect(browser.el["key-copy"].textContent).toBe("Copied");
  });

  it("LP-3 without the Clipboard API the copy button says to copy by hand", async () => {
    const browser = fakeBrowser(
      () =>
        Promise.resolve(Response.json({ api_key: "dh_x" }, { status: 201 })),
      { clipboard: false },
    );
    browser.run();
    await browser.submit("dev@example.com");
    browser.el["key-copy"].fire("click");
    expect(browser.el["key-status"].textContent).toMatch(/copy it by hand/);
  });

  it("LP-3 on 429 it says to try again later", async () => {
    const browser = fakeBrowser(() =>
      Promise.resolve(
        Response.json({ error: { code: "rate_limited" } }, { status: 429 }),
      ),
    );
    browser.run();
    await browser.submit("dev@example.com");
    expect(browser.el["key-status"].textContent.toLowerCase()).toContain(
      "try again later",
    );
    expect(browser.el["key-result"].hidden).toBe(true);
    expect(browser.el["key-submit"].disabled).toBe(false);
  });

  it("LP-3 on 400 it shows the API's message", async () => {
    const message =
      "The part of the email after the @ is not a valid domain name.";
    const browser = fakeBrowser(() =>
      Promise.resolve(
        Response.json(
          { error: { code: "invalid_email", message } },
          { status: 400 },
        ),
      ),
    );
    browser.run();
    await browser.submit("dev@localhost");
    expect(browser.el["key-status"].textContent).toBe(message);
    expect(browser.el["key-submit"].disabled).toBe(false);
  });

  it("LP-3 a network failure, a 500 and a non-JSON reply all say to try again later", async () => {
    const replies: (() => Promise<Response>)[] = [
      () => Promise.reject(new TypeError("offline")),
      () => Promise.resolve(Response.json({ error: {} }, { status: 500 })),
      () =>
        Promise.resolve(
          new Response("<html>bad gateway</html>", { status: 502 }),
        ),
    ];
    for (const reply of replies) {
      const browser = fakeBrowser(reply);
      browser.run();
      await browser.submit("dev@example.com");
      expect(browser.el["key-status"].textContent.toLowerCase()).toContain(
        "try again later",
      );
      expect(browser.el["key-submit"].disabled).toBe(false);
    }
  });

  it("LP-3 the page script works end to end against the real handler", async () => {
    const app = makeApp();
    const toHandler = (url: string, init: RequestInit) =>
      app.handle(new Request(`${ORIGIN}${url}`, init));
    const first = fakeBrowser(toHandler);
    first.run();
    await first.submit("dev@example.com");
    const key = first.el["key-value"].textContent;
    expect(key).toMatch(/^dh_[0-9A-Za-z]{32}$/);
    expect((await app.check("example.com", { key })).status).toBe(200);

    // KEY-3: no per-email limit, and no email at all is fine.
    for (const email of ["DEV@example.com", ""]) {
      const again = fakeBrowser(toHandler);
      again.run();
      await again.submit(email);
      const other = again.el["key-value"].textContent;
      expect(other, email).toMatch(/^dh_[0-9A-Za-z]{32}$/);
      expect(other).not.toBe(key);
    }

    const third = fakeBrowser(toHandler);
    third.run();
    await third.submit("nope");
    expect(third.el["key-status"].textContent).toMatch(/email/i);
  });

  it("LP-4 the page shows the privacy line", async () => {
    const { html } = await page();
    expect(PRIVACY_LINE).toBe(
      "Email is optional. If you add one, we store it only to contact you about this API. The API doesn’t save the domains you check.",
    );
    expect(html).toContain(`<p>${PRIVACY_LINE}</p>`);
  });

  it("LP-5 [SCOPE-2] no page copy, including the script's, says deliver, safe, compliant or guarantee", async () => {
    const withContact = (await page()).html;
    // The one allowed phrase is the fixed limitation sentence "not an email deliverability test".
    const allowed = "not an email deliverability test";
    const copy = withContact.replace(allowed, "");
    expect(withContact).toContain(allowed);
    expect(copy).not.toMatch(/deliver|safe|compliant|guarantee/i);
    expect(KEY_FORM_SCRIPT).not.toMatch(/deliver|safe|compliant|guarantee/i);
    expect(DESCRIPTION + PRIVACY_LINE + SAVE_WARNING).not.toMatch(
      /deliver|safe|compliant|guarantee/i,
    );
  });
});
