import { createMiddleware } from "hono/factory";
import type { Env } from "../types.js";
import { isVersionAtLeast } from "../logic/version.js";

type VersionCtx = { Bindings: Env };

/**
 * Rejects a request from a game server whose reported version is below
 * `env.MIN_CLIENT_VERSION`. Mounted globally in index.ts rather than per-route
 * so a floor raised for one breaking change protects every current and future
 * route uniformly — including /api/register, since an incompatible client
 * shouldn't be able to join in the first place.
 *
 * Admin/operator surfaces are explicitly excluded: they're browser or
 * ADMIN_SECRET calls, never game-client traffic, and never send
 * X-Client-Version, so gating them would just lock the operator out.
 *
 * Unset or "0.0.0" (the wrangler.toml default) means enforcement is off —
 * this is a deliberate floor an operator raises only when a breaking wire
 * change actually ships, not something that blocks by default.
 */
export const clientVersionMiddleware = createMiddleware<VersionCtx>(async (c, next) => {
  if (c.req.path.startsWith("/api/admin") || c.req.path.startsWith("/admin")) {
    return next();
  }

  const min = c.env.MIN_CLIENT_VERSION;
  if (!min || min === "0.0.0") {
    return next();
  }

  const clientVersion = c.req.header("X-Client-Version");
  if (isVersionAtLeast(clientVersion, min)) {
    return next();
  }

  return c.json({
    ok: false,
    error: `This client is too old to sync with the war ledger. Update to v${min} or newer.`,
    min_version: min,
    your_version: clientVersion || null,
  }, 426);
});
