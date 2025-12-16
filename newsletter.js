// newsletter.js
// -----------------------------------------------------------------------------
// Wolk Dynasty – Playoff Newsletter Renderer (SleeperClient + LeagueModels)
// -----------------------------------------------------------------------------
//
// Assumes the following are loaded BEFORE this file:
//   - league_config.js        -> window.LEAGUE_CONFIG
//   - sleeper_client.js       -> window.SleeperClient
//   - models.js               -> window.LeagueModels
//   - projections.js          -> window.ProjectionEngine
//   - charts.js (optional)    -> window.PlayoffCharts
//
// Assumes index.html provides:
//   - #league-subtitle
//   - #matchups-container
//   - #newsletter-content
//   - <canvas id="semifinal-odds-chart">
//   - <canvas id="title-odds-chart">
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    // -----------------------
    // DOM / formatting helpers
    // -----------------------
  
    function $(selector, root = document) {
      return root.querySelector(selector);
    }
  
    function formatPercent(p, digits = 1) {
      return `${(p * 100).toFixed(digits)}%`;
    }
  
    function formatScore(x, digits = 1) {
      return x.toFixed(digits);
    }
  
    function formatRange(low, high, digits = 1) {
      return `${low.toFixed(digits)} – ${high.toFixed(digits)}`;
    }
  
    function formatSpread(muA, muB, nameA, nameB) {
      const diff = muA - muB;
      const abs = Math.abs(diff);
      if (abs < 0.25) return "Pick’em";
      const fav = diff > 0 ? nameA : nameB;
      return `${fav} -${abs.toFixed(1)}`;
    }
  
    function formatTotal(muA, muB) {
      return (muA + muB).toFixed(1);
    }
  
    function probabilityToMoneyline(p) {
      if (p <= 0) return "N/A";
      if (p >= 0.999) return "-∞";
      if (p <= 0.5) {
        const odds = (1 - p) / p;
        const ml = Math.round(odds * 100);
        return `+${ml}`;
      }
      const odds = p / (1 - p);
      const ml = Math.round(100 / odds);
      return `-${ml}`;
    }
  
    // Simple erf-based normal CDF for finals matrix
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
        (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) *
          t *
          Math.exp(-x * x);
  
      return sign * y;
    }
  
    function normalCdf(x) {
      return 0.5 * (1 + erf(x / Math.sqrt(2)));
    }
  
    // -----------------------
    // Finals matrix
    // -----------------------
  
    /**
     * Build pairwise finals win probabilities from semifinal projected distributions.
     *
     * finalsMatrix[teamNameA][teamNameB] = P(A beats B on neutral finals field)
     */
    function buildFinalsMatrixFromSemis(semiWithSims) {
      const teams = {};
  
      semiWithSims.forEach((m) => {
        const a = m.projected.teamA;
        const b = m.projected.teamB;
        const nameA = a.team.teamDisplayName;
        const nameB = b.team.teamDisplayName;
  
        teams[nameA] = {
          mean: a.projection.totalMean,
          sd: a.projection.totalSd,
        };
        teams[nameB] = {
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
          const varDiff = (tA.sd * tA.sd + tB.sd * tB.sd) || 1;
          const z = muDiff / Math.sqrt(varDiff);
          const p = normalCdf(z);
          matrix[nameA][nameB] = p;
        });
      });
  
      return matrix;
    }
  
    // -----------------------
    // Rendering helpers
    // -----------------------
  
    function renderLoading(message) {
      const matchupsEl = $("#matchups-container");
      const newsEl = $("#newsletter-content");
      if (matchupsEl) {
        matchupsEl.innerHTML = `<div class="loading">${message || "Loading league data…"}</div>`;
      }
      if (newsEl) {
        newsEl.innerHTML = `
          <p class="loading">${message || "Building projections and simulations…"}</p>
        `;
      }
    }
  
    function renderError(err) {
      const matchupsEl = $("#matchups-container");
      const newsEl = $("#newsletter-content");
      const msg = err && err.message ? err.message : "Unknown error";
  
      if (matchupsEl) {
        matchupsEl.innerHTML = `
          <article class="matchup-card">
            <div class="matchup-header">
              <div class="matchup-teams">Error loading data from Sleeper</div>
            </div>
            <div class="matchup-scores">
              <span class="small">${msg}</span>
            </div>
          </article>
        `;
      }
  
      if (newsEl) {
        newsEl.innerHTML = `
          <h3>Something went wrong</h3>
          <p>${msg}</p>
          <p class="small">Check the browser console for more details.</p>
        `;
      }
    }
  
    function renderSemifinalCards(semiWithSims) {
      const container = $("#matchups-container");
      if (!container) return;
  
      if (!semiWithSims || !semiWithSims.length) {
        container.innerHTML = `
          <div class="matchup-card">
            <div class="matchup-header">
              <div class="matchup-teams">No semifinal matchups detected</div>
            </div>
            <div class="matchup-scores">
              <span class="small">Check that your LEAGUE_CONFIG playoff settings line up with Sleeper’s bracket.</span>
            </div>
          </div>
        `;
        return;
      }
  
      const cardsHtml = semiWithSims
        .map(({ projected, sim }, idx) => {
          const m = projected.matchup;
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
  
          const winA = sim.teamAWinPct;
          const winB = sim.teamBWinPct;
  
          const favoriteName = winA > winB ? nameA : nameB;
  
          const favTag = (nm) =>
            nm === favoriteName
              ? '<span class="tag tag-favorite">Fav</span>'
              : '<span class="tag tag-underdog">Dog</span>';
  
          return `
            <article class="matchup-card favorite">
              <div class="matchup-header">
                <div class="matchup-teams">
                  ${nameA} vs ${nameB}
                  <span class="seed-label">${m.roundLabel || "Semifinal"} • Matchup ${idx + 1}</span>
                </div>
                <div class="matchup-meta">
                  Simulated ${sim.sims || 10000} times • ${
                    sim.tiePct ? formatPercent(sim.tiePct, 2) + " ties" : "no ties tracked"
                  }
                </div>
              </div>
              <div class="matchup-scores">
                <span>
                  <strong>${formatScore(muA)}</strong> proj 
                  (${formatRange(rangeA.low, rangeA.high)}) 
                  ${favTag(nameA)}
                </span>
                <span>
                  <strong>${formatScore(muB)}</strong> proj 
                  (${formatRange(rangeB.low, rangeB.high)}) 
                  ${favTag(nameB)}
                </span>
              </div>
              <div class="matchup-meta" style="margin-top:6px;">
                Win odds: ${nameA} ${formatPercent(winA)}, ${nameB} ${formatPercent(winB)} •
                Spread: ${formatSpread(muA, muB, nameA, nameB)} •
                Total: ${formatTotal(muA, muB)} pts
              </div>
            </article>
          `;
        })
        .join("");
  
      container.innerHTML = cardsHtml;
    }
  
    function renderNewsletterBody(semiWithSims, champOdds) {
      const container = $("#newsletter-content");
      if (!container) return;
  
      const oddsEntries = champOdds
        ? Object.entries(champOdds).sort((a, b) => b[1].titleOdds - a[1].titleOdds)
        : [];
  
      const champTable = champOdds
        ? `
          <table class="odds-table">
            <thead>
              <tr>
                <th>Team</th>
                <th>Reach Final</th>
                <th>Win Title</th>
                <th>Implied Line</th>
              </tr>
            </thead>
            <tbody>
              ${oddsEntries
                .map(([name, stats]) => {
                  const reach = stats.path && typeof stats.path.reachFinalPct === "number"
                    ? stats.path.reachFinalPct
                    : 0;
                  const titleP = stats.titleOdds || 0;
                  const line = probabilityToMoneyline(titleP);
                  return `
                    <tr>
                      <td>${name}</td>
                      <td>${formatPercent(reach, 1)}</td>
                      <td>${formatPercent(titleP, 1)}</td>
                      <td class="small">${line}</td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table>
        `
        : `<p class="small">Championship odds unavailable – need exactly two semifinal matchups.</p>`;
  
      const semisSummary = semiWithSims
        .map(({ projected, sim }) => {
          const tA = projected.teamA;
          const tB = projected.teamB;
          const nameA = tA.team.teamDisplayName;
          const nameB = tB.team.teamDisplayName;
  
          return `
            <li>
              <strong>${nameA}</strong> vs <strong>${nameB}</strong>:
              ${formatScore(tA.projection.totalMean)}–${formatScore(
            tB.projection.totalMean
          )} (proj) •
              win odds ${nameA} ${formatPercent(sim.teamAWinPct)}, ${nameB} ${formatPercent(
            sim.teamBWinPct
          )}
            </li>
          `;
        })
        .join("");
  
      container.innerHTML = `
        <h3>Semifinal Outlook</h3>
        <p>
          Using your custom per-player projections and a 10,000-run Monte Carlo, here’s how the
          semifinal matchups stack up on paper.
        </p>
        <ul>
          ${semisSummary}
        </ul>
  
        <h3>Title Race – Odds Snapshot</h3>
        ${champTable}
  
        <p class="small">
          All odds are model-based approximations from your current projection engine and can swing
          quickly with lineup changes, injuries, or late waiver moves.
        </p>
      `;
    }
  
    function renderCharts(semiWithSims, champOdds) {
      if (!window.PlayoffCharts) return;
  
      // Championship odds → simple array
      if (champOdds) {
        const titleArray = Object.entries(champOdds).map(([teamName, stats]) => ({
          teamName,
          probability: stats.titleOdds || 0,
        }));
        window.PlayoffCharts.renderChampionshipOdds("title-odds-chart", titleArray);
      }
  
      // Semifinal odds → stacked bars
      if (semiWithSims && semiWithSims.length) {
        const semiArray = semiWithSims.map(({ projected, sim }, idx) => {
          const tA = projected.teamA;
          const tB = projected.teamB;
          const nameA = tA.team.teamDisplayName;
          const nameB = tB.team.teamDisplayName;
  
          const favoriteName = sim.teamAWinPct >= sim.teamBWinPct ? nameA : nameB;
          const favoriteWinProb =
            favoriteName === nameA ? sim.teamAWinPct : sim.teamBWinPct;
          const label = projected.matchup.roundLabel
            ? `${projected.matchup.roundLabel} ${idx + 1}`
            : `${nameA} vs ${nameB}`;
  
          return {
            id: projected.matchup.id || `semi${idx + 1}`,
            label,
            favoriteName,
            favoriteWinProb,
            underdogName: favoriteName === nameA ? nameB : nameA,
          };
        });
  
        window.PlayoffCharts.renderSemifinalOdds("semifinal-odds-chart", semiArray);
      }
    }
  
    // -----------------------
    // Main bootstrap
    // -----------------------
  
    async function init() {
      const cfg = window.LEAGUE_CONFIG || {};
      const semiWeek =
        Number.isFinite(Number(cfg.SEMIFINAL_WEEK)) && Number(cfg.SEMIFINAL_WEEK) > 0
          ? Number(cfg.SEMIFINAL_WEEK)
          : cfg.playoffs && cfg.playoffs.semifinalWeek
          ? Number(cfg.playoffs.semifinalWeek)
          : null;
  
      const champWeek =
        Number.isFinite(Number(cfg.CHAMPIONSHIP_WEEK)) && Number(cfg.CHAMPIONSHIP_WEEK) > 0
          ? Number(cfg.CHAMPIONSHIP_WEEK)
          : semiWeek != null
          ? semiWeek + 1
          : null;
  
      const subtitleEl = $("#league-subtitle");
      renderLoading("Pulling Sleeper league, rosters, and semifinal matchups…");
  
      try {
        if (!window.SleeperClient || !window.LeagueModels || !window.ProjectionEngine) {
          throw new Error(
            "Required modules missing. Ensure sleeper_client.js, models.js, and projections.js are loaded before newsletter.js."
          );
        }
  
        const weeksToFetch = [];
        if (semiWeek != null) weeksToFetch.push(semiWeek);
        if (champWeek != null && champWeek !== semiWeek) weeksToFetch.push(champWeek);
  
        const bundle = await window.SleeperClient.fetchLeagueBundle({
          weeks: weeksToFetch,
        });
  
        const league = bundle.league;
        if (subtitleEl && league) {
          subtitleEl.textContent = `${league.name || "Sleeper League"} • Season ${
            league.season || ""
          } • Semifinals`;
        }
  
        if (semiWeek == null) {
          throw new Error(
            "SEMIFINAL_WEEK is not configured in LEAGUE_CONFIG; cannot build playoff view."
          );
        }
  
        // Build a "snapshot" in the same shape sleeper_api.js would have produced.
        const semiSnapshot = {
          league: bundle.league,
          users: bundle.users,
          rosters: bundle.rosters,
          matchups: bundle.matchupsByWeek[semiWeek] || [],
        };
  
        // Let LeagueModels figure out the 1-vs-4 and 2-vs-3 pairings.
        const playoffMatchups = window.LeagueModels.buildPlayoffMatchups(
          semiSnapshot,
          cfg
        );
  
        const semiMatchups = (playoffMatchups || []).filter((m) => !m.isBye);
  
        if (!semiMatchups.length) {
          throw new Error(
            "No semifinal matchups were produced by LeagueModels.buildPlayoffMatchups."
          );
        }
  
        // Normalize each raw matchup into the shape ProjectionEngine expects.
        const semiWithSims = semiMatchups.map((raw) => {
          const highTeam =
            raw.highSeedTeam ||
            raw.teamA ||
            raw.home ||
            (Array.isArray(raw.teams) ? raw.teams[0] : null);
          const lowTeam =
            raw.lowSeedTeam ||
            raw.teamB ||
            raw.away ||
            (Array.isArray(raw.teams) ? raw.teams[1] : null);
  
          if (!highTeam || !lowTeam) {
            throw new Error("Malformed playoff matchup: missing team views.");
          }
  
          const projected = window.ProjectionEngine.projectMatchup({
            id: raw.id,
            week: raw.week,
            roundLabel: raw.roundLabel || raw.round || "Semifinal",
            teamA: highTeam,
            teamB: lowTeam,
          });
  
          const sim = window.ProjectionEngine.simulateMatchup(projected, {
            sims: 10000,
            trackScores: false,
          });
  
          // Keep a back-reference to round metadata
          projected.matchup = {
            id: raw.id,
            week: raw.week,
            roundLabel: raw.roundLabel || raw.round || "Semifinal",
          };
  
          return { projected, sim };
        });
  
        // Finals pairwise matrix based on these semis.
        const finalsMatrix = buildFinalsMatrixFromSemis(semiWithSims);
  
        // Championship odds (requires exactly two semis).
        const champOdds =
          semiWithSims.length === 2
            ? window.ProjectionEngine.computeChampionshipOdds(
                semiWithSims[0],
                semiWithSims[1],
                finalsMatrix
              )
            : null;
  
        // Render UI
        renderSemifinalCards(semiWithSims);
        renderNewsletterBody(semiWithSims, champOdds);
        renderCharts(semiWithSims, champOdds);
      } catch (err) {
        console.error("[newsletter.js] init error:", err);
        renderError(err);
      }
    }
  
    document.addEventListener("DOMContentLoaded", init);
  
    // Optional manual refresh hook
    window.PlayoffNewsletter = {
      refresh: init,
    };
  })();
  