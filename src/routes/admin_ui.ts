import { Hono } from "hono";
import type { Env } from "../types.js";
import { requireOperator } from "../middleware/access.js";

// The operator-facing admin page. One self-contained HTML document served
// straight from the Worker — no assets binding, no build step, one deploy
// artifact. It talks only to /admin/api/* (same origin), so the Cloudflare
// Access cookie authenticates every call and no secret is ever handled by the
// browser.
//
// Built for a phone: moderation is reactive, and the report that arrives while
// you are away from a desk is the one that otherwise waits a week.

const app = new Hono<{ Bindings: Env }>();

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>LoRa Admin</title>
<style>
  :root {
    --bg: #14181c; --panel: #1c2228; --line: #2b343d; --ink: #d8e0e6;
    --dim: #8b98a5; --accent: #7fb2d9; --warn: #d9a441; --bad: #d96b6b; --ok: #6fbf8b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 0 0 env(safe-area-inset-bottom);
  }
  header {
    position: sticky; top: 0; z-index: 5; background: var(--bg);
    border-bottom: 1px solid var(--line); padding: 12px 14px 0;
  }
  h1 { font-size: 15px; margin: 0 0 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--dim); font-weight: 600; }
  nav { display: flex; gap: 4px; }
  nav button {
    flex: 1; background: none; border: 0; border-bottom: 2px solid transparent;
    color: var(--dim); padding: 9px 4px 10px; font: inherit; font-size: 14px; cursor: pointer;
  }
  nav button[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); }
  main { padding: 14px; max-width: 720px; margin: 0 auto; }
  section[hidden] { display: none; }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    padding: 12px; margin-bottom: 10px;
  }
  .card h2 { font-size: 15px; margin: 0 0 2px; font-weight: 600; }
  .muted { color: var(--dim); font-size: 13px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
  ul.reasons { margin: 8px 0 10px; padding-left: 18px; color: var(--warn); font-size: 13px; }
  ul.reasons li { margin: 2px 0; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row + .row { margin-top: 8px; }
  input[type=text] {
    flex: 1 1 140px; min-width: 0; background: var(--bg); color: var(--ink);
    border: 1px solid var(--line); border-radius: 6px; padding: 9px 10px; font: inherit; font-size: 14px;
  }
  button.act {
    background: var(--bg); color: var(--ink); border: 1px solid var(--line);
    border-radius: 6px; padding: 9px 13px; font: inherit; font-size: 14px; cursor: pointer;
    min-height: 38px;
  }
  button.act:hover { border-color: var(--accent); }
  button.act[disabled] { opacity: .5; cursor: default; }
  button.danger { color: var(--bad); border-color: #4a2f2f; }
  button.primary { color: var(--accent); border-color: #2f4356; }
  .tag {
    display: inline-block; font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
    padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--dim);
  }
  .tag.frozen { color: var(--bad); border-color: #4a2f2f; }
  .tag.censored { color: var(--warn); border-color: #4a3f2a; }
  /* Fixed overlay, not in flow: an in-flow banner that auto-dismisses shifts
     every control up under the operator's finger mid-tap — a good way to hit
     Freeze when you meant Censor. */
  #msg { position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; padding: 0 14px 14px; pointer-events: none; }
  #msg:empty { display: none; }
  .note {
    max-width: 720px; margin: 0 auto; padding: 11px 13px; border-radius: 8px; font-size: 14px;
    border: 1px solid var(--line); box-shadow: 0 6px 20px rgba(0, 0, 0, .45);
  }
  .note.err { background: #2a1d1d; color: #e3a0a0; border-color: #4a2f2f; }
  .note.ok { background: #1d2a22; color: var(--ok); border-color: #2c4436; }
  .empty { color: var(--dim); text-align: center; padding: 26px 10px; }
  .bar { margin-bottom: 12px; }
  .seg { display: flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  .seg button {
    background: var(--panel); color: var(--dim); border: 0; padding: 9px 14px;
    font: inherit; font-size: 14px; cursor: pointer; min-height: 38px;
  }
  .seg button + button { border-left: 1px solid var(--line); }
  .seg button[aria-selected="true"] { background: #24303b; color: var(--accent); }
  .check { display: flex; align-items: center; gap: 7px; color: var(--dim); font-size: 14px; cursor: pointer; }
  .check input { width: 17px; height: 17px; accent-color: var(--accent); }
  /* Freeze is narrower than the word suggests; say so where the button is. */
  .explain {
    color: var(--dim); font-size: 12.5px; line-height: 1.4; margin-top: 8px;
    padding-left: 10px; border-left: 2px solid var(--line);
  }
  .card.dim { opacity: .62; }
  details.help {
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    padding: 10px 12px; margin-bottom: 12px; font-size: 13px; color: var(--dim);
  }
  details.help summary { cursor: pointer; color: var(--accent); font-size: 14px; }
  details.help p { margin: 10px 0 0; line-height: 1.5; }
  details.help strong { color: var(--ink); }
  hr { border: 0; border-top: 1px solid var(--line); margin: 10px 0; }
  pre { white-space: pre-wrap; word-break: break-all; font-size: 12px; color: var(--dim); margin: 0; }
  .meter-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
  .meter-head .pct { font-size: 20px; font-weight: 600; }
  .meter { height: 10px; border-radius: 999px; background: var(--bg); border: 1px solid var(--line); overflow: hidden; }
  .meter > span { display: block; height: 100%; background: var(--ok); transition: width .3s; }
  .meter.warn > span { background: var(--warn); }
  .meter.bad > span { background: var(--bad); }
  .meter-foot { color: var(--dim); font-size: 12.5px; margin-top: 6px; }
</style>
</head>
<body>
<header>
  <h1>LoRa Admin</h1>
  <nav>
    <button data-tab="flags" aria-selected="true">Flags</button>
    <button data-tab="names" aria-selected="false">Names</button>
    <button data-tab="player" aria-selected="false">Player</button>
    <button data-tab="usage" aria-selected="false">Usage</button>
  </nav>
</header>
<main>
  <section id="tab-flags">
    <details class="help">
      <summary>What do Freeze and Dismiss do?</summary>
      <p><strong>Freeze</strong> blocks a player's multiplayer writes — no surveys, raids, or purchases
      reach the server. Their own game keeps working offline, and posts, renown, items and history are
      all preserved untouched. Fully reversible: unfreezing restores everything.</p>
      <p><strong>Dismiss</strong> hides a player once you've judged them fine. They come back on their
      own if a <em>new kind</em> of finding appears — dismissing one thing never mutes the next.
      Nothing is deleted, and "Show dismissed" brings them all back into view.</p>
    </details>
    <div class="row bar">
      <label class="check"><input type="checkbox" id="show-dismissed"> Show dismissed</label>
    </div>
    <div id="flags-out"></div>
  </section>
  <section id="tab-names" hidden>
    <div class="row bar">
      <div class="seg">
        <button data-nfilter="all" aria-selected="true">All</button>
        <button data-nfilter="player" aria-selected="false">Players</button>
        <button data-nfilter="post" aria-selected="false">Posts</button>
      </div>
      <input type="text" id="nsearch" placeholder="filter by name…" autocapitalize="off" spellcheck="false">
    </div>
    <div id="names-out"></div>
  </section>
  <section id="tab-player" hidden>
    <div class="card">
      <div class="row">
        <input type="text" id="pid" placeholder="player name or id" autocapitalize="off" autocorrect="off" spellcheck="false">
        <button class="act primary" id="pid-go">Look up</button>
      </div>
    </div>
    <div id="player-out"></div>
  </section>
  <section id="tab-usage" hidden>
    <div id="usage-out"></div>
  </section>
</main>
<div id="msg" role="status" aria-live="polite"></div>
<script>
(function () {
  var msg = document.getElementById("msg");
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  function note(text, kind) {
    msg.innerHTML = '<div class="note ' + (kind || "ok") + '">' + esc(text) + "</div>";
    if (kind !== "err") setTimeout(function () { msg.innerHTML = ""; }, 4000);
  }
  function api(path, opts) {
    return fetch("/admin/api" + path, Object.assign({ credentials: "same-origin" }, opts || {}))
      .then(function (r) {
        // An expired Access session redirects to the login page; the fetch then
        // lands on HTML instead of JSON. Say so plainly rather than throwing a
        // parse error at the operator.
        if (r.status === 403 || r.status === 401) throw new Error("Session expired — reload the page to sign in again.");
        return r.json().catch(function () { throw new Error("Unexpected response — reload the page."); });
      })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || "Request failed");
        return d;
      });
  }
  function fail(e) { note(e.message || String(e), "err"); }

  // --- tabs ---------------------------------------------------------------
  var loaders = {};
  Array.prototype.forEach.call(document.querySelectorAll("nav button"), function (b) {
    b.addEventListener("click", function () {
      var tab = b.dataset.tab;
      Array.prototype.forEach.call(document.querySelectorAll("nav button"), function (o) {
        o.setAttribute("aria-selected", String(o === b));
      });
      ["flags", "names", "player", "usage"].forEach(function (t) {
        document.getElementById("tab-" + t).hidden = t !== tab;
      });
      msg.innerHTML = "";
      if (loaders[tab]) loaders[tab]();
    });
  });

  function freezeBtn(pid, frozen) {
    return '<button class="act ' + (frozen ? "" : "danger") + '" data-freeze="' + esc(pid) +
      '" data-to="' + (frozen ? "0" : "1") + '">' + (frozen ? "Unfreeze" : "Freeze") + "</button>";
  }

  // --- flags --------------------------------------------------------------
  var flagsEl = document.getElementById("flags-out");
  var showDismissed = document.getElementById("show-dismissed");
  function renderFlags(d) {
    var hiddenNote = d.dismissed && !showDismissed.checked
      ? " " + esc(d.dismissed) + " dismissed and hidden."
      : "";
    if (!d.flagged.length) {
      flagsEl.innerHTML = '<div class="empty">Nothing flagged.<br><span class="muted">' +
        esc(d.checked) + " players checked." + hiddenNote + "</span></div>";
      return;
    }
    flagsEl.innerHTML = '<p class="muted">' + esc(d.flagged.length) + " shown of " +
      esc(d.checked) + " checked." + hiddenNote +
      (d.truncated ? '<br><span style="color:var(--warn)">' + esc(d.total) +
        " players flagged — showing the " + esc(d.flagged.length) +
        " most significant. Clear some findings to see the rest.</span>" : "") + "</p>" +
      d.flagged.map(function (p) {
        return '<div class="card' + (p.dismissed ? " dim" : "") + '">' +
          "<h2>" + esc(p.display_name) +
            (p.frozen ? ' <span class="tag frozen">frozen</span>' : "") +
            (p.dismissed ? ' <span class="tag">dismissed</span>' : "") + "</h2>" +
          '<div class="mono muted">' + esc(p.player_id) + "</div>" +
          '<ul class="reasons">' + p.reasons.map(function (r) {
            return "<li>" + esc(r.text) + "</li>";
          }).join("") + "</ul>" +
          '<div class="muted">' + esc(p.renown_per_day.toFixed ? p.renown_per_day.toFixed(1) : p.renown_per_day) +
            " renown/day · " + esc(p.audit_rejects) + " rejects</div>" +
          '<div class="row" style="margin-top:10px">' +
            freezeBtn(p.player_id, p.frozen) +
            (p.dismissed
              ? '<button class="act" data-undismiss="' + esc(p.player_id) + '">Restore to list</button>'
              : '<button class="act" data-dismiss="' + esc(p.player_id) + '">Dismiss</button>') +
          "</div></div>";
      }).join("");
  }
  loaders.flags = function () {
    flagsEl.innerHTML = '<div class="empty">Loading…</div>';
    api("/flags" + (showDismissed.checked ? "?include_dismissed=1" : ""))
      .then(renderFlags).catch(function (e) { flagsEl.innerHTML = ""; fail(e); });
  };
  showDismissed.addEventListener("change", function () { loaders.flags(); });
  flagsEl.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-freeze]");
    if (b) {
      var to = b.dataset.to === "1";
      b.disabled = true;
      api("/freeze/" + encodeURIComponent(b.dataset.freeze), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ frozen: to }),
      }).then(function () {
        note(to ? "Player frozen — multiplayer writes blocked, nothing lost." : "Player unfrozen.");
        loaders.flags();
      }).catch(function (e) { b.disabled = false; fail(e); });
      return;
    }
    var d = ev.target.closest("[data-dismiss]");
    if (d) {
      d.disabled = true;
      api("/flags/dismiss/" + encodeURIComponent(d.dataset.dismiss), { method: "POST" })
        .then(function () { note("Dismissed — returns if something new appears."); loaders.flags(); })
        .catch(function (e) { d.disabled = false; fail(e); });
      return;
    }
    var u = ev.target.closest("[data-undismiss]");
    if (u) {
      u.disabled = true;
      api("/flags/dismiss/" + encodeURIComponent(u.dataset.undismiss), { method: "DELETE" })
        .then(function () { note("Restored to the list."); loaders.flags(); })
        .catch(function (e) { u.disabled = false; fail(e); });
    }
  });

  // --- names --------------------------------------------------------------
  var namesEl = document.getElementById("names-out");
  function nameRow(kind, pid, hex, raw, pub, override) {
    var censored = override !== null && override !== undefined;
    return '<div class="row" data-kind="' + kind + '" data-pid="' + esc(pid) + '"' +
        (hex ? ' data-hex="' + esc(hex) + '"' : "") + ">" +
      '<div style="flex:1 1 100%">' +
        (kind === "post" ? '<span class="muted mono">' + esc(hex) + "</span> " : "") +
        esc(raw || "(unnamed)") +
        (censored ? ' <span class="tag censored">shown as ' + esc(pub || "—") + "</span>" : "") +
      "</div>" +
      '<input type="text" placeholder="replacement (blank = hide)" value="' + esc(censored ? override : "") + '">' +
      '<button class="act" data-censor>Censor</button>' +
      (censored ? '<button class="act" data-clear>Clear</button>' : "") +
      "</div>";
  }
  // Post names outnumber player names roughly 3:1, so the tab is unusable at any
  // size without a way to narrow it. Filtering runs on the SERVER: at a few
  // hundred players, shipping every name to the phone to filter it here means
  // sending thousands of rows to display a handful. Keystrokes are debounced so
  // typing costs one request, not one per character.
  var nameFilter = "all";
  var nsearch = document.getElementById("nsearch");
  var nameTimer = null;

  function renderNames(d) {
    if (!d.players.length) {
      namesEl.innerHTML = '<div class="empty">No names match.<br><span class="muted">' +
        "Try a different filter or search.</span></div>";
      return;
    }
    var cards = d.players.map(function (p) {
      return '<div class="card">' +
        "<h2>" + esc(p.display_name) + "</h2>" +
        '<div class="mono muted">' + esc(p.player_id) + "</div><hr>" +
        (p.include_player ? nameRow("player", p.player_id, null, p.display_name, p.display_name_public, p.player_override) : "") +
        (p.include_player && p.posts.length ? "<hr>" : "") +
        p.posts.map(function (r) {
          return nameRow("post", p.player_id, r.post_token, r.name, r.name_public, r.override);
        }).join("") +
        "</div>";
    }).join("");

    namesEl.innerHTML = '<p class="muted">' + esc(d.shown) + " name" + (d.shown === 1 ? "" : "s") +
      " shown" + (d.truncated ? " of " + esc(d.total) + " matching" : "") + "." +
      (d.truncated ? '<br><span style="color:var(--warn)">Search to narrow it down.</span>' : "") +
      "</p>" + cards;
  }

  loaders.names = function () {
    namesEl.innerHTML = '<div class="empty">Loading…</div>';
    var qs = "?type=" + encodeURIComponent(nameFilter) + "&q=" + encodeURIComponent(nsearch.value.trim());
    api("/names" + qs)
      .then(renderNames)
      .catch(function (e) { namesEl.innerHTML = ""; fail(e); });
  };
  nsearch.addEventListener("input", function () {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(loaders.names, 250);
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-nfilter]"), function (b) {
    b.addEventListener("click", function () {
      nameFilter = b.dataset.nfilter;
      Array.prototype.forEach.call(document.querySelectorAll("[data-nfilter]"), function (o) {
        o.setAttribute("aria-selected", String(o === b));
      });
      loaders.names();
    });
  });
  namesEl.addEventListener("click", function (ev) {
    var row = ev.target.closest("[data-kind]");
    if (!row) return;
    var kind = row.dataset.kind, pid = row.dataset.pid, hex = row.dataset.hex;
    if (ev.target.closest("[data-censor]")) {
      var val = row.querySelector("input").value;
      api("/censor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: kind, player_id: pid, post_token: hex, replacement: val }),
      }).then(function () { note("Name censored."); loaders.names(); }).catch(fail);
    } else if (ev.target.closest("[data-clear]")) {
      var qs = "?type=" + kind + "&player_id=" + encodeURIComponent(pid) + (hex ? "&post_token=" + encodeURIComponent(hex) : "");
      api("/censor" + qs, { method: "DELETE" })
        .then(function () { note("Override cleared."); loaders.names(); }).catch(fail);
    }
  });

  // --- player -------------------------------------------------------------
  var outEl = document.getElementById("player-out");

  // Accepts a display name or an id. Names aren't unique, so several matches
  // means showing them and letting the operator pick — never guessing, since
  // the actions on the next screen include deleting the wrong person.
  function lookup() {
    var q = document.getElementById("pid").value.trim();
    if (!q) return;
    outEl.innerHTML = '<div class="empty">Searching…</div>';
    api("/players/search?q=" + encodeURIComponent(q)).then(function (d) {
      if (!d.matches.length) {
        outEl.innerHTML = '<div class="empty">No player matches “' + esc(q) + '”.</div>';
        return;
      }
      if (d.matches.length === 1) { showPlayer(d.matches[0].player_id); return; }
      var exact = d.matches.filter(function (m) { return m.exact; });
      if (exact.length === 1) { showPlayer(exact[0].player_id); return; }
      outEl.innerHTML = '<p class="muted">' +
        (d.truncated
          ? esc(d.total) + " players match — showing the first " + esc(d.matches.length) +
            '. <span style="color:var(--warn)">Narrow the search, or paste a player id.</span>'
          : esc(d.matches.length) + " players match — pick one:") + "</p>" +
        d.matches.map(function (m) {
          return '<div class="card"><div class="row">' +
            '<div style="flex:1 1 100%">' + esc(m.display_name) +
              (m.frozen ? ' <span class="tag frozen">frozen</span>' : "") +
              '<br><span class="mono muted">' + esc(m.player_id) + "</span>" +
              '<br><span class="muted">' + esc(m.post_count) + " posts</span></div>" +
            '<button class="act primary" data-pick="' + esc(m.player_id) + '">Open</button>' +
          "</div></div>";
        }).join("");
    }).catch(function (e) { outEl.innerHTML = ""; fail(e); });
  }

  function showPlayer(id) {
    outEl.innerHTML = '<div class="empty">Loading…</div>';
    api("/player/" + encodeURIComponent(id)).then(function (d) {
      var p = d.player;
      outEl.innerHTML = '<div class="card">' +
        "<h2>" + esc(p.display_name) + (p.frozen ? ' <span class="tag frozen">frozen</span>' : "") + "</h2>" +
        '<div class="mono muted">' + esc(p.player_id) + "</div>" +
        '<div class="muted" style="margin-top:6px">' + esc(p.post_summaries.length) + " posts · " +
          esc(p.items.length) + " items · registered " +
          esc(new Date(p.registered_at * 1000).toISOString().slice(0, 10)) + "</div>" +
        '<div class="row" style="margin-top:10px">' +
          '<button class="act" data-freeze-p data-to="' + (p.frozen ? "0" : "1") + '">' +
            (p.frozen ? "Unfreeze" : "Freeze") + "</button>" +
          '<button class="act danger" data-del>Delete player…</button>' +
        "</div>" +
        '<div class="explain"><strong>Freeze</strong> is reversible and loses nothing — it only ' +
          "blocks multiplayer writes. <strong>Delete</strong> permanently removes the profile, " +
          "defenses and leaderboard entry, and cannot be undone; it is for test data, not for " +
          "punishing a player." +
        "</div></div>" +
        '<div class="card"><pre>' + esc(JSON.stringify(d, null, 2)) + "</pre></div>";
      outEl.dataset.pid = p.player_id;
      outEl.dataset.name = p.display_name;
    }).catch(function (e) { outEl.innerHTML = ""; fail(e); });
  }
  document.getElementById("pid-go").addEventListener("click", lookup);
  document.getElementById("pid").addEventListener("keydown", function (e) { if (e.key === "Enter") lookup(); });
  outEl.addEventListener("click", function (ev) {
    var pick = ev.target.closest("[data-pick]");
    if (pick) { showPlayer(pick.dataset.pick); return; }
    var pid = outEl.dataset.pid;
    if (ev.target.closest("[data-freeze-p]")) {
      var to = ev.target.closest("[data-freeze-p]").dataset.to === "1";
      api("/freeze/" + encodeURIComponent(pid), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ frozen: to }),
      }).then(function () {
        note(to ? "Player frozen — multiplayer writes blocked, nothing lost." : "Player unfrozen.");
        showPlayer(pid);
      }).catch(fail);
    } else if (ev.target.closest("[data-del]")) {
      // Deletion is the one irreversible action here, so it costs a typed name.
      var typed = prompt('Permanently delete this player?\\n\\nType the display name to confirm:');
      if (typed === null) return;
      if (typed.trim() !== outEl.dataset.name) { note("Name did not match — nothing deleted.", "err"); return; }
      api("/player/" + encodeURIComponent(pid), { method: "DELETE" })
        .then(function () { outEl.innerHTML = ""; note("Player deleted."); }).catch(fail);
    }
  });

  // --- usage --------------------------------------------------------------
  var usageEl = document.getElementById("usage-out");
  function meter(title, m, foot) {
    var pct = m.fraction * 100;
    var cls = pct >= 90 ? "bad" : pct >= 70 ? "warn" : "";
    return '<div class="card">' +
      '<div class="meter-head"><h2>' + esc(title) + '</h2>' +
        '<span class="pct" style="color:var(--' + (cls || "ok") + ')">' + pct.toFixed(1) + "%</span></div>" +
      '<div class="meter ' + cls + '"><span style="width:' + Math.min(100, pct).toFixed(1) + '%"></span></div>' +
      '<div class="meter-foot">' + esc(m.requests.toLocaleString()) + " of " +
        esc(m.limit.toLocaleString()) + " requests today" + (foot ? " · " + esc(foot) : "") + "</div>" +
      "</div>";
  }
  function renderUsage(d) {
    if (!d.configured) {
      usageEl.innerHTML = '<div class="card"><h2>Not configured</h2>' +
        '<p class="muted">Live usage needs a read-only Cloudflare API token. Create one with ' +
        '<strong>Account Analytics: Read</strong>, then set both secrets and redeploy:</p>' +
        '<pre>wrangler secret put CF_ACCOUNT_ID\\nwrangler secret put CF_ANALYTICS_TOKEN</pre></div>';
      return;
    }
    usageEl.innerHTML =
      meter("Worker requests", d.workers, "free-tier daily cap") +
      meter("Durable Object requests", d.durableObjects,
        "the binding constraint · ~" + esc(d.freeTierPlayerCeiling) + " active players on free tier") +
      '<p class="muted">Since ' + esc(new Date(d.since).toUTCString()) + " (UTC day). " +
        "Percentages are of the free-tier daily ceiling.</p>";
  }
  loaders.usage = function () {
    usageEl.innerHTML = '<div class="empty">Loading…</div>';
    api("/usage").then(renderUsage).catch(function (e) { usageEl.innerHTML = ""; fail(e); });
  };

  loaders.flags();
})();
</script>
</body>
</html>`;

app.get("/admin", async (c) => {
  if (!(await requireOperator(c))) {
    return c.text("Forbidden", 403, { "content-type": "text/plain; charset=utf-8" });
  }
  return c.html(PAGE, 200, {
    // The page loads nothing off-origin; say so, and keep it out of caches and
    // out of any indexer that stumbles onto the path.
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
  });
});

export default app;
