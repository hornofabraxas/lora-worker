import { describe, it, expect } from "vitest";
import {
  renownPerDay,
  totalRenownPerDay,
  totalRenown,
  RENOWN_PER_DAY_PER_LEVEL,
  RENOWN_AGE_BONUS_PER_DAY,
} from "../src/logic/renown.js";

const DAY = 86400;

describe("renownPerDay", () => {
  it("is the level base at age 0", () => {
    const now = 1000000;
    expect(renownPerDay({ level: 1, chartered_at: now }, now)).toBe(
      RENOWN_PER_DAY_PER_LEVEL,
    );
    expect(renownPerDay({ level: 3, chartered_at: now }, now)).toBe(
      3 * RENOWN_PER_DAY_PER_LEVEL,
    );
  });

  it("rises with age (base + age bonus)", () => {
    const now = 1000000;
    // Lv1 post held 10 days = base + 10 * age-bonus.
    expect(renownPerDay({ level: 1, chartered_at: now - DAY * 10 }, now)).toBe(
      RENOWN_PER_DAY_PER_LEVEL + 10 * RENOWN_AGE_BONUS_PER_DAY,
    );
  });

  it("defaults a missing level to 1", () => {
    const now = 1000000;
    expect(renownPerDay({ chartered_at: now }, now)).toBe(
      RENOWN_PER_DAY_PER_LEVEL,
    );
  });
});

describe("totalRenownPerDay", () => {
  it("returns 0 for no posts", () => {
    expect(totalRenownPerDay([], 1000000)).toBe(0);
  });

  it("sums each post's current (age-boosted) daily rate", () => {
    const now = 1000000;
    const posts = [
      { level: 1, chartered_at: now }, // base only
      { level: 2, chartered_at: now - DAY * 10 }, // base + 10*bonus
    ];
    const expected =
      RENOWN_PER_DAY_PER_LEVEL +
      (2 * RENOWN_PER_DAY_PER_LEVEL + 10 * RENOWN_AGE_BONUS_PER_DAY);
    expect(totalRenownPerDay(posts, now)).toBe(Math.round(expected));
  });
});

describe("totalRenown", () => {
  it("returns 0 for no posts", () => {
    expect(totalRenown([], 1000000)).toBe(0);
  });

  it("returns 0 for a brand new post (no age accrued yet)", () => {
    const now = 1000000;
    expect(totalRenown([{ level: 1, chartered_at: now }], now)).toBe(0);
  });

  it("integrates the age-rising rate: base*age + c*age^2/2", () => {
    const now = 1000000;
    const age = 10;
    const base = 2 * RENOWN_PER_DAY_PER_LEVEL;
    const expected =
      base * age + (RENOWN_AGE_BONUS_PER_DAY * age * age) / 2;
    expect(totalRenown([{ level: 2, chartered_at: now - DAY * age }], now)).toBe(
      Math.round(expected),
    );
  });

  it("grows super-linearly (doubling age more than doubles renown)", () => {
    const now = 1000000;
    const at10 = totalRenown([{ level: 1, chartered_at: now - DAY * 10 }], now);
    const at20 = totalRenown([{ level: 1, chartered_at: now - DAY * 20 }], now);
    expect(at20).toBeGreaterThan(at10 * 2);
  });

  it("higher-level posts generate more renown at the same age", () => {
    const now = 1000000;
    const at = now - DAY * 10;
    const lo = totalRenown([{ level: 1, chartered_at: at }], now);
    const hi = totalRenown([{ level: 3, chartered_at: at }], now);
    expect(hi).toBeGreaterThan(lo);
  });

  it("sums across multiple posts", () => {
    const now = 1000000;
    const single = totalRenown([{ level: 1, chartered_at: now - DAY * 10 }], now);
    const double = totalRenown(
      [
        { level: 1, chartered_at: now - DAY * 10 },
        { level: 1, chartered_at: now - DAY * 10 },
      ],
      now,
    );
    expect(double).toBe(single * 2);
  });
});
