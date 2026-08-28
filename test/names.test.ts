import { describe, it, expect } from "vitest";
import { nameIsBlocked } from "../src/logic/names.js";

describe("nameIsBlocked", () => {
  it("blocks clear profanity, including separator and concatenation evasion", () => {
    for (const n of [
      "Fuck Palace",
      "fuckpalace",
      "f u c k",
      "f.u.c.k off",
      "SHIT show",
      "total bitch",
    ]) {
      expect(nameIsBlocked(n)).toBe(true);
    }
  });

  it("blocks whole-word ambiguous terms only as standalone words", () => {
    expect(nameIsBlocked("Anal Palace")).toBe(true);
    expect(nameIsBlocked("big ass")).toBe(true);
    expect(nameIsBlocked("Cock Fort")).toBe(true);
  });

  it("blocks the reviewed crude compounds and stems", () => {
    for (const n of [
      "Pussycat Palace", // 'pussy' is now substring
      "Dickhead Pussyhole", // the motivating example
      "Dickhead Manor", // compound with no 'pussy' to lean on
      "total asshole",
      "what a twat",
      "Moby Dick", // bare 'dick' now blocked as a whole word
      "Dick", // ...including a standalone handle
    ]) {
      expect(nameIsBlocked(n)).toBe(true);
    }
  });

  it("does not false-positive on innocent names that merely contain a fragment", () => {
    for (const n of [
      "Analysis Master",
      "Grand Bass Player",
      "First Class",
      "Assassin's Guild",
      "Cocoon Keeper",
      "Scunthorpe Rambler", // classic Scunthorpe problem — 'cunt' is word-mode
      "Document Reviewer", // contains 'cum'
      "Titan Surveyor", // contains 'tit'
      "Peacock Hollow", // 'cock' is word-mode, not substring
      "Cockpit Ridge",
      "Dickens Trading Post", // 'dick' is word-mode, so 'Dickens' passes
      "Dickinson Ridge",
    ]) {
      expect(nameIsBlocked(n)).toBe(false);
    }
  });

  it("does not block empty or ordinary names", () => {
    expect(nameIsBlocked("")).toBe(false);
    expect(nameIsBlocked("Wandering Rhea")).toBe(false);
  });
});
