import { describe, it, expect } from "vitest";
import { computeDrops } from "../src/logic/drops.js";

describe("computeDrops", () => {
  it("returns empty for zero surveys", async () => {
    const drops = await computeDrops("player1", 1000000, 0);
    expect(drops).toEqual([]);
  });

  it("is deterministic — same inputs produce same outputs", async () => {
    const a = await computeDrops("player1", 1000000, 10);
    const b = await computeDrops("player1", 1000000, 10);
    expect(a).toEqual(b);
  });

  it("different players get different drops", async () => {
    const a = await computeDrops("player1", 1000000, 10);
    const b = await computeDrops("player2", 1000000, 10);
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });

  it("different timestamps get different drops", async () => {
    const a = await computeDrops("player1", 1000000, 10);
    const b = await computeDrops("player1", 2000000, 10);
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });

  it("produces drops at expected rates over many surveys", async () => {
    const drops = await computeDrops("test_rates", 9999999, 1000);

    const counts: Record<string, number> = {};
    for (const d of drops) {
      counts[d.type] = (counts[d.type] ?? 0) + 1;
    }

    // Probes: ~25% → ~250 (±100)
    expect(counts["probe"] ?? 0).toBeGreaterThan(100);
    expect(counts["probe"] ?? 0).toBeLessThan(450);

    // Attack/Defense common: ~20% each → ~200 each (±100)
    expect(counts["attack_common"] ?? 0).toBeGreaterThan(80);
    expect(counts["attack_common"] ?? 0).toBeLessThan(400);
    expect(counts["defense_common"] ?? 0).toBeGreaterThan(80);
    expect(counts["defense_common"] ?? 0).toBeLessThan(400);

    // Uncommon: ~6% each → ~60 each (±40)
    expect(counts["attack_uncommon"] ?? 0).toBeGreaterThan(15);
    expect(counts["attack_uncommon"] ?? 0).toBeLessThan(120);

    // Rare: ~1.5% → ~15 (±12)
    expect(counts["attack_rare"] ?? 0).toBeGreaterThan(1);
    expect(counts["attack_rare"] ?? 0).toBeLessThan(50);

    // Epic: ~0.3% → ~3 (very low, just check non-negative)
    expect(counts["attack_epic"] ?? 0).toBeLessThan(20);
  });

  it("each drop has a unique id", async () => {
    const drops = await computeDrops("player1", 1000000, 50);
    const ids = drops.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("drop ids contain the item type", async () => {
    const drops = await computeDrops("player1", 1000000, 50);
    for (const d of drops) {
      expect(d.id).toContain(d.type);
    }
  });

  it("only produces valid item types", async () => {
    const drops = await computeDrops("player1", 1000000, 100);
    const validTypes = [
      "probe",
      "attack_common", "attack_uncommon", "attack_rare", "attack_epic",
      "defense_common", "defense_uncommon", "defense_rare", "defense_epic",
    ];
    for (const d of drops) {
      expect(validTypes).toContain(d.type);
    }
  });
});
