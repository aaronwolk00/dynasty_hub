// newsletter.js
// -----------------------------------------------------------------------------
// Wolk Dynasty – Playoff Hub bootstrap + newsletter rendering
//
// Responsibilities:
//   - Wire up week selector + refresh button in index.html.
//   - Fetch league + matchup data from Sleeper via SleeperClient.
//   - Build a simple "snapshot" in the shape LeagueModels expects.
//   - Use LeagueModels.buildPlayoffMatchups + ProjectionEngine to:
//       • Project each semifinal matchup
//       • Run Monte Carlo sims for win odds
//       • Approximate championship odds for all four teams
//   - Render:
//       • Matchup cards into #matchups-container
//       • Newsletter-style text into #newsletter-content
//       • Charts via PlayoffCharts (if Chart.js is available)
//
// Assumptions:
//   - window.LEAGUE_CONFIG is defined (league_config.js).
//   - window.SleeperClient, window.LeagueModels, window.ProjectionEngine,
//     and window.PlayoffCharts are loaded before this script.
//   - index.html has:
//       #league-subtitle, #week-select, #refresh-btn,
//       #matchups-container, #newsletter-content,
//       #semifinal-odds-chart, #title-odds-chart
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    // -----------------------
    // Small DOM helpers
    // -----------------------
  
    function $(selector, root = document) {
      return root.querySelector(selector);
    }
  
    function formatPercent(p, digits = 1) {
      if (!Number.isFinite(p)) return "–";
      return `${(p * 100).toFixed(digits)}%`;
    }
  
    function formatScore(x, digits = 1) {
      if (!Number.isFinite(x)) return "–";
      return x.toFixed(digits);
    }
  
    function formatRange(low, high, digits = 1) {
      if (!Number.isFinite(low) || !Number.isFinite(high)) return "–";
      return `${low.toFixed(digits)} – ${high.toFixed(digits)}`;
    }
  
    function formatSpread(muA, muB, nameA, nameB) {
      if (!Number.isFinite(muA) || !Number.isFinite(muB)) return "N/A";
      const diff = muA - muB;
      const abs = Math.abs(diff);
      if (abs < 0.25) return "Pick’em";
      const fav = diff > 0 ? nameA : nameB;
      return `${fav} -${abs.toFixed(1)}`;
    }
  
    function formatTotal(muA, muB) {
      if (!Number.isFinite(muA) || !Number.isFinite(muB)) return "–";
      return (muA + muB).toFixed(1);
    }
  
    function probabilityToMoneyline(p) {
      if (!Number.isFinite(p) || p <= 0) return "N/A";
      if (p >= 0.999) return "-∞";
      if (p <= 0.5) {
        // underdog, positive line
        const odds = (1 - p) / p;
        const ml = Math.round(odds * 100);
        return `+${ml}`;
      }
      // favorite, negative line
      const odds = p / (1 - p);
      const ml = Math.round(100 / odds);
      return `-${ml}`;
    }
  
    // -----------------------
    // Matchup transformation
    // -----------------------
  
    function buildMatchupModels(semiResults) {
      // semiResults: [{ projected, sim }, ...]
      return semiResults.map((entry, idx) => {
        const { projected, sim } = entry;
        const teamA = projected.teamA;
        const teamB = projected.teamB;
  
        const nameA = teamA.team.teamDisplayName;
        const nameB = teamB.team.teamDisplayName;
  
        const muA = teamA.projection.totalMean;
        const muB = teamB.projection.totalMean;
  
        const rangeA = {
          low: teamA.projection.rangeLow,
          high: teamA.projection.rangeHigh,
        };
        const rangeB = {
          low: teamB.projection.rangeLow,
          high: teamB.projection.rangeHigh,
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
          id: `semi-${idx + 1}`,
          roundLabel: projected.roundLabel || "Semifinal",
          bestOf: projected.bestOf || 1,
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
      });
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
        bestOf,
        favoriteName,
      } = model;
  
      const tagFavA =
        favoriteName === nameA
          ? '<span class="tag tag-favorite">Fav</span>'
          : '<span class="tag tag-underdog">Dog</span>';
      const tagFavB =
        favoriteName === nameB
          ? '<span class="tag tag-favorite">Fav</span>'
          : '<span class="tag tag-underdog">Dog</span>';
  
      const isFavorite = !!favoriteName;
      const favClass = isFavorite ? "favorite" : "";
  
      return `
        <article class="matchup-card ${favClass}">
          <div class="matchup-header">
            <div class="matchup-teams">
              ${nameA} vs ${nameB}
            </div>
            <div class="matchup-meta">
              ${roundLabel || "Playoffs"} • Best-of-${bestOf || 1}
            </div>
          </div>
          <div class="matchup-scores">
            <span>
              <strong>${formatScore(muA)}</strong> proj
              &nbsp;(${formatRange(rangeA.low, rangeA.high)}) ${tagFavA}
            </span>
            <span>
              <strong>${formatScore(muB)}</strong> proj
              &nbsp;(${formatRange(rangeB.low, rangeB.high)}) ${tagFavB}
            </span>
          </div>
          <div class="matchup-meta" style="margin-top: 6px;">
            Win odds: ${nameA} ${formatPercent(winA)}, ${nameB} ${formatPercent(winB)}<br/>
            Line: ${impliedSpread} • Total: ${impliedTotal}
          </div>
        </article>
      `;
    }
  
    function buildNewsletterHtml(leagueName, week, matchupModels, champObj) {
      const lines = [];
  
      const titleLine = leagueName
        ? `Playoff Semifinals – ${leagueName}`
        : "Playoff Semifinals";
  
      lines.push(`<h3>${titleLine}</h3>`);
      lines.push(
        `<p>Week ${week} projections are in. Here’s how the semifinals stack up once we fold in your latest projections and a pile of Monte Carlo sims.</p>`
      );
  
      matchupModels.forEach((m) => {
        lines.push(`<h3>${m.nameA} vs ${m.nameB}</h3>`);
        lines.push(
          `<p><strong>Projected score:</strong> ${m.nameA} ${formatScore(
            m.muA
          )} – ${m.nameB} ${formatScore(m.muB)} (total ${
            m.impliedTotal
          }, line ${m.impliedSpread}).</p>`
        );
        lines.push(
          `<p><strong>Win odds:</strong> ${m.nameA} ${formatPercent(
            m.winA
          )}, ${m.nameB} ${formatPercent(m.winB)}. ${m.favoriteName
            ? `${m.favoriteName} enter as the statistical favorite, but a couple of boom weeks can flip this fast.`
            : "This projects as a true coin flip – every lineup call matters."}</p>`
        );
      });
  
      if (champObj) {
        const entries = Object.entries(champObj).sort(
          (a, b) => (b[1].titleOdds || 0) - (a[1].titleOdds || 0)
        );
  
        lines.push(`<h3>Big Picture: Who’s Actually Winning This Thing?</h3>`);
        lines.push(
          `<p>Simulating the bracket forward from these semifinal projections gives the following title odds:</p>`
        );
  
        lines.push('<table class="odds-table"><thead><tr>');
        lines.push(
          "<th>Team</th><th>Reach Final</th><th>Win Title</th><th>Implied Line</th>"
        );
        lines.push("</tr></thead><tbody>");
  
        entries.forEach(([teamName, info]) => {
          const reach = info.path && typeof info.path.reachFinalPct === "number"
            ? info.path.reachFinalPct
            : 0;
          const titleOdds = info.titleOdds || 0;
          const line = probabilityToMoneyline(titleOdds);
  
          lines.push("<tr>");
          lines.push(`<td>${teamName}</td>`);
          lines.push(`<td>${formatPercent(reach, 1)}</td>`);
          lines.push(`<td>${formatPercent(titleOdds, 1)}</td>`);
          lines.push(`<td class="small">${line}</td>`);
          lines.push("</tr>");
        });
  
        lines.push("</tbody></table>");
        lines.push(
          `<p class="small">Implied lines are computed off the modeled probabilities and are just for fun, not a betting recommendation.</p>`
        );
      }
  
      return lines.join("\n");
    }
  
    // -----------------------
    // Core loader
    // -----------------------
  
    async function loadWeek(week) {
      const matchupsContainer = $("#matchups-container");
      const newsletterContent = $("#newsletter-content");
      const subtitle = $("#league-subtitle");
      const cfg = window.LEAGUE_CONFIG || {};
  
      if (matchupsContainer) {
        matchupsContainer.innerHTML = `<div class="loading">Loading Week ${week} matchups…</div>`;
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
  
        // Pull league bundle for this week
        const bundle = await window.SleeperClient.fetchLeagueBundle({
          weeks: [week],
        });
        window.__LAST_BUNDLE__ = bundle;
  
        const league = bundle.league || {};
        const leagueName = league.name || "Sleeper League";
        const season = league.season || (cfg.season && cfg.season.year) || "";
  
        if (subtitle) {
          subtitle.textContent = `${leagueName} • Season ${season} • Week ${week}`;
        }
  
        // Build the "snapshot" shape that LeagueModels.buildPlayoffMatchups expects
        const snapshot = {
          league,
          users: bundle.users || [],
          rosters: bundle.rosters || [],
          matchups: (bundle.matchupsByWeek && bundle.matchupsByWeek[week]) || [],
        };
  
        // Ask LeagueModels to figure out the playoff pairings for this week
        const semiMatchups =
          window.LeagueModels.buildPlayoffMatchups(snapshot, cfg) || [];
  
        if (!semiMatchups.length) {
          console.warn(
            "[newsletter.js] No semifinal matchups produced by LeagueModels.buildPlayoffMatchups.",
            { snapshot, cfg }
          );
  
          if (matchupsContainer) {
            matchupsContainer.innerHTML = `
              <article class="matchup-card">
                <div class="matchup-header">
                  <div class="matchup-teams">No playoff semifinals detected for Week ${week}</div>
                </div>
                <div class="matchup-scores">
                  <span class="small">
                    Check <code>league_config.js</code> playoff weeks and confirm your Sleeper league's playoff bracket has started.
                  </span>
                </div>
              </article>
            `;
          }
  
          if (newsletterContent) {
            newsletterContent.innerHTML = `
              <p>
                League data loaded, but no clear semifinal matchups were detected for Week ${week}.
                Once the winners bracket is seeded (or the correct playoff week is configured),
                this panel will automatically populate with projections and title odds.
              </p>
            `;
          }
  
          // Clear charts if possible
          if (window.PlayoffCharts) {
            try {
              window.PlayoffCharts.renderSemifinalOdds(
                "semifinal-odds-chart",
                []
              );
              window.PlayoffCharts.renderChampionshipOdds(
                "title-odds-chart",
                []
              );
            } catch (chartErr) {
              console.warn("[newsletter.js] Chart clear error:", chartErr);
            }
          }
  
          return;
        }
  
        // Run projections + sims for each semifinal
        const semiResults = semiMatchups.map((m) => {
          const projected = window.ProjectionEngine.projectMatchup(m);
          const sim = window.ProjectionEngine.simulateMatchup(projected, {
            sims: 20000,
            trackScores: false,
          });
          return { projected, sim };
        });
  
        window.__SEMI_RESULTS__ = semiResults;
  
        // Championship odds (if we have exactly two semis)
        let champObj = null;
        if (semiResults.length === 2) {
          try {
            champObj = window.ProjectionEngine.computeChampionshipOdds(
              semiResults[0],
              semiResults[1]
            );
          } catch (err) {
            console.warn(
              "[newsletter.js] Failed to compute championship odds:",
              err
            );
          }
        }
  
        const matchupModels = buildMatchupModels(semiResults);
  
        // ---- Render matchup cards ----
        if (matchupsContainer) {
          matchupsContainer.innerHTML = matchupModels
            .map((m) => renderMatchupCard(m))
            .join("");
        }
  
        // ---- Render newsletter body ----
        if (newsletterContent) {
          newsletterContent.innerHTML = buildNewsletterHtml(
            leagueName,
            week,
            matchupModels,
            champObj
          );
        }
  
        // ---- Render charts ----
        if (window.PlayoffCharts) {
          const semisForChart = matchupModels.map((m) => ({
            id: m.id,
            label: `${m.nameA} vs ${m.nameB}`,
            favoriteName: m.favoriteName || m.nameA,
            favoriteWinProb: m.favoriteWinProb != null ? m.favoriteWinProb : 0.5,
            underdogName: m.underdogName || m.nameB,
          }));
  
          try {
            window.PlayoffCharts.renderSemifinalOdds(
              "semifinal-odds-chart",
              semisForChart
            );
          } catch (err) {
            console.warn("[newsletter.js] Semifinal chart render error:", err);
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
            } catch (err) {
              console.warn("[newsletter.js] Championship chart render error:", err);
            }
          }
        }
      } catch (err) {
        console.error("[newsletter.js] loadWeek error:", err);
        if (matchupsContainer) {
          matchupsContainer.innerHTML = `
            <article class="matchup-card">
              <div class="matchup-header">
                <div class="matchup-teams">Error loading data from Sleeper</div>
              </div>
              <div class="matchup-scores">
                <span class="small">${err.message || "Unknown error"}</span>
              </div>
            </article>
          `;
        }
        if (newsletterContent) {
          newsletterContent.innerHTML = `
            <p>
              Something went wrong while pulling projections and simulations.
              Open the browser console for more detail and confirm your API calls are succeeding.
            </p>
          `;
        }
      }
    }
  
    // -----------------------
    // Bootstrap (hook into index.html controls)
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
          opt.textContent = `Week ${w}`;
          if (w === Number(defaultWeek)) opt.selected = true;
          weekSelect.appendChild(opt);
        }
  
        weekSelect.addEventListener("change", () => {
          const w = parseInt(weekSelect.value, 10);
          if (Number.isFinite(w)) {
            loadWeek(w);
          }
        });
      }
  
      if (refreshBtn) {
        refreshBtn.addEventListener("click", () => {
          const w = weekSelect
            ? parseInt(weekSelect.value, 10)
            : Number(defaultWeek);
          if (Number.isFinite(w)) {
            loadWeek(w);
          }
        });
      }
  
      const initialWeek =
        (weekSelect && parseInt(weekSelect.value, 10)) || Number(defaultWeek);
      if (Number.isFinite(initialWeek)) {
        loadWeek(initialWeek);
      }
    }
  
    document.addEventListener("DOMContentLoaded", init);
  
    // Expose for manual refresh in the console
    window.PlayoffNewsletterApp = {
      loadWeek,
      refresh: () => {
        const weekSelect = $("#week-select");
        const w = weekSelect
          ? parseInt(weekSelect.value, 10)
          : (window.LEAGUE_CONFIG &&
              (window.LEAGUE_CONFIG.SEMIFINAL_WEEK ||
                (window.LEAGUE_CONFIG.playoff &&
                  window.LEAGUE_CONFIG.playoff.semifinalWeek))) ||
            16;
        return loadWeek(w);
      },
    };
  })();
  