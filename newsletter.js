// newsletter.js
// -----------------------------------------------------------------------------
// Wolk Dynasty – Playoff / Matchup Hub bootstrap + newsletter rendering
//
// Responsibilities:
//   - Wire up week selector + refresh button in index.html.
//   - Fetch league + matchup data from Sleeper via SleeperClient.
//   - Build a "snapshot" in the shape LeagueModels expects.
//   - Use LeagueModels.buildPlayoffMatchups + ProjectionEngine to:
//       • Project each matchup for the chosen week
//       • Run Monte Carlo sims for win odds
//       • Approximate championship odds when there are exactly two games
//   - Render:
//       • Matchup cards into #matchups-container
//       • Newsletter-style text into #newsletter-content
//       • Charts via PlayoffCharts (if Chart.js is available)
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    // -----------------------
    // Small DOM helpers
    // -----------------------
  
    function $(selector, root) {
      return (root || document).querySelector(selector);
    }
  
    function formatPercent(p, digits) {
      digits = typeof digits === "number" ? digits : 1;
      if (!Number.isFinite(p)) return "–";
      return (p * 100).toFixed(digits) + "%";
    }
  
    function formatScore(x, digits) {
      digits = typeof digits === "number" ? digits : 1;
      if (!Number.isFinite(x)) return "–";
      return x.toFixed(digits);
    }
  
    function formatRange(low, high, digits) {
      digits = typeof digits === "number" ? digits : 1;
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
      const odds = p / (1 - p);
      const ml = Math.round(100 / odds);
      return "-" + ml;
    }
  
    // -----------------------
    // Matchup transformation
    // -----------------------
  
    /**
     * semiResults items look like:
     *   {
     *     matchup: <projectedMatchup>,  // from ProjectionEngine.projectMatchup
     *     sim: <simResult>
     *   }
     */
    function buildMatchupModels(results) {
      return results.map(function (entry, idx) {
        const projectedMatchup = entry.matchup;
        const sim = entry.sim;
  
        const fallbackId = "m-" + (idx + 1);
  
        if (!projectedMatchup || !projectedMatchup.projected) {
          return {
            id: fallbackId,
            roundLabel: "Matchup",
            bestOf: 1,
            nameA: "TBD",
            nameB: "TBD",
            muA: NaN,
            muB: NaN,
            rangeA: { low: NaN, high: NaN },
            rangeB: { low: NaN, high: NaN },
            winA: 0.5,
            winB: 0.5,
            favoriteName: null,
            favoriteWinProb: null,
            underdogName: null,
            impliedSpread: "N/A",
            impliedTotal: "–",
          };
        }
  
        const pm = projectedMatchup.projected;
        const teamA = pm.teamA;
        const teamB = pm.teamB;
  
        const nameA =
          teamA && teamA.team && teamA.team.teamDisplayName
            ? teamA.team.teamDisplayName
            : "Team A";
        const nameB =
          teamB && teamB.team && teamB.team.teamDisplayName
            ? teamB.team.teamDisplayName
            : "Team B";
  
        const hasProjA = teamA && teamA.projection;
        const hasProjB = teamB && teamB.projection;
  
        const muA = hasProjA ? teamA.projection.totalMean : NaN;
        const muB = hasProjB ? teamB.projection.totalMean : NaN;
  
        const rangeA = {
          low: hasProjA ? teamA.projection.rangeLow : NaN,
          high: hasProjA ? teamA.projection.rangeHigh : NaN,
        };
        const rangeB = {
          low: hasProjB ? teamB.projection.rangeLow : NaN,
          high: hasProjB ? teamB.projection.rangeHigh : NaN,
        };
  
        const winA = sim ? sim.teamAWinPct : 0.5;
        const winB = sim ? sim.teamBWinPct : 0.5;
  
        var favoriteName = null;
        var favoriteWinProb = null;
        var underdogName = null;
  
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
          id: projectedMatchup.id || fallbackId,
          roundLabel: projectedMatchup.roundLabel || "Matchup",
          bestOf: projectedMatchup.bestOf || 1,
          nameA: nameA,
          nameB: nameB,
          muA: muA,
          muB: muB,
          rangeA: rangeA,
          rangeB: rangeB,
          winA: winA,
          winB: winB,
          favoriteName: favoriteName,
          favoriteWinProb: favoriteWinProb,
          underdogName: underdogName,
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
  
      return (
        '<article class="matchup-card ' +
        favClass +
        '">' +
        '<div class="matchup-header">' +
        '<div class="matchup-teams">' +
        nameA +
        " vs " +
        nameB +
        "</div>" +
        '<div class="matchup-meta">' +
        (roundLabel || "Playoffs") +
        " • Best-of-" +
        (bestOf || 1) +
        "</div>" +
        "</div>" +
        '<div class="matchup-scores">' +
        "<span>" +
        "<strong>" +
        formatScore(muA) +
        "</strong> proj&nbsp;(" +
        formatRange(rangeA.low, rangeA.high) +
        ") " +
        tagFavA +
        "</span>" +
        "<span>" +
        "<strong>" +
        formatScore(muB) +
        "</strong> proj&nbsp;(" +
        formatRange(rangeB.low, rangeB.high) +
        ") " +
        tagFavB +
        "</span>" +
        "</div>" +
        '<div class="matchup-meta" style="margin-top: 6px;">' +
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
        impliedTotal +
        "</div>" +
        "</article>"
      );
    }
  
    function buildNewsletterHtml(leagueName, week, matchupModels, champObj) {
      const lines = [];
  
      const titleLine = leagueName
        ? "Week " + week + " Matchups – " + leagueName
        : "Week " + week + " Matchups";
  
      lines.push("<h3>" + titleLine + "</h3>");
      lines.push(
        "<p>Projections for Week " +
          week +
          " are in. Here’s how the key matchups stack up once we fold in your projections and a big Monte Carlo sim.</p>"
      );
  
      matchupModels.forEach(function (m) {
        lines.push("<h3>" + m.nameA + " vs " + m.nameB + "</h3>");
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
      });
  
      if (champObj) {
        const entries = Object.entries(champObj).sort(function (a, b) {
          const pa = (a[1] && a[1].titleOdds) || 0;
          const pb = (b[1] && b[1].titleOdds) || 0;
          return pb - pa;
        });
  
        lines.push("<h3>Big Picture: Title Odds</h3>");
        lines.push(
          "<p>Simulating the bracket forward from these matchups gives the following title odds:</p>"
        );
        lines.push('<table class="odds-table"><thead><tr>');
        lines.push(
          "<th>Team</th><th>Reach Final</th><th>Win Title</th><th>Implied Line</th>"
        );
        lines.push("</tr></thead><tbody>");
  
        entries.forEach(function (pair) {
          var teamName = pair[0];
          var info = pair[1] || {};
          var reach =
            info.path && typeof info.path.reachFinalPct === "number"
              ? info.path.reachFinalPct
              : 0;
          var titleOdds = info.titleOdds || 0;
          var line = probabilityToMoneyline(titleOdds);
  
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
    // Core loader
    // -----------------------
  
    async function loadWeek(week) {
      const matchupsContainer = $("#matchups-container");
      const newsletterContent = $("#newsletter-content");
      const subtitle = $("#league-subtitle");
      const cfg = window.LEAGUE_CONFIG || {};
  
      if (matchupsContainer) {
        matchupsContainer.innerHTML =
          '<div class="loading">Loading Week ' + week + " matchups…</div>";
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
  
        const bundle = await window.SleeperClient.fetchLeagueBundle({
          weeks: [week],
        });
        window.__LAST_BUNDLE__ = bundle;
  
        const league = bundle.league || {};
        const leagueName = league.name || "Sleeper League";
        const season = league.season || (cfg.season && cfg.season.year) || "";
  
        if (subtitle) {
          subtitle.textContent =
            leagueName + " • Season " + season + " • Week " + week;
        }
  
        const snapshot = {
          league: league,
          users: bundle.users || [],
          rosters: bundle.rosters || [],
          matchups:
            (bundle.matchupsByWeek && bundle.matchupsByWeek[week]) || [],
          winnersBracket: bundle.winnersBracket || [],
        };
  
        const weekMatchups =
          window.LeagueModels.buildPlayoffMatchups(snapshot, cfg) || [];
  
        if (!weekMatchups.length) {
          console.warn(
            "[newsletter.js] No matchups produced by LeagueModels.buildPlayoffMatchups.",
            { snapshot: snapshot, cfg: cfg }
          );
  
          if (matchupsContainer) {
            matchupsContainer.innerHTML =
              '<article class="matchup-card">' +
              '<div class="matchup-header">' +
              '<div class="matchup-teams">No matchups detected for Week ' +
              week +
              "</div>" +
              "</div>" +
              '<div class="matchup-scores">' +
              "<span class=\"small\">" +
              "Check your league playoff weeks and confirm Sleeper has generated matchups for this week." +
              "</span>" +
              "</div>" +
              "</article>";
          }
  
          if (newsletterContent) {
            newsletterContent.innerHTML =
              "<p>" +
              "League data loaded, but no clear matchups were detected for Week " +
              week +
              ". Once Sleeper generates matchups (or the correct week is configured), " +
              "this panel will automatically populate with projections and title odds." +
              "</p>";
          }
  
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
  
        const semiResults = weekMatchups.map(function (m) {
          const projected = window.ProjectionEngine.projectMatchup(m);
          const sim = window.ProjectionEngine.simulateMatchup(projected, {
            sims: 20000,
            trackScores: false,
          });
          return { matchup: projected, sim: sim };
        });
  
        window.__SEMI_RESULTS__ = semiResults;
  
        var champObj = null;
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
  
        if (matchupsContainer) {
          matchupsContainer.innerHTML = matchupModels
            .map(function (m) {
              return renderMatchupCard(m);
            })
            .join("");
        }
  
        if (newsletterContent) {
          newsletterContent.innerHTML = buildNewsletterHtml(
            leagueName,
            week,
            matchupModels,
            champObj
          );
        }
  
        if (window.PlayoffCharts) {
          const semisForChart = matchupModels.map(function (m) {
            return {
              id: m.id,
              label: m.nameA + " vs " + m.nameB,
              favoriteName: m.favoriteName || m.nameA,
              favoriteWinProb:
                m.favoriteWinProb != null ? m.favoriteWinProb : 0.5,
              underdogName: m.underdogName || m.nameB,
            };
          });
  
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
              const champArray = Object.entries(champObj).map(function (pair) {
                return {
                  teamName: pair[0],
                  probability: pair[1].titleOdds || 0,
                };
              });
              window.PlayoffCharts.renderChampionshipOdds(
                "title-odds-chart",
                champArray
              );
            } catch (err) {
              console.warn(
                "[newsletter.js] Championship chart render error:",
                err
              );
            }
          }
        }
      } catch (err) {
        console.error("[newsletter.js] loadWeek error:", err);
        if (matchupsContainer) {
          matchupsContainer.innerHTML =
            '<article class="matchup-card">' +
            '<div class="matchup-header">' +
            '<div class="matchup-teams">Error loading data from Sleeper</div>' +
            "</div>" +
            '<div class="matchup-scores">' +
            "<span class=\"small\">" +
            (err.message || "Unknown error") +
            "</span>" +
            "</div>" +
            "</article>";
        }
        if (newsletterContent) {
          newsletterContent.innerHTML =
            "<p>" +
            "Something went wrong while pulling projections and simulations. " +
            "Open the browser console for more detail and confirm your API calls are succeeding." +
            "</p>";
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
  
        weekSelect.addEventListener("change", function () {
          const w = parseInt(weekSelect.value, 10);
          if (Number.isFinite(w)) {
            loadWeek(w);
          }
        });
      }
  
      if (refreshBtn) {
        refreshBtn.addEventListener("click", function () {
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
  
    window.PlayoffNewsletterApp = {
      loadWeek: loadWeek,
      refresh: function () {
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
  