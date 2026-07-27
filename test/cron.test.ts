import { describe, it, expect, beforeEach } from "vitest";
import type { Env, DefenseValues } from "../src/types.js";
import { makeEnv } from "./helpers/env.js";
import { regenPostHp } from "../src/logic/cron.js";


let env: Env;

async function seedDefense(playerId: string, postHex: string, defense: DefenseValues) {
  await env.DEFENSE.put(`defense:${playerId}:${postHex}`, JSON.stringify(defense));
}

describe("regenPostHp", () => {
  beforeEach(() => {
    env = makeEnv();
  });

  it("regenerates HP for damaged posts", async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedDefense("player-1", "post_a", {
      base_defense: 10, survey_bonus: 0,
      defense_item: null, defense_value: 0,
      hp: 30, max_hp: 50,
      hp_updated_at: now - 7200, // 2 hours ago
    });

    const updated = await regenPostHp(env);
    expect(updated).toBe(1);

    const defense = await env.DEFENSE.get("defense:player-1:post_a", "json") as DefenseValues;
    expect(defense.hp).toBe(36); // 30 + floor(3 * 2) = 36
  });

  it("caps regen at max_hp", async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedDefense("player-1", "post_b", {
      base_defense: 10, survey_bonus: 0,
      defense_item: null, defense_value: 0,
      hp: 48, max_hp: 50,
      hp_updated_at: now - 36000, // 10 hours ago
    });

    await regenPostHp(env);

    const defense = await env.DEFENSE.get("defense:player-1:post_b", "json") as DefenseValues;
    expect(defense.hp).toBe(50);
  });

  it("skips posts already at full HP", async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedDefense("player-1", "post_c", {
      base_defense: 10, survey_bonus: 0,
      defense_item: null, defense_value: 0,
      hp: 50, max_hp: 50,
      hp_updated_at: now - 7200,
    });

    const updated = await regenPostHp(env);
    expect(updated).toBe(0);
  });

  it("skips posts updated less than 1 hour ago", async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedDefense("player-1", "post_d", {
      base_defense: 10, survey_bonus: 0,
      defense_item: null, defense_value: 0,
      hp: 30, max_hp: 50,
      hp_updated_at: now - 1800, // 30 min ago
    });

    const updated = await regenPostHp(env);
    expect(updated).toBe(0);
  });
});
