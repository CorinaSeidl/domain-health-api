import { domainToASCII } from "node:url";
import { isIP } from "node:net";

export type NormalizeResult =
  | { ok: true; domain: string }
  | { ok: false; code: "missing_domain" | "invalid_domain"; message: string };

const SPECIAL_USE_TLDS = new Set([
  "localhost",
  "local",
  "internal",
  "invalid",
  "test",
  "onion",
  "lan",
  "home",
  "corp",
]);

function invalid(message: string): NormalizeResult {
  return { ok: false, code: "invalid_domain", message };
}

/** SPEC.md §2. Steps run in the order IN-1, IN-2, IN-3, IN-4, IN-5, IN-6, IN-7. */
export function normalizeDomain(
  input: string | null | undefined,
): NormalizeResult {
  // IN-1
  const trimmed = (input ?? "").trim();
  if (trimmed === "") {
    return {
      ok: false,
      code: "missing_domain",
      message:
        "The domain query parameter is required, for example ?domain=example.com.",
    };
  }

  // IN-2
  let name = trimmed.toLowerCase();
  if (name.endsWith(".")) name = name.slice(0, -1);

  // IN-3 (before IDN conversion so URLs get the clearer message)
  if (name.includes("://")) {
    return invalid("Send a bare domain like example.com, not a URL.");
  }
  if (name.includes("/")) {
    return invalid("Send a bare domain like example.com, without a path.");
  }
  if (name.includes("?")) {
    return invalid(
      "Send a bare domain like example.com, without a query string.",
    );
  }
  if (name.includes("#")) {
    return invalid("Send a bare domain like example.com, without a fragment.");
  }
  if (name.includes("@")) {
    return invalid(
      "Send a bare domain like example.com, without a username or email address.",
    );
  }
  if (name.includes(":")) {
    const bare = name.replace(/^\[|\]$/g, "");
    if (isIP(bare) !== 0) {
      return invalid("Send a domain name like example.com, not an IP address.");
    }
    return invalid("Send a bare domain like example.com, without a port.");
  }
  if (/\s/.test(name)) {
    return invalid("Send a bare domain like example.com, without spaces.");
  }

  // IN-4
  const ascii = domainToASCII(name);
  if (ascii === "") {
    return invalid(
      "That is not a valid domain name. Send a bare domain like example.com.",
    );
  }

  // IN-5
  if (isIP(ascii) !== 0) {
    return invalid("Send a domain name like example.com, not an IP address.");
  }

  // IN-7 (the bare name localhost, checked first for a clearer message)
  if (ascii === "localhost") {
    return invalid(
      "Local and special-use names such as localhost are not public domains.",
    );
  }

  // IN-6
  const labels = ascii.split(".");
  if (ascii.length > 253) {
    return invalid("The domain name is longer than 253 characters.");
  }
  if (labels.length < 2) {
    return invalid("Send a full domain like example.com, not a single label.");
  }
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) {
      return invalid(
        "Each part of the domain name must be 1 to 63 characters long.",
      );
    }
    if (!/^[a-z0-9-]+$/.test(label)) {
      return invalid(
        "The domain name may only contain letters, digits and hyphens.",
      );
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      return invalid(
        "A part of the domain name may not start or end with a hyphen.",
      );
    }
  }
  const tld = labels[labels.length - 1] as string;
  if (/^[0-9]+$/.test(tld)) {
    return invalid("The last part of the domain name may not be all digits.");
  }

  // IN-7
  if (SPECIAL_USE_TLDS.has(tld) || ascii.endsWith(".home.arpa")) {
    return invalid("Local and special-use names are not public domains.");
  }

  return { ok: true, domain: ascii };
}
