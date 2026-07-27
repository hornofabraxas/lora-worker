# Durable Object consolidation (2026-07-22)

## Why

After the batch/cache/poll fixes, the free-tier ceiling was **Durable Object
requests** (100k/day; each stub RPC is one billed request). A hot path that
touched several namespaces (a status poll reads player + defense + raid rows) paid
one RPC per key because each namespace was a *separate* DO instance — you cannot
batch a read across two instances.

Pre-launch, community signal suggested we'll exceed the ~50–70 players that setup
supports, so we consolidated **before** launch rather than migrating live later.

## What changed

**One instance.** All six logical namespaces (LEDGER, PLAYERS, ATTACKS, DEFENSE,
SCOUTS, META) now resolve to a single `KvStore` instance (`CONSOLIDATED_DO_NAME`).
The adapter keeps them isolated by prefixing every key with `<namespace>\x1f`
(`NS_SEP`), so nothing collides in the shared `kv` table and existing range scans
stay correctly bounded. The KV-compatible adapter is unchanged for callers.

**Composite RPCs** (`src/kv/composite.ts`, backed by DO methods in
`do_store.ts`):
- `snapshot(exactKeys, rangePrefixes)` — fetch many exact keys *and* many prefix
  ranges, across namespaces, in one RPC. Used by `buildDefensePosts` (defense +
  inbound raids in one read) and transactional raid resolution.
- `applyMutations(puts, deletes)` — commit every write of an operation in one
  atomic RPC. A DO runs each method to completion single-threaded, so the batch
  lands whole or not at all.

**Transactional raid resolution** (`logic/resolve.ts`). `resolveDueRaids` now
reads all involved players/defenses/notifications/pointers in one snapshot,
computes every outcome in memory (composing multiple raids on the same
target/post), and commits the whole pass — defense + player + raid record +
attacker pointers (`araidlast`, `araid`) + notifications + raze tombstone — in one
atomic `applyMutations`. Because the resolved record and the cleared lock commit
together, they can never disagree, so **`reconcileAttackerRaid` is gone**. The
`araid` one-in-flight lock also carries a 48h TTL as a hard ceiling against an
immortal lock (it never fires for a live raid).

Tombstones are **kept** — they guard against a lagging game *container*
re-asserting a razed post in a later bundle (a client-authority concern), which
atomicity does not address.

## Effect

- DO requests fall off the binding constraint. The next ceiling is **Workers
  requests (100k/day)** — a flat per-poll count tunable via intervals — landing
  free-tier capacity around **~250–400 players**, up from ~50–70.
- The container HTTP API is unchanged; no container change was required.

## Deploy note

Started fresh (pre-launch): the old per-namespace instances still hold their
pre-consolidation snapshots but are now orphaned/unread. Players re-register from
the container. No migration script.

## Next step (not done)

Per-player DO sharding — only if *write concurrency* (not request count) ever
becomes the wall, which for a LoRa-hardware-gated game is the least likely
ceiling. Note per-player sharding reintroduces cross-object coordination for the
two inherently multi-player features (raids, leaderboard), so it is not a strict
upgrade over this single consolidated instance.
