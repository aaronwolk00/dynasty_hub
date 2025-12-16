// newsletter.js
// -----------------------------------------------------------------------------
// Wolk Dynasty – Playoff Hub bootstrap + newsletter rendering
//
// Now supports *all* matchups in a given week, not just semifinals.
//
// Responsibilities:
//   - Wire up week selector + refresh button in index.html.
//   - Fetch league + matchup data from Sleeper via SleeperClient.
//   - Build a "snapshot" in the shape LeagueModels expects.
//   - Compute per-player season averages (for weeks < currentWeek) and expose
//     them as window.__SEASON_AVG_BY_PLAYER_ID__ for ProjectionEngine.
//   - Use LeagueModels.buildAllMatchupsForWeek + ProjectionEngine to:
//       • Project every matchup for the selected week
//       • Run Monte Carlo sims for win odds
//   - Optionally, when the week corresponds to semifinals and
//     LeagueModels.buildPlayoffMatchups returns two matchups, compute
//     championship odds across the four teams.
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
      var diff = muA - muB;
      var abs = Math.abs(diff);
      if (abs < 0.25) return "Pick’em";
      var fav = diff > 0 ? nameA : nameB;
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
        var odds = (1 - p) / p;
        var ml = Math.round(odds * 100);
        return "+" + ml;
      }
      var oddsFav = p / (1 - p);
      var mlFav = Math.round(100 / oddsFav);
      return "-" + mlFav;
    }
  
    // -----------------------
    // Season averages helper
    // -----------------------
  
    /**
     * Compute per-player season averages from all completed weeks
     * strictly less than the selected week.
     *
     * Exposed as window.__SEASON_AVG_BY_PLAYER_ID__ so projections.js
     * can use it as a fallback when no explicit projection exists.
     */
    function computeSeasonAverages(bundle, throughWeek) {
      var matchupsByWeek = bundle.matchupsByWeek || {};
      var accum = {};
  
      Object.keys(matchupsByWeek).forEach(function (wkStr) {
        var wk = Number(wkStr);
        if (!Number.isFinite(wk) || wk >= throughWeek) return;
  
        var weekMatchups = matchupsByWeek[wkStr] || [];
        weekMatchups.forEach(function (m) {
          var playersPoints = m.players_points || {};
          Object.keys(playersPoints).forEach(function (pid) {
            var val = Number(playersPoints[pid]);
            if (!Number.isFinite(val)) return;
            if (!accum[pid]) {
              accum[pid] = { sum: 0, count: 0 };
            }
            accum[pid].sum += val;
            accum[pid].count += 1;
          });
        });
      });
  
      var avg = {};
      Object.keys(accum).forEach(function (pid) {
        var entry = accum[pid];
        if (entry.count > 0) {
          avg[pid] = entry.sum / entry.count;
        }
      });
  
      return avg;
    }
  
    // -----------------------
    // Matchup transformation
    // -----------------------
  
    function buildMatchupModels(entries, week) {
      // entries: [{ id, roundLabel, bestOf, projected, sim }, ...]
      return entries
        .map(function (entry, idx) {
          var projected = entry.projected;
          var sim = entry.sim;
  
          if (
            !projected ||
            !projected.teamA ||
            !projected.teamB ||
            !projected.teamA.projection ||
            !projected.teamB.projection
          ) {
            return null;
          }
  
          var teamA = projected.teamA;
          var teamB = projected.teamB;
  
          var nameA = teamA.team.teamDisplayName;
          var nameB = teamB.team.teamDisplayName;
  
          var muA = teamA.projection.totalMean;
          var muB = teamB.projection.totalMean;
  
          var rangeA = {
            low: teamA.projection.rangeLow,
            high: teamA.projection.rangeHigh
          };
          var rangeB = {
            low: teamB.projection.rangeLow,
            high: teamB.projection.rangeHigh
          };
  
          var winA = sim ? sim.teamAWinPct : 0.5;
          var winB = sim ? sim.teamBWinPct : 0.5;
  
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
            id: entry.id || "matchup-" + (idx + 1),
            week: week,
            roundLabel: entry.roundLabel || ("Week " + week),
            bestOf: entry.bestOf || 1,
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
            impliedTotal: formatTotal(muA, muB)
          };
        })
        .filter(Boolean);
    }
  
    function renderMatchupCard(model) {
      var nameA = model.nameA;
      var nameB = model.nameB;
      var muA = model.muA;
      var muB = model.muB;
      var rangeA = model.rangeA;
      var rangeB = model.rangeB;
      var winA = model.winA;
      var winB = model.winB;
      var impliedSpread = model.impliedSpread;
      var impliedTotal = model.impliedTotal;
      var roundLabel = model.roundLabel;
      var favoriteName = model.favoriteName;
  
      var tagFavA =
        favoriteName === nameA
          ? '<span class="tag tag-favorite">Fav</span>'
          : '<span class="tag tag-underdog">Dog</span>';
      var tagFavB =
        favoriteName === nameB
          ? '<span class="tag tag-favorite">Fav</span>'
          : '<span class="tag tag-underdog">Dog</span>';
  
      var isFavorite = !!favoriteName;
      var favClass = isFavorite ? "favorite" : "";
  
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
        (roundLabel || "Matchup") +
        "</div>" +
        "</div>" +
        '<div class="matchup-scores">' +
        "<span>" +
        "<strong>" +
        formatScore(muA) +
        "</strong> proj " +
        "&nbsp;(" +
        formatRange(rangeA.low, rangeA.high) +
        ") " +
        tagFavA +
        "</span>" +
        "<span>" +
        "<strong>" +
        formatScore(muB) +
        "</strong> proj " +
        "&nbsp;(" +
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
      var lines = [];
  
      var titleLine = leagueName
        ? "Week " + week + " Matchups – " + leagueName
        : "Week " + week + " Matchups";
  
      lines.push("<h3>" + titleLine + "</h3>");
      lines.push(
        "<p>Projections for Week " +
          week +
          " are in. Here’s how the matchups stack up once we fold in your projections and a big Monte Carlo sim.</p>"
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
        var entries = Object.entries(champObj).sort(function (a, b) {
          var pa = (a[1] && a[1].titleOdds) || 0;
          var pb = (b[1] && b[1].titleOdds) || 0;
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
  
        entries.forEach(function (_ref) {
          var teamName = _ref[0],
            info = _ref[1];
  
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
          "<p class=\"small\">Implied lines are computed off the modeled probabilities and are just for fun, not a betting recommendation.</p>"
        );
      }
  
      return lines.join("\n");
    }
  
    // -----------------------
    // Core loader
    // -----------------------
  
    async function loadWeek(week) {
      var matchupsContainer = $("#matchups-container");
      var newsletterContent = $("#newsletter-content");
      var subtitle = $("#league-subtitle");
      var cfg = window.LEAGUE_CONFIG || {};
  
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
  
        // Pull league bundle for weeks 1..week so we can compute season averages.
        var weeksToFetch = [];
        for (var w = 1; w <= week; w++) {
          weeksToFetch.push(w);
        }
  
        var bundle = await window.SleeperClient.fetchLeagueBundle({
          weeks: weeksToFetch
        });
        window.__LAST_BUNDLE__ = bundle;
  
        var league = bundle.league || {};
        var leagueName = league.name || "Sleeper League";
        var season =
          league.season ||
          (cfg.season && cfg.season.year) ||
          "";
  
        if (subtitle) {
          subtitle.textContent =
            leagueName + " • Season " + season + " • Week " + week;
        }
  
        // Compute and expose season averages for projections.js
        var seasonAvgMap = computeSeasonAverages(bundle, week);
        window.__SEASON_AVG_BY_PLAYER_ID__ = seasonAvgMap;
  
        // Build the snapshot shape that LeagueModels expects for this week
        var snapshot = {
          league: league,
          users: bundle.users || [],
          rosters: bundle.rosters || [],
          matchups:
            (bundle.matchupsByWeek &&
              bundle.matchupsByWeek[week]) ||
            []
        };
  
        // Player metadata from the Sleeper "players" preload (index.html)
        var playerMap = window.__SLEEPER_PLAYER_MAP__ || null;
  
        // All matchups for this week (regular season or playoffs),
        // paired by matchup_id.
        var weeklyMatchups =
          window.LeagueModels.buildAllMatchupsForWeek(
            snapshot,
            playerMap
          ) || [];
  
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
  
        // Project and simulate every matchup for the week
        var matchupEntries = [];
        for (var i = 0; i < weeklyMatchups.length; i++) {
          var m = weeklyMatchups[i];
          var projectedMatchup =
            window.ProjectionEngine.projectMatchup(m);
          if (
            !projectedMatchup ||
            !projectedMatchup.projected ||
            !projectedMatchup.projected.teamA ||
            !projectedMatchup.projected.teamB
          ) {
            continue; // skip byes / malformed
          }
  
          var sim = window.ProjectionEngine.simulateMatchup(
            projectedMatchup,
            {
              sims: 15000,
              trackScores: false
            }
          );
          if (!sim) continue;
  
          matchupEntries.push({
            id: m.id || "week" + week + "_m" + (m.matchupId || i + 1),
            roundLabel: "Week " + week,
            bestOf: m.bestOf || 1,
            projected: projectedMatchup.projected,
            sim: sim
          });
        }
  
        var matchupModels = buildMatchupModels(matchupEntries, week);
  
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
  
        // ---- Optional: playoffs title odds when we have two semis ----
        var champObj = null;
        try {
          var semiWeek =
            cfg.SEMIFINAL_WEEK ||
            (cfg.playoff && cfg.playoff.semifinalWeek) ||
            null;
  
          if (semiWeek && week === Number(semiWeek)) {
            // Use a separate playoff view for the winners bracket
            var semiMatchups =
              window.LeagueModels.buildPlayoffMatchups(
                snapshot,
                cfg
              ) || [];
  
            if (semiMatchups.length === 2) {
              var semiResults = semiMatchups.map(function (pm) {
                var proj = window.ProjectionEngine.projectMatchup(pm);
                var sim2 = proj
                  ? window.ProjectionEngine.simulateMatchup(proj, {
                      sims: 20000,
                      trackScores: false
                    })
                  : null;
                return {
                  projected: proj,
                  sim: sim2
                };
              });
  
              // Filter out any broken ones
              semiResults = semiResults.filter(function (x) {
                return (
                  x &&
                  x.projected &&
                  x.projected.projected &&
                  x.sim
                );
              });
  
              if (semiResults.length === 2) {
                // Build a simple finals matrix using the team distributions
                var finalsMatrix = (function buildFinalsMatrix(
                  semiWithSims
                ) {
                  function erf(x) {
                    var sign = x < 0 ? -1 : 1;
                    x = Math.abs(x);
                    var a1 = 0.254829592;
                    var a2 = -0.284496736;
                    var a3 = 1.421413741;
                    var a4 = -1.453152027;
                    var a5 = 1.061405429;
                    var p = 0.3275911;
                    var t = 1 / (1 + p * x);
                    var y =
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
  
                  var teams = {};
                  semiWithSims.forEach(function (m) {
                    var a = m.projected.projected.teamA;
                    var b = m.projected.projected.teamB;
                    teams[a.team.teamDisplayName] = {
                      mean: a.projection.totalMean,
                      sd: a.projection.totalSd
                    };
                    teams[b.team.teamDisplayName] = {
                      mean: b.projection.totalMean,
                      sd: b.projection.totalSd
                    };
                  });
  
                  var names = Object.keys(teams);
                  var matrix = {};
                  names.forEach(function (nameA) {
                    matrix[nameA] = {};
                    names.forEach(function (nameB) {
                      if (nameA === nameB) return;
                      var tA = teams[nameA];
                      var tB = teams[nameB];
                      var muDiff = tA.mean - tB.mean;
                      var varDiff =
                        tA.sd * tA.sd + tB.sd * tB.sd || 1;
                      var z = muDiff / Math.sqrt(varDiff);
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
  
        // ---- Render matchup cards ----
        if (matchupsContainer) {
          matchupsContainer.innerHTML = matchupModels
            .map(function (m) {
              return renderMatchupCard(m);
            })
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
          try {
            var semisForChart = matchupModels.map(function (m) {
              return {
                id: m.id,
                label: m.nameA + " vs " + m.nameB,
                favoriteName: m.favoriteName || m.nameA,
                favoriteWinProb:
                  m.favoriteWinProb != null
                    ? m.favoriteWinProb
                    : m.winA,
                underdogName: m.underdogName || m.nameB
              };
            });
  
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
              var champArray = Object.entries(champObj).map(function (
                _ref2
              ) {
                var teamName = _ref2[0],
                  info = _ref2[1];
                return {
                  teamName: teamName,
                  probability: info.titleOdds || 0
                };
              });
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
            // Clear title chart if no champ odds
            try {
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
    // Bootstrap (hook into index.html controls)
    // -----------------------
  
    async function init() {
      var cfg = window.LEAGUE_CONFIG || {};
      var uiCfg = cfg.ui || {};
      var seasonCfg = cfg.season || {};
  
      var weekSelect = $("#week-select");
      var refreshBtn = $("#refresh-btn");
  
      var maxWeeks = uiCfg.maxWeeksSelectable || 17;
      var defaultWeek =
        cfg.SEMIFINAL_WEEK ||
        (cfg.playoff && cfg.playoff.semifinalWeek) ||
        seasonCfg.defaultWeek ||
        16;
  
      if (weekSelect) {
        weekSelect.innerHTML = "";
        for (var w = 1; w <= maxWeeks; w++) {
          var opt = document.createElement("option");
          opt.value = String(w);
          opt.textContent = "Week " + w;
          if (w === Number(defaultWeek)) opt.selected = true;
          weekSelect.appendChild(opt);
        }
  
        weekSelect.addEventListener("change", function () {
          var val = parseInt(weekSelect.value, 10);
          if (Number.isFinite(val)) {
            loadWeek(val);
          }
        });
      }
  
      if (refreshBtn) {
        refreshBtn.addEventListener("click", function () {
          var val = weekSelect
            ? parseInt(weekSelect.value, 10)
            : Number(defaultWeek);
          if (Number.isFinite(val)) {
            loadWeek(val);
          }
        });
      }
  
      var initialWeek =
        (weekSelect && parseInt(weekSelect.value, 10)) ||
        Number(defaultWeek);
      if (Number.isFinite(initialWeek)) {
        loadWeek(initialWeek);
      }
    }
  
    document.addEventListener("DOMContentLoaded", init);
  
    // Expose for manual refresh in the console
    window.PlayoffNewsletterApp = {
      loadWeek: loadWeek,
      refresh: function () {
        var weekSelect = $("#week-select");
        var w = weekSelect
          ? parseInt(weekSelect.value, 10)
          : (window.LEAGUE_CONFIG &&
              (window.LEAGUE_CONFIG.SEMIFINAL_WEEK ||
                (window.LEAGUE_CONFIG.playoff &&
                  window.LEAGUE_CONFIG.playoff.semifinalWeek))) ||
            16;
        return loadWeek(w);
      }
    };
  })();
  