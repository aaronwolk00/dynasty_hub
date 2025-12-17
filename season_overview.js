// season_overview.js
// -----------------------------------------------------------------------------
// Season Overview tab – standings, PF/PA, median wins, "luck"
// Uses the same league bundle that newsletter.js fetches.
// newsletter.js calls SeasonOverview.renderForWeek(bundle, week).
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    function $(selector, root) {
      if (root === void 0) root = document;
      return root.querySelector(selector);
    }
  
    function formatNum(x, digits) {
      if (!Number.isFinite(x)) return "–";
      return x.toFixed(digits);
    }
  
    // Build per-team season stats from Sleeper-style matchupsByWeek.
    function buildSeasonSummary(bundle, uptoWeek) {
      if (!bundle || !bundle.matchupsByWeek) return null;
  
      const matchupsByWeek = bundle.matchupsByWeek || {};
      const rosters = bundle.rosters || [];
      const users = bundle.users || [];
      const league = bundle.league || {};
  
      // Map roster_id -> team summary
      const teamsByRosterId = {};
      rosters.forEach((r) => {
        const u = users.find((x) => x.user_id === r.owner_id);
        const displayName = u?.display_name || `Team ${r.roster_id}`;
        teamsByRosterId[r.roster_id] = {
          rosterId: r.roster_id,
          displayName,
          wins: 0,
          losses: 0,
          ties: 0,
          games: 0,
          pf: 0,
          pa: 0,
          medianWins: 0,
        };
      });
  
      const allWeeks = Object.keys(matchupsByWeek)
        .map((w) => Number(w))
        .filter((w) => Number.isFinite(w) && (!uptoWeek || w <= uptoWeek))
        .sort((a, b) => a - b);
  
      let lastWeekWithGames = null;
  
      allWeeks.forEach((wk) => {
        const weekKey = String(wk);
        const weekMatchups = matchupsByWeek[weekKey] || [];
        if (!weekMatchups.length) return;
  
        // Collect scores for median calculation
        const weeklyScores = [];
        weekMatchups.forEach((m) => {
          const rid = m.roster_id;
          const pts = Number(m.points);
          if (!teamsByRosterId[rid]) return;
          if (!Number.isFinite(pts)) return;
          weeklyScores.push(pts);
        });
        if (!weeklyScores.length) return;
  
        lastWeekWithGames = wk;
  
        const sorted = weeklyScores.slice().sort((a, b) => a - b);
        const midIdx = (sorted.length - 1) / 2;
        let median;
        if (Number.isInteger(midIdx)) {
          median = sorted[midIdx];
        } else {
          const lo = sorted[Math.floor(midIdx)];
          const hi = sorted[Math.ceil(midIdx)];
          median = (lo + hi) / 2;
        }
  
        // Pair up by matchup_id for W/L
        const byMatchup = {};
        weekMatchups.forEach((m) => {
          const mid = m.matchup_id;
          if (mid == null) return;
          if (!byMatchup[mid]) byMatchup[mid] = [];
          byMatchup[mid].push(m);
        });
  
        Object.values(byMatchup).forEach((pair) => {
          if (pair.length < 2) return;
          const a = pair[0];
          const b = pair[1];
  
          const ridA = a.roster_id;
          const ridB = b.roster_id;
          const ptsA = Number(a.points);
          const ptsB = Number(b.points);
  
          if (!Number.isFinite(ptsA) || !Number.isFinite(ptsB)) return;
          // 0–0 matchups are usually unplayed; ignore
          if (ptsA === 0 && ptsB === 0) return;
  
          const tA = teamsByRosterId[ridA];
          const tB = teamsByRosterId[ridB];
          if (!tA || !tB) return;
  
          tA.pf += ptsA;
          tA.pa += ptsB;
          tA.games += 1;
  
          tB.pf += ptsB;
          tB.pa += ptsA;
          tB.games += 1;
  
          if (ptsA > ptsB) {
            tA.wins += 1;
            tB.losses += 1;
          } else if (ptsB > ptsA) {
            tB.wins += 1;
            tA.losses += 1;
          } else {
            tA.ties += 1;
            tB.ties += 1;
          }
        });
  
        // Median win (expected win) for each team that week
        weekMatchups.forEach((m) => {
          const rid = m.roster_id;
          const pts = Number(m.points);
          const team = teamsByRosterId[rid];
          if (!team || !Number.isFinite(pts)) return;
          if (pts > median) team.medianWins += 1;
          else if (pts === median) team.medianWins += 0.5;
        });
      });
  
      const teams = Object.values(teamsByRosterId);
  
      teams.forEach((t) => {
        t.winPct = t.games ? (t.wins + 0.5 * t.ties) / t.games : 0;
        t.luck = t.wins - t.medianWins;
        t.ppg = t.games ? t.pf / t.games : 0;
      });
  
      teams.sort((a, b) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        if (b.pf !== a.pf) return b.pf - a.pf;
        return a.displayName.localeCompare(b.displayName);
      });
  
      return {
        teams,
        uptoWeek: lastWeekWithGames,
        leagueName: league.name || "",
      };
    }
  
    function renderSeasonSummary(summary) {
      const standingsContainer = $("#season-standings-container");
      const weekLabel = $("#season-week-label");
      const metricsContainer = $("#season-metrics-container");
  
      if (!standingsContainer) return;
  
      if (!summary || !summary.teams.length) {
        standingsContainer.innerHTML =
          '<div class="small">No completed regular-season games yet.</div>';
        if (weekLabel) weekLabel.textContent = "–";
        if (metricsContainer) {
          metricsContainer.innerHTML =
            '<div class="small">Play a few weeks and we’ll start showing rankings and luck metrics here.</div>';
        }
        return;
      }
  
      if (weekLabel && summary.uptoWeek != null) {
        weekLabel.textContent = String(summary.uptoWeek);
      }
  
      const rowsHtml = summary.teams
        .map((t, idx) => {
          const record =
            t.ties > 0
              ? `${t.wins}-${t.losses}-${t.ties}`
              : `${t.wins}-${t.losses}`;
          return (
            "<tr>" +
            `<td>${idx + 1}</td>` +
            `<td>${t.displayName}</td>` +
            `<td>${record}</td>` +
            `<td>${formatNum(t.winPct * 100, 1)}%</td>` +
            `<td>${formatNum(t.pf, 1)}</td>` +
            `<td>${formatNum(t.pa, 1)}</td>` +
            `<td>${formatNum(t.ppg, 1)}</td>` +
            `<td>${formatNum(t.medianWins, 1)}</td>` +
            `<td>${formatNum(t.luck, 1)}</td>` +
            "</tr>"
          );
        })
        .join("");
  
      standingsContainer.innerHTML =
        '<table class="season-standings-table">' +
        "<thead><tr>" +
        "<th>#</th>" +
        "<th>Team</th>" +
        "<th>Record</th>" +
        "<th>Win %</th>" +
        "<th>PF</th>" +
        "<th>PA</th>" +
        "<th>PPG</th>" +
        "<th>Median W</th>" +
        "<th>Luck</th>" +
        "</tr></thead>" +
        "<tbody>" +
        rowsHtml +
        "</tbody></table>";
  
      if (metricsContainer) {
        const sortedByPF = summary.teams
          .slice()
          .sort((a, b) => b.pf - a.pf);
        const sortedByLuck = summary.teams
          .slice()
          .sort((a, b) => b.luck - a.luck);
        const sortedByUnluck = summary.teams
          .slice()
          .sort((a, b) => a.luck - b.luck);
  
        const pfLeader = sortedByPF[0];
        const luckiest = sortedByLuck[0];
        const unluckiest = sortedByUnluck[0];
  
        metricsContainer.innerHTML =
          `<p><strong>Highest PF:</strong> ${pfLeader.displayName} (${formatNum(
            pfLeader.pf,
            1
          )} pts)</p>` +
          `<p><strong>Luckiest:</strong> ${luckiest.displayName} (W - Median W = ${formatNum(
            luckiest.luck,
            1
          )})</p>` +
          `<p><strong>Unluckiest:</strong> ${unluckiest.displayName} (${formatNum(
            unluckiest.luck,
            1
          )})</p>` +
          `<p class="small">“Median W” treats a week as a win if your score beat the league median that week. “Luck” is actual wins minus median wins.</p>`;
      }
    }
  
    function renderForWeek(bundle, uptoWeek) {
      try {
        const summary = buildSeasonSummary(bundle, uptoWeek);
        renderSeasonSummary(summary);
      } catch (err) {
        console.warn("[SeasonOverview] render error:", err);
        const container = $("#season-standings-container");
        if (container) {
          container.innerHTML =
            '<div class="small">Could not compute season summary.</div>';
        }
      }
    }
  
    window.SeasonOverview = {
      renderForWeek,
    };
  })();
  