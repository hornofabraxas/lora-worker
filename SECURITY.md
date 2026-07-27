# Security Policy

This is the multiplayer service for
[LoRa the Explorer](https://github.com/hornofabraxas/lora-the-explorer). It is the trust boundary
for the whole game, so security reports here matter more than anywhere else in the project.

## Reporting a vulnerability

**Please do not open a public issue.**

- **GitHub** → *Security* tab → *Report a vulnerability* (preferred)
- **[Discord](https://discord.gg/EHXemsA2SS)** → direct message the maintainer

Include what the issue is, how to reproduce it, and what an attacker gains. No bounty, no SLA —
one person maintains this — but serious issues are fixed as fast as is practical, with credit if
you want it.

## High-value targets

The things most worth your attention:

- **Location de-anonymisation.** Any way to recover a player's real coordinates, real H3 hex IDs, or
  precise inter-player distance from what this service stores or returns. Post identifiers are
  supposed to be opaque tokens; centroids ~11 km; scout distances fuzzed to 50 miles. **Breaking any
  of those is the most serious class of bug in this project.**
- **Authentication bypass.** Forging or replaying the HMAC signature, acting as another player, or
  defeating the ±300 s timestamp window.
- **Admin exposure.** Reaching `/api/admin/*` without `ADMIN_SECRET`, or `/admin/api/*` without a
  valid Cloudflare Access JWT. Note that an Access session is *deliberately* not accepted on the
  machine path — a bypass of that separation is a finding.
- **Cross-player writes.** Any route that lets one player mutate another's items, defence, posts,
  or standing outside of legitimate combat.
- **Validation escapes.** Anything letting a modified client mint items, backdate charters, inflate
  renown, teleport a centroid before a raid, or evade the rate caps.

## Out of scope

- **A player cheating their own local progression.** The client is open source and self-hosted and
  GPS never leaves the device; spoofed GPS and inflated local XP are known, accepted, and
  architecturally unsolvable. They're bounded by caps and manual review, not prevented.
- Gameplay balance complaints.
- Vulnerabilities in Cloudflare itself — report to Cloudflare.
- Denial of service via request volume against the reference deployment.

## Known design notes

Stated openly so nobody wastes time reporting them as novel:

- **The per-player shared secret is stored in the Durable Object as-is** (the `secret_hash` field is
  a shared HMAC key, despite the name — it cannot be a one-way hash, because the server must
  recompute the signature). Anyone with read access to the storage backend can impersonate any
  player. Access to that storage is the security boundary.
- **Deleting a player leaves historical raid and scout records in place.** Those can reference the
  pseudonymous player ID and the display name at the time. Full erasure is currently a manual step.

## If you run your own instance

- **Set `REGISTER_SECRET`.** Unset means open registration, and every registered player is a
  leaderboard entry and a valid raid actor — that's a sybil surface.
- **Set your own `ADMIN_SECRET`** and rotate it if it's ever been in a shell history or a log.
- **Replace `ADMIN_EMAILS` and the Cloudflare Access values** in `wrangler.toml` with your own.
- Never commit secrets — use `wrangler secret put`. `wrangler.toml` `[vars]` is world-readable in a
  public repository, so only non-sensitive configuration belongs there.
