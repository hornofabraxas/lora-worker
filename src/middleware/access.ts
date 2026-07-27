import type { Env } from "../types.js";
import { timingSafeEqual } from "./auth.js";

// Cloudflare Access verification for the browser-facing /admin surface.
//
// Access sits in front of lora.nukeradio.net/admin* and, once the operator has
// logged in, stamps every request with a signed JWT (header on the first hop,
// CF_Authorization cookie thereafter). We verify that JWT here rather than
// trusting the edge to have blocked the request: a mistyped path in the Access
// application, or a second route bound to this Worker, would silently turn the
// admin page public. Verifying costs one cached JWKS fetch and makes the
// pipeline ordering irrelevant.
//
// Fails closed — if ACCESS_AUD/ACCESS_TEAM_DOMAIN are unset, no Access identity
// is ever accepted. The x-admin-secret header remains a valid alternative gate
// (same trust level as the existing /api/admin/* routes) so `wrangler dev` works
// without a Zero Trust tunnel.

const JWT_HEADER = "Cf-Access-Jwt-Assertion";
const JWT_COOKIE = "CF_Authorization";
const CERTS_TTL_MS = 60 * 60 * 1000; // Cloudflare rotates Access keys ~6 weekly

interface JwkKey {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

interface AccessClaims {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  sub?: string;
}

export interface AccessIdentity {
  email: string;
  sub: string;
}

// Module-scope cache. Workers isolates are short-lived and per-colo, so this is
// a best-effort warm cache, not a shared one — a miss just costs one subrequest.
let certsCache: { teamDomain: string; keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeJson<T>(input: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(input))) as T;
  } catch {
    return null;
  }
}

/** Normalize whatever the operator put in ACCESS_TEAM_DOMAIN to a bare host. */
function normalizeTeamDomain(raw: string): string {
  let host = raw.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host.includes(".")) host = `${host}.cloudflareaccess.com`;
  return host;
}

async function loadCerts(teamDomain: string): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (certsCache && certsCache.teamDomain === teamDomain && now - certsCache.fetchedAt < CERTS_TTL_MS) {
    return certsCache.keys;
  }

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const body = await res.json<{ keys?: JwkKey[] }>();

  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(jwk.kid, key);
    } catch {
      // Skip a malformed key rather than failing every other key with it.
    }
  }

  certsCache = { teamDomain, keys, fetchedAt: now };
  return keys;
}

/** Reset the JWKS cache. Test seam. */
export function resetAccessCerts(): void {
  certsCache = null;
}

function readToken(req: { header: (n: string) => string | undefined }): string | null {
  const header = req.header(JWT_HEADER);
  if (header) return header;
  const cookie = req.header("Cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === JWT_COOKIE && rest.length > 0) return rest.join("=");
  }
  return null;
}

function audienceMatches(aud: string | string[] | undefined, expected: string): boolean {
  if (!aud) return false;
  const list = Array.isArray(aud) ? aud : [aud];
  return list.some((a) => typeof a === "string" && timingSafeEqual(a, expected));
}

/**
 * Verify the Access JWT on a request. Returns the operator's identity, or null
 * if there is no valid Access token (missing, malformed, wrong audience,
 * expired, bad signature, or an email outside ADMIN_EMAILS).
 */
export async function verifyAccessJwt(
  c: { env: Env; req: { header: (n: string) => string | undefined } },
): Promise<AccessIdentity | null> {
  const audience = c.env.ACCESS_AUD;
  const teamRaw = c.env.ACCESS_TEAM_DOMAIN;
  if (!audience || !teamRaw) return null; // unconfigured → fail closed

  const token = readToken(c.req);
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  const header = base64UrlDecodeJson<{ alg?: string; kid?: string }>(headerB64);
  if (!header || header.alg !== "RS256" || !header.kid) return null;

  const claims = base64UrlDecodeJson<AccessClaims>(payloadB64);
  if (!claims) return null;

  const teamDomain = normalizeTeamDomain(teamRaw);

  // Check the cheap claims before spending a possible subrequest on the JWKS.
  if (!audienceMatches(claims.aud, audience)) return null;
  if (claims.iss !== `https://${teamDomain}`) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  if (typeof claims.iat === "number" && claims.iat > now + 60) return null;

  let keys: Map<string, CryptoKey>;
  try {
    keys = await loadCerts(teamDomain);
  } catch {
    return null;
  }
  const key = keys.get(header.kid);
  if (!key) return null;

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!ok) return null;

  const email = (claims.email ?? "").toLowerCase();
  const allowed = (c.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  // ADMIN_EMAILS is a second fence behind the Access policy itself; when it is
  // left unset the Access application's own allow-list is the only gate.
  if (allowed.length > 0 && !allowed.includes(email)) return null;

  return { email, sub: claims.sub ?? "" };
}

/**
 * Gate for the /admin UI surface: a valid Access identity, or the shared
 * x-admin-secret (local dev, and parity with the /api/admin/* routes).
 */
export async function requireOperator(
  c: { env: Env; req: { header: (n: string) => string | undefined } },
): Promise<boolean> {
  const secret = c.env.ADMIN_SECRET;
  const provided = c.req.header("x-admin-secret");
  if (secret && provided && timingSafeEqual(provided, secret)) return true;
  return (await verifyAccessJwt(c)) !== null;
}
