import { describe, it, expect } from "vitest";
import type { DefenseValues, BoostRecord } from "../src/types.js";
import { TRAVEL_MIN_SECONDS, TRAVEL_MAX_SECONDS, BESIEGED_DURATION_SECONDS } from "../src/types.js";
import {
  haversineKm,
  travelTimeSeconds,
  travelTimeBetween,
  boostHpFor,
  makeBoost,
  activeBoosts,
  rawPower,
  effectiveDamage,
  totalPool,
  threatBand,
  resolveRaid,
} from "../src/logic/raid.js";

const NOW = 1_000_000;

function defense(overrides: Partial<DefenseValues> = {}): DefenseValues {
  return {
    base_defense: 10,
    survey_bonus: 0,
    defense_item: null,
    defense_value: 0,
    hp: 100,
    max_hp: 100,
    hp_updated_at: 0,
    boosts: [],
    ...overrides,
  };
}

function boost(hp: number, expires = NOW + 10_000): BoostRecord {
  return { item_type: "defense_common", hp_remaining: hp, hp_initial: hp, installed_at: NOW, expires_at: expires };
}

describe("travel time", () => {
  it("maps distance into the [1h, 12h] band, clamped", () => {
    expect(travelTimeSeconds(0)).toBe(TRAVEL_MIN_SECONDS);
    expect(travelTimeSeconds(5000)).toBe(TRAVEL_MAX_SECONDS);
    expect(travelTimeSeconds(99999)).toBe(TRAVEL_MAX_SECONDS);
    const mid = travelTimeSeconds(2500);
    expect(mid).toBeGreaterThan(TRAVEL_MIN_SECONDS);
    expect(mid).toBeLessThan(TRAVEL_MAX_SECONDS);
  });

  it("haversine ~0 for identical points and ~large across continents", () => {
    expect(haversineKm({ lat: 40, lng: -111 }, { lat: 40, lng: -111 })).toBeCloseTo(0, 5);
    expect(haversineKm({ lat: 40, lng: -111 }, { lat: 51, lng: 0 })).toBeGreaterThan(7000);
  });

  it("falls back to the mid band when a centroid is unknown", () => {
    const mid = Math.round((TRAVEL_MIN_SECONDS + TRAVEL_MAX_SECONDS) / 2);
    expect(travelTimeBetween(undefined, { lat: 1, lng: 1 })).toBe(mid);
    expect(travelTimeBetween({ lat: 1, lng: 1 }, undefined)).toBe(mid);
  });
});

describe("boost diminishing returns", () => {
  it("scales each subsequent active boost by 0.6", () => {
    expect(boostHpFor("defense_common", 0)).toBe(40);
    expect(boostHpFor("defense_common", 1)).toBe(24);
    expect(boostHpFor("defense_common", 2)).toBe(14);
    expect(boostHpFor("defense_epic", 0)).toBe(300);
  });

  it("makeBoost sets a 12h expiry and full initial HP", () => {
    const b = makeBoost("defense_uncommon", 0, NOW);
    expect(b.hp_remaining).toBe(80);
    expect(b.hp_initial).toBe(80);
    expect(b.expires_at).toBe(NOW + 43200);
  });

  it("activeBoosts drops expired and depleted", () => {
    const d = defense({ boosts: [boost(40), boost(10, NOW - 1), { ...boost(0) }] });
    expect(activeBoosts(d, NOW)).toHaveLength(1);
  });
});

describe("damage math", () => {
  it("rawPower sums item powers", () => {
    expect(rawPower(["attack_common", "attack_uncommon"])).toBe(30 + 70);
    expect(rawPower(["attack_epic", "attack_epic"])).toBe(600);
  });

  it("effectiveDamage applies the installed item's % reduction, min 1", () => {
    expect(effectiveDamage(50, defense())).toBe(50); // no item → no reduction
    expect(effectiveDamage(50, defense({ defense_item: "defense_epic" }))).toBe(30); // 40% off
    expect(effectiveDamage(1, defense({ defense_item: "defense_epic" }))).toBe(1); // floored to 1
    expect(effectiveDamage(0, defense())).toBe(0);
  });

  it("totalPool = live boosts + base HP", () => {
    const d = defense({ hp: 50, boosts: [boost(40), boost(10, NOW - 1)] });
    expect(totalPool(d, NOW)).toBe(90); // 40 live + 50 hp (expired 10 ignored)
  });
});

describe("threat band (defender-only)", () => {
  it("classifies raze / heavy / hold vs current pool", () => {
    expect(threatBand(210, defense(), NOW)).toBe("raze"); // eff 205 >= 100
    expect(threatBand(60, defense(), NOW)).toBe("heavy"); // eff 55 in [50,100)
    expect(threatBand(20, defense(), NOW)).toBe("hold"); // eff 15 < 50
  });
});

describe("resolveRaid (atomic, defense-at-arrival)", () => {
  it("defends when the pool survives; sets besieged", () => {
    const r = resolveRaid({ item_types: ["attack_uncommon"], raw_power: 50 }, defense(), 2, NOW);
    expect(r.outcome).toBe("defended");
    expect(r.hp_after).toBe(50); // 100 - 50 (no installed item → no reduction)
    expect(r.defense.besieged_until).toBe(NOW + BESIEGED_DURATION_SECONDS);
  });

  it("drains boosts before base HP", () => {
    const d = defense({ hp: 50, boosts: [boost(40)] });
    // raw 60 -> eff 60 (no item); boost 40 absorbs, 20 hits hp -> 30
    const r = resolveRaid({ item_types: [], raw_power: 60 }, d, 2, NOW);
    expect(r.outcome).toBe("defended");
    expect(r.hp_after).toBe(30);
    expect(r.defense.boosts).toHaveLength(0); // spent boost dropped
  });

  it("razes a level-1 post when the pool is exhausted", () => {
    const r = resolveRaid({ item_types: [], raw_power: 300 }, defense({ hp: 100 }), 1, NOW);
    expect(r.outcome).toBe("razed");
    expect(r.level_after).toBe(0);
    expect(r.hp_after).toBe(0);
  });

  it("drops a level (not razed) for a higher-level post, resetting HP and clearing boosts", () => {
    const d = defense({ hp: 100, boosts: [boost(40)] });
    const r = resolveRaid({ item_types: [], raw_power: 500 }, d, 3, NOW);
    expect(r.outcome).toBe("damaged");
    expect(r.level_after).toBe(2);
    expect(r.hp_after).toBe(100); // POST_MAX_HP[2]
    expect(r.defense.boosts).toHaveLength(0);
  });

  it("does not mutate the input defense object", () => {
    const d = defense({ hp: 100 });
    resolveRaid({ item_types: [], raw_power: 300 }, d, 1, NOW);
    expect(d.hp).toBe(100);
    expect(d.besieged_until).toBeUndefined();
  });
});
