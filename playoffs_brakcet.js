// playoffs_bracket.js
// -----------------------------------------------------------------------------
// Simple winners-bracket visualizer for 6-team playoffs.
//
// - Fetches rosters + users for team names
// - Fetches /winners_bracket from Sleeper
// - Groups by round (r) and renders a 3-column bracket
//
// Depends on: window.LEAGUE_CONFIG.LEAGUE_ID, LEAGUE_CONFIG.PLAYOFFS
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    const cfg = window.LEAGUE_CONFIG || {};
    const playoffsCfg = cfg.PLAYOFFS || {};
    const LEAGUE_ID = cfg.LEAGUE_ID;
  
    if (!LEAGUE_ID || !playoffsCfg.enabled) {
      console.warn("[playoffs_bracket] League ID or PLAYOFFS config missing.");
      return;
    }
  
    // ------------------------------------------------------------
    // Sleeper helpers (standalone, no need to touch sleeper_client.js)
    // ------------------------------------------------------------
  
    async function fetchJson(url) {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return res.json();
    }
  
    async function loadLeagueMeta() {
      const base = "https://api.sleeper.app/v1/league/" + LEAGUE_ID;
      const [rosters, users, winnersBracket] = await Promise.all([
        fetchJson(base + "/rosters"),
        fetchJson(base + "/users"),
        fetchJson(base + "/winners_bracket"),
      ]);
  
      return { rosters, users, winnersBracket };
    }
  
    // Map roster_id → display name + seed
    function buildRosterMap(rosters, users) {
      const userById = {};
      (users || []).forEach((u) => {
        userById[u.user_id] = u;
      });
  
      // Seed approximation: sort by wins, then PF (like Sleeper standings)
      const sorted = [...(rosters || [])].sort((a, b) => {
        const aw = a.settings?.wins ?? 0;
        const bw = b.settings?.wins ?? 0;
        if (aw !== bw) return bw - aw;
  
        const apf = (a.settings?.fpts ?? 0) + (a.settings?.fpts_decimal ?? 0) / 100;
        const bpf = (b.settings?.fpts ?? 0) + (b.settings?.fpts_decimal ?? 0) / 100;
        return bpf - apf;
      });
  
      const seedByRosterId = {};
      sorted.forEach((r, idx) => {
        seedByRosterId[r.roster_id] = idx + 1;
      });
  
      const map = {};
      (rosters || []).forEach((r) => {
        const u = userById[r.owner_id];
        const teamName =
          (u && (u.metadata?.team_name || u.display_name || u.username)) ||
          `Team ${r.roster_id}`;
        map[r.roster_id] = {
          name: teamName,
          seed: seedByRosterId[r.roster_id] || null,
        };
      });
  
      return map;
    }
  
    // ------------------------------------------------------------
    // Rendering helpers
    // ------------------------------------------------------------
  
    function roundMeta(r) {
      const info = playoffsCfg.rounds && playoffsCfg.rounds[r];
      if (!info) {
        return { label: `Round ${r}`, week: null };
      }
      return info;
    }
  
    function describeSide(match, sideKey, fromKey, rosterMap, allMatchesById) {
      const val = match[sideKey];
  
      // Direct roster_id
      if (typeof val === "number" && rosterMap[val]) {
        const t = rosterMap[val];
        const seedPrefix = t.seed ? `#${t.seed} · ` : "";
        return {
          type: "team",
          roster_id: val,
          name: t.name,
          seed: t.seed,
          label: `${seedPrefix}${t.name}`,
        };
      }
  
      // Comes from another match (winner/loser)
      const from = match[fromKey];
      if (from && (from.w != null || from.l != null)) {
        const refMatchId = from.w ?? from.l;
        const refMatch = allMatchesById[refMatchId];
        const refRound = refMatch ? refMatch.r : null;
        const refLabel = refRound
          ? `${roundMeta(refRound).label} M${refMatchId}`
          : `Match ${refMatchId}`;
        const prefix = from.w != null ? "Winner of" : "Loser of";
        return {
          type: "tbd",
          label: `${prefix} ${refLabel}`,
        };
      }
  
      // Completely TBD (pre-playoffs)
      return {
        type: "tbd",
        label: "TBD",
      };
    }
  
    function isWinner(match, rosterId) {
      return match.w != null && match.w === rosterId;
    }
  
    function isLoser(match, rosterId) {
      return match.l != null && match.l === rosterId;
    }
  
    function renderBracket(rootEl, winnersBracket, rosterMap) {
      if (!Array.isArray(winnersBracket) || !winnersBracket.length) {
        rootEl.innerHTML =
          "<p class='small'>Playoff bracket is not configured or not available yet.</p>";
        return;
      }
  
      const matchesByRound = new Map();
      const matchesById = {};
  
      winnersBracket.forEach((m) => {
        matchesById[m.m] = m;
        if (!matchesByRound.has(m.r)) matchesByRound.set(m.r, []);
        matchesByRound.get(m.r).push(m);
      });
  
      // Sort rounds ascending (1 → 2 → 3)
      const sortedRounds = [...matchesByRound.keys()].sort((a, b) => a - b);
  
      const columnsHtml = sortedRounds
        .map((r) => {
          const roundMatches = matchesByRound.get(r) || [];
          const meta = roundMeta(r);
          const titleBits = [meta.label];
          if (meta.week) titleBits.push(`Week ${meta.week}`);
  
          const matchesHtml = roundMatches
            .map((match) => {
              const left = describeSide(
                match,
                "t1",
                "t1_from",
                rosterMap,
                matchesById
              );
              const right = describeSide(
                match,
                "t2",
                "t2_from",
                rosterMap,
                matchesById
              );
  
              const leftClasses = ["bracket-team-name"];
              const rightClasses = ["bracket-team-name"];
  
              if (left.type === "team") {
                if (isWinner(match, left.roster_id)) leftClasses.push("winner");
                if (isLoser(match, left.roster_id)) leftClasses.push("loser");
              } else {
                leftClasses.push("bye");
              }
  
              if (right.type === "team") {
                if (isWinner(match, right.roster_id)) rightClasses.push("winner");
                if (isLoser(match, right.roster_id)) rightClasses.push("loser");
              } else {
                rightClasses.push("bye");
              }
  
              const leftMeta =
                left.type === "team" && left.seed
                  ? `Seed ${left.seed}`
                  : left.type === "tbd"
                  ? "TBD"
                  : "";
              const rightMeta =
                right.type === "team" && right.seed
                  ? `Seed ${right.seed}`
                  : right.type === "tbd"
                  ? "TBD"
                  : "";
  
              return `
                <div class="bracket-matchup">
                  <div class="bracket-matchup-header">
                    <div class="bracket-matchup-label">Match ${match.m}</div>
                    ${
                      meta.week
                        ? `<div class="bracket-matchup-week">Week ${meta.week}</div>`
                        : ""
                    }
                  </div>
                  <div class="bracket-team-slot">
                    <span class="${leftClasses.join(" ")}">${left.label}</span>
                    <span class="bracket-team-meta">${leftMeta}</span>
                  </div>
                  <div class="bracket-team-slot">
                    <span class="${rightClasses.join(" ")}">${right.label}</span>
                    <span class="bracket-team-meta">${rightMeta}</span>
                  </div>
                </div>
              `;
            })
            .join("");
  
          return `
            <div class="bracket-round-column">
              <div class="bracket-round-title">
                ${titleBits.join(" · ")}
              </div>
              ${matchesHtml || "<p class='small'>No matchups in this round.</p>"}
            </div>
          `;
        })
        .join("");
  
      rootEl.innerHTML = columnsHtml;
    }
  
    // ------------------------------------------------------------
    // Bootstrap on DOM ready
    // ------------------------------------------------------------
  
    document.addEventListener("DOMContentLoaded", () => {
      const root = document.getElementById("playoff-bracket-root");
      if (!root) return;
  
      loadLeagueMeta()
        .then(({ rosters, users, winnersBracket }) => {
          const rosterMap = buildRosterMap(rosters, users);
          renderBracket(root, winnersBracket, rosterMap);
        })
        .catch((err) => {
          console.error("[playoffs_bracket] Failed to load bracket:", err);
          root.innerHTML =
            "<p class='small'>Unable to load playoff bracket right now.</p>";
        });
    });
  })();
  