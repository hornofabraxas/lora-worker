import type { DefenseValues, BoostRecord, ItemType, ThreatBand, RaidRecord } from "../types.js";
import {
  ITEM_ATTACK_POWER,
  ITEM_DEFENSE_PCT,
  MAX_DEFENSE_PCT,
  ITEM_BOOST_HP,
  POST_MAX_HP,
  TRAVEL_MIN_SECONDS,
  TRAVEL_MAX_SECONDS,
  TRAVEL_MAX_KM,
  BOOST_DURATION_SECONDS,
  BESIEGED_DURATION_SECONDS,
  BOOST_DR_FACTOR,
} from "../types.js";

// ---------------------------------------------------------------------------
// Travel time (distance -> ETA), from coarse cell centroids. Haversine keeps
// the Worker dependency-free; coarse centroids are within the existing location
// privacy boundary. Falls back to the mid band when a centroid is unknown.
// ---------------------------------------------------------------------------

export interface Coarse {
  lat: number;
  lng: number;
}

export function haversineKm(a: Coarse, b: Coarse): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Linear map distance -> [1h, 12h], clamped. */
export function travelTimeSeconds(distanceKm: number): number {
  const frac = Math.max(0, Math.min(1, distanceKm / TRAVEL_MAX_KM));
  return Math.round(
    TRAVEL_MIN_SECONDS + frac * (TRAVEL_MAX_SECONDS - TRAVEL_MIN_SECONDS),
  );
}

/** ETA from two optional centroids; mid band when either is unknown. */
export function travelTimeBetween(from?: Coarse, to?: Coarse): number {
  if (!from || !to) {
    return Math.round((TRAVEL_MIN_SECONDS + TRAVEL_MAX_SECONDS) / 2);
  }
  return travelTimeSeconds(haversineKm(from, to));
}

// ---------------------------------------------------------------------------
// Defense boosts (temporary flat HP, diminishing returns, soaked first).
// ---------------------------------------------------------------------------

/** Flat HP granted for a new boost given how many are already active. */
export function boostHpFor(itemType: ItemType, activeCount: number): number {
  const base = ITEM_BOOST_HP[itemType] ?? 0;
  return Math.round(base * Math.pow(BOOST_DR_FACTOR, activeCount));
}

export function activeBoosts(defense: DefenseValues, now: number): BoostRecord[] {
  return (defense.boosts ?? []).filter((b) => b.expires_at > now && b.hp_remaining > 0);
}

export function makeBoost(itemType: ItemType, activeCount: number, now: number): BoostRecord {
  const hp = boostHpFor(itemType, activeCount);
  return {
    item_type: itemType,
    hp_remaining: hp,
    hp_initial: hp,
    installed_at: now,
    expires_at: now + BOOST_DURATION_SECONDS,
  };
}

/** Fraction of incoming damage the installed item absorbs (0 if none), capped. */
export function defenseReduction(defense: DefenseValues): number {
  const dr = defense.defense_item ? (ITEM_DEFENSE_PCT[defense.defense_item] ?? 0) : 0;
  return Math.min(MAX_DEFENSE_PCT, dr);
}

export function rawPower(itemTypes: ItemType[]): number {
  return itemTypes.reduce((sum, t) => sum + (ITEM_ATTACK_POWER[t] ?? 0), 0);
}

/** Damage after the installed item's % reduction (min 1 if any power). */
export function effectiveDamage(raw: number, defense: DefenseValues): number {
  if (raw <= 0) return 0;
  return Math.max(1, Math.ceil(raw * (1 - defenseReduction(defense))));
}

/** Total absorbable HP right now: live boosts (soaked first) + base HP. */
export function totalPool(defense: DefenseValues, now: number): number {
  const boostHp = activeBoosts(defense, now).reduce((s, b) => s + b.hp_remaining, 0);
  return boostHp + defense.hp;
}

/** Live effective Health for display: raw pool scaled up by damage reduction. */
export function effectiveHp(defense: DefenseValues, now: number): number {
  return Math.round(totalPool(defense, now) / (1 - defenseReduction(defense)));
}

/** Effective max Health (base pool only, item-scaled) for the display bar. */
export function effectiveMaxHp(defense: DefenseValues): number {
  return Math.round(defense.max_hp / (1 - defenseReduction(defense)));
}

// ---------------------------------------------------------------------------
// Threat readout (defender-only, coarse). Based on the projected outcome
// against the defender's *current* full state (including hidden boosts).
// ---------------------------------------------------------------------------

export function threatBand(raw: number, defense: DefenseValues, now: number): ThreatBand {
  const dmg = effectiveDamage(raw, defense);
  const pool = totalPool(defense, now);
  if (dmg >= pool) return "raze";
  if (dmg >= pool * 0.5) return "heavy";
  return "hold";
}

// ---------------------------------------------------------------------------
// Atomic multi-item resolution against defense-at-arrival. Mutates a copy of
// the defense (boosts drained first, then base HP) and returns the outcome.
// ---------------------------------------------------------------------------

export interface RaidResolution {
  outcome: "razed" | "damaged" | "defended";
  damage_dealt: number;
  hp_after: number;
  level_after: number;
  defense: DefenseValues;
}

export function resolveRaid(
  raid: Pick<RaidRecord, "item_types" | "raw_power">,
  defenseIn: DefenseValues,
  postLevel: number,
  now: number,
): RaidResolution {
  // Work on a copy.
  const defense: DefenseValues = {
    ...defenseIn,
    boosts: (defenseIn.boosts ?? []).map((b) => ({ ...b })),
  };

  const raw = raid.raw_power || rawPower(raid.item_types);
  let remaining = effectiveDamage(raw, defense);
  const damageDealt = remaining;

  // Soak into live boosts first (oldest first), then base HP.
  const live = activeBoosts(defense, now);
  for (const boost of live) {
    if (remaining <= 0) break;
    const absorbed = Math.min(boost.hp_remaining, remaining);
    boost.hp_remaining -= absorbed;
    remaining -= absorbed;
  }
  // Drop spent/expired boosts.
  defense.boosts = (defense.boosts ?? []).filter((b) => b.expires_at > now && b.hp_remaining > 0);

  const hpAfter = Math.max(0, defense.hp - remaining);
  defense.hp = hpAfter;
  defense.hp_updated_at = now;
  // Any landed raid pauses regen (siege), so partial damage isn't undone.
  defense.besieged_until = now + BESIEGED_DURATION_SECONDS;

  if (hpAfter > 0) {
    return { outcome: "defended", damage_dealt: damageDealt, hp_after: hpAfter, level_after: postLevel, defense };
  }

  if (postLevel <= 1) {
    return { outcome: "razed", damage_dealt: damageDealt, hp_after: 0, level_after: 0, defense };
  }

  // Level loss: reset HP to the new (lower) level's max, boosts cleared.
  const newLevel = postLevel - 1;
  const newMax = POST_MAX_HP[newLevel] ?? 50;
  defense.hp = newMax;
  defense.max_hp = newMax;
  defense.boosts = [];
  return { outcome: "damaged", damage_dealt: damageDealt, hp_after: newMax, level_after: newLevel, defense };
}
