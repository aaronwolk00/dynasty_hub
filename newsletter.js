// newsletter.js
// -----------------------------------------------------------------------------
// Wolk Dynasty – Playoff Hub bootstrap + newsletter rendering
//
// Fixes / improvements:
//   • Correctly identifies Winners Bracket matchups for the week using
//     snapshot.winnersBracket (NOT "every matchup is semis").
//   • Correct round labels per matchup: Quarterfinals / Semifinals / Championship
//     / Consolation (or Week N).
//   • Championship / title odds are computed ONLY for teams still alive in the
//     Winners Bracket and ONLY from the actual winners-bracket matchups.
//   • Works for future championship projections (semi week -> title odds).
//
// Assumes:
//   • sleeper_client.js populates snapshot.winnersBracket from /winners_bracket
//   • LeagueModels.buildAllMatchupsForWeek(snapshot, playerMap) returns matchups
//     with m.teams[0].rosterId / m.teams[1].rosterId and team objects with
//     starters, etc.
//   • ProjectionEngine.projectMatchup(matchup) and simulateMatchup(proj, opts)
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
    let CURRENT_MATCHUP_ENTRIES = []; // entries for detail lookup
    let CURRENT_SEASON_AVG = {}; // { playerId -> avg }
  
    // For charts: which matchup IDs are true semifinals (winners bracket only)
    let SEMI_MATCHUP_ID_SET = null;
  
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
  
    // Historical week heuristic: if every matchup has at least one player
    // with > 0 pts, we consider it "played".
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
  
    // -----------------------
    // Matchup identity helpers
    // -----------------------
  
    function computeMatchupIdForWeek(m, week) {
      if (!m) return null;
      if (m.id != null && m.id !== "") return String(m.id);
      if (m.matchup_id != null) return "week" + week + "_m" + m.matchup_id;
      if (m.matchupId != null) return "week" + week + "_m" + m.matchupId;
      return null;
    }
  
    function getRosterIdsFromMatchup(m) {
      try {
        const teams = m && m.teams ? m.teams : [];
        const a = teams[0] ? Number(teams[0].rosterId) : NaN;
        const b = teams[1] ? Number(teams[1].rosterId) : NaN;
        return [a, b];
      } catch (_e) {
        return [NaN, NaN];
      }
    }
  
    function pairKey(a, b) {
      const A = Number(a), B = Number(b);
      if (!Number.isFinite(A) && !Number.isFinite(B)) return null;
      if (Number.isFinite(A) && !Number.isFinite(B)) return String(A) + "-bye";
      if (!Number.isFinite(A) && Number.isFinite(B)) return String(B) + "-bye";
      const lo = Math.min(A, B);
      const hi = Math.max(A, B);
      return lo + "-" + hi;
    }
  
    // -----------------------
    // Winners bracket parsing (ONLY source of truth for "alive" + round matchups)
    // -----------------------
  
    function getPlayoffWeekStart(cfg, league) {
      const fromCfg = cfg.PLAYOFF_START_WEEK;
      if (Number.isFinite(Number(fromCfg))) return Number(fromCfg);
  
      const fromLeague =
        league && league.settings && league.settings.playoff_week_start;
      if (Number.isFinite(Number(fromLeague))) return Number(fromLeague);
  
      // Fallback: if user only configures SEMIFINAL_WEEK
      const semi = cfg.SEMIFINAL_WEEK;
      if (Number.isFinite(Number(semi))) return Number(semi) - 1;
  
      return null;
    }
  
    function getRoundForWeek(cfg, league, week) {
      const start = getPlayoffWeekStart(cfg, league);
      if (!Number.isFinite(start)) return null;
      const w = Number(week);
      if (!Number.isFinite(w)) return null;
      const r = w - start + 1;
      return r >= 1 ? r : null;
    }
  
    function getWeekForRound(cfg, league, round) {
      const start = getPlayoffWeekStart(cfg, league);
      if (!Number.isFinite(start)) return null;
      const r = Number(round);
      if (!Number.isFinite(r)) return null;
      return start + r - 1;
    }
  
    function roundLabelForRound(round) {
      const r = Number(round);
      if (r === 1) return "Quarterfinals";
      if (r === 2) return "Semifinals";
      if (r === 3) return "Championship";
      return "Playoffs";
    }
  
    function buildWinnersBracketContext(snapshot, cfg, league, week) {
      const bracket = snapshot && Array.isArray(snapshot.winnersBracket)
        ? snapshot.winnersBracket
        : [];
  
      if (!bracket.length) {
        return {
          hasBracket: false,
          aliveRosterIds: new Set(),
          round: null,
          roundMatchups: [],
          roundPairKeys: new Set(),
          playoffRosterIds: new Set(),
          eliminatedRosterIds: new Set(),
        };
      }
  
      // All winners-bracket roster IDs (playoff field)
      const playoffRosterIds = new Set();
      bracket.forEach((bm) => {
        const t1 = Number(bm && bm.t1);
        const t2 = Number(bm && bm.t2);
        if (Number.isFinite(t1)) playoffRosterIds.add(t1);
        if (Number.isFinite(t2)) playoffRosterIds.add(t2);
      });
  
      // Eliminated roster IDs = losers from completed winners-bracket matchups
      // Sleeper bracket objects typically include w (winner) and l (loser) once decided.
      const eliminatedRosterIds = new Set();
      bracket.forEach((bm) => {
        const loser = Number(bm && bm.l);
        if (Number.isFinite(loser)) eliminatedRosterIds.add(loser);
      });
  
      const aliveRosterIds = new Set();
      playoffRosterIds.forEach((rid) => {
        if (!eliminatedRosterIds.has(rid)) aliveRosterIds.add(rid);
      });
  
      const round = getRoundForWeek(cfg, league, week);
  
      const roundMatchups = Number.isFinite(round)
        ? bracket.filter((bm) => Number(bm && bm.r) === Number(round))
        : [];
  
      const roundPairKeys = new Set();
      roundMatchups.forEach((bm) => {
        const t1 = Number(bm && bm.t1);
        const t2 = Number(bm && bm.t2);
        const key = pairKey(t1, t2);
        if (key) roundPairKeys.add(key);
      });
  
      return {
        hasBracket: true,
        aliveRosterIds,
        round,
        roundMatchups,
        roundPairKeys,
        playoffRosterIds,
        eliminatedRosterIds,
      };
    }
  
    function classifyMatchupRoundLabel(snapshot, cfg, league, winnersCtx, m, week) {
      const [a, b] = getRosterIdsFromMatchup(m);
      const key = pairKey(a, b);
  
      // If not in playoff window, just "Week N"
      const round = getRoundForWeek(cfg, league, week);
      if (!Number.isFinite(round)) return "Week " + week;
  
      // If this matchup is exactly one of the winners bracket round matchups for the week:
      if (key && winnersCtx && winnersCtx.roundPairKeys && winnersCtx.roundPairKeys.has(key)) {
        return roundLabelForRound(round);
      }
  
      // If both rosters are in the playoff field but this pairing isn't the winners round,
      // it's likely a consolation/toilet matchup.
      const aIn = winnersCtx && winnersCtx.playoffRosterIds && winnersCtx.playoffRosterIds.has(a);
      const bIn = winnersCtx && winnersCtx.playoffRosterIds && winnersCtx.playoffRosterIds.has(b);
  
      if (aIn || bIn) return "Consolation";
  
      // Non-playoff matchup in a playoff week (common in some formats)
      return "Week " + week;
    }
  
    // -----------------------
    // Matchup models for UI
    // -----------------------
  
    function buildMatchupModels(entries, week, options) {
      options = options || {};
      const mode = options.mode || "projections";
  
      return entries
        .map((entry, idx) => {
          // Results / historical
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
  
            const impliedSpread = formatSpread(muA, muB, nameA, nameB);
            const impliedTotal = formatTotal(muA, muB);
  
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
              favoriteName: null,
              favoriteWinProb: null,
              underdogName: null,
              impliedSpread,
              impliedTotal,
              isSemi: !!entry.isSemi,
              isWinnersRound: !!entry.isWinnersRound,
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
            const low = Math.max(0, mu - k * sd);
            const high = mu + k * sd;
            return { low, high };
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
  
          return {
            id: entry.id || "matchup-" + (idx + 1),
            week,
            roundLabel: entry.roundLabel || "Week " + week,
            bestOf: entry.bestOf || 1,
            mode,
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
            isSemi: !!entry.isSemi,
            isWinnersRound: !!entry.isWinnersRound,
          };
        })
        .filter(Boolean);
    }
  
    function renderMatchupCard(model) {
      const {
        id,
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
        isWinnersRound,
      } = model;
  
      const isResults = mode === "results";
      const label = isResults ? "final" : "proj";
  
      const winner =
        isResults && Number.isFinite(muA) && Number.isFinite(muB)
          ? muA > muB
            ? "A"
            : muB > muA
            ? "B"
            : null
          : null;
  
      const favTagA =
        !isResults && favoriteName === nameA
          ? '<span class="tag tag-favorite">Fav</span>'
          : "";
      const favTagB =
        !isResults && favoriteName === nameB
          ? '<span class="tag tag-favorite">Fav</span>'
          : "";
  
      const sideAClass =
        "matchup-score-side" +
        (winner === "A" ? " winner" : winner === "B" ? " loser" : "");
      const sideBClass =
        "matchup-score-side" +
        (winner === "B" ? " winner" : winner === "A" ? " loser" : "");
  
      let metaLine;
      if (isResults) {
        metaLine =
          "Final: " +
          nameA +
          " " +
          formatScore(muA) +
          " – " +
          nameB +
          " " +
          formatScore(muB) +
          " (total " +
          formatTotal(muA, muB) +
          ").";
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
          " • Line: " +
          impliedSpread +
          " • Total: " +
          impliedTotal;
      }
  
      const rangeTextA =
        !isResults &&
        rangeA &&
        Number.isFinite(rangeA.low) &&
        Number.isFinite(rangeA.high)
          ? " (" + formatRange(rangeA.low, rangeA.high) + ")"
          : "";
      const rangeTextB =
        !isResults &&
        rangeB &&
        Number.isFinite(rangeB.low) &&
        Number.isFinite(rangeB.high)
          ? " (" + formatRange(rangeB.low, rangeB.high) + ")"
          : "";
  
      const roundChip = isWinnersRound
        ? '<span class="tag tag-favorite" style="border-color: rgba(34,197,94,.35); color: #a7f3d0;">Winners</span>'
        : "";
  
      return (
        '<article class="matchup-card" data-matchup-id="' +
        id +
        '">' +
        '<div class="matchup-header">' +
        '<div class="matchup-teams">' +
        nameA +
        " vs " +
        nameB +
        "</div>" +
        '<div class="matchup-meta">' +
        (roundLabel || "Week") +
        (roundChip ? " " + roundChip : "") +
        "</div>" +
        "</div>" +
        '<div class="matchup-scores-row">' +
        '<div class="' +
        sideAClass +
        '">' +
        '<div class="matchup-score-line">' +
        '<span class="matchup-score-main">' +
        formatScore(muA) +
        "</span>" +
        '<span class="matchup-score-label">' +
        label +
        "</span>" +
        "</div>" +
        (rangeTextA
          ? '<div class="matchup-score-range small">' + rangeTextA + "</div>"
          : "") +
        (favTagA ? '<div class="matchup-chip-row">' + favTagA + "</div>" : "") +
        "</div>" +
        '<div class="' +
        sideBClass +
        '">' +
        '<div class="matchup-score-line">' +
        '<span class="matchup-score-main">' +
        formatScore(muB) +
        "</span>" +
        '<span class="matchup-score-label">' +
        label +
        "</span>" +
        "</div>" +
        (rangeTextB
          ? '<div class="matchup-score-range small">' + rangeTextB + "</div>"
          : "") +
        (favTagB ? '<div class="matchup-chip-row">' + favTagB + "</div>" : "") +
        "</div>" +
        "</div>" +
        '<div class="matchup-meta matchup-meta-bottom small">' +
        metaLine +
        "</div>" +
        "</article>"
      );
    }
  
    function buildNewsletterHtml(leagueName, week, matchupModels, champObj, options) {
      options = options || {};
      const mode = options.mode || "projections";
      const recapById = options.recapById || null;
      const winnersAliveNames = options.winnersAliveNames || [];
  
      const isResults = mode === "results";
  
      const baseTitle = isResults ? "Week " + week + " Results" : "Week " + week + " Snapshot";
      const titleLine = leagueName ? baseTitle + " – " + leagueName : baseTitle;
  
      const introText = isResults
        ? "Final scores for Week " + week + " are in. Here’s how the matchups played out."
        : "Projections for Week " + week + " are in. Here’s the slate once we fold in your projections and a Monte Carlo sim.";
  
      const lines = [];
  
      lines.push('<section class="newsletter-week-header">');
      lines.push('<div class="newsletter-week-title">' + titleLine + "</div>");
      lines.push('<p class="newsletter-week-subtitle">' + introText + "</p>");
  
      if (!isResults && winnersAliveNames && winnersAliveNames.length) {
        lines.push(
          '<p class="small" style="margin-top:6px;">' +
            "<strong>Winners Bracket alive:</strong> " +
            winnersAliveNames.join(", ") +
            "</p>"
        );
      }
  
      lines.push("</section>");
  
      lines.push('<section class="newsletter-matchups-list">');
      matchupModels.forEach((m) => {
        let cardHtml = renderMatchupCard(m);
  
        if (isResults && recapById && recapById[m.id]) {
          cardHtml = cardHtml.replace(
            "</article>",
            '<p class="nm-recap">' + recapById[m.id] + "</p></article>"
          );
        }
  
        lines.push(cardHtml);
      });
      lines.push("</section>");
  
      // Championship odds card (only when we have a champObj)
      if (!isResults && champObj) {
        const entries = Object.entries(champObj).sort((a, b) => {
          const pa = (a[1] && a[1].titleOdds) || 0;
          const pb = (b[1] && b[1].titleOdds) || 0;
          return pb - pa;
        });
  
        if (entries.length) {
          lines.push('<section class="newsletter-card newsletter-champ-card">');
          lines.push("<h3>Championship Picture</h3>");
          lines.push(
            '<p class="small">Simulating the Winners Bracket forward from the real bracket matchups gives the following title odds:</p>'
          );
  
          lines.push('<table class="odds-table"><thead><tr>');
          lines.push("<th>Team</th><th>Reach Final</th><th>Win Title</th><th>Implied Line</th>");
          lines.push("</tr></thead><tbody>");
  
          entries.forEach(([teamName, info]) => {
            const reach = info.path && typeof info.path.reachFinalPct === "number" ? info.path.reachFinalPct : 0;
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
            '<p class="small">Implied lines are computed from modeled probabilities (for fun, not betting advice).</p>'
          );
          lines.push("</section>");
        }
      }
  
      // Charts row – only meaningful when populated (your charts.js decides)
      lines.push(
        '<section class="newsletter-charts-row">' +
          '<div class="chart-card">' +
          "<h3>Winners Bracket Win Odds</h3>" +
          '<canvas id="semifinal-odds-chart"></canvas>' +
          "</div>" +
          '<div class="chart-card">' +
          "<h3>Title Odds</h3>" +
          '<canvas id="title-odds-chart"></canvas>' +
          "</div>" +
          "</section>"
      );
  
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
  
      const playerMap = window.__SLEEPER_PLAYER_MAP__ || {};
  
      function getPlayerId(p) {
        if (!p) return "";
        return p.playerId || p.player_id || p.id || "";
      }
  
      function getPlayerName(p) {
        if (!p) return "";
        if (p.displayName) return p.displayName;
        const id = getPlayerId(p);
        const meta = playerMap[id];
        if (meta && meta.full_name) return meta.full_name;
        return id;
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
  
        function buildTeamTableResults(teamView) {
          const rows = (teamView.starters || []).map((p) => {
            const id = getPlayerId(p);
            const pts = Number(p.fantasyPoints);
            const seasonAvg = CURRENT_SEASON_AVG[id] != null ? CURRENT_SEASON_AVG[id] : null;
            const last5 = getPlayerLastNAvg(id, CURRENT_WEEK, 5);
  
            return (
              "<tr>" +
              "<td>" +
              (p.position || "") +
              "</td>" +
              "<td>" +
              getPlayerName(p) +
              "</td>" +
              '<td data-col="team">' +
              getPlayerTeam(p) +
              "</td>" +
              '<td data-col="score">' +
              formatScore(pts, 1) +
              "</td>" +
              '<td data-col="seasonAvg">' +
              (seasonAvg != null ? formatScore(seasonAvg, 1) : "–") +
              "</td>" +
              '<td data-col="last5">' +
              (last5 != null ? formatScore(last5, 1) : "–") +
              "</td>" +
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
          '<span class="team-name">' +
          teamAName +
          "</span>" +
          '<span class="small team-score">Team score: ' +
          formatScore(teamA.score, 1) +
          "</span>" +
          "</div>" +
          buildTeamTableResults(teamA) +
          "</section>" +
          '<section class="detail-team">' +
          '<div class="detail-team-header">' +
          '<span class="team-name">' +
          teamBName +
          "</span>" +
          '<span class="small team-score">Team score: ' +
          formatScore(teamB.score, 1) +
          "</span>" +
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
  
      function buildTeamTableProjected(team) {
        const rows = (team.projection.players || []).map((p) => {
          const id = getPlayerId(p);
          const proj = p.projection || {};
          const mean = proj.mean;
          const rangeLow = proj.floor;
          const rangeHigh = proj.ceiling;
          const seasonAvg = CURRENT_SEASON_AVG[id] != null ? CURRENT_SEASON_AVG[id] : null;
          const last5 = getPlayerLastNAvg(id, CURRENT_WEEK, 5);
  
          return (
            "<tr>" +
            "<td>" +
            (p.position || "") +
            "</td>" +
            "<td>" +
            getPlayerName(p) +
            "</td>" +
            '<td data-col="team">' +
            getPlayerTeam(p) +
            "</td>" +
            '<td data-col="proj">' +
            formatScore(mean, 1) +
            "</td>" +
            '<td data-col="projRange">' +
            (Number.isFinite(rangeLow) && Number.isFinite(rangeHigh)
              ? formatRange(rangeLow, rangeHigh, 1)
              : "–") +
            "</td>" +
            '<td data-col="seasonAvg">' +
            (seasonAvg != null ? formatScore(seasonAvg, 1) : "–") +
            "</td>" +
            '<td data-col="last5">' +
            (last5 != null ? formatScore(last5, 1) : "–") +
            "</td>" +
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
        '<span class="team-name">' +
        teamAName +
        "</span>" +
        '<span class="small team-score">Team proj: ' +
        formatScore(tA.projection.totalMean, 1) +
        " (" +
        formatRange(tA.projection.rangeLow, tA.projection.rangeHigh, 1) +
        ")</span>" +
        "</div>" +
        buildTeamTableProjected(tA) +
        "</section>" +
        '<section class="detail-team">' +
        '<div class="detail-team-header">' +
        '<span class="team-name">' +
        teamBName +
        "</span>" +
        '<span class="small team-score">Team proj: ' +
        formatScore(tB.projection.totalMean, 1) +
        " (" +
        formatRange(tB.projection.rangeLow, tB.projection.rangeHigh, 1) +
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
          row.rosterId +
          '">' +
          "<td>" +
          row.rank +
          "</td>" +
          "<td>" +
          row.name +
          "</td>" +
          "<td>" +
          row.wins +
          "-" +
          row.losses +
          (row.ties ? "-" + row.ties : "") +
          "</td>" +
          "<td>" +
          formatPercent(row.winPct, 1) +
          "</td>" +
          "<td>" +
          formatScore(row.pf, 1) +
          "</td>" +
          "<td>" +
          formatScore(row.pa, 1) +
          "</td>" +
          "<td>" +
          (row.diff >= 0 ? "+" : "") +
          formatScore(row.diff, 1) +
          "</td>" +
          "</tr>";
      });
  
      html += "</tbody></table>";
      html += "</div>";
  
      html += '<div class="season-metrics-container">';
      html += '<div class="season-subheading">Season Snapshot</div>';
  
      if (rows.length) {
        const bestPf = rows.slice().sort((a, b) => b.pf - a.pf)[0];
        const bestDiff = rows.slice().sort((a, b) => b.diff - a.diff)[0];
        const worstLuck = rows.slice().sort((a, b) => a.diff - b.diff)[0];
  
        html +=
          "<p><strong>Top Scoring:</strong> " +
          bestPf.name +
          " (" +
          formatScore(bestPf.pf, 1) +
          " PF)</p>";
        html +=
          "<p><strong>Best Differential:</strong> " +
          bestDiff.name +
          " (" +
          (bestDiff.diff >= 0 ? "+" : "") +
          formatScore(bestDiff.diff, 1) +
          ")</p>";
        html +=
          "<p><strong>Roughest Ride:</strong> " +
          worstLuck.name +
          " (" +
          (worstLuck.diff >= 0 ? "+" : "") +
          formatScore(worstLuck.diff, 1) +
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
    // Championship odds helpers (semis -> title odds)
    // -----------------------
  
    function buildFinalsMatrixFromSemiResults(semiResults) {
      // Normal approximation using team means and sds
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
          (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) *
            t *
            Math.exp(-x * x));
        return sign * y;
      }
      function normalCdf(x) {
        return 0.5 * (1 + erf(x / Math.sqrt(2)));
      }
  
      const teams = {};
      semiResults.forEach((r) => {
        const a = r.projected.projected.teamA;
        const b = r.projected.projected.teamB;
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
          const varDiff = (tA.sd * tA.sd + tB.sd * tB.sd) || 1;
          const z = muDiff / Math.sqrt(varDiff);
          matrix[nameA][nameB] = normalCdf(z);
        });
      });
  
      return matrix;
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
      SEMI_MATCHUP_ID_SET = null;
  
      if (matchupsContainer) {
        matchupsContainer.innerHTML = '<div class="loading">Loading Week ' + week + " matchups…</div>";
      }
      if (newsletterContent) {
        newsletterContent.innerHTML = '<p class="small">Building projections and simulations…</p>';
      }
  
      try {
        if (!window.SleeperClient) {
          throw new Error("SleeperClient is not available. Ensure sleeper_client.js is loaded before newsletter.js.");
        }
        if (!window.LeagueModels || !window.ProjectionEngine) {
          throw new Error("LeagueModels or ProjectionEngine missing. Check models.js and projections.js are loaded.");
        }
  
        // Pull league bundle for weeks 1..week for season averages
        const weeksToFetch = [];
        for (let w = 1; w <= week; w++) weeksToFetch.push(w);
  
        const bundle = await window.SleeperClient.fetchLeagueBundle({ weeks: weeksToFetch });
        window.__LAST_BUNDLE__ = bundle;
  
        const league = bundle.league || {};
        const leagueName = league.name || "Sleeper League";
        const season = league.season || (cfg.season && cfg.season.year) || "";
  
        if (subtitle) {
          subtitle.textContent = leagueName + " • Season " + season + " • Week " + week;
        }
  
        CURRENT_SEASON_AVG = computeSeasonAverages(bundle, week);
        window.__SEASON_AVG_BY_PLAYER_ID__ = CURRENT_SEASON_AVG;
  
        // Snapshot for this week (persist optional)
        const snapshot = {
          league,
          users: bundle.users || [],
          rosters: bundle.rosters || [],
          matchups: (bundle.matchupsByWeek && bundle.matchupsByWeek[week]) || [],
          winnersBracket: bundle.winnersBracket || [],
          week: week,
        };
  
        // Persist snapshot (optional)
        if (window.SleeperClient && typeof window.SleeperClient.persistSnapshotToSupabase === "function") {
          window.SleeperClient
            .persistSnapshotToSupabase(snapshot, { source: "newsletter_loadWeek" })
            .catch((err) => console.warn("[newsletter.js] Failed to persist Sleeper snapshot:", err));
        }
  
        const playerMap = window.__SLEEPER_PLAYER_MAP__ || null;
  
        // Build matchups for display (ALL matchups for the week)
        let weeklyMatchups = window.LeagueModels.buildAllMatchupsForWeek(snapshot, playerMap) || [];
  
        // Determine if this week is historical (games played)
        const isHistoricalWeek = inferHistoricalWeek(snapshot.matchups);
  
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
          if (newsletterContent) newsletterContent.innerHTML = "<p>No matchups detected for this week.</p>";
          renderSeasonOverview(bundle);
          return;
        }
  
        // Winners bracket context (alive + identify true winners round matchups)
        const winnersCtx = buildWinnersBracketContext(snapshot, cfg, league, week);
  
        // For display: map roster_id -> display name
        const rosterById = {};
        (snapshot.rosters || []).forEach((r) => (rosterById[r.roster_id] = r));
        const users = snapshot.users || [];
        const rosterName = (rosterId) => {
          const rid = Number(rosterId);
          const r = rosterById[rid];
          if (!r) return "Team " + rid;
          const u = users.find((x) => x.user_id === r.owner_id);
          return (r.metadata && r.metadata.team_name) || (u && (u.display_name || u.username)) || "Team " + rid;
        };
  
        const winnersAliveNames = [];
        if (winnersCtx && winnersCtx.aliveRosterIds && winnersCtx.aliveRosterIds.size) {
          winnersCtx.aliveRosterIds.forEach((rid) => winnersAliveNames.push(rosterName(rid)));
          winnersAliveNames.sort((a, b) => a.localeCompare(b));
        }
  
        // Build matchup entries (results or projections)
        let matchupEntries = [];
        let champObj = null;
  
        // Helper: determine if a matchup is the winners bracket matchup for THIS week’s winners round
        function isWinnersRoundMatchup(m) {
          if (!winnersCtx || !winnersCtx.roundPairKeys) return false;
          const [a, b] = getRosterIdsFromMatchup(m);
          const key = pairKey(a, b);
          return !!(key && winnersCtx.roundPairKeys.has(key));
        }
  
        if (isHistoricalWeek) {
          matchupEntries = weeklyMatchups.map((m, idx) => {
            const id = computeMatchupIdForWeek(m, week) || "week" + week + "_m_fallback" + (idx + 1);
  
            const label = classifyMatchupRoundLabel(snapshot, cfg, league, winnersCtx, m, week);
            const winnersRound = isWinnersRoundMatchup(m);
  
            return {
              id,
              roundLabel: label,
              bestOf: m.bestOf || 1,
              historical: true,
              teams: m.teams,
              isWinnersRound: winnersRound,
              isSemi: label === "Semifinals" && winnersRound,
            };
          });
        } else {
          for (let i = 0; i < weeklyMatchups.length; i++) {
            const m = weeklyMatchups[i];
  
            const projectedMatchup = window.ProjectionEngine.projectMatchup(m);
            if (
              !projectedMatchup ||
              !projectedMatchup.projected ||
              !projectedMatchup.projected.teamA ||
              !projectedMatchup.projected.teamB
            ) {
              continue;
            }
  
            const sim = window.ProjectionEngine.simulateMatchup(projectedMatchup, {
              sims: 15000,
              trackScores: false,
            });
            if (!sim) continue;
  
            const id = computeMatchupIdForWeek(m, week) || "week" + week + "_m_fallback" + (i + 1);
  
            const label = classifyMatchupRoundLabel(snapshot, cfg, league, winnersCtx, m, week);
            const winnersRound = isWinnersRoundMatchup(m);
  
            matchupEntries.push({
              id,
              roundLabel: label,
              bestOf: m.bestOf || 1,
              projectedMatchup,
              sim,
              isWinnersRound: winnersRound,
              isSemi: label === "Semifinals" && winnersRound,
            });
          }
  
          // ----------------------------
          // Championship projections (semis -> title odds) using REAL winners bracket
          // ----------------------------
          const round = winnersCtx && Number.isFinite(winnersCtx.round) ? Number(winnersCtx.round) : null;
  
          // If this is the semifinal round (round=2), compute title odds from those REAL semis only.
          if (round === 2 && winnersCtx && winnersCtx.roundPairKeys && winnersCtx.roundPairKeys.size) {
            try {
              // Find the actual semis matchups in weeklyMatchups (by roster pair)
              const semiMatchups = weeklyMatchups.filter(isWinnersRoundMatchup);
  
              // We expect 2 semifinal matchups (4 teams) for standard brackets.
              if (semiMatchups.length >= 2) {
                const semiResults = semiMatchups
                  .slice(0, 2)
                  .map((pm) => {
                    const proj = window.ProjectionEngine.projectMatchup(pm);
                    const sim =
                      proj &&
                      window.ProjectionEngine.simulateMatchup(proj, {
                        sims: 20000,
                        trackScores: false,
                      });
                    return {
                      originalMatchup: pm,
                      projected: proj,
                      sim,
                    };
                  })
                  .filter((r) => r && r.projected && r.projected.projected && r.sim);
  
                if (semiResults.length >= 2) {
                  const finalsMatrix = buildFinalsMatrixFromSemiResults(semiResults);
  
                  champObj = window.ProjectionEngine.computeChampionshipOdds(
                    semiResults[0],
                    semiResults[1],
                    finalsMatrix
                  );
  
                  // Mark which matchup IDs are true semis for charts + UI
                  const idSet = new Set();
                  semiMatchups.slice(0, 2).forEach((m0) => {
                    const id = computeMatchupIdForWeek(m0, week);
                    if (id) idSet.add(id);
                  });
                  SEMI_MATCHUP_ID_SET = idSet.size ? idSet : null;
  
                  if (SEMI_MATCHUP_ID_SET) {
                    matchupEntries.forEach((e) => {
                      if (SEMI_MATCHUP_ID_SET.has(e.id)) {
                        e.isSemi = true;
                        e.isWinnersRound = true;
                        e.roundLabel = "Semifinals";
                      }
                    });
                  }
                }
              }
            } catch (champErr) {
              console.warn("[newsletter.js] Championship odds computation error:", champErr);
            }
          }
  
          // If this is the championship round (round=3), you can still show "title odds"
          // as basically the win probability for the final matchup. (Optional)
          if (round === 3 && winnersCtx && winnersCtx.roundPairKeys && winnersCtx.roundPairKeys.size) {
            try {
              const finalMatchups = weeklyMatchups.filter(isWinnersRoundMatchup);
              if (finalMatchups.length >= 1) {
                const fm = finalMatchups[0];
                const proj = window.ProjectionEngine.projectMatchup(fm);
                const sim =
                  proj &&
                  window.ProjectionEngine.simulateMatchup(proj, {
                    sims: 25000,
                    trackScores: false,
                  });
  
                if (proj && sim && proj.projected && proj.projected.teamA && proj.projected.teamB) {
                  const aName = proj.projected.teamA.team.teamDisplayName;
                  const bName = proj.projected.teamB.team.teamDisplayName;
  
                  // Shape champObj to match existing rendering (reachFinalPct = 100%)
                  champObj = {};
                  champObj[aName] = {
                    titleOdds: sim.teamAWinPct,
                    path: { reachFinalPct: 1.0 },
                  };
                  champObj[bName] = {
                    titleOdds: sim.teamBWinPct,
                    path: { reachFinalPct: 1.0 },
                  };
  
                  // Mark only the final as "Winners"
                  matchupEntries.forEach((e) => {
                    if (e.id === computeMatchupIdForWeek(fm, week)) {
                      e.isWinnersRound = true;
                      e.roundLabel = "Championship";
                    }
                  });
                }
              }
            } catch (errFinal) {
              console.warn("[newsletter.js] Final win odds error:", errFinal);
            }
          }
        }
  
        CURRENT_MATCHUP_ENTRIES = matchupEntries;
  
        const mode = isHistoricalWeek ? "results" : "projections";
        const matchupModels = buildMatchupModels(matchupEntries, week, { mode });
  
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
          if (newsletterContent) newsletterContent.innerHTML = "<p>Matchups detected, but projections could not be generated.</p>";
          renderSeasonOverview(bundle);
          return;
        }
  
        // Render matchup cards (left list if you use it elsewhere)
        if (matchupsContainer) {
          matchupsContainer.innerHTML = matchupModels.map((m) => renderMatchupCard(m)).join("");
  
          matchupsContainer.onclick = (e) => {
            const card = e.target.closest(".matchup-card");
            if (!card || !card.dataset.matchupId) return;
            showDetailForMatchup(card.dataset.matchupId);
  
            matchupsContainer.querySelectorAll(".matchup-card").forEach((c) => c.classList.remove("selected"));
            card.classList.add("selected");
          };
        }
  
        // Render newsletter body
        if (newsletterContent) {
          newsletterContent.innerHTML = buildNewsletterHtml(
            leagueName,
            week,
            matchupModels,
            champObj,
            { mode, recapById: null, winnersAliveNames }
          );
  
          newsletterContent.onclick = (e) => {
            const card = e.target.closest(".matchup-card");
            if (!card || !card.dataset.matchupId) return;
  
            showDetailForMatchup(card.dataset.matchupId);
  
            newsletterContent.querySelectorAll(".matchup-card").forEach((c) => c.classList.remove("selected"));
            card.classList.add("selected");
          };
        }
  
        // Season Overview
        renderSeasonOverview(bundle);
  
        // Charts: Winners bracket only (real semis / real title odds)
        if (window.PlayoffCharts) {
          if (!isHistoricalWeek) {
            try {
              const semisSource =
                SEMI_MATCHUP_ID_SET && SEMI_MATCHUP_ID_SET.size
                  ? matchupModels.filter((m) => SEMI_MATCHUP_ID_SET.has(m.id))
                  : matchupModels.filter((m) => m.isWinnersRound && m.roundLabel === "Semifinals");
  
              const semisForChart = semisSource.map((m) => ({
                id: m.id,
                label: m.nameA + " vs " + m.nameB,
                favoriteName: m.favoriteName || m.nameA,
                favoriteWinProb: m.favoriteWinProb != null ? m.favoriteWinProb : m.winA,
                underdogName: m.underdogName || m.nameB,
              }));
  
              window.PlayoffCharts.renderSemifinalOdds("semifinal-odds-chart", semisForChart);
            } catch (err) {
              console.warn("[newsletter.js] Winners bracket odds chart render error:", err);
            }
  
            try {
              if (champObj) {
                const champArray = Object.entries(champObj).map(([teamName, info]) => ({
                  teamName,
                  probability: info.titleOdds || 0,
                }));
                window.PlayoffCharts.renderChampionshipOdds("title-odds-chart", champArray);
              } else {
                window.PlayoffCharts.renderChampionshipOdds("title-odds-chart", []);
              }
            } catch (err2) {
              console.warn("[newsletter.js] Title odds chart render error:", err2);
            }
          } else {
            try {
              window.PlayoffCharts.renderSemifinalOdds("semifinal-odds-chart", []);
              window.PlayoffCharts.renderChampionshipOdds("title-odds-chart", []);
            } catch (_e) {}
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
  
      // Insights tab hook
      if (window.PlayoffInsightsApp && typeof window.PlayoffInsightsApp.renderFromBundle === "function") {
        window.PlayoffInsightsApp.renderFromBundle();
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
  