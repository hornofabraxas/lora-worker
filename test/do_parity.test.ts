import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { kvAdapter } from "../src/kv/do_store.js";

// Verifies the KvStore Durable Object + kvAdapter faithfully emulate the subset
// of KV semantics the Worker relies on. This is the one layer the mock-KV unit
// suite can't cover, and the entire delta between tested code and production.

function store(name = crypto.randomUUID()) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return kvAdapter((env as any).KV_DO, name);
}

describe("KvStore DO ↔ KV parity", () => {
  it("put / get returns the raw string; missing keys return null", async () => {
    const kv = store();
    await kv.put("a", "hello");
    expect(await kv.get("a")).toBe("hello");
    expect(await kv.get("nope")).toBeNull();
  });

  it("get(key, 'json') and get(key, {type:'json'}) parse JSON", async () => {
    const kv = store();
    const obj = { x: 1, y: [2, 3], nested: { z: "q" } };
    await kv.put("obj", JSON.stringify(obj));
    expect(await kv.get("obj", "json")).toEqual(obj);
    expect(await kv.get("obj", { type: "json" })).toEqual(obj);
  });

  it("put overwrites and delete removes", async () => {
    const kv = store();
    await kv.put("k", "v1");
    await kv.put("k", "v2");
    expect(await kv.get("k")).toBe("v2");
    await kv.delete("k");
    expect(await kv.get("k")).toBeNull();
  });

  it("list returns only prefix matches with correct shape (range scan, no LIKE wildcards)", async () => {
    const kv = store();
    await kv.put("bundle:1", "x");
    await kv.put("bundle:2", "y");
    await kv.put("player:1", "z");
    // underscore must be treated literally, not as a wildcard
    await kv.put("daily_surveys:p:2026-07-11", "w");

    const bundles = await kv.list({ prefix: "bundle:" });
    expect(bundles.keys.map((k) => k.name).sort()).toEqual(["bundle:1", "bundle:2"]);
    expect(bundles.list_complete).toBe(true);

    const daily = await kv.list({ prefix: "daily_surveys:" });
    expect(daily.keys.map((k) => k.name)).toEqual(["daily_surveys:p:2026-07-11"]);

    const all = await kv.list({});
    expect(all.keys.length).toBe(4);
  });

  it("respects expiry on both get and list", async () => {
    const kv = store();
    const now = Math.floor(Date.now() / 1000);
    await kv.put("exp:gone", "v", { expiration: now - 10 });
    await kv.put("exp:live", "v", { expiration: now + 3600 });

    expect(await kv.get("exp:gone")).toBeNull();
    expect(await kv.get("exp:live")).toBe("v");

    const res = await kv.list({ prefix: "exp:" });
    expect(res.keys.map((k) => k.name)).toEqual(["exp:live"]);
  });

  it("expirationTtl is honored (future ttl stays live)", async () => {
    const kv = store();
    await kv.put("ttl", "v", { expirationTtl: 3600 });
    expect(await kv.get("ttl")).toBe("v");
  });
});
