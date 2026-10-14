import { KEY_FORM_SCRIPT } from "../../src/http/landing-script.js";

type Listener = (event: { preventDefault(): void }) => void;

/** The few element properties the landing page's script touches. */
export class FakeElement {
  hidden = false;
  disabled = false;
  value = "";
  textContent = "";
  readonly listeners = new Map<string, Listener>();
  constructor(readonly id: string) {}
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }
  fire(type: string): void {
    this.listeners.get(type)?.({ preventDefault() {} });
  }
}

const IDS = [
  "key-form",
  "email",
  "key-submit",
  "key-status",
  "key-result",
  "key-value",
  "key-copy",
] as const;

export interface FakeBrowser {
  el: Record<(typeof IDS)[number], FakeElement>;
  fetchCalls: { url: string; init: RequestInit }[];
  copied: string[];
  /** Runs the page script. */
  run(): void;
  /** Types an email into the form and submits it, then lets the promise chain settle. */
  submit(email: string): Promise<void>;
}

/**
 * Runs the real landing-page script against a stub DOM (LP-1, LP-3). `fetchImpl` stands in for
 * the network; `clipboard: false` models a browser without the Clipboard API. No jsdom needed.
 */
export function fakeBrowser(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  options: { clipboard?: boolean } = {},
): FakeBrowser {
  const el = Object.fromEntries(
    IDS.map((id) => [id, new FakeElement(id)]),
  ) as FakeBrowser["el"];
  // As in the HTML: the form starts hidden, the result and exists blocks start hidden.
  el["key-form"].hidden = true;
  el["key-result"].hidden = true;
  const fetchCalls: FakeBrowser["fetchCalls"] = [];
  const copied: string[] = [];
  const document = {
    getElementById: (id: string) => el[id as keyof typeof el],
  };
  const navigator =
    options.clipboard === false
      ? {}
      : {
          clipboard: {
            writeText: (text: string) => {
              copied.push(text);
              return Promise.resolve();
            },
          },
        };
  const fetchStub = (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    return fetchImpl(url, init);
  };
  return {
    el,
    fetchCalls,
    copied,
    run: () =>
      new Function("document", "fetch", "navigator", KEY_FORM_SCRIPT)(
        document,
        fetchStub,
        navigator,
      ),
    submit: async (email) => {
      el["email"].value = email;
      el["key-form"].fire("submit");
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}
