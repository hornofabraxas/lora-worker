// Proactive profanity denylist for player-VISIBLE names — display names and
// outpost names, the two fields shipped to other players (leaderboard / scout /
// raid). Deliberately conservative: it blocks the clearest slurs and profanity so
// an obvious one can't sit on the board until an operator notices, and it signals
// to a player that the field is moderated. It is NOT the whole moderation system
// — the operator censor → freeze → delete ladder (logic/moderation.ts) remains
// the backstop for anything that slips through or evades this.
//
// Mirror of the Python list in lora-the-explorer (game/names.py). Keep them in
// sync when editing — the game client filters at name-set time for instant
// feedback; this is the authoritative check a modified client can't skip.
//
// Two match modes manage the Scunthorpe problem (blocking "Scunthorpe" for
// containing a slur, or "Analysis" for "anal"):
//
//   SUBSTRING — terms with no innocent-word collisions. Matched anywhere, on the
//   name with separators stripped, so "f u c k" and "f.u.c.k" are caught too.
//
//   WORD — terms that DO appear inside ordinary words. Matched only as whole
//   words on the spaced name, so "class"/"analysis"/"cocoon" pass while
//   "ass"/"anal"/"coon" as standalone words are blocked.
//
// Editing guidance: a term is SUBSTRING-safe only if no common word contains it.
// When unsure, put it in WORD — a whole-word match is the safe default. The cost
// of a false block is low (the player just picks another name and is told why);
// the cost of a miss is a slur on everyone's board — so we lean toward blocking.
//
// Ambiguous stems stay WORD to protect real names (Bass, Canal, Scunthorpe,
// Raccoon, Spice, Peacock, Shoe...), but their clearly-offensive COMPOUNDS are
// listed as SUBSTRING (asshole, dickhead...) since those collide with nothing.
// Bare "dick" IS included as WORD by choice: it blocks a standalone "Dick" and
// "Moby Dick" too, accepting that a player named Richard must pick another handle
// — the crude use outweighs the collision here. It stays WORD (not substring) so
// "Dickens"/"Dickinson" still pass.
const SUBSTRING_TERMS = [
  "fuck", "shit", "bitch", "nigger", "nigga", "faggot",
  "whore", "wetback", "tranny", "beaner", "kike", "slut",
  "pussy", "twat", "asshole", "cocksucker",
  "dickhead", "dickface", "dickhole", "dickwad",
];
const WORD_TERMS = [
  "ass", "anal", "cum", "cunt", "coon", "spic", "chink",
  "fag", "tit", "tits", "hoe", "cock", "dick",
];

/**
 * True if `raw` contains a denylisted term. Case-insensitive. See the module note
 * for the two match modes and the Scunthorpe trade-off. An empty/blank name is
 * never blocked (length rules handle those elsewhere).
 */
export function nameIsBlocked(raw: string): boolean {
  const lower = raw.toLowerCase();
  const collapsed = lower.replace(/[^a-z0-9]/g, "");
  if (SUBSTRING_TERMS.some((t) => collapsed.includes(t))) return true;
  const words = lower.split(/[^a-z0-9]+/).filter(Boolean);
  return WORD_TERMS.some((t) => words.includes(t));
}
