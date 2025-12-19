// newsletter.js
// -----------------------------------------------------------------------------
// Wolk Dynasty – Playoff Hub bootstrap + newsletter rendering
//
// Supports:
//   - All matchups in a given week (reg season + playoffs)
//   - Historical weeks: show final scores only (no projections/sims)
//   - Future/current weeks: projections + Monte Carlo sims
//   - Season-average fallback projections
//   - Matchup Detail with Starters / All Players toggle (global scope)
//   - Optional Supabase-driven recap phrases via window.PhraseEngine
//   - Season overview (standings + simple metrics)
//
// NOTE: Newsletter charts removed from this file. League Pulse fills:
//   #pulse-title-odds, #pulse-alerts, #pulse-quick-table (if present).
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    // -----------------------
    // Small DOM helpers
    // -----------------------
  
    function $(selector, root) {
      if (root === void 0) root = document;
      return root.querySelector(selector);
    }
  
    function formatPercent(p, digits) {
      if (digits === void 0) digits = 1;
      if (!Number.isFinite(p)) return "–";
      return (p * 100).toFixed(digits) + "%";
    }
  
    function formatScore(x, digits) {
      if (digits === void 0) digits = 1;
      if (!Number.isFinite(x)) return "–";
      return x.toFixed(digits);
    }
  
    function formatRange(low, high, digits) {
      if (digits === void 0) digits = 1;
      if (!Number.isFinite(low) || !Number.isFinite(high)) return "–";
      return low.toFixed(digits) + " – " + high.toFixed(digits);
    }
  
    function formatSpread(muA, muB, nameA, nameB) {
      if (!Number.isFinite(muA) || !Number.isFinite(muB)) return "N/A";
      const diff = muA - muB;
      const abs = Math.abs(diff);
      if (abs < 0.25) return "Pick’em";
      const fav = diff > 0 ? nameA : nameB;
      return fav + " -" + abs.toFixed(1);
    }
  
    function formatTotal(muA, muB) {
      if (!Number.isFinite(muA) || !Number.isFinite(muB)) return "–";
      return (muA + muB).toFixed(1);
    }
  
    function probabilityToMoneyline(p) {
      if (!Number.isFinite(p) || p <= 0) return "N/A";
      if (p >= 0.999) return "-∞";
      if (p <= 0.5) {
        const odds = (1 - p) / p;
        const ml = Math.round(odds * 100);
        return "+" + ml;
      }
      const oddsFav = p / (1 - p);
      const mlFav = Math.round(100 / oddsFav);
      return "-" + mlFav;
    }
  
    function escapeHtml(str) {
      const s = String(str == null ? "" : str);
      return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }
  
    // -----------------------
    // Shared state
    // -----------------------
  
    let CURRENT_WEEK = null;
    let CURRENT_MATCHUP_ENTRIES = []; // [ { historical?, projectedMatchup?, teams? } ]
    let CURRENT_SEASON_AVG = {}; // { playerId -> avg }
    let CURRENT_SELECTED_MATCHUP_ID = null;
    let CURRENT_AVATAR_BY_ROSTER_ID = {};
    let CURRENT_RECORD_BY_ROSTER_ID = {};
    let CURRENT_MATCHUP_MODELS = [];


  
    // Optional: for semis detection (still used for tags/labels if you want)
    let SEMI_MATCHUP_ID_SET = null;
  
    // -----------------------
    // Detail scope (Starters / All)
    // -----------------------
  
    function getDetailScope() {
      // Preferred: global set by index.html toggle
      const s = window.__MATCHUP_DETAIL_SCOPE__;
      if (s === "all" || s === "starters") return s;
  
      // Fallback: data attribute on container
      const c = $("#matchup-detail-container");
      const attr = c && c.getAttribute("data-detail-scope");
      if (attr === "all" || attr === "starters") return attr;
  
      return "starters";
    }
  
    // Re-render current selection when toggle changes
    window.addEventListener("matchup-detail-scope", function () {
      if (CURRENT_SELECTED_MATCHUP_ID) {
        showDetailForMatchup(CURRENT_SELECTED_MATCHUP_ID, { fromScopeToggle: true });
      }
    });
  
    // -----------------------
    // Helpers: season averages & Last 5
    // -----------------------
  
    function computeSeasonAverages(bundle, throughWeek) {
      const matchupsByWeek = bundle.matchupsByWeek || {};
      const accum = {};
  
      Object.keys(matchupsByWeek).forEach((wkStr) => {
        const wk = Number(wkStr);
        if (!Number.isFinite(wk) || wk >= throughWeek) return;
  
        const weekMatchups = matchupsByWeek[wkStr] || [];
        weekMatchups.forEach((m) => {
          const playersPoints = m.players_points || {};
          Object.keys(playersPoints).forEach((pid) => {
            const val = Number(playersPoints[pid]);
            // treat obvious DNPs (0) as "no game"
            if (!Number.isFinite(val) || val <= 0) return;
            if (!accum[pid]) accum[pid] = { sum: 0, count: 0 };
            accum[pid].sum += val;
            accum[pid].count += 1;
          });
        });
      });
  
      const avg = {};
      Object.keys(accum).forEach((pid) => {
        const entry = accum[pid];
        if (entry.count > 0) avg[pid] = entry.sum / entry.count;
      });
  
      return avg;
    }
  
    function getPlayerLastNAvg(playerId, uptoWeek, n) {
      if (n === void 0) n = 5;
      const bundle = window.__LAST_BUNDLE__;
      if (!bundle || !bundle.matchupsByWeek) return null;
  
      const matchupsByWeek = bundle.matchupsByWeek;
      const weeks = Object.keys(matchupsByWeek)
        .map((w) => Number(w))
        .filter((w) => Number.isFinite(w) && w < uptoWeek)
        .sort((a, b) => b - a);
  
      const scores = [];
      outer: for (let i = 0; i < weeks.length; i++) {
        const wk = weeks[i];
        const weekMatchups = matchupsByWeek[String(wk)] || [];
        for (let j = 0; j < weekMatchups.length; j++) {
          const m = weekMatchups[j];
          const pts = m.players_points && m.players_points[playerId];
          const val = Number(pts);
          if (Number.isFinite(val) && val > 0) {
            scores.push(val);
            if (scores.length >= n) break outer;
          }
        }
      }
  
      if (!scores.length) return null;
      const sum = scores.reduce((a, b) => a + b, 0);
      return sum / scores.length;
    }
  
    // Historical week heuristic: if every matchup has at least one player with > 0 pts
    function inferHistoricalWeek(matchups) {
      if (!matchups || !matchups.length) return false;
      return matchups.every((m) => {
        const pts = m.players_points || {};
        return Object.values(pts).some((v) => Number(v) > 0);
      });
    }
  
    function attachColumnToggles(root) {
      if (!root) return;
      const headers = root.querySelectorAll("th[data-col]");
      headers.forEach((th) => {
        th.addEventListener("click", () => {
          const key = th.dataset.col;
          const isHidden = th.classList.toggle("col-hidden");
          const cells = root.querySelectorAll('[data-col="' + key + '"]');
          cells.forEach((cell) => {
            if (isHidden) cell.classList.add("col-hidden");
            else cell.classList.remove("col-hidden");
          });
        });
      });
    }

    function splitRosterPlayers(roster) {
        if (!roster) {
          return { starters: [], bench: [], taxi: [], ir: [] };
        }
      
        const starters = Array.isArray(roster.starters)
          ? roster.starters.filter((pid) => pid && pid !== "0")
          : [];
      
        const allPlayers = Array.isArray(roster.players)
          ? roster.players.filter((pid) => pid && pid !== "0")
          : starters.slice(); // fallback if players missing
      
        const taxi = Array.isArray(roster.taxi)
          ? roster.taxi.filter((pid) => pid && pid !== "0")
          : [];
      
        const ir = Array.isArray(roster.reserve)
          ? roster.reserve.filter((pid) => pid && pid !== "0")
          : [];
      
        // Bench = everyone on players who isn't a starter / taxi / IR
        const reserved = new Set([...starters, ...taxi, ...ir]);
        const bench = allPlayers.filter((pid) => !reserved.has(pid));
      
        return { starters, bench, taxi, ir };
      }

        // -----------------------
    // Rosters tab – full team detail
    // -----------------------
    function renderRosterDetail(roster) {
        const tbody = document.getElementById("roster-detail-body");
        const headerEl = document.getElementById("roster-detail-header");
        if (!tbody) return;
  
        // Clear old content
        tbody.innerHTML = "";
  
        if (!roster) {
          if (headerEl) headerEl.textContent = "Select a team";
          tbody.innerHTML = `
            <tr>
              <td colspan="4" class="small muted">No roster selected.</td>
            </tr>
          `;
          return;
        }
  
        const playerMap = window.__SLEEPER_PLAYER_MAP__ || {};
        const ktcClient = window.KTCClient || null;
  
        // Record if available (from computeSeasonStandings -> CURRENT_RECORD_BY_ROSTER_ID)
        const recMap = CURRENT_RECORD_BY_ROSTER_ID || {};
        const rec = recMap[String(roster.roster_id)] || null;
  
        // Build header text
        if (headerEl) {
          const ownerName =
            roster.owner_display ||
            roster.owner_name ||
            roster.display_name ||
            "";
  
          const teamName =
            (roster.metadata &&
              (roster.metadata.team_name ||
                roster.metadata.team_name_update)) ||
            "";
  
          const parts = [];
          if (teamName) parts.push(teamName);
          if (ownerName) parts.push(`(${ownerName})`);
          if (rec) parts.push(` ${rec}`);
  
          headerEl.textContent =
            parts.length > 0
              ? `Roster – ${parts.join(" ")}`
              : `Roster ${roster.roster_id}`;
        }
  
        // Use the helper above to break roster into slots
        const { starters, bench, taxi, ir } = splitRosterPlayers(roster);
  
        function renderPlayerRow(pid, slotLabel) {
          const meta = playerMap[pid] || {};
          const name =
            meta.full_name ||
            (meta.first_name && meta.last_name
              ? `${meta.first_name} ${meta.last_name}`
              : String(pid));
  
          const pos = meta.position || "";
          const team = meta.team || "";
  
          let ktcValueText = "";
          if (ktcClient && typeof ktcClient.getBestValueForSleeperId === "function") {
            const v = ktcClient.getBestValueForSleeperId(String(pid));
            if (typeof v === "number" && Number.isFinite(v) && v > 0) {
              ktcValueText = v.toFixed(0);
            }
          }
  
          return `
            <tr class="roster-player-row roster-player-${slotLabel.toLowerCase()}">
              <td class="cell-slot">${escapeHtml(slotLabel)}</td>
              <td class="cell-name">${escapeHtml(name)}</td>
              <td class="cell-pos">
                ${escapeHtml(pos)}${team ? " · " + escapeHtml(team) : ""}
              </td>
              <td class="cell-ktc">${ktcValueText}</td>
            </tr>
          `;
        }
  
        const sections = [];
  
        function pushSection(title, players, slotLabel) {
          if (!players || !players.length) return;
          sections.push(`
            <tr class="roster-section-header">
              <td colspan="4">${escapeHtml(title)}</td>
            </tr>
          `);
          players.forEach((pid) => {
            sections.push(renderPlayerRow(pid, slotLabel));
          });
        }
  
        pushSection("Starters", starters, "Starter");
        pushSection("Bench", bench, "Bench");
        pushSection("Taxi", taxi, "Taxi");
        pushSection("IR / Reserve", ir, "IR");
  
        if (!sections.length) {
          tbody.innerHTML = `
            <tr>
              <td colspan="4" class="small muted">This roster has no players.</td>
            </tr>
          `;
        } else {
          tbody.innerHTML = sections.join("");
        }
      }
  
      
  
    // -----------------------
    // Matchup ID helper
    // -----------------------
  
    function computeMatchupIdForWeek(m, week) {
      if (!m) return null;
      if (m.id != null && m.id !== "") return String(m.id);
      if (m.matchup_id != null) return "week" + week + "_m" + m.matchup_id;
      if (m.matchupId != null) return "week" + week + "_m" + m.matchupId;
      return null;
    }
  
    function getRoundLabelFromConfig(cfg, week) {
      const playoffStart = cfg.PLAYOFF_START_WEEK || 15;
      const semiWeek = cfg.SEMIFINAL_WEEK || 16;
      const champWeek = cfg.CHAMPIONSHIP_WEEK || 17;
  
      if (week === champWeek) return "Championship";
      if (week === semiWeek) return "Semifinals";
      if (week === playoffStart) return "Quarterfinals";
      return "Week " + week;
    }
  
    // -----------------------
    // Records helpers
    // -----------------------
  
    function getRosterRecordString(roster) {
      if (!roster || !roster.settings) return null;
      const w = Number(roster.settings.wins);
      const l = Number(roster.settings.losses);
      const t = Number(roster.settings.ties);
      if (!Number.isFinite(w) || !Number.isFinite(l)) return null;
      if (Number.isFinite(t) && t > 0) return w + "-" + l + "-" + t;
      return w + "-" + l;
    }
  
    function getRosterIdFromTeamObj(obj) {
      if (!obj) return null;
      return (
        obj.rosterId ??
        obj.roster_id ??
        (obj.team && (obj.team.rosterId ?? obj.team.roster_id)) ??
        null
      );
    }

    function getRosterAvatarUrl(rosterId) {
        const id = rosterId != null ? CURRENT_AVATAR_BY_ROSTER_ID[String(rosterId)] : null;
        return id
          ? `https://sleepercdn.com/avatars/thumbs/${id}`
          : "https://sleepercdn.com/images/v2/icons/player_default.webp";
      }
      
  
    // -----------------------
    // Matchup models for UI
    // -----------------------
  
    function buildMatchupModels(entries, week, options) {
      options = options || {};
      const mode = options.mode || "projections";
      const rosterById = options.rosterById || {};
  
      return entries
        .map((entry, idx) => {
          // -------------------------
          // Results mode
          // -------------------------
          if (entry.historical && entry.teams && entry.teams.length >= 2) {
            const teamAView = entry.teams[0];
            const teamBView = entry.teams[1];
            if (!teamAView || !teamBView) return null;
  
            const nameA = teamAView.team.teamDisplayName;
            const nameB = teamBView.team.teamDisplayName;
  
            const muA = Number(teamAView.score);
            const muB = Number(teamBView.score);
  
            const winA = muA > muB ? 1 : muA < muB ? 0 : 0.5;
            const winB = 1 - winA;
  
            const rosterIdA = getRosterIdFromTeamObj(teamAView);
            const rosterIdB = getRosterIdFromTeamObj(teamBView);
            const recordA = getRosterRecordString(rosterById[rosterIdA]);
            const recordB = getRosterRecordString(rosterById[rosterIdB]);
  
            const impliedSpread = formatSpread(muA, muB, nameA, nameB);
            const impliedTotal = formatTotal(muA, muB);
            const avatarA = getRosterAvatarUrl(rosterIdA);
            const avatarB = getRosterAvatarUrl(rosterIdB);
  
            return {
              id: entry.id || "matchup-" + (idx + 1),
              week,
              roundLabel: entry.roundLabel || "Week " + week,
              bestOf: entry.bestOf || 1,
              mode: "results",
  
              nameA,
              nameB,
              recordA,
              recordB,
              muA,
              muB,
              rangeA: { low: muA, high: muA },
              rangeB: { low: muB, high: muB },
              winA,
              winB,
              avatarA,
              avatarB,
  
              favoriteName: null,
              favoriteWinProb: null,
              underdogName: null,
  
              impliedSpread,
              impliedTotal,
              isSemi: !!entry.isSemi,
            };
          }
  
          // -------------------------
          // Projection mode
          // -------------------------
          const pm = entry.projectedMatchup;
          const projected = pm && pm.projected;
          const sim = entry.sim;
  
          if (
            !projected ||
            !projected.teamA ||
            !projected.teamB ||
            !projected.teamA.projection ||
            !projected.teamB.projection
          ) {
            return null;
          }
  
          const tA = projected.teamA;
          const tB = projected.teamB;
  
          const nameA = tA.team.teamDisplayName;
          const nameB = tB.team.teamDisplayName;
  
          const rosterIdA = getRosterIdFromTeamObj(tA.team);
          const rosterIdB = getRosterIdFromTeamObj(tB.team);
          const recordA = getRosterRecordString(rosterById[rosterIdA]);
          const recordB = getRosterRecordString(rosterById[rosterIdB]);
  
          const muA = tA.projection.totalMean;
          const muB = tB.projection.totalMean;
  
          const sdA = Number(tA.projection.totalSd);
          const sdB = Number(tB.projection.totalSd);
  
          function makeRange(mu, sd, fallbackLow, fallbackHigh) {
            if (!Number.isFinite(mu)) return { low: null, high: null };
            if (!Number.isFinite(sd) || sd <= 0) {
              const low = Number.isFinite(fallbackLow) ? fallbackLow : null;
              const high = Number.isFinite(fallbackHigh) ? fallbackHigh : null;
              return { low, high };
            }
            const k = 1.05;
            const low = Math.max(0, mu - k * sd);
            const high = mu + k * sd;
            return { low, high };
          }
  
          const rangeA = makeRange(muA, sdA, tA.projection.rangeLow, tA.projection.rangeHigh);
          const rangeB = makeRange(muB, sdB, tB.projection.rangeLow, tB.projection.rangeHigh);

          const avatarA = getRosterAvatarUrl(rosterIdA);
          const avatarB = getRosterAvatarUrl(rosterIdB);
  
          const winA = sim ? sim.teamAWinPct : 0.5;
          const winB = sim ? sim.teamBWinPct : 0.5;
  
          let favoriteName = null;
          let favoriteWinProb = null;
          let underdogName = null;
  
          if (winA > winB) {
            favoriteName = nameA;
            favoriteWinProb = winA;
            underdogName = nameB;
          } else if (winB > winA) {
            favoriteName = nameB;
            favoriteWinProb = winB;
            underdogName = nameA;
          }
  
          return {
            id: entry.id || "matchup-" + (idx + 1),
            week,
            roundLabel: entry.roundLabel || "Week " + week,
            bestOf: entry.bestOf || 1,
            mode,
  
            nameA,
            nameB,
            recordA,
            recordB,
            muA,
            muB,
            rangeA,
            rangeB,
            winA,
            winB,
            avatarA,
            avatarB,
  
            favoriteName,
            favoriteWinProb,
            underdogName,
  
            impliedSpread: formatSpread(muA, muB, nameA, nameB),
            impliedTotal: formatTotal(muA, muB),
            isSemi: !!entry.isSemi,
          };
        })
        .filter(Boolean);
    }
  
    function renderMatchupCard(model) {
        const {
          id, mode,
          nameA, nameB,
          recordA, recordB,
          muA, muB,
          rangeA, rangeB,
          winA, winB,
          impliedSpread, impliedTotal,
          roundLabel,
          avatarA, avatarB,
          favoriteName
        } = model;
      
        const isResults = mode === "results";
      
        // Win bar
        const pctA = Math.max(0, Math.min(100, Math.round((Number(winA) || 0.5) * 100)));
        const pctB = 100 - pctA;
      
        // Scores
        const scoreA = formatScore(muA, 1);
        const scoreB = formatScore(muB, 1);
      
        // Subtext under scores
        const subA = isResults
          ? "Final"
          : (rangeA && Number.isFinite(rangeA.low) && Number.isFinite(rangeA.high))
            ? `Proj ${formatRange(rangeA.low, rangeA.high, 1)}`
            : "Proj";
        const subB = isResults
          ? "Final"
          : (rangeB && Number.isFinite(rangeB.low) && Number.isFinite(rangeB.high))
            ? `Proj ${formatRange(rangeB.low, rangeB.high, 1)}`
            : "Proj";
      
        // Footer line
        const footerLeft = isResults
          ? `Final: ${nameA} ${scoreA} – ${nameB} ${scoreB}`
          : `Win odds: ${pctA}% / ${pctB}%`;
      
        const footerRight = isResults
          ? `Total: ${formatTotal(muA, muB)}`
          : `Line: ${impliedSpread} • O/U: ${impliedTotal}`;
      
        const favChip = (!isResults && favoriteName)
          ? `<span class="mu-chip">Fav: ${escapeHtml(favoriteName)}</span>`
          : "";
      
        const fallback = "https://sleepercdn.com/images/v2/icons/player_default.webp";
      
        return `
          <article class="matchup-card" data-matchup-id="${escapeHtml(id)}">
            <div class="mu-top">
              <div class="mu-round">
                <span>${escapeHtml(roundLabel || "")}</span>
                ${favChip}
              </div>
              <div class="mu-meta">
                <span>${escapeHtml(isResults ? "Final" : impliedSpread)}</span>
                <span>${escapeHtml(isResults ? "" : "O/U " + impliedTotal)}</span>
              </div>
            </div>
      
            <div class="mu-grid">
              <div class="mu-side left">
                <div class="mu-id">
                  <img class="mu-avatar" src="${escapeHtml(avatarA || fallback)}"
                       alt="${escapeHtml(nameA)}" loading="lazy"
                       onerror="this.onerror=null;this.src='${fallback}';" />
                  <div style="min-width:0;">
                    <div class="mu-team">${escapeHtml(nameA)}</div>
                    ${recordA ? `<div class="mu-record">${escapeHtml(recordA)}</div>` : ``}
                  </div>
                </div>
                <div class="mu-score">${escapeHtml(scoreA)}</div>
                <div class="mu-sub">${escapeHtml(subA)}</div>
              </div>
      
              <div class="mu-center">
                <div class="mu-odds">${pctA}% · ${pctB}%</div>
                <div class="mu-vs">VS</div>
              </div>
      
              <div class="mu-side right">
                <div class="mu-id">
                  <img class="mu-avatar" src="${escapeHtml(avatarB || fallback)}"
                       alt="${escapeHtml(nameB)}" loading="lazy"
                       onerror="this.onerror=null;this.src='${fallback}';" />
                  <div style="min-width:0;">
                    <div class="mu-team">${escapeHtml(nameB)}</div>
                    ${recordB ? `<div class="mu-record">${escapeHtml(recordB)}</div>` : ``}
                  </div>
                </div>
                <div class="mu-score">${escapeHtml(scoreB)}</div>
                <div class="mu-sub">${escapeHtml(subB)}</div>
              </div>
            </div>
      
            <div class="mu-winbar" title="Win Odds: ${pctA}% vs ${pctB}%">
              <div class="mu-winseg a" style="width:${pctA}%"></div>
              <div class="mu-winseg b" style="width:${pctB}%"></div>
            </div>
      
            <div class="mu-footer">
              <span>${escapeHtml(footerLeft)}</span>
              <span>${escapeHtml(footerRight)}</span>
            </div>
          </article>
        `;
      }
      
  
    function buildNewsletterHtml(leagueName, week, matchupModels, options) {
      options = options || {};
      const mode = options.mode || "projections";
      const recapById = options.recapById || null;
      const isResults = mode === "results";
  
      const baseTitle = isResults ? "Week " + week + " Results" : "Week " + week + " Matchups";
      const titleLine = leagueName ? baseTitle + " – " + leagueName : baseTitle;
  
      const introText = isResults
        ? "Final scores are in. Here’s how it played out."
        : "Projections are in. Here’s how things look after a Monte Carlo sim.";
  
      const lines = [];
  
      lines.push('<section class="newsletter-week-header">');
      lines.push('<div class="newsletter-week-title">' + escapeHtml(titleLine) + "</div>");
      lines.push('<p class="newsletter-week-subtitle">' + escapeHtml(introText) + "</p>");
      lines.push("</section>");
  
      lines.push('<section class="newsletter-matchups-list">');
  
      matchupModels.forEach((m) => {
        let cardHtml = renderMatchupCard(m);
  
        // Append recap (results weeks only)
        if (isResults && recapById && recapById[m.id]) {
          cardHtml = cardHtml.replace(
            "</article>",
            '<p class="nm-recap">' + escapeHtml(recapById[m.id]) + "</p></article>"
          );
        }
  
        lines.push(cardHtml);
      });
  
      lines.push("</section>");
  
      return lines.join("\n");
    }
  
    // -----------------------
    // Matchup Detail view
    // -----------------------
  
    function findMatchupEntryById(id) {
      return CURRENT_MATCHUP_ENTRIES.find((m) => m.id === id) || null;
    }
  
    function setDetailTitleFromEntry(entry) {
      const titleEl = $("#detail-title");
      if (!titleEl) return;
  
      if (!entry) {
        titleEl.textContent = "Select a matchup";
        return;
      }
  
      // Historical
      if (entry.historical && entry.teams && entry.teams.length >= 2) {
        const a = entry.teams[0];
        const b = entry.teams[1];
        const nameA = a && a.team && a.team.teamDisplayName ? a.team.teamDisplayName : "Team A";
        const nameB = b && b.team && b.team.teamDisplayName ? b.team.teamDisplayName : "Team B";
        titleEl.textContent = nameA + " vs " + nameB;
        return;
      }
  
      // Projections
      const pm = entry.projectedMatchup;
      const projected = pm && pm.projected;
      if (projected && projected.teamA && projected.teamB) {
        const nameA = projected.teamA.team.teamDisplayName;
        const nameB = projected.teamB.team.teamDisplayName;
        titleEl.textContent = nameA + " vs " + nameB;
        return;
      }
  
      titleEl.textContent = "Matchup Detail";
    }
  
    function getPlayerId(p) {
      if (!p) return "";
      return p.playerId || p.player_id || p.id || "";
    }
  
    function getPlayerName(p, playerMap) {
      if (!p) return "";
      if (p.displayName) return p.displayName;
      const id = getPlayerId(p);
      const meta = playerMap[id];
      if (meta && meta.full_name) return meta.full_name;
      return id;
    }
  
    function getPlayerTeam(p, playerMap) {
      if (!p) return "";
      if (p.nflTeam) return p.nflTeam;
      const id = getPlayerId(p);
      const meta = playerMap[id];
      return meta && meta.team ? meta.team : "";
    }
  
    function uniqByPlayerId(list) {
      const out = [];
      const seen = new Set();
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        const id = String(getPlayerId(p));
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(p);
      }
      return out;
    }
  
    function normalizeProjectedSlot(p) {
      return (
        p.slot ??
        p.rosterSlot ??
        p.lineupSlot ??
        p.slotName ??
        p.slot_type ??
        p.slotType ??
        ""
      );
    }
  
    function isProjectedStarter(p) {
      const slot = String(normalizeProjectedSlot(p)).toLowerCase();
      if (!slot) {
        // If we can't tell, assume starter (better UX than hiding everything)
        return true;
      }
      // Common bench codes
      if (slot === "bn" || slot === "be" || slot === "bench") return false;
      if (slot.includes("bench")) return false;
      return true;
    }
  
    function chooseHistoricalPlayers(teamView, scope) {
      const starters = Array.isArray(teamView.starters) ? teamView.starters : [];
      if (scope === "starters") return starters;
  
      // Try common “all players” shapes
      const all =
        (Array.isArray(teamView.players) && teamView.players) ||
        (Array.isArray(teamView.allPlayers) && teamView.allPlayers) ||
        (Array.isArray(teamView.rosterPlayers) && teamView.rosterPlayers) ||
        null;
  
      const bench = Array.isArray(teamView.bench) ? teamView.bench : [];
      const merged = all ? all : starters.concat(bench);
  
      return uniqByPlayerId(merged.length ? merged : starters);
    }
  
    function chooseProjectedPlayers(teamProj, scope) {
      const all = Array.isArray(teamProj.projection.players) ? teamProj.projection.players : [];
      if (scope === "all") return all;
  
      const starters = all.filter(isProjectedStarter);
      return starters.length ? starters : all; // fallback
    }
  
    function renderMatchupDetail(entry) {
      const container = $("#matchup-detail-container");
      if (!container || !entry) return;
  
      const scope = getDetailScope();
      const playerMap = window.__SLEEPER_PLAYER_MAP__ || {};
  
      // -----------------------------
      // Historical (results) mode
      // -----------------------------
      if (entry.historical && entry.teams && entry.teams.length >= 2) {
        const teamA = entry.teams[0];
        const teamB = entry.teams[1];
  
        const teamAName = teamA.team.teamDisplayName;
        const teamBName = teamB.team.teamDisplayName;
  
        function buildTeamTableResults(teamView) {
          const list = chooseHistoricalPlayers(teamView, scope);
  
          const rows = list.map((p) => {
            const id = getPlayerId(p);
            const pts = Number(p.fantasyPoints);
            const seasonAvg = CURRENT_SEASON_AVG[id] != null ? CURRENT_SEASON_AVG[id] : null;
            const last5 = getPlayerLastNAvg(id, CURRENT_WEEK, 5);
  
            return (
              "<tr>" +
              "<td>" + escapeHtml(p.position || "") + "</td>" +
              "<td>" + escapeHtml(getPlayerName(p, playerMap)) + "</td>" +
              '<td data-col="team">' + escapeHtml(getPlayerTeam(p, playerMap)) + "</td>" +
              '<td data-col="score">' + escapeHtml(formatScore(pts, 1)) + "</td>" +
              '<td data-col="seasonAvg">' + escapeHtml(seasonAvg != null ? formatScore(seasonAvg, 1) : "–") + "</td>" +
              '<td data-col="last5">' + escapeHtml(last5 != null ? formatScore(last5, 1) : "–") + "</td>" +
              "</tr>"
            );
          });
  
          return (
            '<table class="detail-table">' +
            "<thead><tr>" +
            "<th>Pos</th>" +
            "<th>Player</th>" +
            '<th data-col="team">Team</th>' +
            '<th data-col="score">Pts</th>' +
            '<th data-col="seasonAvg">Season Avg</th>' +
            '<th data-col="last5">Last 5</th>' +
            "</tr></thead><tbody>" +
            rows.join("") +
            "</tbody></table>"
          );
        }
  
        container.innerHTML =
          '<div class="detail-layout">' +
          '<section class="detail-team">' +
          '<div class="detail-team-header">' +
          '<span class="team-name">' + escapeHtml(teamAName) + "</span>" +
          '<span class="small team-score">Team score: ' + escapeHtml(formatScore(teamA.score, 1)) + "</span>" +
          "</div>" +
          buildTeamTableResults(teamA) +
          "</section>" +
          '<section class="detail-team">' +
          '<div class="detail-team-header">' +
          '<span class="team-name">' + escapeHtml(teamBName) + "</span>" +
          '<span class="small team-score">Team score: ' + escapeHtml(formatScore(teamB.score, 1)) + "</span>" +
          "</div>" +
          buildTeamTableResults(teamB) +
          "</section>" +
          "</div>";
  
        attachColumnToggles(container);
        return;
      }
  
      // -----------------------------
      // Projection mode
      // -----------------------------
      const pm = entry.projectedMatchup;
      const projected = pm && pm.projected;
      if (
        !projected ||
        !projected.teamA ||
        !projected.teamB ||
        !projected.teamA.projection ||
        !projected.teamB.projection
      ) {
        container.innerHTML = '<p class="small">No detailed projections available for this matchup.</p>';
        return;
      }
  
      const tA = projected.teamA;
      const tB = projected.teamB;
  
      const teamAName = tA.team.teamDisplayName;
      const teamBName = tB.team.teamDisplayName;
  
      function buildTeamTableProjected(team) {
        const list = chooseProjectedPlayers(team, scope);
  
        const rows = list.map((p) => {
          const id = getPlayerId(p);
          const proj = p.projection || {};
          const mean = proj.mean;
          const rangeLow = proj.floor;
          const rangeHigh = proj.ceiling;
  
          const seasonAvg = CURRENT_SEASON_AVG[id] != null ? CURRENT_SEASON_AVG[id] : null;
          const last5 = getPlayerLastNAvg(id, CURRENT_WEEK, 5);
  
          return (
            "<tr>" +
            "<td>" + escapeHtml(p.position || "") + "</td>" +
            "<td>" + escapeHtml(getPlayerName(p, playerMap)) + "</td>" +
            '<td data-col="team">' + escapeHtml(getPlayerTeam(p, playerMap)) + "</td>" +
            '<td data-col="proj">' + escapeHtml(formatScore(mean, 1)) + "</td>" +
            '<td data-col="projRange">' +
            escapeHtml(
              Number.isFinite(rangeLow) && Number.isFinite(rangeHigh)
                ? formatRange(rangeLow, rangeHigh, 1)
                : "–"
            ) +
            "</td>" +
            '<td data-col="seasonAvg">' + escapeHtml(seasonAvg != null ? formatScore(seasonAvg, 1) : "–") + "</td>" +
            '<td data-col="last5">' + escapeHtml(last5 != null ? formatScore(last5, 1) : "–") + "</td>" +
            "</tr>"
          );
        });
  
        return (
          '<table class="detail-table">' +
          "<thead><tr>" +
          "<th>Pos</th>" +
          "<th>Player</th>" +
          '<th data-col="team">Team</th>' +
          '<th data-col="proj">Proj</th>' +
          '<th data-col="projRange">Proj Range</th>' +
          '<th data-col="seasonAvg">Season Avg</th>' +
          '<th data-col="last5">Last 5</th>' +
          "</tr></thead><tbody>" +
          rows.join("") +
          "</tbody></table>"
        );
      }
  
      container.innerHTML =
        '<div class="detail-layout">' +
        '<section class="detail-team">' +
        '<div class="detail-team-header">' +
        '<span class="team-name">' + escapeHtml(teamAName) + "</span>" +
        '<span class="small team-score">Team proj: ' +
        escapeHtml(formatScore(tA.projection.totalMean, 1)) +
        " (" +
        escapeHtml(formatRange(tA.projection.rangeLow, tA.projection.rangeHigh, 1)) +
        ")</span>" +
        "</div>" +
        buildTeamTableProjected(tA) +
        "</section>" +
        '<section class="detail-team">' +
        '<div class="detail-team-header">' +
        '<span class="team-name">' + escapeHtml(teamBName) + "</span>" +
        '<span class="small team-score">Team proj: ' +
        escapeHtml(formatScore(tB.projection.totalMean, 1)) +
        " (" +
        escapeHtml(formatRange(tB.projection.rangeLow, tB.projection.rangeHigh, 1)) +
        ")</span>" +
        "</div>" +
        buildTeamTableProjected(tB) +
        "</section>" +
        "</div>";
  
      attachColumnToggles(container);
    }
  
    function showDetailForMatchup(id) {
      const entry = findMatchupEntryById(id);
      if (!entry) return;
  
      CURRENT_SELECTED_MATCHUP_ID = id;
      setDetailTitleFromEntry(entry);
      renderMatchupDetail(entry);
    }
  
    // -----------------------
    // League Pulse (NEW)
    // -----------------------
  
    function renderLeaguePulse(matchupModels, champObj, mode) {
      const titleEl = $("#pulse-title-odds");
      const alertsEl = $("#pulse-alerts");
      const quickEl = $("#pulse-quick-table");
  
      // If your new layout isn't present, skip silently
      if (!titleEl && !alertsEl && !quickEl) return;
  
      // ---- Title odds ----
      if (titleEl) {
        if (mode === "projections" && champObj) {
          const entries = Object.entries(champObj)
            .map(([teamName, info]) => ({
              teamName,
              title: Number(info && info.titleOdds),
              reachFinal: Number(info && info.path && info.path.reachFinalPct),
            }))
            .filter((x) => Number.isFinite(x.title))
            .sort((a, b) => b.title - a.title)
            .slice(0, 8);
  
          if (entries.length) {
            titleEl.innerHTML =
              "<ol class='small' style='margin:0; padding-left:18px;'>" +
              entries
                .map(
                  (x) =>
                    "<li>" +
                    escapeHtml(x.teamName) +
                    " — <strong>" +
                    escapeHtml(formatPercent(x.title, 1)) +
                    "</strong>" +
                    (Number.isFinite(x.reachFinal)
                      ? " <span class='muted'>(Final " + escapeHtml(formatPercent(x.reachFinal, 1)) + ")</span>"
                      : "") +
                    "</li>"
                )
                .join("") +
              "</ol>";
          } else {
            titleEl.textContent = "Title odds will appear here when semifinal math is available.";
          }
        } else {
          titleEl.textContent = "Title odds will appear here for upcoming playoff weeks.";
        }
      }
  
      // ---- Alerts ----
      if (alertsEl) {
        if (!matchupModels || !matchupModels.length) {
          alertsEl.textContent = "No alerts yet.";
        } else if (mode === "results") {
          // Closest final margin + biggest blowout
          const withMargin = matchupModels
            .map((m) => ({
              m,
              margin: Math.abs(Number(m.muA) - Number(m.muB)),
            }))
            .filter((x) => Number.isFinite(x.margin))
            .sort((a, b) => a.margin - b.margin);
  
          const closest = withMargin[0];
          const biggest = withMargin.slice().sort((a, b) => b.margin - a.margin)[0];
  
          const lines = [];
          if (closest) {
            lines.push(
              "Closest finish: " +
                closest.m.nameA +
                " vs " +
                closest.m.nameB +
                " (Δ " +
                closest.margin.toFixed(1) +
                ")."
            );
          }
          if (biggest) {
            lines.push(
              "Most lopsided: " +
                biggest.m.nameA +
                " vs " +
                biggest.m.nameB +
                " (Δ " +
                biggest.margin.toFixed(1) +
                ")."
            );
          }
  
          alertsEl.innerHTML = "<div class='small'>" + lines.map(escapeHtml).join("<br/>") + "</div>";
        } else {
          // Projection mode: closest by win prob + biggest favorite + “flip watch”
          const byCloseness = matchupModels
            .map((m) => ({
              m,
              close: Math.abs((Number(m.winA) || 0.5) - 0.5),
            }))
            .sort((a, b) => a.close - b.close);
  
          const closest = byCloseness[0];
  
          const byFav = matchupModels
            .map((m) => {
              const a = Number(m.winA);
              const b = Number(m.winB);
              const favP = Math.max(a, b);
              const favName = a >= b ? m.nameA : m.nameB;
              return { m, favP, favName };
            })
            .filter((x) => Number.isFinite(x.favP))
            .sort((a, b) => b.favP - a.favP);
  
          const biggestFav = byFav[0];
  
          const lines = [];
          if (closest) {
            lines.push(
              "Upset watch: " +
                closest.m.nameA +
                " vs " +
                closest.m.nameB +
                " (" +
                formatPercent(closest.m.winA, 1) +
                " / " +
                formatPercent(closest.m.winB, 1) +
                ")."
            );
          }
          if (biggestFav) {
            lines.push(
              "Blowout risk: " +
                biggestFav.favName +
                " favored (" +
                formatPercent(biggestFav.favP, 1) +
                ")."
            );
          }
  
          alertsEl.innerHTML = "<div class='small'>" + lines.map(escapeHtml).join("<br/>") + "</div>";
        }
      }
  
      // ---- Quick table ----
      if (quickEl) {
        if (!matchupModels || !matchupModels.length) {
          quickEl.textContent = "No matchups yet.";
        } else {
          const rows = matchupModels
            .slice()
            .map((m) => {
              const label = m.nameA + " vs " + m.nameB;
              const line = m.mode === "results" ? "Final" : m.impliedSpread;
              const odds =
                m.mode === "results"
                  ? formatScore(m.muA, 1) + " – " + formatScore(m.muB, 1)
                  : formatPercent(m.winA, 0) + " / " + formatPercent(m.winB, 0);
              return { label, line, odds };
            });
  
          quickEl.innerHTML =
            "<table class='odds-table' style='margin-top:0;'>" +
            "<thead><tr><th>Matchup</th><th>Line</th><th>Odds</th></tr></thead>" +
            "<tbody>" +
            rows
              .map(
                (r) =>
                  "<tr>" +
                  "<td>" +
                  escapeHtml(r.label) +
                  "</td>" +
                  "<td class='small'>" +
                  escapeHtml(r.line) +
                  "</td>" +
                  "<td class='small'>" +
                  escapeHtml(r.odds) +
                  "</td>" +
                  "</tr>"
              )
              .join("") +
            "</tbody></table>";
        }
      }
    }
  
    // -----------------------
    // Season Overview helpers (standings)
    // -----------------------
  
    function computeSeasonStandings(bundle) {
      const matchupsByWeek = bundle.matchupsByWeek || {};
      const rosters = bundle.rosters || [];
      const users = bundle.users || [];
  
      const teamMap = {};
      rosters.forEach((r) => {
        const u = users.find((x) => x.user_id === r.owner_id);
        const name = u ? u.display_name : "Team " + r.roster_id;
        teamMap[r.roster_id] = {
          rosterId: r.roster_id,
          name,
          wins: 0,
          losses: 0,
          ties: 0,
          pf: 0,
          pa: 0,
        };
      });
  
      Object.keys(matchupsByWeek).forEach((wkStr) => {
        const weekMatchups = matchupsByWeek[wkStr] || [];
        if (!inferHistoricalWeek(weekMatchups)) return;
  
        weekMatchups.forEach((m) => {
          const teams = m.teams || [];
          if (teams.length < 2) return;
          const a = teams[0];
          const b = teams[1];
          const scoreA = Number(a.score);
          const scoreB = Number(b.score);
  
          const ta = teamMap[a.rosterId];
          const tb = teamMap[b.rosterId];
          if (!ta || !tb) return;
  
          if (Number.isFinite(scoreA)) {
            ta.pf += scoreA;
            tb.pa += scoreA;
          }
          if (Number.isFinite(scoreB)) {
            tb.pf += scoreB;
            ta.pa += scoreB;
          }
  
          if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB)) return;
          if (scoreA > scoreB) {
            ta.wins += 1;
            tb.losses += 1;
          } else if (scoreB > scoreA) {
            tb.wins += 1;
            ta.losses += 1;
          } else {
            ta.ties += 1;
            tb.ties += 1;
          }
        });
      });
  
      const rows = Object.values(teamMap);
      rows.sort((a, b) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        if (b.pf !== a.pf) return b.pf - a.pf;
        return (a.name || "").localeCompare(b.name || "");
      });
  
      return rows.map((row, idx) => {
        const games = row.wins + row.losses + row.ties;
        const winPct = games > 0 ? row.wins / games : 0;
        const diff = row.pf - row.pa;
        return {
          rank: idx + 1,
          name: row.name,
          rosterId: row.rosterId,
          wins: row.wins,
          losses: row.losses,
          ties: row.ties,
          pf: row.pf,
          pa: row.pa,
          diff: diff,
          winPct: winPct,
        };
      });
    }
  
    function renderSeasonOverview(bundle) {
      const container = $("#season-overview-root");
      if (!container) return;
  
      const rows = computeSeasonStandings(bundle);
  
      let html = "";
      html += '<div class="season-overview">';
      html += '<div class="season-standings-container">';
      html += '<div class="season-subheading">Standings</div>';
      html +=
        '<table class="season-standings-table"><thead><tr>' +
        "<th>#</th><th>Team</th><th>W-L-T</th><th>Win%</th><th>PF</th><th>PA</th><th>Diff</th>" +
        "</tr></thead><tbody>";
  
      rows.forEach((row) => {
        html +=
          '<tr data-roster-id="' +
          escapeHtml(row.rosterId) +
          '">' +
          "<td>" +
          row.rank +
          "</td>" +
          "<td>" +
          escapeHtml(row.name) +
          "</td>" +
          "<td>" +
          row.wins +
          "-" +
          row.losses +
          (row.ties ? "-" + row.ties : "") +
          "</td>" +
          "<td>" +
          escapeHtml(formatPercent(row.winPct, 1)) +
          "</td>" +
          "<td>" +
          escapeHtml(formatScore(row.pf, 1)) +
          "</td>" +
          "<td>" +
          escapeHtml(formatScore(row.pa, 1)) +
          "</td>" +
          "<td>" +
          (row.diff >= 0 ? "+" : "") +
          escapeHtml(formatScore(row.diff, 1)) +
          "</td>" +
          "</tr>";
      });
  
      html += "</tbody></table>";
      html += "</div>";
  
      // Right-side metrics
      html += '<div class="season-metrics-container">';
      html += '<div class="season-subheading">Season Snapshot</div>';
  
      if (rows.length) {
        const bestPf = rows.slice().sort((a, b) => b.pf - a.pf)[0];
        const bestDiff = rows.slice().sort((a, b) => b.diff - a.diff)[0];
        const worstDiff = rows.slice().sort((a, b) => a.diff - b.diff)[0];
  
        html +=
          "<p><strong>Top Scoring:</strong> " +
          escapeHtml(bestPf.name) +
          " (" +
          escapeHtml(formatScore(bestPf.pf, 1)) +
          " PF)</p>";
        html +=
          "<p><strong>Best Differential:</strong> " +
          escapeHtml(bestDiff.name) +
          " (" +
          (bestDiff.diff >= 0 ? "+" : "") +
          escapeHtml(formatScore(bestDiff.diff, 1)) +
          ")</p>";
        html +=
          "<p><strong>Roughest Ride:</strong> " +
          escapeHtml(worstDiff.name) +
          " (" +
          (worstDiff.diff >= 0 ? "+" : "") +
          escapeHtml(formatScore(worstDiff.diff, 1)) +
          " net points)</p>";
      } else {
        html += "<p>No completed games yet for a season overview.</p>";
      }
  
      html +=
        '<p class="small">Click any row in the standings to show that team’s profile (once wired to TeamProfile.render).</p>';
      html += "</div></div>";
  
      container.innerHTML = html;
    }
  
    // -----------------------
    // Week Brief (top blurb)
    // -----------------------
  
    function setWeekBrief(leagueName, week, mode, matchupModels) {
      const titleEl = $("#week-brief-title");
      const textEl = $("#week-brief-text");
  
      if (!titleEl && !textEl) return;
  
      if (titleEl) {
        titleEl.textContent = (leagueName ? leagueName + " — " : "") + "Week " + week + " Snapshot";
      }
  
      if (!textEl) return;
  
      if (!matchupModels || !matchupModels.length) {
        textEl.textContent = "No matchups detected for this week.";
        return;
      }
  
      if (mode === "results") {
        // Quick “front page” recap for results
        const margins = matchupModels
          .map((m) => ({
            m,
            margin: Math.abs(Number(m.muA) - Number(m.muB)),
            total: Number(m.muA) + Number(m.muB),
          }))
          .filter((x) => Number.isFinite(x.margin) && Number.isFinite(x.total));
  
        margins.sort((a, b) => a.margin - b.margin);
        const closest = margins[0];
        margins.sort((a, b) => b.total - a.total);
        const highestTotal = margins[0];
  
        const parts = [];
        parts.push("Scores are final.");
        if (closest) parts.push("Closest finish: " + closest.m.nameA + " vs " + closest.m.nameB + ".");
        if (highestTotal) parts.push("Highest combined score: " + highestTotal.m.nameA + " vs " + highestTotal.m.nameB + ".");
        parts.push("Open any matchup to see per-player detail.");
  
        textEl.textContent = parts.join(" ");
        return;
      }
  
      // Projection mode: closest by win odds + biggest favorite
      const close = matchupModels
        .map((m) => ({ m, close: Math.abs((Number(m.winA) || 0.5) - 0.5) }))
        .sort((a, b) => a.close - b.close)[0];
  
      const bigFav = matchupModels
        .map((m) => {
          const a = Number(m.winA);
          const b = Number(m.winB);
          const favP = Math.max(a, b);
          const favName = a >= b ? m.nameA : m.nameB;
          return { m, favP, favName };
        })
        .filter((x) => Number.isFinite(x.favP))
        .sort((a, b) => b.favP - a.favP)[0];
  
      const parts = [];
      parts.push("This week’s board is live with projections + sim-based win odds.");
      if (close) parts.push("Closest line: " + close.m.nameA + " vs " + close.m.nameB + ".");
      if (bigFav) parts.push("Biggest favorite: " + bigFav.favName + " (" + formatPercent(bigFav.favP, 0) + ").");
      parts.push("Click a matchup card for Starters detail, or toggle to All.");
  
      textEl.textContent = parts.join(" ");
    }
  
    // ============================================================
    // Core Loader (Rewritten)
    // ============================================================

    async function loadWeek(week) {
        const matchupsContainer = $("#matchups-container");
        const newsletterContent = $("#newsletter-content");
        const subtitle = $("#league-subtitle");
        const cfg = window.LEAGUE_CONFIG || {};
    
        CURRENT_WEEK = week;
        CURRENT_MATCHUP_ENTRIES = [];
        CURRENT_SELECTED_MATCHUP_ID = null;
        SEMI_MATCHUP_ID_SET = null;
        setDetailTitleFromEntry(null);
    
        if (matchupsContainer)
        matchupsContainer.innerHTML = `<div class="loading">Loading Week ${week} matchups…</div>`;
        if (newsletterContent)
        newsletterContent.innerHTML = `<p class="small">Building projections and simulations…</p>`;
    
        try {
        if (!window.SleeperClient)
            throw new Error("SleeperClient unavailable. Check sleeper_client.js load order.");
    
        const weeksToFetch = Array.from({ length: week }, (_, i) => i + 1);
        const bundle = await window.SleeperClient.fetchLeagueBundle({ weeks: weeksToFetch });
        window.__LAST_BUNDLE__ = bundle;
        window.dispatchEvent(new CustomEvent("playoffhub:bundle", { detail: { bundle, week } }));

    
        const league = bundle.league || {};
        const leagueName = league.name || "Sleeper League";
        const season = league.season || (cfg.season && cfg.season.year) || "";
        if (subtitle) subtitle.textContent = `${leagueName} • Season ${season} • Week ${week}`;
    
        // -------------- SEASON AVERAGES --------------
        CURRENT_SEASON_AVG = computeSeasonAverages(bundle, week);
        window.__SEASON_AVG_BY_PLAYER_ID__ = CURRENT_SEASON_AVG;
    
        // -------------- SNAPSHOT --------------
        const snapshot = {
            league,
            users: bundle.users || [],
            rosters: bundle.rosters || [],
            matchups: (bundle.matchupsByWeek && bundle.matchupsByWeek[week]) || [],
            winnersBracket: bundle.winnersBracket || [],
            week,
        };
    
        // Persist snapshot (optional)
        if (
            window.SleeperClient &&
            typeof window.SleeperClient.persistSnapshotToSupabase === "function"
        ) {
            window.SleeperClient
            .persistSnapshotToSupabase(snapshot, { source: "newsletter_loadWeek" })
            .catch((err) =>
                console.warn("[newsletter.js] Failed to persist Sleeper snapshot:", err)
            );
        }
    
        // -------------- MAPS: Rosters, Users, Avatars, Records --------------
        const rosterById = {};
        (snapshot.rosters || []).forEach((r) => (rosterById[r.roster_id] = r));
    
        const userById = {};
        (snapshot.users || []).forEach((u) => {
            if (u && u.user_id) userById[u.user_id] = u;
        });
    
        CURRENT_AVATAR_BY_ROSTER_ID = {};
        (snapshot.rosters || []).forEach((r) => {
            const owner = r && r.owner_id ? userById[r.owner_id] : null;
            const avatarId =
            (owner && owner.avatar) ||
            (r && r.metadata && r.metadata.avatar) ||
            null;
            CURRENT_AVATAR_BY_ROSTER_ID[String(r.roster_id)] = avatarId;
        });
    
        try {
            const standingsRows = computeSeasonStandings(bundle);
            CURRENT_RECORD_BY_ROSTER_ID = {};
            standingsRows.forEach((row) => {
            const rec = `${row.wins}-${row.losses}${row.ties ? "-" + row.ties : ""}`;
            CURRENT_RECORD_BY_ROSTER_ID[String(row.rosterId)] = rec;
            });
        } catch {
            CURRENT_RECORD_BY_ROSTER_ID = {};
        }
    
        // -------------- MATCHUPS + PROJECTIONS --------------
        const playerMap = window.__SLEEPER_PLAYER_MAP__ || null;
        const semiWeek = cfg.SEMIFINAL_WEEK || (cfg.playoff && cfg.playoff.semifinalWeek);
        let weeklyMatchups =
            window.LeagueModels.buildAllMatchupsForWeek(snapshot, playerMap) || [];
    
        const isHistoricalWeek = inferHistoricalWeek(snapshot.matchups);
        if (!isHistoricalWeek && semiWeek && week === Number(semiWeek)) {
            const playoffMatchups =
            window.LeagueModels.buildPlayoffMatchups(snapshot, cfg, { week, playerMap }) ||
            [];
            if (playoffMatchups.length) weeklyMatchups = playoffMatchups;
        }
    
        if (!weeklyMatchups.length) {
            if (matchupsContainer)
            matchupsContainer.innerHTML =
                `<article class="matchup-card"><div class="matchup-header">
                <div class="matchup-teams">No matchups found for Week ${week}</div></div>
                <div class="matchup-scores small">Check league schedule.</div></article>`;
            if (newsletterContent)
            newsletterContent.innerHTML = `<p>No matchups detected for this week.</p>`;
            // Season tab render (do NOT rewrite #season-overview-root from newsletter.js)
            if (window.SeasonOverview?.renderForWeek) {
                window.SeasonOverview.renderForWeek(bundle, week);
            }
            if (window.PlayoffsBracket?.renderFromBundle) {
                window.PlayoffsBracket.renderFromBundle(bundle, week);
            }
            
            // Broadcast bundle for any other modules
            window.dispatchEvent(new CustomEvent("playoffhub:bundle", { detail: { bundle, week } }));
            
            return;
        }
    
        // -------------- BUILD ENTRIES --------------
        let matchupEntries = [];
        let champObj = null;
    
        if (isHistoricalWeek) {
            matchupEntries = weeklyMatchups.map((m, i) => ({
            id:
                computeMatchupIdForWeek(m, week) ||
                `week${week}_m_fallback${i + 1}`,
            roundLabel: getRoundLabelFromConfig(cfg, week),
            bestOf: 1,
            historical: true,
            teams: m.teams,
            rosterIdA: m.teams?.[0]?.rosterId,
            rosterIdB: m.teams?.[1]?.rosterId,
            }));
        } else {
            for (let i = 0; i < weeklyMatchups.length; i++) {
            const m = weeklyMatchups[i];
            const projectedMatchup = window.ProjectionEngine.projectMatchup(m);
            if (!projectedMatchup?.projected?.teamA?.team || !projectedMatchup?.projected?.teamB?.team)
                continue;
    
            const sim = window.ProjectionEngine.simulateMatchup(projectedMatchup, {
                sims: 15000,
                trackScores: false,
            });
            if (!sim) continue;
    
            matchupEntries.push({
                id:
                computeMatchupIdForWeek(m, week) ||
                `week${week}_m_fallback${i + 1}`,
                roundLabel: getRoundLabelFromConfig(cfg, week),
                bestOf: m.bestOf || 1,
                projectedMatchup,
                sim,
                rosterIdA: m.teams?.[0]?.rosterId,
                rosterIdB: m.teams?.[1]?.rosterId,
            });
            }
    
            // -------------- SEMI + CHAMPIONSHIP ODDS --------------
            try {
            if (semiWeek && week === Number(semiWeek)) {
                const semiMatchups =
                window.LeagueModels.buildPlayoffMatchups(snapshot, cfg, { week, playerMap }) ||
                [];
                const semiResults = semiMatchups
                .map((pm) => {
                    const proj = window.ProjectionEngine.projectMatchup(pm);
                    const sim =
                    proj &&
                    window.ProjectionEngine.simulateMatchup(proj, {
                        sims: 20000,
                        trackScores: false,
                    });
                    return { originalMatchup: pm, projected: proj, sim };
                })
                .filter((r) => r?.projected?.projected?.teamA && r.sim);
    
                if (semiResults.length >= 2) {
                // Build finals matrix manually to avoid undefined 'team'
                const teams = {};
                semiResults.forEach((r) => {
                    const a = r.projected.projected.teamA;
                    const b = r.projected.projected.teamB;
                    teams[a.team.teamDisplayName] = {
                    mean: a.projection.totalMean,
                    sd: a.projection.totalSd,
                    };
                    teams[b.team.teamDisplayName] = {
                    mean: b.projection.totalMean,
                    sd: b.projection.totalSd,
                    };
                });
                const names = Object.keys(teams);
                const matrix = {};
                names.forEach((A) => {
                    matrix[A] = {};
                    names.forEach((B) => {
                    if (A === B) return;
                    const tA = teams[A],
                        tB = teams[B];
                    const muDiff = tA.mean - tB.mean;
                    const varDiff = tA.sd ** 2 + tB.sd ** 2 || 1;
                    const z = muDiff / Math.sqrt(varDiff);
                    const cdf = 0.5 * (1 + Math.erf(z / Math.sqrt(2)));
                    matrix[A][B] = cdf;
                    });
                });
    
                champObj = {};
                names.forEach((n) => {
                    const vs = matrix[n];
                    const avg = Object.values(vs).reduce((a, b) => a + b, 0) / names.length;
                    champObj[n] = Math.round(avg * 100);
                });
    
                // Mark semifinal IDs
                SEMI_MATCHUP_ID_SET = new Set(
                    semiResults.map((r) => computeMatchupIdForWeek(r.originalMatchup, week))
                );
                matchupEntries.forEach((e) => {
                    if (SEMI_MATCHUP_ID_SET.has(e.id)) e.isSemi = true;
                });
                }
            }
            } catch (err) {
            console.warn("[newsletter.js] Championship odds computation error:", err);
            }
        }
    
        // -------------- BUILD MODELS + RENDER --------------
        CURRENT_MATCHUP_ENTRIES = matchupEntries;
        const mode = isHistoricalWeek ? "results" : "projections";
        const matchupModels = buildMatchupModels(matchupEntries, week, {
            mode,
            rosterById,
        });
        CURRENT_MATCHUP_MODELS = matchupModels;

    
        if (!matchupModels.length) {
            if (matchupsContainer)
            matchupsContainer.innerHTML = `<article class="matchup-card"><div class="matchup-header">
                <div class="matchup-teams">No projectable matchups</div></div>
                <div class="matchup-scores small">Missing projection data.</div></article>`;
            if (newsletterContent)
            newsletterContent.innerHTML = `<p>No projectable matchups.</p>`;
            // Season tab render (do NOT rewrite #season-overview-root from newsletter.js)
            if (window.SeasonOverview?.renderForWeek) {
                window.SeasonOverview.renderForWeek(bundle, week);
            }
            if (window.PlayoffsBracket?.renderFromBundle) {
                window.PlayoffsBracket.renderFromBundle(bundle, week);
            }
            
            // Broadcast bundle for any other modules
            window.dispatchEvent(new CustomEvent("playoffhub:bundle", { detail: { bundle, week } }));
            
            return;
        }
    
        // Recaps (results weeks only)
        let recapById = null;
        if (mode === "results" && window.PhraseEngine?.init) {
            try {
            await window.PhraseEngine.init();
            if (window.PhraseEngine.beginWeek)
                window.PhraseEngine.beginWeek(week);
    
            recapById = {};
            const allScores = (snapshot.matchups || [])
                .flatMap((m) => (m.teams || []).map((t) => Number(t.score)))
                .filter((v) => Number.isFinite(v));
    
            matchupEntries.forEach((entry) => {
                const model = matchupModels.find((m) => m.id === entry.id);
                if (!model) return;
    
                const teams = entry.teams || [];
                const a = teams[0] || {};
                const b = teams[1] || {};
                const recap = window.PhraseEngine.buildResultSentence({
                model,
                entry,
                week,
                leagueName,
                rawMatchupA: a,
                rawMatchupB: b,
                rosterA: rosterById[a.rosterId],
                rosterB: rosterById[b.rosterId],
                allScoresThisWeek: allScores,
                });
                if (recap) recapById[model.id] = recap;
            });
            } catch (err) {
            console.warn("[newsletter.js] PhraseEngine error:", err);
            }
        }
    
        // Left panel: Matchup list
        if (matchupsContainer) {
            matchupsContainer.innerHTML = matchupModels
            .map((m) => renderMatchupCard(m))
            .join("");
            matchupsContainer.onclick = (e) => {
            const card = e.target.closest(".matchup-card");
            if (!card?.dataset.matchupId) return;
            showDetailForMatchup(card.dataset.matchupId);
            matchupsContainer
                .querySelectorAll(".matchup-card")
                .forEach((c) => c.classList.remove("selected"));
            card.classList.add("selected");
            };
        }
    
        // Main newsletter content
        if (newsletterContent) {
            newsletterContent.innerHTML = buildNewsletterHtml(leagueName, week, matchupModels, {
            mode,
            recapById,
            });
            newsletterContent.onclick = (e) => {
            const card = e.target.closest(".matchup-card");
            if (!card?.dataset.matchupId) return;
            showDetailForMatchup(card.dataset.matchupId);
            newsletterContent
                .querySelectorAll(".matchup-card")
                .forEach((c) => c.classList.remove("selected"));
            card.classList.add("selected");
            };
        }
    
        // Top + bottom summary
        setWeekBrief(leagueName, week, mode, matchupModels);
        renderLeaguePulse(matchupModels, champObj, mode);
        // Season tab render (do NOT rewrite #season-overview-root from newsletter.js)
        if (window.SeasonOverview?.renderForWeek) {
            window.SeasonOverview.renderForWeek(bundle, week);
        }
        if (window.PlayoffsBracket?.renderFromBundle) {
            window.PlayoffsBracket.renderFromBundle(bundle, week);
        }
        
        // Broadcast bundle for any other modules
        window.dispatchEvent(new CustomEvent("playoffhub:bundle", { detail: { bundle, week } }));
        
    
        if (window.PlayoffInsightsApp?.renderFromBundle)
            window.PlayoffInsightsApp.renderFromBundle();
    
        } catch (err) {
        console.error("[newsletter.js] loadWeek error:", err);
        const msg = err?.message || "Unknown error";
    
        if (matchupsContainer)
            matchupsContainer.innerHTML = `<article class="matchup-card"><div class="matchup-header">
            <div class="matchup-teams">Error loading data</div></div>
            <div class="matchup-scores small">${escapeHtml(msg)}</div></article>`;
        if (newsletterContent)
            newsletterContent.innerHTML = `<p>Error pulling projections. Check console.</p>`;
        }
    }
    
    // ============================================================
    // App Bootstrap
    // ============================================================
    
    async function init() {
        const cfg = window.LEAGUE_CONFIG || {};
        const uiCfg = cfg.ui || {};
        const seasonCfg = cfg.season || {};
    
        const weekSelect = $("#week-select");
        const refreshBtn = $("#refresh-btn");
    
        const maxWeeks = uiCfg.maxWeeksSelectable || 17;
        const defaultWeek =
        cfg.SEMIFINAL_WEEK ||
        (cfg.playoff && cfg.playoff.semifinalWeek) ||
        seasonCfg.defaultWeek ||
        16;
    
        if (weekSelect) {
        weekSelect.innerHTML = "";
        for (let w = 1; w <= maxWeeks; w++) {
            const opt = document.createElement("option");
            opt.value = String(w);
            opt.textContent = "Week " + w;
            if (w === Number(defaultWeek)) opt.selected = true;
            weekSelect.appendChild(opt);
        }
        weekSelect.addEventListener("change", () => {
            const val = parseInt(weekSelect.value, 10);
            if (Number.isFinite(val)) loadWeek(val);
        });
        }
    
        if (refreshBtn) {
        refreshBtn.addEventListener("click", () => {
            const val =
            weekSelect && Number.isFinite(parseInt(weekSelect.value, 10))
                ? parseInt(weekSelect.value, 10)
                : Number(defaultWeek);
            loadWeek(val);
        });
        }
    
        const initialWeek =
        (weekSelect && parseInt(weekSelect.value, 10)) || Number(defaultWeek);
        if (Number.isFinite(initialWeek)) loadWeek(initialWeek);
    }
    
    document.addEventListener("DOMContentLoaded", init);
    
    window.PlayoffNewsletterApp = {
        loadWeek,
        refresh: () => {
        const weekSelect = $("#week-select");
        const w =
            (weekSelect && parseInt(weekSelect.value, 10)) ||
            (window.LEAGUE_CONFIG &&
            (window.LEAGUE_CONFIG.SEMIFINAL_WEEK ||
                (window.LEAGUE_CONFIG.playoff &&
                window.LEAGUE_CONFIG.playoff.semifinalWeek))) ||
            16;
        return loadWeek(w);
        },
        showDetailForMatchup,
        renderRosterDetail,
    };
    
    })();
  