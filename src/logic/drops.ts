import type { ItemDrop, ItemType } from "../types.js";

const DROP_TABLE: { type: ItemType; chance: number }[] = [
  { type: "probe", chance: 0.25 },
  { type: "attack_common", chance: 0.20 },
  { type: "defense_common", chance: 0.20 },
  { type: "attack_uncommon", chance: 0.06 },
  { type: "defense_uncommon", chance: 0.06 },
  { type: "attack_rare", chance: 0.015 },
  { type: "defense_rare", chance: 0.015 },
  { type: "attack_epic", chance: 0.003 },
  { type: "defense_epic", chance: 0.003 },
];

async function sha256(input: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash);
}

function uint8ToFloat(bytes: Uint8Array, offset: number): number {
  const val = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
  return (val >>> 0) / 0xffffffff;
}

export async function computeDrops(
  playerId: string,
  timestamp: number,
  surveyCount: number,
): Promise<ItemDrop[]> {
  const drops: ItemDrop[] = [];

  for (let i = 0; i < surveyCount; i++) {
    for (const entry of DROP_TABLE) {
      // One independent hash per (survey, item type). The previous approach
      // packed all 9 rolls into a single 32-byte hash via (j*3)%28 offsets,
      // which made attack_epic (bytes 21-24) and defense_epic (bytes 24-27)
      // share byte 24 and correlate their rolls. A per-type hash gives every
      // item type a fully independent roll with no shared bytes.
      const hash = await sha256(`${playerId}:${timestamp}:${i}:${entry.type}`);
      const roll = uint8ToFloat(hash, 0);
      if (roll < entry.chance) {
        const idBytes = hash.slice(28, 32);
        const idSuffix = Array.from(idBytes).map(b => b.toString(16).padStart(2, "0")).join("");
        drops.push({
          type: entry.type,
          id: `${entry.type}_${timestamp}_${i}_${idSuffix}`,
        });
      }
    }
  }

  return drops;
}
