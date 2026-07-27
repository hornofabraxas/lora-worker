import { describe, it, expect } from "vitest";
import {
  ruinIncomeFactor,
  ruinEffectiveDays,
  renownFactor,
  renownActiveDays,
  RUIN_GRACE_DAYS,
  RUIN_RAMP_DAYS,
} from "../src/logic/ruin.js";
import { renownPerDay, totalRenown } from "../src/logic/renown.js";

const DAY = 86400;
const NOW = 1_700_000_000;

describe("ruinIncomeFactor", () => {
  it("is full through the grace window and zero past the ramp", () => {
    expect(ruinIncomeFactor(0)).toBe(1);
    expect(ruinIncomeFactor(RUIN_GRACE_DAYS)).toBe(1);
    expect(ruinIncomeFactor(RUIN_GRACE_DAYS + RUIN_RAMP_DAYS)).toBe(0);
    expect(ruinIncomeFactor(RUIN_GRACE_DAYS + RUIN_RAMP_DAYS + 5)).toBe(0);
  });

  it("ramps linearly across the ruin window", () => {
    const mid = RUIN_GRACE_DAYS + RUIN_RAMP_DAYS / 2;
    expect(ruinIncomeFactor(mid)).toBeCloseTo(0.5, 6);
  });

  it("respects an extended grace (camp 7)", () => {
    expect(ruinIncomeFactor(12, 13)).toBe(1); // still inside the wider grace
  });
});

describe("ruinEffectiveDays", () => {
  it("credits full days inside the grace window", () => {
    expect(ruinEffectiveDays(0, 5)).toBeCloseTo(5, 6);
  });
  it("caps at grace + half the ramp for a long-neglected post", () => {
    expect(ruinEffectiveDays(0, 999)).toBeCloseTo(
      RUIN_GRACE_DAYS + RUIN_RAMP_DAYS / 2,
      6,
    );
  });
});

describe("renownFactor", () => {
  it("is full for a freshly-tended post", () => {
    const post = { chartered_at: NOW - DAY * 100, last_tended_at: NOW };
    expect(renownFactor(post, NOW)).toBe(1);
  });

  it("fades to 0 as a neglected post falls into ruin", () => {
    const tended = NOW - DAY * (RUIN_GRACE_DAYS + RUIN_RAMP_DAYS + 1);
    const post = { chartered_at: tended, last_tended_at: tended };
    expect(renownFactor(post, NOW)).toBe(0);
  });

  it("is 0 while dormant under a ward", () => {
    const post = {
      chartered_at: NOW - DAY * 5,
      last_tended_at: NOW - DAY * 5,
      warded_at: NOW - DAY * 2,
      dormant_until: NOW + DAY * 10,
    };
    expect(renownFactor(post, NOW)).toBe(0);
  });

  it("excludes ward time from the ruin clock (ward pauses ruin)", () => {
    // Last tended 20 days ago, but warded for 15 of those days → only 5 days of
    // real ruin age, still inside grace, so full renown once the ward lifts.
    const post = {
      chartered_at: NOW - DAY * 30,
      last_tended_at: NOW - DAY * 20,
      warded_at: NOW - DAY * 20,
      dormant_until: NOW - DAY * 5, // ward already ended
    };
    expect(renownFactor(post, NOW)).toBe(1);
  });

  it("treats a legacy post with no upkeep data as maintained", () => {
    expect(renownFactor({ chartered_at: NOW - DAY * 100 }, NOW)).toBe(1);
  });
});

describe("renownActiveDays", () => {
  it("equals full age for a healthy post", () => {
    const post = { chartered_at: NOW - DAY * 20, last_tended_at: NOW };
    expect(renownActiveDays(post, NOW)).toBeCloseTo(20, 6);
  });

  it("plateaus once a post is fully ruined", () => {
    // Fully ruined: active days freeze at (age before ruin) + grace + half ramp.
    const tended = NOW - DAY * 40;
    const post = { chartered_at: tended, last_tended_at: tended };
    const active = renownActiveDays(post, NOW);
    // Full age 40, ruin caps effective earning at grace + ramp/2 = 13.5 days.
    expect(active).toBeCloseTo(RUIN_GRACE_DAYS + RUIN_RAMP_DAYS / 2, 6);
  });

  it("does not advance while warded", () => {
    const base = {
      chartered_at: NOW - DAY * 10,
      last_tended_at: NOW - DAY * 10,
      warded_at: NOW - DAY * 4,
      dormant_until: NOW + DAY * 6,
    };
    // 10 days old, warded for the last 4 → 6 active days.
    expect(renownActiveDays(base, NOW)).toBeCloseTo(6, 6);
  });
});

describe("renownPerDay with ruin", () => {
  it("drops to 0 for a post in ruin", () => {
    const tended = NOW - DAY * (RUIN_GRACE_DAYS + RUIN_RAMP_DAYS + 3);
    const post = { level: 3, chartered_at: tended, last_tended_at: tended };
    expect(renownPerDay(post, NOW)).toBe(0);
  });

  it("matches the un-faded rate for a freshly-tended post", () => {
    const post = { level: 2, chartered_at: NOW - DAY * 10, last_tended_at: NOW };
    // base(6) + 10 active days * 0.5 = 11, factor 1.
    expect(renownPerDay(post, NOW)).toBeCloseTo(11, 6);
  });
});

describe("totalRenown freeze", () => {
  it("a ruined post's total never exceeds an equally-old healthy post's", () => {
    const chartered = NOW - DAY * 30;
    const healthy = { level: 2, chartered_at: chartered, last_tended_at: NOW };
    const ruined = { level: 2, chartered_at: chartered, last_tended_at: chartered };
    expect(totalRenown([ruined], NOW)).toBeLessThan(totalRenown([healthy], NOW));
  });

  it("tending a ruined post restores its accrual (total climbs again)", () => {
    const chartered = NOW - DAY * 30;
    const ruined = { level: 2, chartered_at: chartered, last_tended_at: chartered };
    const tended = { level: 2, chartered_at: chartered, last_tended_at: NOW };
    expect(totalRenown([tended], NOW)).toBeGreaterThan(totalRenown([ruined], NOW));
  });
});
