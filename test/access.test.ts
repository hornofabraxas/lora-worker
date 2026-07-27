import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import { makeEnv } from "./helpers/env.js";
import { resetAccessCerts } from "../src/middleware/access.js";

// Cloudflare Access verification. The Worker checks the Access JWT itself
// instead of trusting the edge to have blocked the request, so these tests
// mint real RS256 tokens against a stubbed JWKS endpoint and confirm every way
// a token can be wrong is rejected.

const AUD = "a416f57695a708e11eed20e991aedda5c19dfd9b988bc18f4c43d2b97cd64893";
const TEAM = "testteam.cloudflareaccess.com";
const KID = "test-key-1";
const EMAIL = "operator@example.com";

let env: Env;
let keyPair: CryptoKeyPair;
let otherPair: CryptoKeyPair;
let realFetch: typeof globalThis.fetch;

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string"
    ? bytes
    : Array.from(bytes).map((b) => String.fromCharCode(b)).join("");
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function mintToken(opts: {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  iat?: number;
  email?: string;
  kid?: string;
  signWith?: CryptoKeyPair;
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: opts.kid ?? KID, typ: "JWT" };
  const claims = {
    aud: opts.aud ?? AUD,
    iss: opts.iss ?? `https://${TEAM}`,
    exp: opts.exp ?? now + 3600,
    iat: opts.iat ?? now - 10,
    email: opts.email ?? EMAIL,
    sub: "operator-sub",
  };
  const signing = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    (opts.signWith ?? keyPair).privateKey,
    new TextEncoder().encode(signing),
  );
  return `${signing}.${b64url(new Uint8Array(sig))}`;
}

beforeEach(async () => {
  env = makeEnv();
  const e = env as unknown as Record<string, string>;
  e.ACCESS_AUD = AUD;
  e.ACCESS_TEAM_DOMAIN = TEAM;
  e.ADMIN_EMAILS = EMAIL;
  delete (env as { ADMIN_SECRET?: string }).ADMIN_SECRET;

  const params = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  keyPair = await crypto.subtle.generateKey(params, true, ["sign", "verify"]) as CryptoKeyPair;
  otherPair = await crypto.subtle.generateKey(params, true, ["sign", "verify"]) as CryptoKeyPair;

  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  resetAccessCerts();
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify({ keys: [{ kid: KID, kty: "RSA", alg: "RS256", n: jwk.n, e: jwk.e }] }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetAccessCerts();
});

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { headers });
}

describe("Access-gated /admin surface", () => {
  it("serves the page to a valid Access identity", async () => {
    const res = await app.fetch(req("/admin", { "Cf-Access-Jwt-Assertion": await mintToken() }), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("LoRa Admin");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts the token from the CF_Authorization cookie too", async () => {
    const token = await mintToken();
    const res = await app.fetch(req("/admin", { Cookie: `CF_Authorization=${token}; other=1` }), env);
    expect(res.status).toBe(200);
  });

  it("serves the JSON API to a valid identity", async () => {
    const res = await app.fetch(req("/admin/api/flags", { "Cf-Access-Jwt-Assertion": await mintToken() }), env);
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });

  it("rejects a request with no token at all", async () => {
    expect((await app.fetch(req("/admin"), env)).status).toBe(403);
    expect((await app.fetch(req("/admin/api/flags"), env)).status).toBe(403);
    expect((await app.fetch(req("/admin/api/names"), env)).status).toBe(403);
  });

  it("rejects a token signed by the wrong key", async () => {
    const token = await mintToken({ signWith: otherPair });
    expect((await app.fetch(req("/admin", { "Cf-Access-Jwt-Assertion": token }), env)).status).toBe(403);
  });

  it("rejects a token for a different Access application (wrong aud)", async () => {
    const token = await mintToken({ aud: "0".repeat(64) });
    expect((await app.fetch(req("/admin", { "Cf-Access-Jwt-Assertion": token }), env)).status).toBe(403);
  });

  it("rejects a token from a different team (wrong iss)", async () => {
    const token = await mintToken({ iss: "https://someoneelse.cloudflareaccess.com" });
    expect((await app.fetch(req("/admin", { "Cf-Access-Jwt-Assertion": token }), env)).status).toBe(403);
  });

  it("rejects an expired token", async () => {
    const token = await mintToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    expect((await app.fetch(req("/admin", { "Cf-Access-Jwt-Assertion": token }), env)).status).toBe(403);
  });

  it("rejects an unknown signing key id", async () => {
    const token = await mintToken({ kid: "not-a-real-kid" });
    expect((await app.fetch(req("/admin", { "Cf-Access-Jwt-Assertion": token }), env)).status).toBe(403);
  });

  it("rejects an email outside ADMIN_EMAILS", async () => {
    const token = await mintToken({ email: "someone.else@example.com" });
    expect((await app.fetch(req("/admin", { "Cf-Access-Jwt-Assertion": token }), env)).status).toBe(403);
  });

  it("rejects malformed tokens without throwing", async () => {
    for (const bad of ["", "not.a.jwt", "a.b", "....", "aaa.bbb.ccc"]) {
      const res = await app.fetch(req("/admin", { "Cf-Access-Jwt-Assertion": bad }), env);
      expect(res.status).toBe(403);
    }
  });

  it("fails closed when Access is unconfigured", async () => {
    const e = env as unknown as Record<string, string | undefined>;
    const token = await mintToken();
    e.ACCESS_AUD = undefined;
    expect((await app.fetch(req("/admin", { "Cf-Access-Jwt-Assertion": token }), env)).status).toBe(403);
    e.ACCESS_AUD = AUD;
    e.ACCESS_TEAM_DOMAIN = undefined;
    expect((await app.fetch(req("/admin", { "Cf-Access-Jwt-Assertion": token }), env)).status).toBe(403);
  });

  it("still accepts the admin secret on /admin (local dev parity)", async () => {
    (env as unknown as { ADMIN_SECRET: string }).ADMIN_SECRET = "s3cret";
    expect((await app.fetch(req("/admin", { "x-admin-secret": "s3cret" }), env)).status).toBe(200);
    expect((await app.fetch(req("/admin", { "x-admin-secret": "wrong" }), env)).status).toBe(403);
  });
});

describe("the two admin mounts stay in step", () => {
  it("exposes the same handlers under /api/admin and /admin/api", async () => {
    (env as unknown as { ADMIN_SECRET: string }).ADMIN_SECRET = "s3cret";
    const token = await mintToken();

    const viaSecret = await app.fetch(req("/api/admin/flags", { "x-admin-secret": "s3cret" }), env);
    const viaAccess = await app.fetch(req("/admin/api/flags", { "Cf-Access-Jwt-Assertion": token }), env);
    expect(viaSecret.status).toBe(200);
    expect(viaAccess.status).toBe(200);
    expect(await viaAccess.json()).toEqual(await viaSecret.json());
  });

  it("does not let an Access token unlock the machine surface, or vice versa", async () => {
    (env as unknown as { ADMIN_SECRET: string }).ADMIN_SECRET = "s3cret";
    const token = await mintToken();
    // The /api/admin/* surface is secret-only by design: an Access session in a
    // browser must not be able to drive the scripted surface via CSRF.
    expect((await app.fetch(req("/api/admin/flags", { "Cf-Access-Jwt-Assertion": token }), env)).status).toBe(403);
  });
});
