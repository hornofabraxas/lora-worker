#!/usr/bin/env python3
"""Operator maintenance tool for the lora-worker war ledger.

Talks to the machine admin surface (``/api/admin/*``, gated by the
``x-admin-secret`` header). Standard library only — no dependencies.

The secret is read, in order, from:
  1. ``--secret VALUE``
  2. the ``ADMIN_SECRET`` environment variable
  3. the gitignored ``.admin_secret`` file at the repo root

Commands
--------
  list                 Print the current player roster (id, name).
  wipe                 Delete players. DRY-RUN by default — prints exactly what
                       would be deleted and stops. Pass --apply to actually
                       delete. Use --keep to preserve accounts by id or name.
  seed FILE.json       Create seed players from a JSON array (see seed_players.json).
                       DRY-RUN by default; --apply to write.

Examples
--------
  # See who's registered
  python scripts/admin_tool.py list

  # Preview a full wipe (deletes nothing)
  python scripts/admin_tool.py wipe

  # Actually wipe everyone EXCEPT one account, by name or id
  python scripts/admin_tool.py wipe --keep "Wandering Rhea" --apply

  # Preview seeding, then apply
  python scripts/admin_tool.py seed scripts/seed_players.json
  python scripts/admin_tool.py seed scripts/seed_players.json --apply
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_BASE = "https://lora.nukeradio.net"


def resolve_secret(cli_secret: str | None) -> str:
    if cli_secret:
        return cli_secret.strip()
    env = os.environ.get("ADMIN_SECRET")
    if env:
        return env.strip()
    # repo-root .admin_secret (this file lives in <repo>/scripts/)
    secret_file = Path(__file__).resolve().parent.parent / ".admin_secret"
    if secret_file.exists():
        return secret_file.read_text().strip()
    sys.exit(
        "No admin secret found. Pass --secret, set ADMIN_SECRET, "
        "or create .admin_secret at the repo root."
    )


def api(base: str, secret: str, method: str, path: str, body: dict | None = None) -> dict:
    url = base.rstrip("/") + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("x-admin-secret", secret)
    # Cloudflare bot protection 403s (error 1010) the default "Python-urllib" UA,
    # so present a plain, honest one.
    req.add_header("user-agent", "lora-admin-tool/1.0")
    if data is not None:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        sys.exit(f"HTTP {e.code} on {method} {path}: {detail}")
    except urllib.error.URLError as e:
        sys.exit(f"Network error on {method} {path}: {e.reason}")


def fetch_roster(base: str, secret: str) -> list[dict]:
    """Return [{player_id, display_name}]. Warns if truncated."""
    res = api(base, secret, "GET", "/api/admin/names?type=player")
    players = res.get("players", [])
    if res.get("truncated"):
        print(
            f"!! roster truncated at {res.get('shown')} of {res.get('total')} — "
            "the worker /names cap (REPORT_LIMIT=50) was hit. Re-run after the "
            "first wipe, or raise the cap, to be sure you've cleared everyone.",
            file=sys.stderr,
        )
    # NB: the /names endpoint returns no post rows under type=player, so we don't
    # try to show a post count here — it would always read 0 and mislead.
    return [
        {"player_id": p["player_id"], "display_name": p.get("display_name", "")}
        for p in players
        if p.get("include_player")
    ]


def cmd_list(args) -> None:
    secret = resolve_secret(args.secret)
    roster = fetch_roster(args.base, secret)
    if not roster:
        print("Roster is empty.")
        return
    print(f"{len(roster)} player(s):\n")
    for p in roster:
        print(f"  {p['player_id']}  {p['display_name']!r:34}")


def cmd_wipe(args) -> None:
    secret = resolve_secret(args.secret)
    keep = {k.lower() for k in (args.keep or [])}
    roster = fetch_roster(args.base, secret)

    to_delete, kept = [], []
    for p in roster:
        if p["player_id"].lower() in keep or p["display_name"].lower() in keep:
            kept.append(p)
        else:
            to_delete.append(p)

    if kept:
        print("KEEPING:")
        for p in kept:
            print(f"  {p['player_id']}  {p['display_name']!r}")
        print()

    if not to_delete:
        print("Nothing to delete.")
        return

    print(f"{'DELETING' if args.apply else 'WOULD DELETE'} {len(to_delete)} player(s):")
    for p in to_delete:
        print(f"  {p['player_id']}  {p['display_name']!r:34}")

    if not args.apply:
        print("\nDRY RUN — nothing was deleted. Re-run with --apply to erase these.")
        return

    print()
    for p in to_delete:
        res = api(args.base, secret, "DELETE", f"/api/admin/player/{p['player_id']}")
        ok = res.get("ok")
        print(f"  {'ok ' if ok else 'ERR'} deleted {p['player_id']} {p['display_name']!r}")
    print(f"\nDone. Erased {len(to_delete)} player(s).")


def cmd_seed(args) -> None:
    secret = resolve_secret(args.secret)
    seeds = json.loads(Path(args.file).read_text())
    if not isinstance(seeds, list):
        sys.exit("Seed file must be a JSON array of player objects.")

    print(f"{'SEEDING' if args.apply else 'WOULD SEED'} {len(seeds)} player(s):")
    for s in seeds:
        name = s.get("display_name", "?")
        title = s.get("active_title", "")
        posts = len(s.get("posts", []))
        print(f"  {name!r:34}  title={title!r:12}  posts={posts}")

    if not args.apply:
        print("\nDRY RUN — nothing was written. Re-run with --apply to create these.")
        return

    print()
    for s in seeds:
        res = api(args.base, secret, "POST", "/api/admin/seed-player", s)
        ok = res.get("ok")
        print(f"  {'ok ' if ok else 'ERR'} {s.get('display_name')!r} -> {res.get('player_id', res.get('error'))}")
    print(f"\nDone. Seeded {len(seeds)} player(s).")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default=DEFAULT_BASE, help=f"Worker base URL (default {DEFAULT_BASE})")
    ap.add_argument("--secret", help="Admin secret (else ADMIN_SECRET env, else .admin_secret file)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="Print the player roster").set_defaults(func=cmd_list)

    w = sub.add_parser("wipe", help="Delete players (dry-run unless --apply)")
    w.add_argument("--keep", action="append", metavar="ID_OR_NAME", help="Preserve this player (repeatable)")
    w.add_argument("--apply", action="store_true", help="Actually delete (default is dry-run)")
    w.set_defaults(func=cmd_wipe)

    s = sub.add_parser("seed", help="Create seed players from a JSON file (dry-run unless --apply)")
    s.add_argument("file", help="Path to a JSON array of seed-player objects")
    s.add_argument("--apply", action="store_true", help="Actually create (default is dry-run)")
    s.set_defaults(func=cmd_seed)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
