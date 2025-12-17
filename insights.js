// insights.js
// -----------------------------------------------------------------------------
// Season Overview + Insights (Schedule Luck, vs Avg, Boom/Bust)
// -----------------------------------------------------------------------------
//
// Assumes the following globals from newsletter.js / sleeper_client.js:
//   window.__LAST_BUNDLE__ = {
//      league,
//      users: [...],
//      rosters: [...],
//      matchupsByWeek: { "1": [matchup...], "2": [...], ... }
//   }
//
// Matchup shape is the standard Sleeper one:
//   { roster_id, matchup_id, points, ... }
//
// This script:
//
//   • Computes per-team season stats from matchupsByWeek
//   • Populates the Season tab:
//       - #season-standings-body
//       - #season-metrics-container
//   • Populates the Insights tab:
//       - #insights-table-body
//       - #insights-luck-chart
//       - #insights-boom-bust-chart
//       - Adds an #insights-legend paragraph
//
// Luck definition (all-play):
//   For each week, treat scores as if every team played every other team.
//   All-play win% = (wins + 0.5 * ties) / all comparisons.
//   Luck (wins) = actual wins − expected wins from all-play (% * games).
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    const EPS = 1e-4;
  
    let lastBundleToken = null;
    let luckChart = null;
    let boomBustChart = null;
  
    // ----------------------------------------
    // Small helpers
    // ----------------------------------------
  
    function safeNumber(x) {
      const n = Number(x);
      return Number.isFinite(n) ? n : 0;
    }
  
    function shortName(name, maxLen) {
      if (!name) return "";
      if (name.length <= maxLen) return name;
      return name.slice(0, maxLen - 1) + "…";
    }
  
    function formatRecord(t) {
      const base = `${t.wins}-${t.losses}`;
      return t.ties ? `${base}-${t.ties}` : base;
    }
  
    function bundleToken(bundle) {
      if (!bundle) return null;
      const weeks = bundle.matchupsByWeek
        ? Object.keys(bundle.matchupsByWeek).length
        : 0;
      const rosters = (bundle.rosters || []).length;
      const season = bundle.league && bundle.league.season
        ? String(bundle.league.season)
        : "na";
      return `${season}|w${weeks}|r${rosters}`;
    }
  
    // ----------------------------------------
    // Core aggregation
    // ----------------------------------------
  
    function computeSeasonMetrics(bundle) {
      const rosters = bundle.rosters || [];
      const users = bundle.users || [];
      const matchupsByWeek = bundle.matchupsByWeek || {};
  
      const rosterIdToName = {};
      rosters.forEach((r) => {
        const owner = users.find((u) => u.user_id === r.owner_id) || {};
        const display =
          owner.display_name ||
          r.metadata?.team_name ||
          r.team_name ||
          `Team ${r.roster_id}`;
        rosterIdToName[Number(r.roster_id)] = display;
      });
  
      const teamsMap = new Map();
  
      function ensureTeam(rosterId) {
        const idNum = Number(rosterId);
        if (!teamsMap.has(idNum)) {
          teamsMap.set(idNum, {
            rosterId: idNum,
            name: rosterIdToName[idNum] || `Team ${idNum}`,
  
            wins: 0,
            losses: 0,
            ties: 0,
            games: 0,
  
            pf: 0,
            pa: 0,
            diff: 0,
  
            allPlayWins: 0,
            allPlayLosses: 0,
            allPlayTies: 0,
  
            vsAvgWins: 0,
            vsAvgLosses: 0,
            vsAvgTies: 0,
  
            boomWeeks: 0,
            bustWeeks: 0,
            weeksWithScore: 0,
  
            // will be filled later
            ppg: 0,
            actualWinPct: 0,
            allPlayWinPct: 0,
            luckGames: 0,
            vsAvgPct: 0,
            boomPct: 0,
            bustPct: 0,
          });
        }
        return teamsMap.get(idNum);
      }
  
      const allWeeklyScores = [];
  
      // First pass: PF/PA, actual record, all-play, vs-average
      Object.keys(matchupsByWeek).forEach((wkStr) => {
        const weekMatchups = matchupsByWeek[wkStr] || [];
        if (!weekMatchups.length) return;
      
        const scores = [];
        const byGame = new Map();
      
        // Collect scores and game groupings
        weekMatchups.forEach((m) => {
          const rosterId = Number(m.roster_id);
          const pts = Number(m.points);
          if (!rosterId || !Number.isFinite(pts)) return;
          scores.push({ rosterId, pts });
      
          const key =
            m.matchup_id != null
              ? String(m.matchup_id)
              : "solo-" + String(rosterId);
          if (!byGame.has(key)) byGame.set(key, []);
          byGame.get(key).push({ rosterId, pts });
        });
      
        if (!scores.length) return;
      
        // ✨ NEW: Ignore weeks where nobody has actually scored yet
        // (Sleeper often reports future weeks as 0–0 for everyone).
        const anyPointsPlayed = scores.some((s) => s.pts > 0.05);
        if (!anyPointsPlayed) {
          // Don’t count toward PF/PA, all-play, vsAvg, boom/bust, etc.
          return;
        }
      
        // Now that we know this is a real, played week,
        // include these scores in the global boom/bust stats.
        scores.forEach((s) => {
          allWeeklyScores.push(s.pts);
        });
      
        const weekAvg =
          scores.reduce((sum, s) => sum + s.pts, 0) / scores.length;
      
        // --- vs league average ---
        scores.forEach((s) => {
          const t = ensureTeam(s.rosterId);
          if (s.pts > weekAvg + EPS) t.vsAvgWins++;
          else if (s.pts < weekAvg - EPS) t.vsAvgLosses++;
          else t.vsAvgTies++;
        });
      
        // --- all-play ---
        for (let i = 0; i < scores.length; i++) {
          const a = scores[i];
          const tA = ensureTeam(a.rosterId);
          for (let j = 0; j < scores.length; j++) {
            if (i === j) continue;
            const b = scores[j];
            if (a.pts > b.pts + EPS) tA.allPlayWins++;
            else if (a.pts < b.pts - EPS) tA.allPlayLosses++;
            else tA.allPlayTies++;
          }
        }
      
        // --- actual record + PF/PA from head-to-head ---
        byGame.forEach((gameArr) => {
          if (gameArr.length < 2) return;
          const g1 = gameArr[0];
          const g2 = gameArr[1];
          const t1 = ensureTeam(g1.rosterId);
          const t2 = ensureTeam(g2.rosterId);
      
          t1.pf += g1.pts;
          t1.pa += g2.pts;
          t2.pf += g2.pts;
          t2.pa += g1.pts;
      
          t1.diff = t1.pf - t1.pa;
          t2.diff = t2.pf - t2.pa;
      
          t1.games++;
          t2.games++;
      
          if (Math.abs(g1.pts - g2.pts) <= EPS) {
            t1.ties++;
            t2.ties++;
          } else if (g1.pts > g2.pts) {
            t1.wins++;
            t2.losses++;
          } else {
            t2.wins++;
            t1.losses++;
          }
        });
      
        // weeksWithScore only counts played weeks now
        scores.forEach((s) => {
          const t = ensureTeam(s.rosterId);
          t.weeksWithScore++;
        });
      });
      
  
      // Global thresholds for boom/bust (mean ± 1σ over all roster-week scores)
      let globalMean = 0;
      let globalStd = 0;
      if (allWeeklyScores.length) {
        const n = allWeeklyScores.length;
        globalMean =
          allWeeklyScores.reduce((sum, x) => sum + x, 0) / n;
        const variance =
          allWeeklyScores.reduce(
            (sum, x) => sum + (x - globalMean) * (x - globalMean),
            0
          ) / n;
        globalStd = Math.sqrt(variance);
      }
  
      if (globalStd > 0) {
        const upper = globalMean + globalStd;
        const lower = globalMean - globalStd;
  
        Object.keys(matchupsByWeek).forEach((wkStr) => {
          const weekMatchups = matchupsByWeek[wkStr] || [];
          weekMatchups.forEach((m) => {
            const rosterId = Number(m.roster_id);
            const pts = Number(m.points);
            if (!rosterId || !Number.isFinite(pts)) return;
            const t = ensureTeam(rosterId);
            if (pts >= upper) t.boomWeeks++;
            else if (pts <= lower) t.bustWeeks++;
          });
        });
      }
  
      // Finalize per-team rates + derived fields
      const teamList = Array.from(teamsMap.values());
      teamList.forEach((t) => {
        const g = t.games || 0;
        const allPlayGames =
          t.allPlayWins + t.allPlayLosses + t.allPlayTies;
        const vsAvgGames =
          t.vsAvgWins + t.vsAvgLosses + t.vsAvgTies;
        const weeks = t.weeksWithScore || 0;
  
        t.ppg = g ? t.pf / g : 0;
  
        const actualWinPct = g
          ? (t.wins + 0.5 * t.ties) / g
          : 0;
        const allPlayWinPct = allPlayGames
          ? (t.allPlayWins + 0.5 * t.allPlayTies) / allPlayGames
          : 0;
  
        t.actualWinPct = actualWinPct;
        t.allPlayWinPct = allPlayWinPct;
  
        const expectedWinsFromAllPlay = g * allPlayWinPct;
        t.luckGames = g ? t.wins - expectedWinsFromAllPlay : 0;
  
        t.vsAvgPct = vsAvgGames ? t.vsAvgWins / vsAvgGames : 0;
  
        t.boomPct = weeks ? t.boomWeeks / weeks : 0;
        t.bustPct = weeks ? t.bustWeeks / weeks : 0;
      });
  
      // Sort standings: wins → diff → PF → name
      teamList.sort((a, b) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        const diffA = a.diff || 0;
        const diffB = b.diff || 0;
        if (diffB !== diffA) return diffB - diffA;
        if (b.pf !== a.pf) return b.pf - a.pf;
        return a.name.localeCompare(b.name);
      });
  
      return { teamList };
    }
  
    // ----------------------------------------
    // Season Overview rendering
    // ----------------------------------------
  
    function renderSeasonStandings(metrics) {
      const tbody = document.getElementById("season-standings-body");
      const snapshotBox = document.getElementById(
        "season-metrics-container"
      );
      if (!tbody) return;
  
      const teams = metrics.teamList || [];
  
      if (!teams.length) {
        tbody.innerHTML =
          '<tr><td colspan="6" class="small">No season data available yet.</td></tr>';
        if (snapshotBox) {
          snapshotBox.innerHTML =
            '<p class="small">Season metrics will appear once at least one week has scores.</p>';
        }
        return;
      }
  
      const rowsHtml = teams
        .map((t, idx) => {
          return `
            <tr>
              <td>${idx + 1}</td>
              <td>${t.name}</td>
              <td>${formatRecord(t)}</td>
              <td>${t.pf.toFixed(1)}</td>
              <td>${t.pa.toFixed(1)}</td>
              <td>${(t.diff || 0).toFixed(1)}</td>
            </tr>
          `;
        })
        .join("");
  
      tbody.innerHTML = rowsHtml;
  
      if (snapshotBox) {
        const byPF = [...teams].sort((a, b) => b.pf - a.pf);
        const byDiff = [...teams].sort((a, b) => (b.diff || 0) - (a.diff || 0));
        const byLuckMost = [...teams].sort(
          (a, b) => (b.luckGames || 0) - (a.luckGames || 0)
        );
        const byLuckLeast = [...teams].sort(
          (a, b) => (a.luckGames || 0) - (b.luckGames || 0)
        );
  
        const topPF = byPF[0];
        const bestDiff = byDiff[0];
        const luckiest = byLuckMost[0];
        const unluckiest = byLuckLeast[0];
  
        snapshotBox.innerHTML = `
          <p><strong>Top Scoring:</strong> ${
            topPF
              ? `${topPF.name} (${topPF.pf.toFixed(1)} PF)`
              : "–"
          }</p>
          <p><strong>Best Differential:</strong> ${
            bestDiff
              ? `${bestDiff.name} (${(bestDiff.diff || 0).toFixed(1)})`
              : "–"
          }</p>
          <p><strong>Luck Index:</strong> ${
            luckiest && unluckiest
              ? `${luckiest.name} is +${luckiest.luckGames.toFixed(
                  1
                )} wins vs all-play; ${unluckiest.name} is ${unluckiest.luckGames.toFixed(
                  1
                )}.`
              : "–"
          }</p>
          <p class="small">
            Luck is measured by comparing a team's actual record to how often
            their weekly scores would win if they played every other team every week
            (all-play record).
          </p>
        `;
      }
    }
  
    // ----------------------------------------
    // Insights rendering
    // ----------------------------------------
  
    function renderInsights(metrics) {
      const tab = document.getElementById("tab-insights");
      const tbody = document.getElementById("insights-table-body");
      const luckCanvas = document.getElementById("insights-luck-chart");
      const boomCanvas = document.getElementById(
        "insights-boom-bust-chart"
      );
      if (!tab || !tbody) return;
  
      const teams = metrics.teamList || [];
      if (!teams.length) {
        tbody.innerHTML =
          '<tr><td colspan="8" class="small">Insights will populate once historical scores are available.</td></tr>';
        return;
      }
  
      // Legend / description
      let legend = document.getElementById("insights-legend");
      if (!legend) {
        legend = document.createElement("p");
        legend.id = "insights-legend";
        legend.className = "small";
        legend.style.marginBottom = "10px";
        const overview = tab.querySelector(".season-overview");
        if (overview) {
          tab.insertBefore(legend, overview);
        } else {
          tab.insertBefore(legend, tab.firstChild);
        }
      }
      legend.textContent =
        "Luck = actual wins minus expected wins from your all-play record " +
        "(playing every team each week). vs Avg = share of weeks where your " +
        "score beat the league average. Boom/Bust = share of weeks at least " +
        "1σ above / below the league-wide scoring mean.";
  
      // Table
      const rowsHtml = teams
        .map((t, idx) => {
          return `
            <tr>
              <td>${idx + 1}</td>
              <td>${t.name}</td>
              <td>${formatRecord(t)}</td>
              <td>${t.ppg.toFixed(1)}</td>
              <td>${t.luckGames >= 0 ? "+" : ""}${t.luckGames.toFixed(1)}</td>
              <td>${(t.vsAvgPct * 100).toFixed(0)}%</td>
              <td>${(t.boomPct * 100).toFixed(0)}%</td>
              <td>${(t.bustPct * 100).toFixed(0)}%</td>
            </tr>
          `;
        })
        .join("");
      tbody.innerHTML = rowsHtml;
  
      // Charts
      if (window.Chart) {
        const labels = teams.map((t) => shortName(t.name, 12));
        const luckData = teams.map((t) =>
          Number(t.luckGames.toFixed(2))
        );
        const boomData = teams.map((t) =>
          Number((t.boomPct * 100).toFixed(1))
        );
        const bustData = teams.map((t) =>
          Number((t.bustPct * 100).toFixed(1))
        );
  
        if (luckCanvas) {
          if (luckChart) luckChart.destroy();
          luckChart = new Chart(luckCanvas, {
            type: "bar",
            data: {
              labels,
              datasets: [
                {
                  label: "Luck (wins vs all-play)",
                  data: luckData,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              scales: {
                x: {
                  ticks: {
                    autoSkip: false,
                    maxRotation: 75,
                    minRotation: 45,
                  },
                },
                y: {
                  title: {
                    display: true,
                    text: "Wins over/under all-play",
                  },
                },
              },
            },
          });
        }
  
        if (boomCanvas) {
          if (boomBustChart) boomBustChart.destroy();
          boomBustChart = new Chart(boomCanvas, {
            type: "bar",
            data: {
              labels,
              datasets: [
                {
                  label: "Boom weeks (≥ +1σ)",
                  data: boomData,
                },
                {
                  label: "Bust weeks (≤ −1σ)",
                  data: bustData,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              scales: {
                y: {
                  title: {
                    display: true,
                    text: "% of weeks",
                  },
                },
              },
            },
          });
        }
      }
    }
  
    // ----------------------------------------
    // Poll for bundle + refresh both tabs
    // ----------------------------------------
  
    function refreshIfBundleChanged() {
      const bundle = window.__LAST_BUNDLE__;
      if (!bundle) return;
  
      const token = bundleToken(bundle);
      if (!token || token === lastBundleToken) return;
      lastBundleToken = token;
  
      try {
        const metrics = computeSeasonMetrics(bundle);
        renderSeasonStandings(metrics);
        renderInsights(metrics);
      } catch (err) {
        console.warn("[insights.js] refresh error:", err);
      }
    }
  
    document.addEventListener("DOMContentLoaded", () => {
      // Run once, then whenever __LAST_BUNDLE__ changes (week select / refresh)
      refreshIfBundleChanged();
      setInterval(refreshIfBundleChanged, 1500);
    });
  
    // Expose a tiny API if you ever want to force-refresh manually.
    window.Insights = {
      refreshFromBundle: function (bundle) {
        try {
          const metrics = computeSeasonMetrics(bundle);
          renderSeasonStandings(metrics);
          renderInsights(metrics);
        } catch (err) {
          console.warn("[insights.js] manual refresh error:", err);
        }
      },
    };
  })();
  