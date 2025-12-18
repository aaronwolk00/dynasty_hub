// newsletter.js
// -----------------------------------------------------------------------------
// Dynasty Playoff Hub – Newsletter + matchup list + matchup detail rail
//
// Key UX goals this version supports:
//   • No duplicate matchup list (rendered once into #matchups-container)
//   • Right-rail detail pane with Starters / All toggle
//   • “Open Summary” dialog (placeholder now; you can swap in Supabase text later)
//   • Internal scrolling panes so the page itself doesn’t need to scroll at 100% zoom
//   • Optional Supabase-driven recap phrases via window.PhraseEngine (results weeks)
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    // -----------------------
    // DOM helpers
    // -----------------------
  
    function $(selector, root) {
      if (root === void 0) root = document;
      return root.querySelector(selector);
    }
  
    function escapeHtml(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return (
          {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          }[c] || c
        );
      });
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
  
    // -----------------------
    // Shared state
    // -----------------------
  
    let CURRENT_WEEK = null;
    let CURRENT_MATCHUP_ENTRIES = []; // entries with ids + matchup data
    let CURRENT_SEASON_AVG = {}; // playerId -> avg
    let CURRENT_SELECTED_MATCHUP_ID = null;
  
    // Detail filter: "starters" | "all"
    let DETAIL_MODE = "starters";
  
    // -----------------------
    // Column toggles for detail tables
    // -----------------------
  
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
  
    // -----------------------
    // Averages + last N
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
            if (!Number.isFinite(val) || val <= 0) return; // ignore DNP-ish
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
  
    // Historical week heuristic
    function inferHistoricalWeek(matchups) {
      if (!matchups || !matchups.length) return false;
      return matchups.every((m) => {
        const pts = m.players_points || {};
        return Object.values(pts).some((v) => Number(v) > 0);
      });
    }
  
    // -----------------------
    // Records helper
    // -----------------------
  
    function formatRosterRecord(roster) {
      const s = roster && roster.settings ? roster.settings : roster;
      const w = Number(s && (s.wins != null ? s.wins : s.w));
      const l = Number(s && (s.losses != null ? s.losses : s.l));
      const t = Number(s && (s.ties != null ? s.ties : s.t));
  
      if (!Number.isFinite(w) || !Number.isFinite(l)) return "—";
      if (Number.isFinite(t) && t > 0) return w + "-" + l + "-" + t;
      return w + "-" + l;
    }
  
    // -----------------------
    // Matchup ids + round labels
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
    // UI: header + summary dialog wiring
    // -----------------------
  
    function setWeekHeader(leagueName, week, mode) {
      const titleEl = $("#newsletter-week-title");
      const subEl = $("#newsletter-week-subtitle");
  
      const baseTitle =
        mode === "results" ? "Week " + week + " Results" : "Week " + week + " Matchups";
      const titleLine = leagueName ? baseTitle + " – " + leagueName : baseTitle;
  
      const intro =
        mode === "results"
          ? "Final scores are in. Click a matchup for player detail."
          : "Projections are in. Click a matchup for player detail.";
  
      if (titleEl) titleEl.textContent = titleLine;
      if (subEl) subEl.textContent = intro;
    }
  
    function ensureSummaryDialogWired() {
      const btn = $("#open-summary-btn");
      const dlg = $("#summary-dialog");
      const closeBtn = $("#summary-dialog-close");
  
      if (!btn || !dlg) return;
  
      if (!btn.__wired) {
        btn.__wired = true;
        btn.addEventListener("click", () => {
          if (typeof dlg.showModal === "function") dlg.showModal();
          else dlg.setAttribute("open", "open");
        });
      }
  
      if (closeBtn && !closeBtn.__wired) {
        closeBtn.__wired = true;
        closeBtn.addEventListener("click", () => {
          if (typeof dlg.close === "function") dlg.close();
          else dlg.removeAttribute("open");
        });
      }
    }
  
    function setSummaryDialog(leagueName, week, lines) {
      const title = $("#summary-dialog-title");
      const body = $("#summary-dialog-body");
  
      if (title) title.textContent = (leagueName ? leagueName + " — " : "") + "Week " + week;
  
      if (!body) return;
  
      if (!lines || !lines.length) {
        body.innerHTML =
          "<p><strong>Coming soon:</strong> your 3–4 sentence week blurb.</p>" +
          "<p class='small'>For now, this space can show recap sentences on results weeks.</p>";
        return;
      }
  
      body.innerHTML =
        "<div>" +
        lines
          .map((s) => "<p style='margin:6px 0;'>" + escapeHtml(s) + "</p>")
          .join("") +
        "</div>";
    }
  
    function setWeekBriefBlurb(text) {
      const el = $("#week-brief-blurb");
      if (!el) return;
      el.textContent = text || "—";
    }
  
    // -----------------------
    // Detail filter wiring
    // -----------------------
  
    function ensureDetailFilterWired() {
      const startersBtn = $("#detail-filter-starters");
      const allBtn = $("#detail-filter-all");
  
      function setMode(next) {
        DETAIL_MODE = next === "all" ? "all" : "starters";
  
        if (startersBtn) startersBtn.classList.toggle("active", DETAIL_MODE === "starters");
        if (allBtn) allBtn.classList.toggle("active", DETAIL_MODE === "all");
  
        if (CURRENT_SELECTED_MATCHUP_ID) {
          const entry = findMatchupEntryById(CURRENT_SELECTED_MATCHUP_ID);
          if (entry) renderMatchupDetail(entry);
        }
      }
  
      if (startersBtn && !startersBtn.__wired) {
        startersBtn.__wired = true;
        startersBtn.addEventListener("click", () => setMode("starters"));
      }
      if (allBtn && !allBtn.__wired) {
        allBtn.__wired = true;
        allBtn.addEventListener("click", () => setMode("all"));
      }
    }
  
    // -----------------------
    // Matchup models (for cards)
    // -----------------------
  
    function buildMatchupModels(entries, week, options) {
      options = options || {};
      const mode = options.mode || "projections";
      const rosterById = options.rosterById || {};
  
      return entries
        .map((entry, idx) => {
          // Results mode
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
  
            const rosterA = rosterById[teamAView.rosterId];
            const rosterB = rosterById[teamBView.rosterId];
  
            return {
              id: entry.id || "matchup-" + (idx + 1),
              week,
              roundLabel: entry.roundLabel || "Week " + week,
              bestOf: entry.bestOf || 1,
              mode: "results",
              nameA,
              nameB,
              recordA: formatRosterRecord(rosterA),
              recordB: formatRosterRecord(rosterB),
              muA,
              muB,
              rangeA: { low: muA, high: muA },
              rangeB: { low: muB, high: muB },
              winA,
              winB,
              favoriteName: null,
              favoriteWinProb: null,
              underdogName: null,
              impliedSpread: formatSpread(muA, muB, nameA, nameB),
              impliedTotal: formatTotal(muA, muB),
            };
          }
  
          // Projection mode
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
            return { low: Math.max(0, mu - k * sd), high: mu + k * sd };
          }
  
          const rangeA = makeRange(muA, sdA, tA.projection.rangeLow, tA.projection.rangeHigh);
          const rangeB = makeRange(muB, sdB, tB.projection.rangeLow, tB.projection.rangeHigh);
  
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
  
          // rosterId discovery (best-effort)
          const rosterIdA = tA.team.rosterId || tA.team.roster_id || null;
          const rosterIdB = tB.team.rosterId || tB.team.roster_id || null;
  
          const rosterA = rosterIdA != null ? rosterById[rosterIdA] : null;
          const rosterB = rosterIdB != null ? rosterById[rosterIdB] : null;
  
          return {
            id: entry.id || "matchup-" + (idx + 1),
            week,
            roundLabel: entry.roundLabel || "Week " + week,
            bestOf: entry.bestOf || 1,
            mode,
            nameA,
            nameB,
            recordA: formatRosterRecord(rosterA),
            recordB: formatRosterRecord(rosterB),
            muA,
            muB,
            rangeA,
            rangeB,
            winA,
            winB,
            favoriteName,
            favoriteWinProb,
            underdogName,
            impliedSpread: formatSpread(muA, muB, nameA, nameB),
            impliedTotal: formatTotal(muA, muB),
          };
        })
        .filter(Boolean);
    }
  
    function renderMatchupCard(model) {
      const isResults = model.mode === "results";
      const label = isResults ? "final" : "proj";
  
      const nameA = escapeHtml(model.nameA);
      const nameB = escapeHtml(model.nameB);
  
      const winner =
        isResults && Number.isFinite(model.muA) && Number.isFinite(model.muB)
          ? model.muA > model.muB
            ? "A"
            : model.muB > model.muA
            ? "B"
            : null
          : null;
  
      const favTagA =
        !isResults && model.favoriteName === model.nameA
          ? '<span class="tag tag-favorite">Fav</span>'
          : "";
      const favTagB =
        !isResults && model.favoriteName === model.nameB
          ? '<span class="tag tag-favorite">Fav</span>'
          : "";
  
      const sideAClass =
        "matchup-score-side" + (winner === "A" ? " winner" : winner === "B" ? " loser" : "");
      const sideBClass =
        "matchup-score-side" + (winner === "B" ? " winner" : winner === "A" ? " loser" : "");
  
      const rangeTextA =
        !isResults && model.rangeA && Number.isFinite(model.rangeA.low) && Number.isFinite(model.rangeA.high)
          ? " (" + formatRange(model.rangeA.low, model.rangeA.high) + ")"
          : "";
      const rangeTextB =
        !isResults && model.rangeB && Number.isFinite(model.rangeB.low) && Number.isFinite(model.rangeB.high)
          ? " (" + formatRange(model.rangeB.low, model.rangeB.high) + ")"
          : "";
  
      let metaLine;
      if (isResults) {
        metaLine =
          "Final • " +
          escapeHtml(model.recordA) +
          " vs " +
          escapeHtml(model.recordB) +
          " • Total " +
          formatTotal(model.muA, model.muB);
      } else {
        metaLine =
          "Win odds: " +
          nameA +
          " " +
          formatPercent(model.winA) +
          ", " +
          nameB +
          " " +
          formatPercent(model.winB) +
          " • Line: " +
          escapeHtml(model.impliedSpread) +
          " • Total: " +
          escapeHtml(model.impliedTotal);
      }
  
      return (
        '<article class="matchup-card" data-matchup-id="' +
        escapeHtml(model.id) +
        '">' +
        '<div class="matchup-header">' +
        '<div class="matchup-teams">' +
        nameA +
        " <span class='nm-vs'>vs</span> " +
        nameB +
        "</div>" +
        '<div class="matchup-meta">' +
        escapeHtml(model.roundLabel || "Week") +
        "</div>" +
        "</div>" +
        '<div class="matchup-scores-row">' +
        '<div class="' +
        sideAClass +
        '">' +
        '<div class="matchup-score-line">' +
        '<span class="matchup-score-main">' +
        formatScore(model.muA) +
        "</span>" +
        '<span class="matchup-score-label">' +
        label +
        "</span>" +
        "</div>" +
        (rangeTextA ? '<div class="matchup-score-range small">' + escapeHtml(rangeTextA) + "</div>" : "") +
        '<div class="small" style="margin-top:2px;color:var(--text-soft);">' +
        escapeHtml(model.recordA || "—") +
        "</div>" +
        (favTagA ? '<div class="matchup-chip-row">' + favTagA + "</div>" : "") +
        "</div>" +
        '<div class="' +
        sideBClass +
        '">' +
        '<div class="matchup-score-line">' +
        '<span class="matchup-score-main">' +
        formatScore(model.muB) +
        "</span>" +
        '<span class="matchup-score-label">' +
        label +
        "</span>" +
        "</div>" +
        (rangeTextB ? '<div class="matchup-score-range small">' + escapeHtml(rangeTextB) + "</div>" : "") +
        '<div class="small" style="margin-top:2px;color:var(--text-soft);text-align:right;">' +
        escapeHtml(model.recordB || "—") +
        "</div>" +
        (favTagB ? '<div class="matchup-chip-row">' + favTagB + "</div>" : "") +
        "</div>" +
        "</div>" +
        '<div class="matchup-meta matchup-meta-bottom small">' +
        metaLine +
        "</div>" +
        "</article>"
      );
    }
  
    // -----------------------
    // Matchup detail
    // -----------------------
  
    function findMatchupEntryById(id) {
      return CURRENT_MATCHUP_ENTRIES.find((m) => m.id === id) || null;
    }
  
    function renderMatchupDetail(entry) {
      const container = $("#matchup-detail-container");
      if (!container || !entry) return;
  
      const title = $("#detail-title");
      const playerMap = window.__SLEEPER_PLAYER_MAP__ || {};
  
      function getPlayerId(p) {
        return (p && (p.playerId || p.player_id || p.id)) ? String(p.playerId || p.player_id || p.id) : "";
      }
  
      function getPlayerName(p) {
        if (!p) return "";
        if (p.displayName) return p.displayName;
        const id = getPlayerId(p);
        const meta = playerMap[id];
        return (meta && meta.full_name) ? meta.full_name : id;
      }
  
      function getPlayerTeam(p) {
        if (!p) return "";
        if (p.nflTeam) return p.nflTeam;
        const id = getPlayerId(p);
        const meta = playerMap[id];
        return meta && meta.team ? meta.team : "";
      }
  
      // Results mode
      if (entry.historical && entry.teams && entry.teams.length >= 2) {
        const teamA = entry.teams[0];
        const teamB = entry.teams[1];
  
        const teamAName = teamA.team.teamDisplayName;
        const teamBName = teamB.team.teamDisplayName;
  
        if (title) title.textContent = teamAName + " vs " + teamBName;
  
        function pickPlayers(teamView) {
          if (!teamView) return [];
          if (DETAIL_MODE === "all") {
            return teamView.players || teamView.allPlayers || teamView.starters || [];
          }
          return teamView.starters || [];
        }
  
        function buildTeamTableResults(teamView) {
          const list = pickPlayers(teamView);
  
          const rows = list
            .map((p) => {
              const id = getPlayerId(p);
              const pts = Number(p.fantasyPoints);
              const seasonAvg = CURRENT_SEASON_AVG[id] != null ? CURRENT_SEASON_AVG[id] : null;
              const last5 = getPlayerLastNAvg(id, CURRENT_WEEK, 5);
  
              return (
                "<tr>" +
                "<td>" + escapeHtml(p.position || "") + "</td>" +
                "<td>" + escapeHtml(getPlayerName(p)) + "</td>" +
                '<td data-col="team">' + escapeHtml(getPlayerTeam(p)) + "</td>" +
                '<td data-col="score">' + escapeHtml(formatScore(pts, 1)) + "</td>" +
                '<td data-col="seasonAvg">' + escapeHtml(seasonAvg != null ? formatScore(seasonAvg, 1) : "–") + "</td>" +
                '<td data-col="last5">' + escapeHtml(last5 != null ? formatScore(last5, 1) : "–") + "</td>" +
                "</tr>"
              );
            })
            .join("");
  
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
            rows +
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
  
      // Projection mode
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
  
      if (title) title.textContent = teamAName + " vs " + teamBName;
  
      function pickProjectedPlayers(team) {
        const proj = team && team.projection ? team.projection : null;
        if (!proj) return [];
        if (DETAIL_MODE === "all") return proj.allPlayers || proj.players || [];
        return proj.starters || proj.players || [];
      }
  
      function buildTeamTableProjected(team) {
        const list = pickProjectedPlayers(team);
  
        const rows = list
          .map((p) => {
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
              "<td>" + escapeHtml(getPlayerName(p)) + "</td>" +
              '<td data-col="team">' + escapeHtml(getPlayerTeam(p)) + "</td>" +
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
          })
          .join("");
  
        return (
          '<table class="detail-table">' +
          "<thead><tr>" +
          "<th>Pos</th>" +
          "<th>Player</th>" +
          '<th data-col="team">Team</th>' +
          '<th data-col="proj">Proj</th>' +
          '<th data-col="projRange">Range</th>' +
          '<th data-col="seasonAvg">Season Avg</th>' +
          '<th data-col="last5">Last 5</th>' +
          "</tr></thead><tbody>" +
          rows +
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
      renderMatchupDetail(entry);
    }
  
    // -----------------------
    // Season overview passthrough (keep your existing renderer)
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
      // keep your existing Season tab rendering; if you already have another renderer, no-op is fine
      if (window.TeamProfile && typeof window.TeamProfile.renderSeasonOverview === "function") {
        try {
          window.TeamProfile.renderSeasonOverview(bundle, { currentWeek: CURRENT_WEEK });
          return;
        } catch (_) {}
      }
  
      const root = $("#season-overview-root");
      if (!root) return;
  
      const rows = computeSeasonStandings(bundle);
      const body = $("#season-standings-body");
      if (!body) return;
  
      body.innerHTML = rows
        .map((r) => {
          return (
            "<tr>" +
            "<td>" +
            r.rank +
            "</td>" +
            "<td>" +
            escapeHtml(r.name) +
            "</td>" +
            "<td>" +
            r.wins +
            "-" +
            r.losses +
            (r.ties ? "-" + r.ties : "") +
            "</td>" +
            "<td>" +
            escapeHtml(formatPercent(r.winPct, 1)) +
            "</td>" +
            "<td>" +
            escapeHtml(formatScore(r.pf, 1)) +
            "</td>" +
            "<td>" +
            escapeHtml(formatScore(r.pa, 1)) +
            "</td>" +
            "<td>" +
            (r.diff >= 0 ? "+" : "") +
            escapeHtml(formatScore(r.diff, 1)) +
            "</td>" +
            "</tr>"
          );
        })
        .join("");
    }
  
    // -----------------------
    // Extras: championship odds (optional)
    // -----------------------
  
    function renderChampionshipExtras(champObj) {
      const container = $("#newsletter-extras");
      if (!container) return;
  
      if (!champObj) {
        container.innerHTML = "";
        return;
      }
  
      const entries = Object.entries(champObj).sort((a, b) => {
        const pa = (a[1] && a[1].titleOdds) || 0;
        const pb = (b[1] && b[1].titleOdds) || 0;
        return pb - pa;
      });
  
      if (!entries.length) {
        container.innerHTML = "";
        return;
      }
  
      const rows = entries
        .map(([teamName, info]) => {
          const reach =
            info.path && typeof info.path.reachFinalPct === "number" ? info.path.reachFinalPct : 0;
          const titleOdds = info.titleOdds || 0;
          const line = probabilityToMoneyline(titleOdds);
  
          return (
            "<tr>" +
            "<td>" +
            escapeHtml(teamName) +
            "</td>" +
            "<td>" +
            escapeHtml(formatPercent(reach, 1)) +
            "</td>" +
            "<td>" +
            escapeHtml(formatPercent(titleOdds, 1)) +
            "</td>" +
            '<td class="small">' +
            escapeHtml(line) +
            "</td>" +
            "</tr>"
          );
        })
        .join("");
  
      container.innerHTML =
        '<section class="newsletter-card newsletter-champ-card">' +
        "<h3>Championship Picture</h3>" +
        '<p class="small">Title odds from simulating the bracket forward (for fun):</p>' +
        '<table class="odds-table"><thead><tr>' +
        "<th>Team</th><th>Reach Final</th><th>Win Title</th><th>Implied Line</th>" +
        "</tr></thead><tbody>" +
        rows +
        "</tbody></table>" +
        "</section>";
    }
  
    // -----------------------
    // Core loader
    // -----------------------
  
    async function loadWeek(week) {
      const matchupsContainer = $("#matchups-container");
      const subtitle = $("#league-subtitle");
      const cfg = window.LEAGUE_CONFIG || {};
  
      CURRENT_WEEK = week;
      CURRENT_MATCHUP_ENTRIES = [];
      CURRENT_SELECTED_MATCHUP_ID = null;
  
      ensureDetailFilterWired();
      ensureSummaryDialogWired();
  
      if (matchupsContainer) {
        matchupsContainer.innerHTML = '<div class="loading">Loading Week ' + week + "…</div>";
      }
  
      try {
        if (!window.SleeperClient) {
          throw new Error("SleeperClient missing. Ensure sleeper_client.js is loaded before newsletter.js.");
        }
        if (!window.LeagueModels || !window.ProjectionEngine) {
          throw new Error("LeagueModels / ProjectionEngine missing. Check models.js and projections.js load order.");
        }
  
        // Fetch weeks 1..week (season averages + standings)
        const weeksToFetch = [];
        for (let w = 1; w <= week; w++) weeksToFetch.push(w);
  
        const bundle = await window.SleeperClient.fetchLeagueBundle({ weeks: weeksToFetch });
        window.__LAST_BUNDLE__ = bundle;
  
        const league = bundle.league || {};
        const leagueName = league.name || "Sleeper League";
        const season = league.season || (cfg.season && cfg.season.year) || "";
  
        if (subtitle) subtitle.textContent = leagueName + " • Season " + season + " • Week " + week;
  
        CURRENT_SEASON_AVG = computeSeasonAverages(bundle, week);
        window.__SEASON_AVG_BY_PLAYER_ID__ = CURRENT_SEASON_AVG;
  
        // Snapshot for this week (optional persistence)
        const snapshot = {
          league,
          users: bundle.users || [],
          rosters: bundle.rosters || [],
          matchups: (bundle.matchupsByWeek && bundle.matchupsByWeek[week]) || [],
          winnersBracket: bundle.winnersBracket || [],
          week: week,
        };
  
        if (window.SleeperClient && typeof window.SleeperClient.persistSnapshotToSupabase === "function") {
          window.SleeperClient.persistSnapshotToSupabase(snapshot, { source: "newsletter_loadWeek" }).catch(function () {});
        }
  
        const rosterById = {};
        (snapshot.rosters || []).forEach((r) => {
          rosterById[r.roster_id] = r;
        });
  
        const playerMap = window.__SLEEPER_PLAYER_MAP__ || null;
        const semiWeek =
          cfg.SEMIFINAL_WEEK || (cfg.playoff && cfg.playoff.semifinalWeek) || null;
  
        let weeklyMatchups =
          window.LeagueModels.buildAllMatchupsForWeek(snapshot, playerMap) || [];
  
        const isHistoricalWeek = inferHistoricalWeek(snapshot.matchups);
  
        // If semifinal week and not historical, prefer bracket-based matchups
        if (!isHistoricalWeek && semiWeek && week === Number(semiWeek)) {
          const playoffMatchups =
            window.LeagueModels.buildPlayoffMatchups(snapshot, cfg, { week, playerMap }) || [];
          if (playoffMatchups.length) weeklyMatchups = playoffMatchups;
        }
  
        if (!weeklyMatchups.length) {
          if (matchupsContainer) {
            matchupsContainer.innerHTML =
              '<div class="small">No matchups found for Week ' + week + ".</div>";
          }
          setWeekHeader(leagueName, week, "projections");
          setWeekBriefBlurb("No matchups detected for this week.");
          setSummaryDialog(leagueName, week, []);
          renderChampionshipExtras(null);
          renderSeasonOverview(bundle);
          return;
        }
  
        // Build entries
        const mode = isHistoricalWeek ? "results" : "projections";
        setWeekHeader(leagueName, week, mode);
  
        let matchupEntries = [];
        let champObj = null;
  
        if (isHistoricalWeek) {
          matchupEntries = weeklyMatchups.map((m, idx) => {
            const id = computeMatchupIdForWeek(m, week) || "week" + week + "_m_fallback" + (idx + 1);
            return {
              id,
              roundLabel: getRoundLabelFromConfig(cfg, week),
              bestOf: 1,
              historical: true,
              teams: m.teams,
            };
          });
        } else {
          for (let i = 0; i < weeklyMatchups.length; i++) {
            const m = weeklyMatchups[i];
            const projectedMatchup = window.ProjectionEngine.projectMatchup(m);
            if (!projectedMatchup || !projectedMatchup.projected) continue;
  
            const sim = window.ProjectionEngine.simulateMatchup(projectedMatchup, {
              sims: 15000,
              trackScores: false,
            });
            if (!sim) continue;
  
            const id = computeMatchupIdForWeek(m, week) || "week" + week + "_m_fallback" + (i + 1);
  
            matchupEntries.push({
              id,
              roundLabel: getRoundLabelFromConfig(cfg, week),
              bestOf: m.bestOf || 1,
              projectedMatchup,
              sim,
            });
          }
  
          // Optional championship odds only for semifinal week (kept from your prior logic)
          try {
            if (semiWeek && week === Number(semiWeek)) {
              const semiMatchups =
                window.LeagueModels.buildPlayoffMatchups(snapshot, cfg, { week, playerMap }) || [];
  
              if (semiMatchups.length >= 2) {
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
                  .filter((r) => r && r.projected && r.projected.projected && r.sim);
  
                if (semiResults.length >= 2) {
                  // (same finalsMatrix + computeChampionshipOdds approach)
                  const finalsMatrix = (function buildFinalsMatrix(semiWithSims) {
                    function erf(x) {
                      const sign = x < 0 ? -1 : 1;
                      x = Math.abs(x);
                      const a1 = 0.254829592;
                      const a2 = -0.284496736;
                      const a3 = 1.421413741;
                      const a4 = -1.453152027;
                      const a5 = 1.061405429;
                      const p = 0.3275911;
                      const t = 1 / (1 + p * x);
                      const y =
                        1 -
                        (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
                      return sign * y;
                    }
                    function normalCdf(x) {
                      return 0.5 * (1 + erf(x / Math.sqrt(2)));
                    }
  
                    const teams = {};
                    semiWithSims.forEach((m0) => {
                      const a = m0.projected.projected.teamA;
                      const b = m0.projected.projected.teamB;
                      teams[a.team.teamDisplayName] = { mean: a.projection.totalMean, sd: a.projection.totalSd };
                      teams[b.team.teamDisplayName] = { mean: b.projection.totalMean, sd: b.projection.totalSd };
                    });
  
                    const names = Object.keys(teams);
                    const matrix = {};
                    names.forEach((nameA) => {
                      matrix[nameA] = {};
                      names.forEach((nameB) => {
                        if (nameA === nameB) return;
                        const tA = teams[nameA];
                        const tB = teams[nameB];
                        const muDiff = tA.mean - tB.mean;
                        const varDiff = tA.sd * tA.sd + tB.sd * tB.sd || 1;
                        const z = muDiff / Math.sqrt(varDiff);
                        matrix[nameA][nameB] = normalCdf(z);
                      });
                    });
                    return matrix;
                  })(semiResults);
  
                  champObj = window.ProjectionEngine.computeChampionshipOdds(
                    semiResults[0],
                    semiResults[1],
                    finalsMatrix
                  );
                }
              }
            }
          } catch (_) {}
        }
  
        CURRENT_MATCHUP_ENTRIES = matchupEntries;
  
        const matchupModels = buildMatchupModels(matchupEntries, week, {
          mode,
          rosterById,
        });
  
        if (!matchupModels.length) {
          if (matchupsContainer) {
            matchupsContainer.innerHTML =
              '<div class="small">Matchups detected, but projections/results could not be generated.</div>';
          }
          setWeekBriefBlurb("No projectable matchups for this week.");
          setSummaryDialog(leagueName, week, []);
          renderChampionshipExtras(null);
          renderSeasonOverview(bundle);
          return;
        }
  
        // Recap phrases (results only)
        let recapLines = [];
        if (mode === "results" && window.PhraseEngine && typeof window.PhraseEngine.init === "function") {
          try {
            await window.PhraseEngine.init();
            if (typeof window.PhraseEngine.beginWeek === "function") window.PhraseEngine.beginWeek(week);
  
            const allScoresThisWeek = (snapshot.matchups || [])
              .flatMap((m) => (m.teams || []).map((t) => Number(t.score)).filter((v) => Number.isFinite(v)));
  
            matchupEntries.forEach((entry) => {
              const model = matchupModels.find((m) => m.id === entry.id);
              if (!model) return;
  
              const teams = entry.teams || [];
              const rawMatchupA = teams[0] || null;
              const rawMatchupB = teams[1] || null;
  
              const rosterA = rawMatchupA && rosterById[rawMatchupA.rosterId] ? rosterById[rawMatchupA.rosterId] : null;
              const rosterB = rawMatchupB && rosterById[rawMatchupB.rosterId] ? rosterById[rawMatchupB.rosterId] : null;
  
              const recap = window.PhraseEngine.buildResultSentence({
                model,
                entry,
                week,
                leagueName,
                rawMatchupA,
                rawMatchupB,
                rosterA,
                rosterB,
                allScoresThisWeek,
              });
  
              if (recap) recapLines.push(recap);
            });
          } catch (_) {}
        }
  
        // Week brief blurb (placeholder now, swap later with your Supabase 3–4 sentences)
        if (mode === "results") {
          setWeekBriefBlurb(recapLines.length ? "Top storylines from this week are ready in Open Summary." : "Results are in.");
        } else {
          setWeekBriefBlurb("Snapshot preview: projected points, win odds, and who’s trending.");
        }
  
        // Summary dialog content
        setSummaryDialog(leagueName, week, recapLines);
  
        // Render matchup list (single source of truth)
        if (matchupsContainer) {
          matchupsContainer.innerHTML = matchupModels.map(renderMatchupCard).join("");
  
          matchupsContainer.onclick = (e) => {
            const card = e.target.closest(".matchup-card");
            if (!card || !card.dataset.matchupId) return;
  
            const id = card.dataset.matchupId;
            CURRENT_SELECTED_MATCHUP_ID = id;
  
            showDetailForMatchup(id);
  
            matchupsContainer.querySelectorAll(".matchup-card").forEach((c) => c.classList.remove("selected"));
            card.classList.add("selected");
          };
        }
  
        // Extras (no “bottom charts” here)
        renderChampionshipExtras(mode === "results" ? null : champObj);
  
        // Season tab refresh
        renderSeasonOverview(bundle);
  
        // Default-select the first matchup to avoid the empty “smushed” rail
        if (matchupModels.length && !CURRENT_SELECTED_MATCHUP_ID) {
          CURRENT_SELECTED_MATCHUP_ID = matchupModels[0].id;
          const firstEntry = findMatchupEntryById(CURRENT_SELECTED_MATCHUP_ID);
          if (firstEntry) renderMatchupDetail(firstEntry);
  
          const firstCard = matchupsContainer && matchupsContainer.querySelector('.matchup-card[data-matchup-id="' + CSS.escape(CURRENT_SELECTED_MATCHUP_ID) + '"]');
          if (firstCard) firstCard.classList.add("selected");
        }
      } catch (err) {
        console.error("[newsletter.js] loadWeek error:", err);
  
        setWeekBriefBlurb("Error loading data.");
        setSummaryDialog("—", week, []);
  
        if (matchupsContainer) {
          matchupsContainer.innerHTML =
            '<div class="small">Error loading data from Sleeper. Check console for details.</div>';
        }
      }
  
      // Insights hook
      if (window.PlayoffInsightsApp && typeof window.PlayoffInsightsApp.renderFromBundle === "function") {
        try {
          window.PlayoffInsightsApp.renderFromBundle();
        } catch (_) {}
      }
    }
  
    // -----------------------
    // Bootstrap
    // -----------------------
  
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
  
      ensureDetailFilterWired();
      ensureSummaryDialogWired();
  
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
          const val = weekSelect ? parseInt(weekSelect.value, 10) : Number(defaultWeek);
          if (Number.isFinite(val)) loadWeek(val);
        });
      }
  
      const initialWeek = (weekSelect && parseInt(weekSelect.value, 10)) || Number(defaultWeek);
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
              (window.LEAGUE_CONFIG.playoff && window.LEAGUE_CONFIG.playoff.semifinalWeek))) ||
          16;
        return loadWeek(w);
      },
      showDetailForMatchup,
    };
  })();
  