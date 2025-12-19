// playoffs_bracket.js
// -----------------------------------------------------------------------------
// Winners bracket renderer for the Season tab.
// Mount: #playoff-bracket-root (recommended). If missing, it will create one
// under #season-overview-root.
//
// Data: prefers bundle.winnersBracket (from your SleeperClient bundle)
// Fallback: fetch /winners_bracket via league id.
//
// Listens for: "playoffhub:bundle" { detail: { bundle, week } }
// -----------------------------------------------------------------------------

(function () {
  "use strict";

  const AVATAR_BASE = "https://sleepercdn.com/avatars/";

  function escapeHtml(str) {
    const s = String(str == null ? "" : str);
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function getMount() {
    let root = document.getElementById("playoff-bracket-root");
    if (root) return root;

    const seasonRoot = document.getElementById("season-overview-root");
    if (!seasonRoot) return null;

    const section = document.createElement("section");
    section.innerHTML = `
      <h3 class="season-subheading">Playoff Bracket</h3>
      <div id="playoff-bracket-root" class="season-standings-container">
        <p class="small">Loading bracket…</p>
      </div>
    `;
    seasonRoot.appendChild(section);
    return document.getElementById("playoff-bracket-root");
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

  async function fetchBracketFallback(leagueId) {
    const base = "https://api.sleeper.app/v1/league/" + leagueId;
    const [rosters, users, winnersBracket] = await Promise.all([
      fetchJson(base + "/rosters"),
      fetchJson(base + "/users"),
      fetchJson(base + "/winners_bracket"),
    ]);
    return { rosters, users, winnersBracket };
  }

  function buildUserById(users) {
    const map = {};
    (users || []).forEach((u) => u?.user_id && (map[u.user_id] = u));
    return map;
  }

  function seedMapFromRosters(rosters) {
    const sorted = [...(rosters || [])].sort((a, b) => {
      const aw = Number(a?.settings?.wins || 0);
      const bw = Number(b?.settings?.wins || 0);
      if (aw !== bw) return bw - aw;
      const apf = Number(a?.settings?.fpts || 0) + Number(a?.settings?.fpts_decimal || 0) / 100;
      const bpf = Number(b?.settings?.fpts || 0) + Number(b?.settings?.fpts_decimal || 0) / 100;
      return bpf - apf;
    });
    const out = {};
    sorted.forEach((r, idx) => (out[r.roster_id] = idx + 1));
    return out;
  }

  function rosterMap(rosters, users) {
    const uBy = buildUserById(users);
    const seeds = seedMapFromRosters(rosters);
    const map = {};

    (rosters || []).forEach((r) => {
      const u = uBy[r.owner_id];
      const metaName =
        (u && u.metadata && (u.metadata.team_name || u.metadata.team_name_update)) || "";
      const name = metaName || (u && (u.display_name || u.username)) || `Team ${r.roster_id}`;
      map[r.roster_id] = {
        name,
        seed: seeds[r.roster_id] || null,
        avatar: (u && u.avatar) || null,
      };
    });

    return map;
  }

  function avatarHtml(avatarId, alt) {
    if (!avatarId) return "";
    const src = AVATAR_BASE + encodeURIComponent(avatarId);
    return `<img class="team-avatar" src="${escapeHtml(src)}" alt="${escapeHtml(alt || "")}">`;
  }

  function roundLabel(r, maxR) {
    if (maxR >= 3) {
      if (r === 1) return "Quarterfinals";
      if (r === 2) return "Semifinals";
      if (r === 3) return "Championship";
    }
    if (maxR === 2) {
      if (r === 1) return "Semifinals";
      if (r === 2) return "Championship";
    }
    return `Round ${r}`;
  }

  function describeSide(match, key, fromKey, rm, matchesById) {
    const val = match[key];

    if (typeof val === "number" && rm[val]) {
      const t = rm[val];
      const seedPrefix = t.seed ? `#${t.seed} · ` : "";
      return { type: "team", rosterId: val, label: `${seedPrefix}${t.name}`, meta: t };
    }

    const from = match[fromKey];
    if (from && (from.w != null || from.l != null)) {
      const ref = from.w ?? from.l;
      const prefix = from.w != null ? "Winner of" : "Loser of";
      const refMatch = matchesById[ref];
      const refText = refMatch ? `R${refMatch.r} M${refMatch.m}` : `Match ${ref}`;
      return { type: "tbd", label: `${prefix} ${refText}`, meta: null };
    }

    return { type: "tbd", label: "TBD", meta: null };
  }

  function render(root, winnersBracket, rm) {
    if (!Array.isArray(winnersBracket) || winnersBracket.length === 0) {
      root.innerHTML = `<p class="small">Bracket not available yet.</p>`;
      return;
    }
  
    const byRound = new Map();
    winnersBracket.forEach((m) => {
      if (!byRound.has(m.r)) byRound.set(m.r, []);
      byRound.get(m.r).push(m);
    });
  
    const rounds = [...byRound.keys()].sort((a, b) => a - b);
    const maxR = rounds[rounds.length - 1] || 1;
  
    const roundName = (r) => {
      if (maxR >= 3) {
        if (r === 1) return "Quarterfinals";
        if (r === 2) return "Semifinals";
        if (r === 3) return "Championship";
      }
      if (maxR === 2) {
        if (r === 1) return "Semifinals";
        if (r === 2) return "Championship";
      }
      return `Round ${r}`;
    };
  
    const getSide = (m, key, fromKey) => {
      const val = m[key];
      if (typeof val === "number" && rm[val]) {
        const t = rm[val];
        return {
          name: `#${t.seed} ${t.name}`,
          avatar: t.avatar,
        };
      }
      const from = m[fromKey];
      if (from && (from.w || from.l)) {
        const ref = from.w ?? from.l;
        const label = from.w ? `Winner of M${ref}` : `Loser of M${ref}`;
        return { name: label, avatar: null };
      }
      return { name: "TBD", avatar: null };
    };
  
    const roundsHtml = rounds
      .map((r) => {
        const matches = byRound.get(r) || [];
        const title = roundName(r);
        const matchHtml = matches
          .map((m) => {
            const a = getSide(m, "t1", "t1_from");
            const b = getSide(m, "t2", "t2_from");
            return `
              <div class="match-box">
                <div class="team">
                  ${a.avatar ? `<img src="https://sleepercdn.com/avatars/${a.avatar}">` : ""}
                  <span>${escapeHtml(a.name)}</span>
                </div>
                <div class="meta">vs</div>
                <div class="team">
                  ${b.avatar ? `<img src="https://sleepercdn.com/avatars/${b.avatar}">` : ""}
                  <span>${escapeHtml(b.name)}</span>
                </div>
              </div>
            `;
          })
          .join("");
        return `<div class="bracket-round"><h4>${escapeHtml(title)}</h4>${matchHtml}</div>`;
      })
      .join("");
  
    root.innerHTML = `<div class="bracket-wrapper">${roundsHtml}</div>`;
  }
  

  async function renderFromBundle(bundle) {
    const root = getMount();
    if (!root) return;

    root.innerHTML = `<p class="small">Loading bracket…</p>`;

    try {
      const cfg = window.LEAGUE_CONFIG || {};
      const leagueId = cfg.LEAGUE_ID || null;

      let rosters = bundle?.rosters || null;
      let users = bundle?.users || null;
      let winnersBracket = bundle?.winnersBracket || bundle?.winners_bracket || null;

      if (!Array.isArray(winnersBracket) || !winnersBracket.length) {
        if (leagueId) {
          const fetched = await fetchBracketFallback(leagueId);
          rosters = fetched.rosters;
          users = fetched.users;
          winnersBracket = fetched.winnersBracket;
        }
      }

      const rm = rosterMap(rosters || [], users || []);
      render(root, winnersBracket || [], rm);
      console.log("[PlayoffsBracket] Rendered", { matches: Array.isArray(winnersBracket) ? winnersBracket.length : 0 });
    } catch (err) {
      console.error("[PlayoffsBracket] Failed:", err);
      root.innerHTML = `<p class="small">Unable to load bracket right now.</p>`;
    }
  }

  window.PlayoffsBracket = { renderFromBundle };

  window.addEventListener("playoffhub:bundle", (e) => {
    const b = e?.detail?.bundle;
    if (b) renderFromBundle(b);
  });
})();
