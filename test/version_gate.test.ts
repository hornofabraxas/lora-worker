import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import { makeEnv } from "./helpers/env.js";

let env: Env;

beforeEach(() => {
  env = makeEnv();
});

function setFloor(v: string) {
  (env as unknown as { MIN_CLIENT_VERSION: string }).MIN_CLIENT_VERSION = v;
}

function registerReq(version?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (version) headers["X-Client-Version"] = version;
  return new Request("http://localhost/api/register", {
    method: "POST",
    headers,
    body: JSON.stringify({ display_name: "Whoever" }),
  });
}

describe("client version gate", () => {
  it("is a no-op with the default floor (0.0.0)", async () => {
    // makeEnv() picks up wrangler.toml's MIN_CLIENT_VERSION = "0.0.0" — no
    // override needed. Every existing test in the suite relies on exactly
    // this: the gate must never block a request that sends no version header.
    const res = await app.fetch(registerReq(), env);
    expect(res.status).not.toBe(426);
  });

  it("is a no-op with the floor unset entirely", async () => {
    (env as unknown as { MIN_CLIENT_VERSION?: string }).MIN_CLIENT_VERSION = undefined;
    const res = await app.fetch(registerReq(), env);
    expect(res.status).not.toBe(426);
  });

  it("rejects a request with no version header once a real floor is set", async () => {
    setFloor("0.3.0");
    const res = await app.fetch(registerReq(), env);
    expect(res.status).toBe(426);
    const body = await res.json() as { ok: boolean; min_version: string; your_version: string | null };
    expect(body.ok).toBe(false);
    expect(body.min_version).toBe("0.3.0");
    expect(body.your_version).toBeNull();
  });

  it("rejects a client below the floor", async () => {
    setFloor("0.3.0");
    const res = await app.fetch(registerReq("0.2.0"), env);
    expect(res.status).toBe(426);
    const body = await res.json() as { your_version: string };
    expect(body.your_version).toBe("0.2.0");
  });

  it("accepts a client at or above the floor", async () => {
    setFloor("0.3.0");
    expect((await app.fetch(registerReq("0.3.0"), env)).status).not.toBe(426);
    expect((await app.fetch(registerReq("0.4.1"), env)).status).not.toBe(426);
  });

  it("never gates the admin API, even below the floor", async () => {
    setFloor("99.0.0");
    (env as unknown as { ADMIN_SECRET: string }).ADMIN_SECRET = "s";
    const res = await app.fetch(
      new Request("http://localhost/api/admin/flags", {
        headers: { "x-admin-secret": "s" },
      }),
      env,
    );
    expect(res.status).not.toBe(426);
  });

  it("never gates the browser admin UI, even below the floor", async () => {
    setFloor("99.0.0");
    const res = await app.fetch(new Request("http://localhost/admin"), env);
    expect(res.status).not.toBe(426);
  });
});
