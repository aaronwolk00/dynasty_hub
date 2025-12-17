// newsletter.js
// -----------------------------------------------------------------------------
// Wolk Dynasty – Playoff Hub bootstrap + newsletter rendering
//
// Now supports:
//   - All matchups in a given week (reg season + playoffs)
//   - Historical weeks: show final scores only (no projections/sims)
//   - Future/current weeks: projections + Monte Carlo sims
//   - Season-average fallback projections
//   - Matchup Detail with per-player scores and Last 5
//   - Optional Supabase-driven recap phrases via window.PhraseEngine
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
  
    // -----------------------
    // Shared state
    // -----------------------
  
    let CURRENT_WEEK = null;
    let CURRENT_MATCHUP_ENTRIES = []; // [ { historical?, projectedMatchup?, teams? } ]
    let CURRENT_SEASON_AVG = {};      // { playerId -> avg }
  
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
            if (!accum[pid]) {
              accum[pid] = { sum: 0, count: 0 };
            }
            accum[pid].sum += val;
            accum[pid].count += 1;
          });
        });
      });
  
      const avg = {};
      Object.keys(accum).forEach((pid) => {
        const entry = accum[pid];
        if (entry.count > 0) {
          avg[pid] = entry.sum / entry.count;
        }
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
  
    // Historical week heuristic: if every matchup has at least one player
    // with > 0 pts, we consider it "played".
    function inferHistoricalWeek(matchups) {
      if (!matchups || !matchups.length) return false;
      return matchups.every((m) => {
        const pts = m.players_points || {};
        return Object.values(pts).some((v) => Number(v) > 0);
      });
    }
  
    // -----------------------
    // Matchup models for UI
    // -----------------------
  
    function buildMatchupModels(entries, week, options) {
      options = options || {};
      const mode = options.mode || "projections"; // "projections" | "results"
  
      return entries
        .map((entry, idx) => {
          if (entry.historical && entry.teams && entry.teams.length >= 2) {
            const teamAView = entry.teams[0];
            const teamBView = entry.teams[1];
  
            if (!teamAView || !teamBView) return null;
  
            const nameA = teamAView.team.teamDisplayName;
            const nameB = teamBView.team.teamDisplayName;
  
            const muA = teamAView.score;
            const muB = teamBView.score;
  
            const winA = muA > muB ? 1 : muA < muB ? 0 : 0.5;
            const winB = muB > muA ? 1 : muB < muA ? 0 : 0.5;
  
            return {
              id: entry.id || "matchup-" + (idx + 1),
              week,
              roundLabel: entry.roundLabel || "Week " + week,
              bestOf: entry.bestOf || 1,
              mode: "results",
              nameA,
              nameB,
              muA,
              muB,
              rangeA: { low: muA, high: muA },
              rangeB: { low: muB, high: muB },
              winA,
              winB,
              favoriteName: muA > muB ? nameA : muB > muA ? nameB : null,
              favoriteWinProb: muA === muB ? null : 1,
              underdogName: muA > muB ? nameB : muB > muA ? nameA : null,
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
  
          const rangeA = {
            low: tA.projection.rangeLow,
            high: tA.projection.rangeHigh,
          };
          const rangeB = {
            low: tB.projection.rangeLow,
            high: tB.projection.rangeHigh,
          };
  
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
            mode: mode,
            nameA,
            nameB,
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
      const {
        nameA,
        nameB,
        muA,
        muB,
        rangeA,
        rangeB,
        winA,
        winB,
        impliedSpread,
        impliedTotal,
        roundLabel,
        favoriteName,
        mode,
      } = model;
  
      const isResults = mode === "results";
      const label = isResults ? "final" : "proj";
  
      const tagFavA =
        favoriteName === nameA
          ? '<span class="tag tag-favorite">Fav</span>'
          : "";
      const tagFavB =
        favoriteName === nameB
          ? '<span class="tag tag-favorite">Fav</span>'
          : "";
  
      const favClass = favoriteName ? "favorite" : "";
  
      let metaLine;
      if (isResults) {
        metaLine =
          "Final: " +
          nameA +
          " " +
          formatScore(muA) +
          ", " +
          nameB +
          " " +
          formatScore(muB) +
          ".";
      } else {
        metaLine =
          "Win odds: " +
          nameA +
          " " +
          formatPercent(winA) +
          ", " +
          nameB +
          " " +
          formatPercent(winB) +
          "<br/>" +
          "Line: " +
          impliedSpread +
          " • Total: " +
          impliedTotal;
      }
  
      return (
        '<article class="matchup-card ' +
        favClass +
        '" data-matchup-id="' +
        model.id +
        '">' +
        '<div class="matchup-header">' +
        '<div class="matchup-teams">' +
        nameA +
        " vs " +
        nameB +
        "</div>" +
        '<div class="matchup-meta">' +
        (roundLabel || "Matchup") +
        "</div>" +
        "</div>" +
        '<div class="matchup-scores">' +
        "<span>" +
        "<strong>" +
        formatScore(muA) +
        "</strong> " +
        label +
        (rangeA && !isResults
          ? " (" + formatRange(rangeA.low, rangeA.high) + ")"
          : "") +
        (tagFavA ? " " + tagFavA : "") +
        "</span>" +
        "<span>" +
        "<strong>" +
        formatScore(muB) +
        "</strong> " +
        label +
        (rangeB && !isResults
          ? " (" + formatRange(rangeB.low, rangeB.high) + ")"
          : "") +
        (tagFavB ? " " + tagFavB : "") +
        "</span>" +
        "</div>" +
        '<div class="matchup-meta" style="margin-top: 6px;">' +
        metaLine +
        "</div>" +
        "</article>"
      );
    }
  
    function buildNewsletterHtml(
      leagueName,
      week,
      matchupModels,
      champObj,
      options
    ) {
      options = options || {};
      const mode = options.mode || "projections";
      const recapById = options.recapById || null;
  
      const lines = [];
      const isResults = mode === "results";
  
      const baseTitle = isResults
        ? "Week " + week + " Results"
        : "Week " + week + " Matchups";
      const titleLine = leagueName ? baseTitle + " – " + leagueName : baseTitle;
  
      lines.push("<h3>" + titleLine + "</h3>");
  
      if (isResults) {
        lines.push(
          "<p>Final scores for Week " +
            week +
            " are in. Here’s how the matchups actually played out.</p>"
        );
      } else {
        lines.push(
          "<p>Projections for Week " +
            week +
            " are in. Here’s how the matchups stack up once we fold in your projections and a big Monte Carlo sim.</p>"
        );
      }
  
      matchupModels.forEach((m) => {
        lines.push("<h3>" + m.nameA + " vs " + m.nameB + "</h3>");
  
        if (isResults) {
          lines.push(
            "<p><strong>Final score:</strong> " +
              m.nameA +
              " " +
              formatScore(m.muA) +
              " – " +
              m.nameB +
              " " +
              formatScore(m.muB) +
              " (total " +
              m.impliedTotal +
              ").</p>"
          );
  
          // Optional Supabase-powered recap line
          if (recapById && recapById[m.id]) {
            lines.push("<p>" + recapById[m.id] + "</p>");
          }
        } else {
          lines.push(
            "<p><strong>Projected score:</strong> " +
              m.nameA +
              " " +
              formatScore(m.muA) +
              " – " +
              m.nameB +
              " " +
              formatScore(m.muB) +
              " (total " +
              m.impliedTotal +
              ", line " +
              m.impliedSpread +
              ").</p>"
          );
          lines.push(
            "<p><strong>Win odds:</strong> " +
              m.nameA +
              " " +
              formatPercent(m.winA) +
              ", " +
              m.nameB +
              " " +
              formatPercent(m.winB) +
              ". " +
              (m.favoriteName
                ? m.favoriteName +
                  " enter as the statistical favorite, but a couple of boom weeks can flip this fast."
                : "This projects as a true coin flip – every lineup call matters.") +
              "</p>"
          );
        }
      });
  
      if (!isResults && champObj) {
        const entries = Object.entries(champObj).sort((a, b) => {
          const pa = (a[1] && a[1].titleOdds) || 0;
          const pb = (b[1] && b[1].titleOdds) || 0;
          return pb - pa;
        });
  
        lines.push("<h3>Big Picture: Who’s Actually Winning This Thing?</h3>");
        lines.push(
          "<p>Simulating the bracket forward from these matchups gives the following title odds:</p>"
        );
  
        lines.push('<table class="odds-table"><thead><tr>');
        lines.push(
          "<th>Team</th><th>Reach Final</th><th>Win Title</th><th>Implied Line</th>"
        );
        lines.push("</tr></thead><tbody>");
  
        entries.forEach(([teamName, info]) => {
          const reach =
            info.path && typeof info.path.reachFinalPct === "number"
              ? info.path.reachFinalPct
              : 0;
          const titleOdds = info.titleOdds || 0;
          const line = probabilityToMoneyline(titleOdds);
  
          lines.push("<tr>");
          lines.push("<td>" + teamName + "</td>");
          lines.push("<td>" + formatPercent(reach, 1) + "</td>");
          lines.push("<td>" + formatPercent(titleOdds, 1) + "</td>");
          lines.push('<td class="small">' + line + "</td>");
          lines.push("</tr>");
        });
  
        lines.push("</tbody></table>");
        lines.push(
          '<p class="small">Implied lines are computed off the modeled probabilities and are just for fun, not a betting recommendation.</p>'
        );
      }
  
      return lines.join("\n");
    }
  
    // -----------------------
    // Matchup Detail view
    // -----------------------
  
    function findMatchupEntryById(id) {
      return CURRENT_MATCHUP_ENTRIES.find((m) => m.id === id) || null;
    }
  
    function renderMatchupDetail(entry) {
      const container = $("#matchup-detail-container");
      if (!container || !entry) return;
  
      // Historical (results) mode: show fantasy points only
      if (entry.historical && entry.teams && entry.teams.length >= 2) {
        const teamA = entry.teams[0];
        const teamB = entry.teams[1];
  
        const teamAName = teamA.team.teamDisplayName;
        const teamBName = teamB.team.teamDisplayName;
  
        function buildTeamTableResults(teamView) {
          const rows = (teamView.starters || []).map((p) => {
            const pts = Number(p.fantasyPoints);
            const seasonAvg =
              CURRENT_SEASON_AVG[p.playerId] != null
                ? CURRENT_SEASON_AVG[p.playerId]
                : null;
            const last5 = getPlayerLastNAvg(p.playerId, CURRENT_WEEK, 5);
  
            return (
              "<tr>" +
              "<td>" +
              (p.position || "") +
              "</td>" +
              "<td>" +
              (p.displayName || p.playerId) +
              "</td>" +
              "<td>" +
              (p.nflTeam || "") +
              "</td>" +
              "<td>" +
              formatScore(pts, 1) +
              "</td>" +
              "<td>" +
              (seasonAvg != null ? formatScore(seasonAvg, 1) : "–") +
              "</td>" +
              "<td>" +
              (last5 != null ? formatScore(last5, 1) : "–") +
              "</td>" +
              "</tr>"
            );
          });
  
          return (
            '<table class="detail-table">' +
            "<thead><tr>" +
            "<th>Pos</th><th>Player</th><th>Team</th>" +
            "<th>Pts</th><th>Season Avg</th><th>Last 5</th>" +
            "</tr></thead><tbody>" +
            rows.join("") +
            "</tbody></table>"
          );
        }
  
        container.innerHTML =
          '<div class="detail-layout">' +
          '<section class="detail-team">' +
          '<div class="detail-team-header">' +
          "<span>" +
          teamAName +
          "</span>" +
          '<span class="small">Team score: ' +
          formatScore(teamA.score, 1) +
          "</span>" +
          "</div>" +
          buildTeamTableResults(teamA) +
          "</section>" +
          '<section class="detail-team">' +
          '<div class="detail-team-header">' +
          "<span>" +
          teamBName +
          "</span>" +
          '<span class="small">Team score: ' +
          formatScore(teamB.score, 1) +
          "</span>" +
          "</div>" +
          buildTeamTableResults(teamB) +
          "</section>" +
          "</div>";
  
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
        container.innerHTML =
          '<p class="small">No detailed projections available for this matchup.</p>';
        return;
      }
  
      const tA = projected.teamA;
      const tB = projected.teamB;
  
      const teamAName = tA.team.teamDisplayName;
      const teamBName = tB.team.teamDisplayName;
  
      function buildTeamTableProjected(team) {
        const rows = (team.projection.players || []).map((p) => {
          const proj = p.projection || {};
          const mean = proj.mean;
          const rangeLow = proj.floor;
          const rangeHigh = proj.ceiling;
          const seasonAvg =
            CURRENT_SEASON_AVG[p.playerId] != null
              ? CURRENT_SEASON_AVG[p.playerId]
              : null;
          const last5 = getPlayerLastNAvg(p.playerId, CURRENT_WEEK, 5);
  
          return (
            "<tr>" +
            "<td>" +
            (p.position || "") +
            "</td>" +
            "<td>" +
            (p.displayName || p.playerId) +
            "</td>" +
            "<td>" +
            (p.nflTeam || "") +
            "</td>" +
            "<td>" +
            formatScore(mean, 1) +
            "</td>" +
            "<td>" +
            (Number.isFinite(rangeLow) && Number.isFinite(rangeHigh)
              ? formatRange(rangeLow, rangeHigh, 1)
              : "–") +
            "</td>" +
            "<td>" +
            (seasonAvg != null ? formatScore(seasonAvg, 1) : "–") +
            "</td>" +
            "<td>" +
            (last5 != null ? formatScore(last5, 1) : "–") +
            "</td>" +
            "</tr>"
          );
        });
  
        return (
          '<table class="detail-table">' +
          "<thead><tr>" +
          "<th>Pos</th><th>Player</th><th>Team</th>" +
          "<th>Proj</th><th>Proj Range</th>" +
          "<th>Season Avg</th><th>Last 5</th>" +
          "</tr></thead><tbody>" +
          rows.join("") +
          "</tbody></table>"
        );
      }
  
      container.innerHTML =
        '<div class="detail-layout">' +
        '<section class="detail-team">' +
        '<div class="detail-team-header">' +
        "<span>" +
        teamAName +
        "</span>" +
        '<span class="small">Team proj: ' +
        formatScore(tA.projection.totalMean, 1) +
        " (" +
        formatRange(tA.projection.rangeLow, tA.projection.rangeHigh, 1) +
        ")</span>" +
        "</div>" +
        buildTeamTableProjected(tA) +
        "</section>" +
        '<section class="detail-team">' +
        '<div class="detail-team-header">' +
        "<span>" +
        teamBName +
        "</span>" +
        '<span class="small">Team proj: ' +
        formatScore(tB.projection.totalMean, 1) +
        " (" +
        formatRange(tB.projection.rangeLow, tB.projection.rangeHigh, 1) +
        ")</span>" +
        "</div>" +
        buildTeamTableProjected(tB) +
        "</section>" +
        "</div>";
    }
  
    function showDetailForMatchup(id) {
      const entry = findMatchupEntryById(id);
      if (!entry) return;
      renderMatchupDetail(entry);
    }
  
    // -----------------------
    // Core loader
    // -----------------------
  
    async function loadWeek(week) {
      const matchupsContainer = $("#matchups-container");
      const newsletterContent = $("#newsletter-content");
      const subtitle = $("#league-subtitle");
      const cfg = window.LEAGUE_CONFIG || {};
  
      CURRENT_WEEK = week;
      CURRENT_MATCHUP_ENTRIES = [];
  
      if (matchupsContainer) {
        matchupsContainer.innerHTML =
          '<div class="loading">Loading Week ' +
          week +
          " matchups…</div>";
      }
      if (newsletterContent) {
        newsletterContent.innerHTML =
          '<p class="small">Building projections and simulations…</p>';
      }
  
      try {
        if (!window.SleeperClient) {
          throw new Error(
            "SleeperClient is not available. Ensure sleeper_client.js is loaded before newsletter.js."
          );
        }
        if (!window.LeagueModels || !window.ProjectionEngine) {
          throw new Error(
            "LeagueModels or ProjectionEngine missing. Check models.js and projections.js are loaded."
          );
        }
  
        // Pull league bundle for weeks 1..week for season averages
        const weeksToFetch = [];
        for (let w = 1; w <= week; w++) weeksToFetch.push(w);
  
        const bundle = await window.SleeperClient.fetchLeagueBundle({
          weeks: weeksToFetch,
        });
        window.__LAST_BUNDLE__ = bundle;
  
        const league = bundle.league || {};
        const leagueName = league.name || "Sleeper League";
        const season =
          league.season || (cfg.season && cfg.season.year) || "";
  
        if (subtitle) {
          subtitle.textContent =
            leagueName + " • Season " + season + " • Week " + week;
        }
  
        // Season averages available to projections.js and detail view
        CURRENT_SEASON_AVG = computeSeasonAverages(bundle, week);
        window.__SEASON_AVG_BY_PLAYER_ID__ = CURRENT_SEASON_AVG;
  
        const snapshot = {
          league,
          users: bundle.users || [],
          rosters: bundle.rosters || [],
          matchups:
            (bundle.matchupsByWeek && bundle.matchupsByWeek[week]) || [],
        };
  
        const playerMap = window.__SLEEPER_PLAYER_MAP__ || null;
        const semiWeek =
          cfg.SEMIFINAL_WEEK ||
          (cfg.playoff && cfg.playoff.semifinalWeek) ||
          null;
  
        let weeklyMatchups =
          window.LeagueModels.buildAllMatchupsForWeek(
            snapshot,
            playerMap
          ) || [];
  
        // Determine if this week is historical (games played)
        const isHistoricalWeek = inferHistoricalWeek(snapshot.matchups);
  
        // For semifinal week, if not historical, prefer bracket-based matchups.
        if (!isHistoricalWeek && semiWeek && week === Number(semiWeek)) {
          const playoffMatchups =
            window.LeagueModels.buildPlayoffMatchups(snapshot, cfg, {
              week,
              playerMap,
            }) || [];
          if (playoffMatchups.length) {
            weeklyMatchups = playoffMatchups;
          }
        }
  
        if (!weeklyMatchups.length) {
          if (matchupsContainer) {
            matchupsContainer.innerHTML =
              '<article class="matchup-card">' +
              '<div class="matchup-header">' +
              '<div class="matchup-teams">No matchups found for Week ' +
              week +
              "</div>" +
              "</div>" +
              '<div class="matchup-scores">' +
              '<span class="small">Check that your league has matchups scheduled for this week.</span>' +
              "</div>" +
              "</article>";
          }
          if (newsletterContent) {
            newsletterContent.innerHTML =
              "<p>No matchups detected for this week.</p>";
          }
          return;
        }
  
        let matchupEntries = [];
        let champObj = null;
  
        if (isHistoricalWeek) {
          // Completed week: no projections or sims. Just scores.
          matchupEntries = weeklyMatchups.map((m, idx) => ({
            id:
              m.id ||
              "week" + week + "_m" + (m.matchupId || idx + 1),
            roundLabel: m.roundLabel || "Week " + week,
            bestOf: 1,
            historical: true,
            teams: m.teams,
          }));
        } else {
          // Future / current week: projections + sims
          for (let i = 0; i < weeklyMatchups.length; i++) {
            const m = weeklyMatchups[i];
            const projectedMatchup =
              window.ProjectionEngine.projectMatchup(m);
            if (
              !projectedMatchup ||
              !projectedMatchup.projected ||
              !projectedMatchup.projected.teamA ||
              !projectedMatchup.projected.teamB
            ) {
              continue;
            }
  
            const sim = window.ProjectionEngine.simulateMatchup(
              projectedMatchup,
              {
                sims: 15000,
                trackScores: false,
              }
            );
            if (!sim) continue;
  
            matchupEntries.push({
              id:
                m.id ||
                "week" + week + "_m" + (m.matchupId || i + 1),
              roundLabel: m.roundLabel || "Week " + week,
              bestOf: m.bestOf || 1,
              projectedMatchup,
              sim,
            });
          }
  
          // Optional: championship odds if this is the semifinal week
          try {
            if (semiWeek && week === Number(semiWeek)) {
              const semiMatchups =
                window.LeagueModels.buildPlayoffMatchups(
                  snapshot,
                  cfg,
                  { week, playerMap }
                ) || [];
  
              if (semiMatchups.length === 2) {
                const semiResults = semiMatchups
                  .map((pm) => {
                    const proj =
                      window.ProjectionEngine.projectMatchup(pm);
                    const sim =
                      proj &&
                      window.ProjectionEngine.simulateMatchup(proj, {
                        sims: 20000,
                        trackScores: false,
                      });
                    return {
                      projected: proj,
                      sim,
                    };
                  })
                  .filter(
                    (r) =>
                      r &&
                      r.projected &&
                      r.projected.projected &&
                      r.sim
                  );
  
                if (semiResults.length === 2) {
                  // finals matrix from team means / SDs
                  const finalsMatrix = (function buildFinalsMatrix(
                    semiWithSims
                  ) {
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
                        (((((a5 * t + a4) * t + a3) * t + a2) * t +
                          a1) *
                          t *
                          Math.exp(-x * x));
                      return sign * y;
                    }
                    function normalCdf(x) {
                      return 0.5 * (1 + erf(x / Math.sqrt(2)));
                    }
  
                    const teams = {};
                    semiWithSims.forEach((m0) => {
                      const a = m0.projected.projected.teamA;
                      const b = m0.projected.projected.teamB;
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
                    names.forEach((nameA) => {
                      matrix[nameA] = {};
                      names.forEach((nameB) => {
                        if (nameA === nameB) return;
                        const tA = teams[nameA];
                        const tB = teams[nameB];
                        const muDiff = tA.mean - tB.mean;
                        const varDiff =
                          tA.sd * tA.sd + tB.sd * tB.sd || 1;
                        const z = muDiff / Math.sqrt(varDiff);
                        matrix[nameA][nameB] = normalCdf(z);
                      });
                    });
                    return matrix;
                  })(semiResults);
  
                  champObj =
                    window.ProjectionEngine.computeChampionshipOdds(
                      semiResults[0],
                      semiResults[1],
                      finalsMatrix
                    );
                }
              }
            }
          } catch (champErr) {
            console.warn(
              "[newsletter.js] Championship odds computation error:",
              champErr
            );
          }
        }
  
        CURRENT_MATCHUP_ENTRIES = matchupEntries;
  
        const mode = isHistoricalWeek ? "results" : "projections";
        const matchupModels = buildMatchupModels(matchupEntries, week, {
          mode,
        });
  
        if (!matchupModels.length) {
          if (matchupsContainer) {
            matchupsContainer.innerHTML =
              '<article class="matchup-card">' +
              '<div class="matchup-header">' +
              '<div class="matchup-teams">No projectable matchups for this week</div>' +
              "</div>" +
              '<div class="matchup-scores">' +
              '<span class="small">Projections could not be generated. Check your player data.</span>' +
              "</div>" +
              "</article>";
          }
          if (newsletterContent) {
            newsletterContent.innerHTML =
              "<p>Matchups detected, but projections could not be generated.</p>";
          }
          return;
        }
  
        // ----------------------------------------------------
        // Build recap phrases (results weeks only) via Supabase
        // ----------------------------------------------------
        let recapById = null;
        if (
          mode === "results" &&
          window.PhraseEngine &&
          typeof window.PhraseEngine.init === "function"
        ) {
          try {
            // Load phrases once (cached internally)
            await window.PhraseEngine.init();
            recapById = {};
            matchupEntries.forEach((entry) => {
              const model = matchupModels.find(
                (m) => m.id === entry.id
              );
              if (!model) return;
  
              const recap =
                window.PhraseEngine.buildResultSentence({
                  model,
                  entry,
                  week,
                  leagueName,
                });
              if (recap) {
                recapById[model.id] = recap;
              }
            });
          } catch (phraseErr) {
            console.warn(
              "[newsletter.js] PhraseEngine error:",
              phraseErr
            );
          }
        }
  
        // Render matchup cards
        if (matchupsContainer) {
          matchupsContainer.innerHTML = matchupModels
            .map((m) => renderMatchupCard(m))
            .join("");
  
          matchupsContainer.onclick = (e) => {
            const card = e.target.closest(".matchup-card");
            if (!card || !card.dataset.matchupId) return;
            showDetailForMatchup(card.dataset.matchupId);
          };
        }
  
        // Render newsletter body
        if (newsletterContent) {
          newsletterContent.innerHTML = buildNewsletterHtml(
            leagueName,
            week,
            matchupModels,
            champObj,
            { mode, recapById }
          );
        }
  
        // Charts: only meaningful in projection mode
        if (window.PlayoffCharts) {
          if (!isHistoricalWeek) {
            try {
              const semisForChart = matchupModels.map((m) => ({
                id: m.id,
                label: m.nameA + " vs " + m.nameB,
                favoriteName: m.favoriteName || m.nameA,
                favoriteWinProb:
                  m.favoriteWinProb != null
                    ? m.favoriteWinProb
                    : m.winA,
                underdogName: m.underdogName || m.nameB,
              }));
  
              window.PlayoffCharts.renderSemifinalOdds(
                "semifinal-odds-chart",
                semisForChart
              );
            } catch (err) {
              console.warn(
                "[newsletter.js] Semifinal/all-matchup chart render error:",
                err
              );
            }
  
            if (champObj) {
              try {
                const champArray = Object.entries(champObj).map(
                  ([teamName, info]) => ({
                    teamName,
                    probability: info.titleOdds || 0,
                  })
                );
                window.PlayoffCharts.renderChampionshipOdds(
                  "title-odds-chart",
                  champArray
                );
              } catch (err2) {
                console.warn(
                  "[newsletter.js] Championship chart render error:",
                  err2
                );
              }
            } else {
              try {
                window.PlayoffCharts.renderChampionshipOdds(
                  "title-odds-chart",
                  []
                );
              } catch (_) {}
            }
          } else {
            // Historical week: clear charts
            try {
              window.PlayoffCharts.renderSemifinalOdds(
                "semifinal-odds-chart",
                []
              );
              window.PlayoffCharts.renderChampionshipOdds(
                "title-odds-chart",
                []
              );
            } catch (_) {}
          }
        }
      } catch (err3) {
        console.error("[newsletter.js] loadWeek error:", err3);
        if (matchupsContainer) {
          matchupsContainer.innerHTML =
            '<article class="matchup-card">' +
            '<div class="matchup-header">' +
            '<div class="matchup-teams">Error loading data from Sleeper</div>' +
            "</div>" +
            '<div class="matchup-scores">' +
            '<span class="small">' +
            (err3.message || "Unknown error") +
            "</span>" +
            "</div>" +
            "</article>";
        }
        if (newsletterContent) {
          newsletterContent.innerHTML =
            "<p>Something went wrong while pulling projections and simulations. Open the browser console for more detail and confirm your API calls are succeeding.</p>";
        }
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
          if (Number.isFinite(val)) {
            loadWeek(val);
          }
        });
      }
  
      if (refreshBtn) {
        refreshBtn.addEventListener("click", () => {
          const val = weekSelect
            ? parseInt(weekSelect.value, 10)
            : Number(defaultWeek);
          if (Number.isFinite(val)) {
            loadWeek(val);
          }
        });
      }
  
      const initialWeek =
        (weekSelect && parseInt(weekSelect.value, 10)) ||
        Number(defaultWeek);
      if (Number.isFinite(initialWeek)) {
        loadWeek(initialWeek);
      }
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
    };
  })();
  