import { describe, it, expect, beforeEach } from "vitest";
import type { Env, PlayerProfile } from "../src/types.js";
import { makeEnv } from "./helpers/env.js";
import { putPlayer, addToPlayerIndex, getPlayer } from "../src/kv/queries.js";
import { retireGarrisonIfClear, NPC_RETIRE_TOP_N } from "../src/logic/leaderboard.js";

let env: Env;
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// A player whose single post's age (days) drives its renown. `npc` marks the
// garrison. Higher age => higher renown (totalRenown is quadratic in age).
async function seed(id: string, ageDays: number, level: number, npc: boolean): Promise<void> {
  const player: PlayerProfile = {
    player_id: id,
    display_name: id,
    registered_at: NOW - ageDays * DAY,
    items: [],
    post_summaries: [{ post_token: `${id}-p`, level, chartered_at: NOW - ageDays * DAY }],
    secret: "x".repeat(64),
    ...(npc ? { npc: true } : {}),
  };
  await putPlayer(env, player);
  await addToPlayerIndex(env, id);
}

describe("retireGarrisonIfClear", () => {
  beforeEach(() => {
    env = makeEnv();
  });

  it("keeps the garrison while an NPC still holds a top slot", async () => {
    await seed("npc-a", 0, 1, true); // ~0 renown
    await seed("npc-b", 0, 1, true);
    await seed("real-1", 30, 5, false); // high renown, but field < band
    const retired = await retireGarrisonIfClear(env, NOW);
    expect(retired).toBe(0);
    expect(await getPlayer(env, "npc-a")).not.toBeNull();
    expect(await getPlayer(env, "npc-b")).not.toBeNull();
  });

  it("retires the whole garrison once real players own the top band", async () => {
    await seed("npc-a", 0, 1, true);
    await seed("npc-b", 0, 1, true);
    // Fill the entire top band with higher-renown real players.
    for (let i = 0; i < NPC_RETIRE_TOP_N; i++) await seed(`real-${i}`, 30, 5, false);

    const retired = await retireGarrisonIfClear(env, NOW);
    expect(retired).toBe(2);
    expect(await getPlayer(env, "npc-a")).toBeNull();
    expect(await getPlayer(env, "npc-b")).toBeNull();
    // Real players are untouched.
    expect(await getPlayer(env, "real-0")).not.toBeNull();
  });

  it("is a no-op when there are no NPCs", async () => {
    await seed("real-1", 30, 5, false);
    expect(await retireGarrisonIfClear(env, NOW)).toBe(0);
    expect(await getPlayer(env, "real-1")).not.toBeNull();
  });
});
