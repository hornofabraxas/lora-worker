# lora-worker

The multiplayer service — "the war ledger" — for
[**LoRa the Explorer**](https://github.com/hornofabraxas/lora-the-explorer).

A Cloudflare Worker (Hono + TypeScript) that acts as the sole authority for multiplayer items,
combat resolution, and the leaderboard. Player-run game servers push signed bundles to it; it
decides what's real.

> Only needed if you want multiplayer. The game is fully playable single-player without it.

---

## Why a central authority

The game client is open source and player-hosted, which means **everything a game server tells this
service is attacker-controlled**. So the trust boundary is drawn here: every field crossing into the
Worker is either computed by the Worker, validated by the Worker, or accepted as deliberately
low-stakes.

The Worker owns item drops, combat outcomes, renown, and rankings. The game server owns local
progression. Some cheating (GPS spoofing, local XP inflation) is not solvable by any architecture —
GPS never leaves the player's device — so it's bounded by rate caps and manual review rather than
pretended away.

## Privacy boundary

**This is the design constraint that matters most.** The service is built so that a player's real
location cannot be reconstructed from it:

- Survey Posts are identified by **opaque random tokens**, never their real H3 hex IDs (a res-8 hex
  decodes to a ~460 m area).
- The only geography stored is a **centroid snapped to a ~50 mile grid**, used for raid travel time
  (true home is somewhere inside that ~50-mile cell).
- Scout reports fuzz inter-player distance to the **nearest 50 miles**.
- Player IDs are **random 128-bit values**, unrelated to hardware or identity.
- **The application logs no IP addresses** and collects no analytics.

Previous public-read endpoints that leaked location (a public ledger feed and a public profile
route) were **deleted**, not merely gated, in July 2026. The leaderboard now requires
authentication.

Full detail: **[PRIVACY.md](https://github.com/hornofabraxas/lora-the-explorer/blob/main/PRIVACY.md)**
· **[TERMS.md](https://github.com/hornofabraxas/lora-the-explorer/blob/main/TERMS.md)**

## Architecture

```
game server ──signed bundle──> Worker ──> KvStore Durable Object (SQLite)
                                 │
                                 ├── cron (6h): HP regen, leaderboard rebuild
                                 └── /admin: Cloudflare Access-gated moderation UI
```

- **Storage:** one consolidated SQLite-backed Durable Object (`src/kv/do_store.ts`) behind a
  KV-compatible adapter with namespace-prefixed keys. A single RPC can read and commit across
  namespaces, so raids resolve atomically.
- **Auth:** HMAC-SHA256 over `player_id + timestamp + body`, with a ±300 s skew window and
  constant-time comparison (`src/middleware/auth.ts`).
- **Admin:** handlers defined once in `src/routes/admin.ts`, mounted twice — `/api/admin/*` behind a
  shared secret (machine) and `/admin/api/*` behind Cloudflare Access (browser). An Access session
  deliberately cannot unlock the machine path; that's CSRF defence in depth.
- **Version gate:** a global middleware (`src/middleware/version.ts`) rejects a game server whose
  `X-Client-Version` is below `MIN_CLIENT_VERSION` with `426 Upgrade Required`, before auth runs.
  Off by default; the floor is only raised alongside a breaking wire/schema change. Skips
  `/api/admin/*` and `/admin/*` — those are operator calls, never game-client traffic.

### Key routes

| Route | Purpose |
|---|---|
| `POST /api/register` | Create a player. Invite-gated when `REGISTER_SECRET` is set |
| `POST /api/bundle` | Push gameplay state; server validates and clamps every field |
| `GET  /api/status` | Combined defence + own-raid poll (one request) |
| `GET  /api/leaderboard` | Rankings — **authenticated**, precomputed snapshot |
| `POST /api/scout` | Spend a probe for recon plus a 50 mi-fuzzed distance |
| `POST /api/raid/dispatch` | Launch a travelling multi-item raid |
| `POST /api/defend/*` | Install, boost, restore |

## Setup

```bash
npm install
npx wrangler deploy
```

Configure in `wrangler.toml` (`[vars]`) and via `wrangler secret put`:

| Name | Kind | Purpose |
|---|---|---|
| `REGISTER_SECRET` | secret | Invite code required to register. **Unset = open registration** |
| `ADMIN_SECRET` | secret | Guards `/api/admin/*` |
| `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN` | var | Cloudflare Access application audience + team domain |
| `ADMIN_EMAILS` | secret | Comma-separated operator allow-list, a second fence behind Access. A secret rather than a var only to keep personal addresses out of a public repo — it grants nothing on its own |
| `MIN_CLIENT_VERSION` | var | Floor for a game server's reported `X-Client-Version` (see `middleware/version.ts`). `"0.0.0"` or unset = no enforcement. Raise it only alongside a breaking wire/schema change, in the commit that makes the change, so the floor and the reason are reviewed together |
| `MAX_TOTAL_PLAYERS` | var | Hard lifetime roster ceiling; registration closes (403) once reached. Unset = no cap |
| `REGISTER_DAILY_LIMIT` | var | Global new players allowed per UTC day (429 over). Unset = no cap |
| `REGISTER_IP_DAILY_LIMIT` | var | New players per `CF-Connecting-IP` per UTC day (429 over); skipped when the header is absent. Unset = no cap |

> **If you deploy your own:** set `REGISTER_SECRET`, or anyone can register. Every registered player
> is a leaderboard entry and a valid raid actor, so open registration is a sybil surface. Replace
> `ADMIN_EMAILS` and the Access values with your own — the committed ones are the reference
> deployment's and grant nothing without the matching Cloudflare Access account.
>
> **Access gotcha:** an Access application with zero policies matches nobody and silently never
> sends the OTP. Always add an Allow policy with an Emails include rule.

### Abuse & cost controls

Two independent layers keep a forked/modified client — or a leaked invite code — from
running up Cloudflare usage. They're complementary: the app caps bound *player creation* and
per-player writes; the edge rule bounds *raw request volume* before it costs a Worker
invocation.

**1. Application caps (this repo).** The invite code (`REGISTER_SECRET`) is a *shared* secret —
every player's client config holds it — so it stops strangers but not a holder or a leak minting
players in a loop. `routes/register.ts` adds three opt-in caps (all off when unset, like
`REGISTER_SECRET`), keyed on server-time UTC date and committed atomically with the player write.
The reference deployment runs (in `wrangler.toml [vars]`):

```toml
MAX_TOTAL_PLAYERS = "500"        # hard lifetime ceiling — a leaked invite can't exceed it
REGISTER_DAILY_LIMIT = "100"     # absorbs a launch-day surge, still caps a leak per day
REGISTER_IP_DAILY_LIMIT = "3"    # one base camp per home; covers a household, blocks a loop
```

Per-bundle writes are already capped independently in `routes/bundle.ts` (6 bundles/rolling
hour/player, 50 surveys/day), and the Worker recomputes drops and clamps every leaderboard input
server-side — a modified *local* client can't cheat rankings or mint rewards.

**2. Edge rate limiting (Cloudflare dashboard — not in this repo).**
Security → WAF → Rate limiting rules, on the `nukeradio.net` zone:

- **Match:** `(http.host eq "lora.nukeradio.net" and starts_with(http.request.uri.path, "/api/"))`
- **Characteristic:** IP
- **Rate:** 50 requests / 10 seconds
- **Action:** **Block** for 10 seconds

Use **Block, not a Challenge** — the clients are headless game servers and can't solve one. The
free plan fixes the period and block duration at 10s and allows a single rule; that one rule covers
`/api/register` too (it's under `/api/`), backed by `REGISTER_IP_DAILY_LIMIT`. 50/10s is generous
headroom for a real client (multiplayer pages fan out a handful of calls) while stopping a flood
dead. On the free plan the ultimate backstop is the ~100k requests/day cutoff — the Worker returns
429s for the rest of the UTC day and **cannot be billed**; runaway *cost* is only possible on
Workers Paid, where a billing alert is the safety net. Adjust the rate rule if the front-end's
per-page call fan-out grows.

## Development

```bash
npm run dev        # local Worker
npm test           # vitest, via @cloudflare/vitest-pool-workers
npm run typecheck
```

### Gotchas worth knowing

- **workerd's DO SQLite caps a statement at 100 bound variables.** Any batched `IN (...)` read must
  chunk at ≤90 keys.
- **Durable Object *requests* are the billing constraint**, not reads or writes. Batch aggressively;
  fold auth and rate-limit reads into the route's own snapshot.
- **Multi-write resolution must be atomic and self-healing.** Commit the whole outcome from one
  snapshot, and make the poller able to reconcile stuck state rather than relying on a single pass.

## Operating it

Moderation ladder, in increasing severity: **censor a name** (applied at read time, so it survives
the next bundle sync) → **freeze the account** (reversible; authenticates but cannot write) →
**delete the player**.

Deleting a player is a **complete erasure** (`purgePlayerData` in `src/kv/queries.ts`), because it
is the endpoint behind a "delete my account" request. It removes every row keyed by that player —
profile, defence, raze tombstones, raid records, cooldowns, notifications, audit counters,
rate-limit rows, leaderboard index entry — and then scrubs their identifiers out of records that
belong to players who remain: raids are **anonymised** (the survivor keeps a coherent history, the
departed player's id and name are replaced), and scout reports naming either side are deleted.

It costs a few full scans, deliberately. Nothing on a gameplay hot path calls it, and the
guarantee matters more than the milliseconds. `test/erasure.test.ts` locks the behaviour down.

## Security

See [SECURITY.md](SECURITY.md). Report privately — never in a public issue.

## License

[MIT](LICENSE) © 2026 hornofabraxas.

Built with [Hono](https://hono.dev) (MIT). Not affiliated with Cloudflare, Inc.
