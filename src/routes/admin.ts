import { Hono } from "hono";
import type { Env, PlayerProfile, PostSummary, DefenseValues, ItemRecord } from "../types.js";
import { POST_MAX_HP } from "../types.js";
import {
  getPlayer, putPlayer, addToPlayerIndex, removeFromPlayerIndex,
  getDefense, putDefense, getAuditReject,
  playersFromRows, auditRejectsFromRows, PLAYER_SCAN_LIMIT,
} from "../kv/queries.js";
import {
  defenseKey, playerLastBundleKey, playerKey,
  PLAYER_PREFIX, AUDIT_REJECT_PREFIX, NS,
} from "../kv/schema.js";
import { snapshotRead } from "../kv/composite.js";
import { timingSafeEqual } from "../middleware/auth.js";
import { requireOperator } from "../middleware/access.js";
import {
  getOverrides, putOverrides, postOverrideKey, parseOverrides, MODERATION_KEY,
  applyPostName, applyPlayerName,
} from "../logic/moderation.js";
import type { ModerationOverrides } from "../logic/moderation.js";
import { totalRenownPerDay } from "../logic/renown.js";
import { reasonsFor, isDismissed, getFlagAcks, putFlagAcks, parseFlagAcks, FLAG_ACK_KEY } from "../logic/flags.js";

// Every admin report is capped at this many rows. The cap is about the operator
// and the phone holding the page, not about storage: a report nobody can read to
// the bottom is not a report. Each response says what it truncated so a narrower
// filter is the obvious next move.
const REPORT_LIMIT = 50;

// Admin toolkit for seeding, inspecting, moderating, and removing players. Not
// part of the game protocol. Every handler is registered once on `core` and
// then mounted twice, under two prefixes with two different gates:
//
//   /api/admin/*  — machine surface, gated on the ADMIN_SECRET shared secret
//                   via the `x-admin-secret` header (tests, scripted fixups).
//   /admin/api/*  — browser surface for the admin page, gated on a Cloudflare
//                   Access identity (see middleware/access.ts). The operator
//                   logs in with Access; no secret ever reaches the browser.
//
// Mounting the same handlers twice is what keeps the two surfaces honestly
// identical — a new endpoint is available to both the moment it is written.

const app = new Hono<{ Bindings: Env }>();
const core = new Hono<{ Bindings: Env }>();

function requireAdmin(c: { env: Env; req: { header: (n: string) => string | undefined } }): boolean {
  const secret = c.env.ADMIN_SECRET;
  const provided = c.req.header("x-admin-secret");
  return !!secret && !!provided && timingSafeEqual(provided, secret);
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface SeedPostInput {
  post_hex: string;
  level: number;
  chartered_at?: number;
  dormant_until?: number;
  defense?: Partial<DefenseValues>;
  /**
   * Level the Worker "first saw" this post at. Defaults to the post's current
   * level, matching a real registrant whose posts arrive established — so a
   * seeded player is unflagged unless the seed deliberately says otherwise.
   */
  first_level?: number;
  /** When the Worker "first saw" it. Defaults to chartered_at. */
  first_seen?: number;
}

interface SeedPlayerInput {
  player_id?: string;
  display_name: string;
  coarse_centroid?: { lat: number; lng: number };
  registered_at?: number;
  items?: ItemRecord[];
  posts?: SeedPostInput[];
  overwrite?: boolean;
  /**
   * Displayed title, e.g. "Warlord". Seeds only — real players earn theirs and
   * push the label through the bundle route. Same 40-char clamp as that path.
   */
  active_title?: string;
}

// Create or overwrite a player with fully-specified posts + per-post defense.
core.post("/seed-player", async (c) => {
  const body = await c.req.json<SeedPlayerInput>();
  if (!body.display_name || body.display_name.length < 1 || body.display_name.length > 32) {
    return c.json({ ok: false, error: "display_name must be 1-32 characters" }, 400);
  }
  const playerId = body.player_id ?? randomHex(16);
  const existing = await getPlayer(c.env, playerId);
  if (existing && !body.overwrite) {
    return c.json({ ok: false, error: "Player exists; pass overwrite:true to replace" }, 409);
  }

  const now = Math.floor(Date.now() / 1000);
  const secret = existing?.secret_hash ?? randomHex(32);

  const postInputs = body.posts ?? [];
  const post_summaries: PostSummary[] = postInputs.map((p) => ({
    post_hex: p.post_hex,
    level: p.level,
    chartered_at: p.chartered_at ?? now - 86400 * 20,
    coarse_cell: "",
    ...(p.dormant_until ? { dormant_until: p.dormant_until } : {}),
  }));

  const player: PlayerProfile = {
    player_id: playerId,
    display_name: body.display_name,
    registered_at: body.registered_at ?? existing?.registered_at ?? now,
    items: body.items ?? existing?.items ?? [],
    post_summaries,
    secret_hash: secret,
    ...(body.coarse_centroid ? { coarse_centroid: body.coarse_centroid } : {}),
    ...(typeof body.active_title === "string"
      ? { active_title: body.active_title.slice(0, 40) }
      : existing?.active_title
        ? { active_title: existing.active_title }
        : {}),
    post_first_seen: Object.fromEntries(
      postInputs.map((p, i) => [p.post_hex, p.first_seen ?? post_summaries[i].chartered_at]),
    ),
    post_first_level: Object.fromEntries(
      postInputs.map((p) => [p.post_hex, p.first_level ?? p.level]),
    ),
  };

  await putPlayer(c.env, player);
  await addToPlayerIndex(c.env, playerId);

  // Write per-post defense records (full HP by level unless overridden).
  const defenses: Record<string, DefenseValues> = {};
  for (const p of postInputs) {
    const maxHp = p.defense?.max_hp ?? POST_MAX_HP[p.level] ?? 50;
    const def: DefenseValues = {
      base_defense: p.defense?.base_defense ?? 10,
      survey_bonus: p.defense?.survey_bonus ?? 0,
      defense_item: p.defense?.defense_item ?? null,
      defense_value: p.defense?.defense_value ?? 0,
      hp: p.defense?.hp ?? maxHp,
      max_hp: maxHp,
      hp_updated_at: now,
      ...(p.defense?.boosts ? { boosts: p.defense.boosts } : {}),
      ...(p.defense?.besieged_until ? { besieged_until: p.defense.besieged_until } : {}),
    };
    await putDefense(c.env, playerId, p.post_hex, def);
    defenses[p.post_hex] = def;
  }

  return c.json({ ok: true, player_id: playerId, secret, player, defenses }, existing ? 200 : 201);
});

// Resolve whatever the operator typed — a display name or a player id — to a
// list of candidates. Display names are neither unique nor indexed, so a name
// query reads the whole roster; it does so in ONE range scan rather than a get
// per player, so the cost is flat in roster size. A full player id — what the
// operator arrives with when clicking through from a flag row — skips the scan
// entirely and reads that one key.
//
// Returning candidates rather than guessing means two players sharing a name is
// a choice the operator makes, not one this endpoint makes silently.
const FULL_PLAYER_ID = /^[0-9a-f]{32}$/i;

interface SearchMatch {
  player_id: string;
  display_name: string;
  display_name_public: string;
  frozen: boolean;
  post_count: number;
  exact: boolean;
}

function toMatch(player: PlayerProfile, overrides: ModerationOverrides, q: string): SearchMatch {
  const id = player.player_id;
  const name = player.display_name ?? "";
  return {
    player_id: id,
    display_name: name,
    display_name_public: applyPlayerName(overrides, id, name),
    frozen: !!player.frozen,
    post_count: player.post_summaries.length,
    // An exact id match is what the operator meant; sort it to the front.
    exact: id.toLowerCase() === q || name.toLowerCase() === q,
  };
}

core.get("/players/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  if (!q) return c.json({ ok: false, error: "q required" }, 400);

  // Fast path: an exact id needs one key, not the roster.
  if (FULL_PLAYER_ID.test(q)) {
    const snap = await snapshotRead(
      c.env,
      [{ ns: NS.PLAYERS, key: playerKey(q) }, { ns: NS.META, key: MODERATION_KEY }],
      [],
    );
    const raw = snap.exact[0];
    const overrides = parseOverrides(snap.exact[1]);
    const matches = raw ? [toMatch(JSON.parse(raw) as PlayerProfile, overrides, q)] : [];
    return c.json({ ok: true, matches, total: matches.length, truncated: false });
  }

  const snap = await snapshotRead(
    c.env,
    [{ ns: NS.META, key: MODERATION_KEY }],
    [{ ns: NS.PLAYERS, key: PLAYER_PREFIX, limit: PLAYER_SCAN_LIMIT }],
  );
  const overrides = parseOverrides(snap.exact[0]);

  const matches: SearchMatch[] = [];
  for (const player of playersFromRows(snap.ranges[0])) {
    const id = player.player_id.toLowerCase();
    const name = (player.display_name ?? "").toLowerCase();
    if (!id.startsWith(q) && !name.includes(q)) continue;
    matches.push(toMatch(player, overrides, q));
  }
  matches.sort((a, b) => Number(b.exact) - Number(a.exact) || a.display_name.localeCompare(b.display_name));

  // Cap after sorting, so the rows most likely to be the intended player are the
  // ones that survive rather than whichever the scan happened to reach first.
  const total = matches.length;
  return c.json({
    ok: true,
    matches: matches.slice(0, REPORT_LIMIT),
    total,
    truncated: total > REPORT_LIMIT,
  });
});

// Inspect a player's full profile + per-post defense records.
core.get("/player/:id", async (c) => {
  const id = c.req.param("id");
  const player = await getPlayer(c.env, id);
  if (!player) return c.json({ ok: false, error: "Player not found" }, 404);

  const defenses: Record<string, DefenseValues | null> = {};
  for (const p of player.post_summaries) {
    defenses[p.post_hex] = await getDefense(c.env, id, p.post_hex);
  }
  return c.json({ ok: true, player, defenses });
});

// Remove a player entirely: profile, per-post defense, last-bundle marker, and
// leaderboard index entry. (Ledger/raid history is left to age out on its own.)
core.delete("/player/:id", async (c) => {
  const id = c.req.param("id");
  const player = await getPlayer(c.env, id);
  if (!player) return c.json({ ok: false, error: "Player not found" }, 404);

  for (const p of player.post_summaries) {
    await c.env.DEFENSE.delete(defenseKey(id, p.post_hex));
  }
  await c.env.PLAYERS.delete(`player:${id}`);
  await c.env.PLAYERS.delete(playerLastBundleKey(id));
  await removeFromPlayerIndex(c.env, id);

  return c.json({ ok: true, removed: id });
});

// Trim a player's UNUSED, UNINSTALLED items of given types down to a target
// count each (oldest kept). One-time hygiene for the legacy duplicate-drop era,
// which minted defense epics/rares far over their true rates and left a banked
// boost-HP stockpile that would distort every raid for months. Dry-run unless
// {apply:true}. Body: { player_id, keep: {"defense_epic":1, ...}, apply? }.
core.post("/trim-items", async (c) => {
  const body = await c.req.json<{ player_id?: string; keep?: Record<string, number>; apply?: boolean }>();
  if (!body.player_id || !body.keep || typeof body.keep !== "object") {
    return c.json({ ok: false, error: "player_id and keep{type:count} required" }, 400);
  }
  const player = await getPlayer(c.env, body.player_id);
  if (!player) return c.json({ ok: false, error: "Player not found" }, 404);

  const removedIds: string[] = [];
  const summary: Record<string, { before: number; kept: number; removed: number }> = {};
  for (const [type, keepRaw] of Object.entries(body.keep)) {
    const keep = Math.max(0, Math.floor(keepRaw));
    // Only free items are eligible — never touch used or installed inventory.
    const free = player.items
      .filter((i) => i.type === type && !i.used && !i.installed_post_hex)
      .sort((a, b) => a.assigned_at - b.assigned_at); // oldest first
    const toRemove = free.slice(keep); // keep the oldest `keep`, remove the rest
    summary[type] = { before: free.length, kept: Math.min(keep, free.length), removed: toRemove.length };
    for (const it of toRemove) removedIds.push(it.id);
  }

  if (body.apply && removedIds.length > 0) {
    const drop = new Set(removedIds);
    player.items = player.items.filter((i) => !drop.has(i.id));
    await putPlayer(c.env, player);
  }

  return c.json({
    ok: true,
    applied: !!body.apply,
    player_id: body.player_id,
    summary,
    removed_count: removedIds.length,
    removed_ids: removedIds,
    remaining_items: body.apply ? player.items.length : undefined,
  });
});

// ---------------------------------------------------------------------------
// Anti-cheat backstop: an anomaly report and a reversible suspension. The
// bundle/shop/defense routes enforce the hard invariants at write time; these
// two endpoints are the human review + enforcement layer for whatever a
// heuristic can flag but not prove.
// ---------------------------------------------------------------------------

// Anomaly report across all players, still computed on read — but in ONE storage
// round trip: the operator's acknowledgements, every player profile, and the
// sparse audit-reject counters all come back from a single composite read, so
// the cost is flat in roster size instead of 2 subrequests per player.
//
// Computing on read (rather than maintaining a flag list at write time) is
// deliberate. Reads happen a few times a day; player writes happen every ~35s
// per player, so a write-time index would tax the hot path to subsidise a cold
// one. Two of the three findings are also time-dependent — the audit counter is
// a rolling 7d window and instant-max-level turns on an age threshold — so a
// stored verdict would have to be re-evaluated on read regardless.
core.get("/flags", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const includeDismissed = c.req.query("include_dismissed") === "1";

  const snap = await snapshotRead(
    c.env,
    [{ ns: NS.META, key: FLAG_ACK_KEY }],
    [
      { ns: NS.PLAYERS, key: PLAYER_PREFIX, limit: PLAYER_SCAN_LIMIT },
      { ns: NS.META, key: AUDIT_REJECT_PREFIX, limit: PLAYER_SCAN_LIMIT },
    ],
  );
  const acks = parseFlagAcks(snap.exact[0]);
  // Scanning `player:` directly rather than walking the player index also means a
  // profile that fell out of the index still gets reviewed — the right bias for
  // an audit report.
  const players = playersFromRows(snap.ranges[0]);
  const rejects = auditRejectsFromRows(snap.ranges[1]);

  const flagged = [];
  let dismissedCount = 0;

  for (const player of players) {
    const id = player.player_id;
    const auditRejects = rejects.get(id) ?? 0;
    const reasons = reasonsFor(player, auditRejects, now);
    if (reasons.length === 0) continue;

    const dismissed = isDismissed(acks[id], reasons);
    if (dismissed) {
      dismissedCount++;
      if (!includeDismissed) continue;
    }

    flagged.push({
      player_id: id,
      display_name: player.display_name,
      frozen: !!player.frozen,
      renown_per_day: totalRenownPerDay(player.post_summaries, now),
      audit_rejects: auditRejects,
      reasons,
      dismissed,
      dismissed_at: dismissed ? acks[id]?.at ?? null : null,
    });
  }

  // Sort before capping: the most-flagged, highest-renown rows are the ones
  // worth an operator's attention, so those are what a truncated page shows.
  flagged.sort((a, b) => b.reasons.length - a.reasons.length || b.renown_per_day - a.renown_per_day);
  const total = flagged.length;

  return c.json({
    ok: true,
    checked: players.length,
    dismissed: dismissedCount,
    flagged: flagged.slice(0, REPORT_LIMIT),
    total,
    truncated: total > REPORT_LIMIT,
  });
});

// Acknowledge a player's current findings so the report stops surfacing them.
// Stores the reason CODES, not the rendered text, and not a blanket mute: if a
// new kind of finding appears later the row returns, because dismissing "holds
// 4 posts" must not silence a signal nobody has looked at yet.
core.post("/flags/dismiss/:id", async (c) => {
  const id = c.req.param("id");
  const player = await getPlayer(c.env, id);
  if (!player) return c.json({ ok: false, error: "Player not found" }, 404);

  const now = Math.floor(Date.now() / 1000);
  const auditRejects = await getAuditReject(c.env, id);
  const reasons = reasonsFor(player, auditRejects, now);
  if (reasons.length === 0) return c.json({ ok: false, error: "Player has no active findings" }, 400);

  const acks = await getFlagAcks(c.env);
  acks[id] = { codes: reasons.map((r) => r.code).sort(), at: now };
  await putFlagAcks(c.env, acks);
  return c.json({ ok: true, player_id: id, dismissed: acks[id] });
});

// Undo a dismissal — the row returns to the report on the next read.
core.delete("/flags/dismiss/:id", async (c) => {
  const id = c.req.param("id");
  const acks = await getFlagAcks(c.env);
  if (!acks[id]) return c.json({ ok: false, error: "No dismissal to clear" }, 404);
  delete acks[id];
  await putFlagAcks(c.env, acks);
  return c.json({ ok: true, player_id: id });
});

// Reversibly suspend (or restore) a player. A frozen player still authenticates
// but every write is rejected (see auth middleware); history is untouched.
// POST {frozen:false} to lift it. Rounds out the ladder: censor → freeze → delete.
core.post("/freeze/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ frozen?: boolean }>().catch(() => ({} as { frozen?: boolean }));
  const frozen = body.frozen !== false; // default true; pass {frozen:false} to unfreeze

  const player = await getPlayer(c.env, id);
  if (!player) return c.json({ ok: false, error: "Player not found" }, 404);

  player.frozen = frozen;
  await putPlayer(c.env, player);
  return c.json({ ok: true, player_id: id, frozen });
});

// ---------------------------------------------------------------------------
// Name moderation (manual). The public leaderboard/scout/raid surfaces echo
// post names and player display names verbatim from self-hosted game servers.
// These endpoints let an operator review and censor them without a wordlist.
// Overrides are applied on read (see logic/moderation.ts) so they survive the
// next bundle sync.
// ---------------------------------------------------------------------------

interface CensorInput {
  type: "post" | "player";
  player_id: string;
  post_hex?: string;
  // Replacement label; omit or send "" to hide behind the neutral fallback.
  replacement?: string;
}

// Review public names across all players, with any active override shown. One
// range scan for the whole roster (see /flags) plus server-side filtering.
//
// Filtering moved off the client because the payload, not the read, is the limit
// here: post names outnumber player names roughly 3:1, so shipping every name to
// a phone to filter it there means sending ~2000 rows to display 5. `q` matches a
// name or a post hex; `type` narrows to players or posts. Rows are capped, and a
// truncated response says so, since a silently-cut moderation list is the kind
// that hides the name you were looking for.
core.get("/names", async (c) => {
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const type = c.req.query("type");
  const wantPlayers = type !== "post";
  const wantPosts = type !== "player";

  const snap = await snapshotRead(
    c.env,
    [{ ns: NS.META, key: MODERATION_KEY }],
    [{ ns: NS.PLAYERS, key: PLAYER_PREFIX, limit: PLAYER_SCAN_LIMIT }],
  );
  const overrides = parseOverrides(snap.exact[0]);
  const roster = playersFromRows(snap.ranges[0]);
  roster.sort((a, b) => (a.display_name ?? "").localeCompare(b.display_name ?? ""));

  const players = [];
  let rows = 0;      // name rows emitted — what the cap counts
  let total = 0;     // name rows that matched, capped or not
  let truncated = false;

  for (const player of roster) {
    const id = player.player_id;
    const name = player.display_name ?? "";
    const playerHit = wantPlayers && (!q || name.toLowerCase().includes(q));
    const postHits = wantPosts
      ? player.post_summaries.filter((p) =>
          !q || (p.name ?? "").toLowerCase().includes(q) || p.post_hex.toLowerCase().includes(q))
      : [];
    if (!playerHit && postHits.length === 0) continue;

    total += (playerHit ? 1 : 0) + postHits.length;
    if (rows >= REPORT_LIMIT) {
      truncated = true;
      continue; // keep counting matches so `total` stays honest
    }

    // A card is never split mid-player: taking the whole match keeps the player
    // row and its posts together, so the cap can overshoot by a few rows rather
    // than show a player's posts without the player.
    rows += (playerHit ? 1 : 0) + postHits.length;
    players.push({
      player_id: id,
      display_name: name,
      display_name_public: applyPlayerName(overrides, id, name),
      player_override: overrides.players[id] ?? null,
      include_player: playerHit,
      posts: postHits.map((p) => ({
        post_hex: p.post_hex,
        name: p.name ?? "",
        name_public: applyPostName(overrides, id, p.post_hex, p.name ?? ""),
        override: overrides.posts[postOverrideKey(id, p.post_hex)] ?? null,
      })),
    });
  }

  return c.json({ ok: true, players, overrides, shown: rows, total, truncated });
});

// Censor a post name or player display name. Idempotent upsert of one override.
core.post("/censor", async (c) => {
  const body = await c.req.json<CensorInput>();
  if (body.type !== "post" && body.type !== "player") {
    return c.json({ ok: false, error: "type must be 'post' or 'player'" }, 400);
  }
  if (!body.player_id) {
    return c.json({ ok: false, error: "player_id required" }, 400);
  }
  const replacement = (body.replacement ?? "").slice(0, 32);

  const overrides = await getOverrides(c.env);
  if (body.type === "post") {
    if (!body.post_hex) {
      return c.json({ ok: false, error: "post_hex required for type 'post'" }, 400);
    }
    overrides.posts[postOverrideKey(body.player_id, body.post_hex)] = replacement;
  } else {
    overrides.players[body.player_id] = replacement;
  }
  await putOverrides(c.env, overrides);
  return c.json({ ok: true, overrides });
});

// Clear a previously-set override (via query params).
core.delete("/censor", async (c) => {
  const type = c.req.query("type");
  const playerId = c.req.query("player_id");
  const postHex = c.req.query("post_hex");
  if (type !== "post" && type !== "player") {
    return c.json({ ok: false, error: "type must be 'post' or 'player'" }, 400);
  }
  if (!playerId) {
    return c.json({ ok: false, error: "player_id required" }, 400);
  }

  const overrides = await getOverrides(c.env);
  if (type === "post") {
    if (!postHex) {
      return c.json({ ok: false, error: "post_hex required for type 'post'" }, 400);
    }
    delete overrides.posts[postOverrideKey(playerId, postHex)];
  } else {
    delete overrides.players[playerId];
  }
  await putOverrides(c.env, overrides);
  return c.json({ ok: true, overrides });
});

// ---------------------------------------------------------------------------
// Mounts. The gate is middleware on the prefix rather than a line inside every
// handler, so a handler can never be added without one.
// ---------------------------------------------------------------------------

app.use("/api/admin/*", async (c, next) => {
  if (!requireAdmin(c)) return c.json({ ok: false, error: "Forbidden" }, 403);
  await next();
});
app.route("/api/admin", core);

app.use("/admin/api/*", async (c, next) => {
  if (!(await requireOperator(c))) return c.json({ ok: false, error: "Forbidden" }, 403);
  await next();
});
app.route("/admin/api", core);

export default app;
