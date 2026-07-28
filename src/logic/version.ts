/**
 * Minimal dotted-version comparison for the client-version gate. Not full
 * semver (no prerelease-ordering rules) — this only needs to answer "is the
 * game server's reported version at least this Worker's floor?", where both
 * sides are always plain X.Y.Z from the client's own __version__.
 */
function parseVersion(v: string): number[] {
  const core = v.replace(/^v/i, "").split("+")[0].split("-")[0];
  const parts = core.split(".").map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return parts.length > 0 ? parts : [0];
}

/** -1 if a<b, 0 if equal, 1 if a>b, comparing missing trailing segments as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * A missing/empty clientVersion always fails once a floor is set — it means
 * either a pre-version-reporting client (older than this feature existed) or a
 * client that stripped the header, and there is no way to tell those apart, so
 * the safe assumption is "too old." Callers only invoke this once minVersion
 * is a real floor (see the "0.0.0"/unset short-circuit in the middleware).
 */
export function isVersionAtLeast(clientVersion: string | null | undefined, minVersion: string): boolean {
  if (!clientVersion) return false;
  return compareVersions(clientVersion, minVersion) >= 0;
}
