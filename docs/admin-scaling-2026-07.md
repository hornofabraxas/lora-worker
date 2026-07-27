# Admin reports: flat-cost reads (2026-07-23)

## The problem

The three roster-wide admin endpoints each issued one storage read *per player*:

| Endpoint | Subrequests | At 500 players |
|---|---|---|
| `GET /flags` | `2N + 2` (profile + audit counter each) | 1,002 |
| `GET /players/search` | `N + 2` | 502 |
| `GET /names` | `N + 2` | 502 |

Cloudflare caps a request at **50 subrequests on the free plan** (1,000 on paid).
So this was not a report that got slower as the roster grew — it was a report
that started throwing. On the free plan `/flags` breaks at roughly **24
players**; on paid, around 500. The Worker is sized for ~560 players
(`do-consolidation-2026-07.md`), so this was a live ceiling, not a hypothetical.

## Why not a write-time flag list

The obvious fix — maintain a list of flagged players as writes happen, so the
report is a single read — was considered and rejected:

1. **It inverts the cost.** Flag reads happen a few times a day (one operator, on
   a phone). Player writes happen every ~35s per player. A write-time index taxes
   the hot path — the same bundle path that was just tuned down to 2 RPCs — to
   subsidise a cold one.
2. **Two of the three findings are time-dependent.** `audit_rejects` is a rolling
   7-day counter, and `instant_max_level` turns on an age threshold crossing. A
   stored verdict would go stale on its own and have to be re-evaluated on read
   anyway, so the index would buy nothing while adding an invalidation surface.

Computing on read is correct here. The defect was never *when* the work happened,
it was *how many round trips* it took.

## What changed

Each endpoint now issues **one composite read** (`kv/composite.ts` `snapshotRead`),
regardless of roster size:

- `/flags` — exact `META/moderation:flag_acks`, plus ranges over
  `PLAYERS/player:` (every profile, bodies included) and `META/audit:reject:`
  (sparse and TTL'd — only players who have actually been rejected).
- `/names` — exact `META/moderation:names`, plus the `PLAYERS/player:` range.
- `/players/search` — the `PLAYERS/player:` range; **or**, when the query is a
  full 32-hex player id (the case when clicking through from a flag row), one
  exact key read and no scan at all.

`player:<id>:last_bundle` markers share the `player:` prefix and are separated on
key shape (`isPlayerProfileKey` — a profile key has exactly one colon).

Scanning `player:` directly, rather than walking `player_index`, also means a
profile that fell out of the index still gets reviewed. That is the right bias
for an audit report.

## Bounded responses

RPC count is now flat, but *payload* still scales with the roster — 500 profiles
is a few MB into the Worker, and for `/names` it was thousands of rows onto a
phone. So:

- Every report caps at **50 rows** (`REPORT_LIMIT` in `routes/admin.ts`) and
  reports `total` + `truncated` so the operator knows something was withheld.
- Capping happens **after sorting**, so a truncated flags report shows the
  most-flagged, highest-renown players rather than whichever the scan reached
  first.
- `/names` never splits a player's card across the cap — it takes a whole match
  or none, so the cap can overshoot by a few rows rather than show a player's
  posts without the player.
- The Names tab's filter moved **server-side** (`?q=`, `?type=player|post`), with
  the keystroke debounced 250ms in the page. Filtering on the client meant
  shipping every name to the phone to display a handful.

## Test guard

`test/admin_scale.test.ts` seeds a 120-player roster (past the 50-subrequest
ceiling) and asserts each endpoint costs exactly **1 RPC**, using
`makeCountingEnv()` from `test/helpers/env.ts` — which wires both the KV adapters
and `KV_DO` through a counting stub. RPC count is a correctness property here,
not a performance note, so it is pinned rather than left to review.

## Not changed

The game-server container is untouched — no HTTP API changed shape. `/names`
gained fields (`include_player`, `shown`, `total`, `truncated`) and `/flags` and
`/players/search` gained `total`/`truncated`; the existing fields all kept their
meaning, so nothing else consuming them needed a change.
