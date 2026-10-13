/** In-memory fake of the Upstash REST API (/pipeline and /multi-exec). No network, no credentials. */

export const FAKE_URL = "https://fake-redis.test";
export const FAKE_TOKEN = "fake-token-not-a-secret";

export interface FakeCall {
  path: string;
  commands: (string | number)[][];
}

export function fakeUpstash(now: () => number = Date.now) {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const expiry = new Map<string, number>();
  const calls: FakeCall[] = [];
  const state = { failWith: null as null | "http" | "network" | "command" };

  const alive = (key: string): boolean => {
    const at = expiry.get(key);
    if (at !== undefined && at <= now() / 1000) {
      strings.delete(key);
      sets.delete(key);
      expiry.delete(key);
      return false;
    }
    return true;
  };

  function run(cmd: (string | number)[]): unknown {
    const [name, key, ...rest] = cmd as [
      string,
      string,
      ...(string | number)[],
    ];
    switch (name) {
      case "INCR": {
        alive(key);
        const n = Number(strings.get(key) ?? 0) + 1;
        strings.set(key, String(n));
        return n;
      }
      case "GET":
        return alive(key) ? (strings.get(key) ?? null) : null;
      case "SET": {
        alive(key);
        if (rest[1] === "NX" && strings.has(key)) return null;
        strings.set(key, String(rest[0]));
        return "OK";
      }
      case "DEL": {
        const had = strings.delete(key) || sets.delete(key);
        expiry.delete(key);
        return had ? 1 : 0;
      }
      case "EXPIREAT":
        if (!strings.has(key) && !sets.has(key)) return 0;
        expiry.set(key, Number(rest[0]));
        return 1;
      case "SADD": {
        alive(key);
        const set = sets.get(key) ?? new Set<string>();
        const before = set.size;
        set.add(String(rest[0]));
        sets.set(key, set);
        return set.size - before;
      }
      case "SMEMBERS":
        return alive(key) ? [...(sets.get(key) ?? [])] : [];
      default:
        throw new Error(`fake upstash: unsupported ${name}`);
    }
  }

  const fetchImpl = (input: string, init: RequestInit): Promise<Response> => {
    const path = input.slice(FAKE_URL.length);
    const headers = new Headers(init.headers);
    const commands = JSON.parse(String(init.body)) as (string | number)[][];
    calls.push({ path, commands });
    if (state.failWith === "network") {
      return Promise.reject(new TypeError("fetch failed"));
    }
    if (
      headers.get("authorization") !== `Bearer ${FAKE_TOKEN}` ||
      state.failWith === "http"
    ) {
      return Promise.resolve(new Response('{"error":"boom"}', { status: 401 }));
    }
    if (path !== "/pipeline" && path !== "/multi-exec") {
      return Promise.resolve(new Response("{}", { status: 404 }));
    }
    const results = commands.map((c) =>
      state.failWith === "command" ? { error: "ERR boom" } : { result: run(c) },
    );
    return Promise.resolve(Response.json(results));
  };

  return {
    fetch: fetchImpl as unknown as typeof fetch,
    calls,
    state,
    strings,
    expiry,
  };
}
