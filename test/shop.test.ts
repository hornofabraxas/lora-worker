import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index.js";
import { computeHmac } from "../src/middleware/auth.js";
import type { Env } from "../src/types.js";
import { makeEnv } from "./helpers/env.js";


let env: Env;

async function registerPlayer(name: string = "TestPlayer"): Promise<{ player_id: string; secret: string }> {
  const res = await app.fetch(
    new Request("http://localhost/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: name, coarse_cells: ["831a00fffffffff"] }),
    }),
    env,
  );
  return res.json();
}

async function makeAuthHeaders(
  playerId: string,
  secret: string,
  body: string,
): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = playerId + timestamp + body;
  const signature = await computeHmac(secret, message);
  return {
    "X-Player-ID": playerId,
    "X-Timestamp": timestamp,
    "X-Signature": signature,
    "Content-Type": "application/json",
  };
}

async function buy(
  player: { player_id: string; secret: string },
  item_type: string,
  purchase_id: string,
) {
  const body = JSON.stringify({ item_type, purchase_id });
  const headers = await makeAuthHeaders(player.player_id, player.secret, body);
  return app.fetch(
    new Request("http://localhost/api/shop/buy", { method: "POST", headers, body }),
    env,
  );
}

describe("POST /api/shop/buy", () => {
  beforeEach(() => {
    env = makeEnv();
  });

  it("mints a sellable item into the player's inventory", async () => {
    const player = await registerPlayer("Buyer");
    const purchaseId = crypto.randomUUID();

    const res = await buy(player, "probe", purchaseId);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.item.type).toBe("probe");
    expect(data.item.id).toBe(purchaseId);
    expect(data.item.used).toBe(false);

    const stored = (await env.PLAYERS.get(`player:${player.player_id}`, "json")) as any;
    expect(stored.items.some((i: any) => i.id === purchaseId)).toBe(true);
  });

  it("is idempotent for a repeated purchase_id (no duplicate mint)", async () => {
    const player = await registerPlayer("Buyer2");
    const purchaseId = crypto.randomUUID();

    await buy(player, "attack_common", purchaseId);
    const res = await buy(player, "attack_common", purchaseId);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);

    const stored = (await env.PLAYERS.get(`player:${player.player_id}`, "json")) as any;
    const matching = stored.items.filter((i: any) => i.id === purchaseId);
    expect(matching).toHaveLength(1);
  });

  it("rejects a non-sellable (rare) item", async () => {
    const player = await registerPlayer("Buyer3");
    const res = await buy(player, "attack_rare", crypto.randomUUID());
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.error).toContain("not for sale");
  });

  it("rejects an unknown item type", async () => {
    const player = await registerPlayer("Buyer4");
    const res = await buy(player, "gold_bar", crypto.randomUUID());
    expect(res.status).toBe(400);
  });

  it("requires item_type and purchase_id", async () => {
    const player = await registerPlayer("Buyer5");
    const body = JSON.stringify({ item_type: "probe" });
    const headers = await makeAuthHeaders(player.player_id, player.secret, body);
    const res = await app.fetch(
      new Request("http://localhost/api/shop/buy", { method: "POST", headers, body }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated requests", async () => {
    const body = JSON.stringify({ item_type: "probe", purchase_id: crypto.randomUUID() });
    const res = await app.fetch(
      new Request("http://localhost/api/shop/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});

async function salvage(
  player: { player_id: string; secret: string },
  item_ids: string[],
) {
  const body = JSON.stringify({ item_ids });
  const headers = await makeAuthHeaders(player.player_id, player.secret, body);
  return app.fetch(
    new Request("http://localhost/api/shop/salvage", { method: "POST", headers, body }),
    env,
  );
}

describe("POST /api/shop/salvage", () => {
  beforeEach(() => {
    env = makeEnv();
  });

  it("removes free items and reports how many were removed", async () => {
    const player = await registerPlayer("Salv1");
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    await buy(player, "attack_common", id1);
    await buy(player, "attack_uncommon", id2);

    const res = await salvage(player, [id1, id2]);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.removed_count).toBe(2);
    expect(new Set(data.removed_ids)).toEqual(new Set([id1, id2]));

    const stored = (await env.PLAYERS.get(`player:${player.player_id}`, "json")) as any;
    expect(stored.items).toHaveLength(0);
  });

  it("is idempotent: re-salvaging already-removed ids credits nothing", async () => {
    const player = await registerPlayer("Salv2");
    const id1 = crypto.randomUUID();
    await buy(player, "attack_common", id1);

    await salvage(player, [id1]);
    const res = await salvage(player, [id1]);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.removed_count).toBe(0);
  });

  it("will not salvage an installed defense item", async () => {
    const player = await registerPlayer("Salv3");
    const id1 = crypto.randomUUID();
    await buy(player, "defense_common", id1);
    // Mark it installed directly in the store.
    const stored = (await env.PLAYERS.get(`player:${player.player_id}`, "json")) as any;
    stored.items = stored.items.map((i: any) =>
      i.id === id1 ? { ...i, installed_post_token: "8a2a1072b59ffff" } : i);
    await env.PLAYERS.put(`player:${player.player_id}`, JSON.stringify(stored));

    const res = await salvage(player, [id1]);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.removed_count).toBe(0);
  });

  it("requires a non-empty item_ids array", async () => {
    const player = await registerPlayer("Salv4");
    const body = JSON.stringify({ item_ids: [] });
    const headers = await makeAuthHeaders(player.player_id, player.secret, body);
    const res = await app.fetch(
      new Request("http://localhost/api/shop/salvage", { method: "POST", headers, body }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated requests", async () => {
    const body = JSON.stringify({ item_ids: ["x"] });
    const res = await app.fetch(
      new Request("http://localhost/api/shop/salvage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});
