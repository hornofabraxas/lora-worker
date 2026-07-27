import type { Env, RaidRecord, PlayerProfile, DefenseValues, Notification } from "../types.js";
import { RAZE_TOMBSTONE_TTL } from "../types.js";
import { listRaids, getAttackerLastRaid, defaultDefense } from "../kv/queries.js";
import { playerKey, defenseKey, razeTombstoneKey, notificationsKey, NS } from "../kv/schema.js";
import { snapshotRead, MutationBuffer, type NsRef } from "../kv/composite.js";
import { resolveRaid } from "./raid.js";

// How long a resolved raid record lingers in the `raid:` keyspace, matched to the
// attacker's `araidlast` copy so both windows expire together and the scan
// resolveDueRaids pays stays bounded.
const RESOLVED_RAID_TTL = 172800; // 48h
const ATTACKER_LAST_RAID_TTL = 172800; // 48h — mirrors putAttackerLastRaid

function raidKey(targetId: string, raidId: string): string {
  return `raid:${targetId}:${raidId}`;
}

/**
 * Resolve every in-flight raid whose ETA has passed, against defense-at-arrival.
 * Called lazily on the defender's poll (near-real-time for active players) and
 * from the cron (backstop for inactive defenders). Pass a targetId to resolve
 * just that defender's incoming raids.
 *
 * All reads are gathered in one snapshot and all writes are flushed in one atomic
 * MutationBuffer commit — so the multi-row mutation a raid performs (defense +
 * player + raid record + attacker pointers + notification) either lands whole or
 * not at all. That atomicity is why there is no reconcile pass: the resolved
 * record and the attacker's cleared lock can never disagree.
 */
export async function resolveDueRaids(env: Env, targetId?: string): Promise<RaidRecord[]> {
  const now = Math.floor(Date.now() / 1000);
  const raids = await listRaids(env, targetId);
  const due = raids.filter((r) => r.status === "in_flight" && r.arrives_at <= now);
  if (due.length === 0) return [];

  // One snapshot pulls every row the pass needs: each target player, that post's
  // defense row, the target's notification list, and each attacker's last-raid
  // pointer. Deduplicate — several raids can share a target.
  const refs: NsRef[] = [];
  const seen = new Set<string>();
  const addRef = (ns: string, key: string) => {
    const tag = ns + "\x1f" + key;
    if (seen.has(tag)) return;
    seen.add(tag);
    refs.push({ ns, key });
  };
  for (const raid of due) {
    addRef(NS.PLAYERS, playerKey(raid.target_player_id));
    addRef(NS.DEFENSE, defenseKey(raid.target_player_id, raid.target_post_token));
    addRef(NS.SCOUTS, notificationsKey(raid.target_player_id));
    addRef(NS.ATTACKS, `araidlast:${raid.attacker_id}`);
  }
  const snap = await snapshotRead(env, refs, []);
  const idx = new Map<string, number>();
  refs.forEach((r, i) => idx.set(r.ns + "\x1f" + r.key, i));
  const read = <T>(ns: string, key: string): T | null => {
    const i = idx.get(ns + "\x1f" + key);
    if (i === undefined) return null;
    const raw = snap.exact[i];
    return raw === null ? null : (JSON.parse(raw) as T);
  };

  // In-memory working copies so several raids on the same target/post compose
  // (a second raze sees the first's removed post; a second hit sees drained HP).
  const players = new Map<string, PlayerProfile | null>();
  const defenses = new Map<string, DefenseValues>();
  const notifications = new Map<string, Notification[]>();
  const buf = new MutationBuffer();
  const resolved: RaidRecord[] = [];

  const getPlayerCopy = (id: string): PlayerProfile | null => {
    if (!players.has(id)) players.set(id, read<PlayerProfile>(NS.PLAYERS, playerKey(id)));
    return players.get(id) ?? null;
  };
  const notifsFor = (id: string): Notification[] => {
    if (!notifications.has(id)) notifications.set(id, read<Notification[]>(NS.SCOUTS, notificationsKey(id)) ?? []);
    return notifications.get(id)!;
  };

  const finalize = (raid: RaidRecord) => {
    // Attacker pointers and the resolved record commit together (one atomic
    // batch), so they can never disagree. Update araidlast only if it still
    // points at this raid, so a newer dispatch isn't clobbered.
    const last = read<RaidRecord>(NS.ATTACKS, `araidlast:${raid.attacker_id}`);
    if (last && last.raid_id === raid.raid_id) {
      buf.put(NS.ATTACKS, `araidlast:${raid.attacker_id}`, JSON.stringify(raid), ATTACKER_LAST_RAID_TTL);
    }
    buf.del(NS.ATTACKS, `araid:${raid.attacker_id}`);
    buf.put(NS.ATTACKS, raidKey(raid.target_player_id, raid.raid_id), JSON.stringify(raid), RESOLVED_RAID_TTL);
    resolved.push(raid);
  };

  for (const raid of due) {
    const target = getPlayerCopy(raid.target_player_id);
    const post = target?.post_summaries.find((p) => p.post_token === raid.target_post_token);

    if (!target || !post) {
      // Post already gone (e.g. razed by an earlier raid) — the raid fizzles.
      Object.assign(raid, { status: "resolved", outcome: "defended", damage_dealt: 0, resolved_at: now });
      finalize(raid);
      continue;
    }

    const defKey = `${target.player_id}:${post.post_token}`;
    let defense = defenses.get(defKey);
    if (!defense) {
      defense = read<DefenseValues>(NS.DEFENSE, defenseKey(target.player_id, post.post_token))
        ?? defaultDefense(post.level, now);
      defenses.set(defKey, defense);
    }

    // Post level before resolution — spoils are paid on what the raid actually hit.
    const preLevel = post.level;
    const outcome = resolveRaid(raid, defense, post.level, now);
    defenses.set(defKey, outcome.defense);
    buf.put(NS.DEFENSE, defenseKey(target.player_id, post.post_token), JSON.stringify(outcome.defense));

    // Raid spoils: a raze pays 10x the razed post's level in marks, a knockdown
    // 2x, a repelled raid nothing. Rides on the record; the attacker credits it.
    const spoilsMarks =
      outcome.outcome === "razed" ? 10 * preLevel :
      outcome.outcome === "damaged" ? 2 * preLevel : 0;

    if (outcome.outcome === "razed") {
      target.post_summaries = target.post_summaries.filter((p) => p.post_token !== raid.target_post_token);
      buf.put(NS.PLAYERS, playerKey(target.player_id), JSON.stringify(target));
      // Tombstone the hex so a not-yet-reconciled game server can't resurrect the
      // razed post by re-sending it in its next bundle.
      buf.put(NS.DEFENSE, razeTombstoneKey(target.player_id, raid.target_post_token), String(now), RAZE_TOMBSTONE_TTL);
    } else if (outcome.outcome === "damaged") {
      post.level = outcome.level_after;
      buf.put(NS.PLAYERS, playerKey(target.player_id), JSON.stringify(target));
    }

    Object.assign(raid, {
      status: "resolved",
      outcome: outcome.outcome,
      damage_dealt: outcome.damage_dealt,
      hp_after: outcome.hp_after,
      level_after: outcome.level_after,
      spoils_marks: spoilsMarks,
      resolved_at: now,
    });

    // Notify the defender which post was hit (bare "outpost" for legacy raids).
    const postName = raid.target_post_name || post.name || "";
    const outpostLabel = postName ? `outpost "${postName}"` : "outpost";
    const msg = outcome.outcome === "razed"
      ? `${raid.attacker_name}'s raiding party razed your ${outpostLabel}!`
      : outcome.outcome === "damaged"
        ? `${raid.attacker_name}'s raid forced your ${outpostLabel} down a level!`
        : `${raid.attacker_name}'s raid hit your ${outpostLabel} — defenses held.`;
    const notifs = notifsFor(target.player_id);
    notifs.push({
      type: `raid_${outcome.outcome}`,
      message: msg,
      timestamp: now,
      data: { raid_id: raid.raid_id, post_token: raid.target_post_token, outcome: outcome.outcome, damage: outcome.damage_dealt, level_after: outcome.level_after },
    });
    buf.put(NS.SCOUTS, notificationsKey(target.player_id), JSON.stringify(notifs));

    finalize(raid);
  }

  await buf.commit(env);
  return resolved;
}

/**
 * Resolve just the attacker's own outbound raid, if it has landed — without the
 * account-wide `raid:` scan the global resolveDueRaids does. The attacker's
 * cached `araidlast` names the target, so we resolve only that one defender's
 * incoming raids, which flips this raid's record (and its own araidlast copy).
 */
export async function resolveAttackerRaid(env: Env, attackerId: string): Promise<void> {
  const last = await getAttackerLastRaid(env, attackerId);
  if (last && last.status === "in_flight") {
    await resolveDueRaids(env, last.target_player_id);
  }
}
