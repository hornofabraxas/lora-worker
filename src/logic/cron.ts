import type { Env, DefenseValues } from "../types.js";
import { getPlayerIndex } from "../kv/queries.js";
import { PLAYER_INDEX_KEY } from "../kv/schema.js";
import { batch } from "../kv/do_store.js";

const HP_REGEN_PER_HOUR = 3;

export async function backfillPlayerIndex(env: Env): Promise<number> {
  const existing = await getPlayerIndex(env);
  if (existing.length > 0) return 0;

  const list = await env.PLAYERS.list({ prefix: "player:" });
  const ids: string[] = [];
  for (const key of list.keys) {
    if (key.name.includes(":last_bundle") || key.name.includes(":last_attack")) continue;
    ids.push(key.name.replace("player:", ""));
  }

  if (ids.length > 0) {
    await env.META.put(PLAYER_INDEX_KEY, JSON.stringify(ids));
  }
  return ids.length;
}

export async function regenPostHp(env: Env): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  // One RPC pulls every defense row (key + body); we only write back the posts
  // that actually regen, so the write count stays proportional to damaged posts.
  const rows = await batch(env.DEFENSE).listValues("defense:");
  let updated = 0;

  for (const row of rows) {
    const defense = JSON.parse(row.value) as DefenseValues;
    if (defense.hp >= defense.max_hp) continue;
    // Besieged posts don't regen — so a partial raid isn't undone before a follow-up.
    if (defense.besieged_until && now < defense.besieged_until) continue;

    const hoursSince = Math.max(0, (now - defense.hp_updated_at) / 3600);
    if (hoursSince < 1) continue;

    const regen = Math.floor(HP_REGEN_PER_HOUR * hoursSince);
    if (regen <= 0) continue;

    defense.hp = Math.min(defense.max_hp, defense.hp + regen);
    defense.hp_updated_at = now;
    await env.DEFENSE.put(row.name, JSON.stringify(defense));
    updated++;
  }

  return updated;
}

