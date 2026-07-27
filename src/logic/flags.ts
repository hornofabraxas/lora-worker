import type { Env, PlayerProfile } from "../types.js";
import { MAX_POST_LEVEL } from "../types.js";

// The anomaly report behind GET /api/admin/flags, plus the operator's
// acknowledgements of it.
//
// Every reason carries a stable `code` alongside its human text. The text
// contains live numbers ("after only 0.7d", "24 rejected requests") that drift
// on every read, so it can't be what a dismissal is keyed on — the operator
// would dismiss a row and watch it return a minute later wearing a slightly
// different number. The code is what persists.

export const FLAG_ACK_KEY = "moderation:flag_acks";

// The live game caps a player at 3 posts (engine.MAX_SURVEY_POSTS); more than
// that is worth a human look even though the bundle route tolerates a little
// headroom. Enough rejected authenticated requests means someone is poking the
// API with a modified client. Both are review signals, not auto-bans.
export const GAME_MAX_POSTS = 3;
export const INSTANT_MAX_LEVEL_AGE_DAYS = 2;
export const AUDIT_FLAG_THRESHOLD = 20;

export interface FlagReason {
  /** Stable identity of the finding — what a dismissal is keyed on. */
  code: string;
  /** Human sentence, including live numbers. Never used for identity. */
  text: string;
}

export interface FlagAck {
  /** Sorted reason codes the operator dismissed. */
  codes: string[];
  at: number;
}

export type FlagAcks = Record<string, FlagAck>;

export async function getFlagAcks(env: Env): Promise<FlagAcks> {
  return (await env.META.get<FlagAcks>(FLAG_ACK_KEY, "json")) ?? {};
}

/** Decode acks already pulled as part of a larger snapshot read. */
export function parseFlagAcks(raw: string | null): FlagAcks {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as FlagAcks;
  } catch {
    return {};
  }
}

export async function putFlagAcks(env: Env, acks: FlagAcks): Promise<void> {
  await env.META.put(FLAG_ACK_KEY, JSON.stringify(acks));
}

/**
 * Reasons a player is worth a human look. Empty means nothing anomalous.
 *
 * `auditRejects` is passed in rather than read here so the caller controls the
 * storage round-trip.
 */
export function reasonsFor(player: PlayerProfile, auditRejects: number, now: number): FlagReason[] {
  const reasons: FlagReason[] = [];

  if (player.post_summaries.length > GAME_MAX_POSTS) {
    reasons.push({
      code: "posts_over_max",
      text: `holds ${player.post_summaries.length} posts (game max ${GAME_MAX_POSTS})`,
    });
  }

  for (const post of player.post_summaries) {
    if (post.level < MAX_POST_LEVEL) continue;

    // Only growth the Worker actually witnessed counts. A post first seen at max
    // level arrived that way — which is true of every post belonging to a new
    // registrant, since first-seen is their registration moment — and a post
    // predating post_first_level (undefined) can't be judged at all. Flagging
    // either would fire on exactly the players worth welcoming.
    const firstLevel = player.post_first_level?.[post.post_token];
    if (firstLevel === undefined || firstLevel >= MAX_POST_LEVEL) continue;

    // Measure from when we started watching, not from the claimed charter date.
    const watchedFrom = player.post_first_seen?.[post.post_token] ?? post.chartered_at;
    const ageDays = (now - watchedFrom) / 86400;
    if (ageDays < INSTANT_MAX_LEVEL_AGE_DAYS) {
      reasons.push({
        code: `instant_max_level:${post.post_token}`,
        text: `post ${post.post_token} climbed from level ${firstLevel} to max in ${ageDays.toFixed(1)}d`,
      });
    }
  }

  if (auditRejects >= AUDIT_FLAG_THRESHOLD) {
    reasons.push({
      code: "audit_rejects",
      text: `${auditRejects} rejected requests in the last 7d`,
    });
  }

  return reasons;
}

/**
 * True when the operator has already dismissed exactly this set of findings.
 * A new reason appearing un-dismisses the row: acknowledging "holds 4 posts"
 * must not also silence a raid-cheat signal that shows up next week.
 */
export function isDismissed(ack: FlagAck | undefined, reasons: FlagReason[]): boolean {
  if (!ack) return false;
  const current = reasons.map((r) => r.code).sort();
  const dismissed = new Set(ack.codes);
  return current.every((c) => dismissed.has(c));
}
