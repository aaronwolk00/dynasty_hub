// insights.js
// -----------------------------------------------------------------------------
// Season Overview + Insights + Dynasty vs Contender Heatmap
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
// And:
//   window.LeagueModels.buildTeams(league, users, rosters)
//   window.KTCClient (optional, from ktc_client.js)
//   Chart.js already loaded
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
//   • Adds a "Dynasty vs Contender" heatmap:
//       - Uses PF/G as X (win-now strength)
//       - Uses total KTC per roster as Y (dynasty value)
//       - Bubble radius scaled by KTC
//       - Quadrants based on league medians
// ----------------------------------------------------------------------------- 

(function () {
    "use strict";
  
    const EPS = 1e-4;
  
    let lastBundleToken = null;
    let luckChart = null;
    let boomBustChart = null;
    let dynastyHeatmapChart = null;
  
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
      const season =
        bundle.league && bundle.league.season
          ? String(bundle.league.season)
          : "na";
      return `${season}|w${weeks}|r${rosters}`;
    }
  
    function median(values) {
      if (!values || !values.length) return 0;
      const arr = values.slice().sort((a, b) => a - b);
      const mid = Math.floor(arr.length / 2);
      if (arr.length % 2) return arr[mid];
      return 0.5 * (arr[mid - 1] + arr[mid]);
    }
  
    // Dynasty vs Contender buckets
    function classifyBucket(winNow, dynasty, xMed, yMed) {
      const hiX = winNow >= xMed;
      const hiY = dynasty >= yMed;
  
      if (hiX && hiY) return "powerhouse";
      if (hiX && !hiY) return "win-now";
      if (!hiX && hiY) return "rebuild";
      return "middling";
    }
  
    const BUCKET_LABELS = {
      powerhouse: "Powerhouse (Now + Future)",
      "win-now": "All-In Contender",
      rebuild: "Rebuild / Future-Focused",
      middling: "Stuck in the Middle",
    };
  
    const BUCKET_COLORS = {
      powerhouse: "rgba(34, 197, 94, 0.8)",   // green
      "win-now": "rgba(59, 130, 246, 0.8)",   // blue
      rebuild: "rgba(249, 115, 22, 0.85)",    // orange
      middling: "rgba(148, 163, 184, 0.8)",   // slate
    };
  
    function computeRadius(dynasty, minDyn, maxDyn) {
      if (!Number.isFinite(dynasty)) return 6;
      if (!Number.isFinite(minDyn) || !Number.isFinite(maxDyn) || maxDyn <= minDyn) {
        return 10;
      }
      const t = (dynasty - minDyn) / (maxDyn - minDyn);
      const rMin = 6;
      const rMax = 20;
      return rMin + t * (rMax - rMin);
    }
  
    // ----------------------------------------
    // Core aggregation (season metrics)
    // ----------------------------------------
  
    function computeSeasonMetrics(bundle) {
      const rosters = bundle.rosters || [];
      const users = bundle.users || [];
      const matchupsByWeek = bundle.matchupsByWeek || {};
  
      const rosterIdToName = {};
      rosters.forEach((r) => {
        const owner = users.find((u) => u.user_id === r.owner_id) || {};
        const display =
          (r.metadata && r.metadata.team_name) ||
          owner.display_name ||
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
  
            // filled later
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
      const playedWeeks = new Set();
  
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
  
        // Ignore future weeks where nobody has actually scored yet
        const anyPointsPlayed = scores.some((s) => s.pts > 0.05);
        if (!anyPointsPlayed) {
          return;
        }
  
        // Mark this week as "played" for later boom/bust pass
        playedWeeks.add(wkStr);
  
        // Global distribution for boom/bust
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
  
        // weeksWithScore only counts weeks that actually produced scores
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
          if (!playedWeeks.has(wkStr)) return; // only real weeks
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
          '<tr><td colspan="7" class="small">No season data available yet.</td></tr>';
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
        const byDiff = [...teams].sort(
          (a, b) => (b.diff || 0) - (a.diff || 0)
        );
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
    // Insights rendering (table + luck + boom/bust)
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
    // Dynasty vs Contender Heatmap
    // ----------------------------------------
  
    // Custom plugin to draw median crosshairs
    const DynastyMedianLinesPlugin = {
      id: "dynastyMedianLines",
      afterDraw(chart) {
        const med = chart.$dynastyMedians;
        if (!med) return;
        const xMed = med.x;
        const yMed = med.y;
        if (!Number.isFinite(xMed) || !Number.isFinite(yMed)) return;
  
        const xScale = chart.scales.x;
        const yScale = chart.scales.y;
        if (!xScale || !yScale) return;
  
        const ctx = chart.ctx;
        const xPix = xScale.getPixelForValue(xMed);
        const yPix = yScale.getPixelForValue(yMed);
  
        ctx.save();
        ctx.strokeStyle = "rgba(148, 163, 184, 0.7)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
  
        // Vertical line at x = median win-now
        ctx.beginPath();
        ctx.moveTo(xPix, yScale.top);
        ctx.lineTo(xPix, yScale.bottom);
        ctx.stroke();
  
        // Horizontal line at y = median dynasty
        ctx.beginPath();
        ctx.moveTo(xScale.left, yPix);
        ctx.lineTo(xScale.right, yPix);
        ctx.stroke();
  
        ctx.restore();
      },
    };
  
    function computeDynastyVsContenderMetrics(bundle, seasonMetrics) {
      const ktcClient = window.KTCClient || null;
      if (!seasonMetrics || !seasonMetrics.teamList || !seasonMetrics.teamList.length) {
        return { points: [], xMedian: 0, yMedian: 0 };
      }
  
      const teams = seasonMetrics.teamList;
      const rosters = bundle.rosters || [];
  
      const rosterMap = {};
      rosters.forEach((r) => {
        rosterMap[String(r.roster_id)] = r;
      });
  
      const points = [];
  
      teams.forEach((t) => {
        const ridStr = String(t.rosterId);
        const roster = rosterMap[ridStr];
        if (!roster) return;
  
        // Win-now strength: PF per game from season metrics
        const winNow = t.ppg || 0;
  
        // Dynasty value: sum KTC across rostered players
        let dynasty = 0;
        const players = Array.isArray(roster.players) && roster.players.length
          ? roster.players
          : (roster.starters || []);
  
        if (ktcClient && typeof ktcClient.getBestValueForSleeperId === "function") {
          players.forEach((pid) => {
            const v = ktcClient.getBestValueForSleeperId(String(pid));
            if (typeof v === "number" && Number.isFinite(v) && v > 0) {
              dynasty += v;
            }
          });
        }
  
        points.push({
          rosterId: t.rosterId,
          teamName: t.name,
          winNow,
          dynasty,
        });
      });
  
      if (!points.length) {
        return { points: [], xMedian: 0, yMedian: 0 };
      }
  
      const xMedianVal = median(
        points.map((p) => p.winNow).filter(Number.isFinite)
      );
      const yMedianVal = median(
        points.map((p) => p.dynasty).filter(Number.isFinite)
      );
  
      const minDyn = Math.min.apply(
        null,
        points.map((p) => p.dynasty)
      );
      const maxDyn = Math.max.apply(
        null,
        points.map((p) => p.dynasty)
      );
  
      points.forEach((p) => {
        const bucket = classifyBucket(p.winNow, p.dynasty, xMedianVal, yMedianVal);
        p.bucket = bucket;
        p.bucketLabel = BUCKET_LABELS[bucket] || bucket;
        p.radius = computeRadius(p.dynasty, minDyn, maxDyn);
        p.color = BUCKET_COLORS[bucket] || BUCKET_COLORS.middling;
      });
  
      return {
        points,
        xMedian: xMedianVal,
        yMedian: yMedianVal,
      };
    }
  
    function ensureDynastyHeatmapCanvas() {
      let canvas = document.getElementById("insights-dynasty-heatmap");
      if (canvas) return canvas;
  
      const tab = document.getElementById("tab-insights");
      if (!tab) return null;
  
      const overview = tab.querySelector(".season-overview") || tab;
  
      const section = document.createElement("section");
      section.className = "dynasty-heatmap-section";
      section.innerHTML = `
        <h3 class="season-subheading">Dynasty vs Contender</h3>
        <div class="chart-card" style="height: 260px; margin-bottom: 16px;">
          <canvas id="insights-dynasty-heatmap"></canvas>
        </div>
        <p class="small">
          X-axis: win-now strength (PF per game). Y-axis: total KTC value of the roster.
          Bubble size also scales with KTC. Quadrants separate powerhouses, contenders,
          rebuilders, and teams stuck in the middle.
        </p>
      `;
  
      overview.appendChild(section);
      return section.querySelector("canvas");
    }
  
    function renderDynastyHeatmap(dynMetrics) {
      const pts = dynMetrics.points || [];
      if (!pts.length) {
        console.warn("[insights.js] No data for Dynasty vs Contender heatmap.");
        return;
      }
  
      const canvas = ensureDynastyHeatmapCanvas();
      if (!canvas || !canvas.getContext) {
        console.warn(
          "[insights.js] Could not find or create #insights-dynasty-heatmap canvas."
        );
        return;
      }
  
      const ctx = canvas.getContext("2d");
  
      if (dynastyHeatmapChart) {
        dynastyHeatmapChart.destroy();
        dynastyHeatmapChart = null;
      }
  
      const xVals = pts.map((p) => p.winNow).filter(Number.isFinite);
      const yVals = pts.map((p) => p.dynasty).filter(Number.isFinite);
  
      const xMin = Math.min.apply(null, xVals);
      const xMax = Math.max.apply(null, xVals);
      const yMin = Math.min.apply(null, yVals);
      const yMax = Math.max.apply(null, yVals);
  
      const xPad = (xMax - xMin) * 0.1 || 5;
      const yPad = (yMax - yMin) * 0.1 || 500;
  
      const dataPoints = pts.map((p) => ({
        x: p.winNow,
        y: p.dynasty,
        r: p.radius,
        label: p.teamName,
        bucket: p.bucket,
        bucketLabel: p.bucketLabel,
        backgroundColor: p.color,
      }));
  
      dynastyHeatmapChart = new Chart(ctx, {
        type: "bubble",
        data: {
          datasets: [
            {
              label: "Teams",
              data: dataPoints,
              backgroundColor: dataPoints.map((d) => d.backgroundColor),
              borderWidth: 1,
              borderColor: "rgba(15, 23, 42, 0.9)",
              hoverBorderWidth: 2,
            },
          ],
        },
        plugins: [DynastyMedianLinesPlugin],
        options: {
          responsive: true,
          maintainAspectRatio: false,
          parsing: false,
          scales: {
            x: {
              title: {
                display: true,
                text: "Win-Now Strength (PF per game)",
              },
              min: xMin - xPad,
              max: xMax + xPad,
              grid: {
                color: "rgba(31, 41, 55, 0.4)",
              },
              ticks: {
                precision: 1,
              },
            },
            y: {
              title: {
                display: true,
                text: "Dynasty Value (Total KTC)",
              },
              min: yMin - yPad,
              max: yMax + yPad,
              grid: {
                color: "rgba(31, 41, 55, 0.4)",
              },
            },
          },
          plugins: {
            legend: {
              display: false,
            },
            title: {
              display: true,
              text: "Dynasty vs Contender – Strategy Heatmap",
            },
            tooltip: {
              callbacks: {
                label(context) {
                  const d = context.raw || {};
                  const lines = [];
                  lines.push(d.label || "Unknown Team");
                  lines.push("Win-Now (PF/G): " + context.parsed.x.toFixed(1));
                  lines.push("Dynasty KTC: " + context.parsed.y.toFixed(0));
                  if (d.bucketLabel) lines.push(d.bucketLabel);
                  return lines;
                },
              },
            },
          },
        },
      });
  
      dynastyHeatmapChart.$dynastyMedians = {
        x: dynMetrics.xMedian,
        y: dynMetrics.yMedian,
      };
    }
  
    function renderDynastyVsContender(bundle, seasonMetrics) {
      if (!window.Chart) return;
  
      const ktcClient = window.KTCClient || null;
      if (!ktcClient) {
        console.warn(
          "[insights.js] KTCClient not available; Dynasty vs Contender heatmap skipped."
        );
        return;
      }
  
      const maybeReady =
        typeof ktcClient.whenReady === "function"
          ? ktcClient.whenReady()
          : Promise.resolve();
  
      maybeReady
        .then(() => {
          const dynMetrics = computeDynastyVsContenderMetrics(
            bundle,
            seasonMetrics
          );
          if (!dynMetrics.points.length) return;
          renderDynastyHeatmap(dynMetrics);
        })
        .catch((err) => {
          console.warn(
            "[insights.js] Error waiting for KTCClient.whenReady():",
            err
          );
        });
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
        renderDynastyVsContender(bundle, metrics);
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
      refreshFromBundle(bundle) {
        try {
          const b = bundle || window.__LAST_BUNDLE__;
          if (!b) return;
          const metrics = computeSeasonMetrics(b);
          renderSeasonStandings(metrics);
          renderInsights(metrics);
          renderDynastyVsContender(b, metrics);
        } catch (err) {
          console.warn("[insights.js] manual refresh error:", err);
        }
      },
    };
  })();
  