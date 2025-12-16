// projections.js
// -----------------------------------------------------------------------------
// Projection + simulation layer for the Sleeper playoff hub.
//
// Responsibilities:
//
//   - Take a "team-week view" from LeagueModels and attach:
//       • Per-player mean projection
//       • Per-player standard deviation
//       • Team total mean and variance
//       • A "confident scoring range" (low / high)
//   - Run Monte Carlo simulations of matchups using those player distributions
//     to estimate win probabilities and score distributions.
//   - Approximate championship odds from two semifinals.
//
// Design goals:
//
//   - Reusable across seasons and league structures.
//   - Decoupled from the DOM – purely data in, data out.
//   - Works even if only partial projection data is provided.
// ----------------------------------------------------------------------------- 

(function () {
    "use strict";
  
    if (!window.LeagueModels) {
      console.error(
        "[projections.js] LeagueModels is not defined. Make sure models.js is loaded first."
      );
    }
  
    // -----------------------
    // Configuration
    // -----------------------
  
    var DEFAULT_SD_FRACTION_BY_POS = {
      QB: 0.35,
      RB: 0.45,
      WR: 0.5,
      TE: 0.55,
      K: 0.25,
      DEF: 0.3,
      // IDP / others
      LB: 0.4,
      DL: 0.45,
      DB: 0.4,
      DEFAULT: 0.45
    };
  
    var TEAM_CONFIDENCE_SIGMAS = 1.1;
    var DEFAULT_SIM_COUNT = 10000;
  
    // -----------------------
    // Projection data access
    // -----------------------
  
    // External per-week projections, if provided (e.g. from Supabase or a CSV)
    function getProjectionSource() {
      return window.PROJECTION_DATA && window.PROJECTION_DATA.byPlayerName
        ? window.PROJECTION_DATA.byPlayerName
        : {};
    }
  
    function normalizeName(name) {
      if (!name || typeof name !== "string") return "";
      return name.trim().toLowerCase().replace(/\s+/g, " ");
    }
  
    function findProjectionForPlayer(playerDisplayName) {
      var source = getProjectionSource();
      var target = normalizeName(playerDisplayName);
      if (!target) return null;
  
      // Exact match
      for (var key in source) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        if (normalizeName(key) === target) {
          return source[key];
        }
      }
  
      // Strip suffixes
      var stripped = target
        .replace(/\b(jr\.?|sr\.?|ii|iii|iv|v)\b/gi, "")
        .trim();
      if (!stripped) return null;
  
      for (var key2 in source) {
        if (!Object.prototype.hasOwnProperty.call(source, key2)) continue;
        var norm = normalizeName(key2)
          .replace(/\b(jr\.?|sr\.?|ii|iii|iv|v)\b/gi, "")
          .trim();
        if (norm === stripped) {
          return source[key2];
        }
      }
  
      return null;
    }
  
    // -----------------------
    // Player-level projections
    // -----------------------
  
    function estimateSdFromFloorCeiling(mean, floor, ceiling) {
      if (!Number.isFinite(mean)) return null;
      var f = Number.isFinite(floor) ? floor : null;
      var c = Number.isFinite(ceiling) ? ceiling : null;
  
      if (f != null && c != null) {
        var span = Math.max(Math.abs(mean - f), Math.abs(c - mean));
        if (span > 0) return span / 2;
      }
  
      if (f != null) {
        var spanF = mean - f;
        if (spanF > 0) return spanF / 2;
      }
  
      if (c != null) {
        var spanC = c - mean;
        if (spanC > 0) return spanC / 2;
      }
  
      return null;
    }
  
    function estimateSdFallback(mean, position) {
      if (!Number.isFinite(mean)) return 0;
      var posKey =
        position && DEFAULT_SD_FRACTION_BY_POS[position]
          ? position
          : "DEFAULT";
      var frac =
        DEFAULT_SD_FRACTION_BY_POS[posKey] ||
        DEFAULT_SD_FRACTION_BY_POS.DEFAULT;
      return mean * frac;
    }
  
    /**
     * Build a projection object for a player given:
     *   - The team-week starter entry (from LeagueModels.buildTeamWeekView)
     *   - Optional external projection data (from PROJECTION_DATA)
     *
     * Fallback order (no generic defaults):
     *   1) External projection row (per-week / Supabase / CSV)
     *   2) Season average fantasy points for this player
     *   3) Last known fantasyPoints on the starterEntry (usually last week)
     */
    function buildPlayerProjection(starterEntry) {
      var name = starterEntry.displayName || starterEntry.playerId;
      var pos = starterEntry.position || null;
      var projRow = findProjectionForPlayer(name);
  
      // Season-average cache from newsletter.js:
      // window.__SEASON_AVG_BY_PLAYER_ID__ = { [playerId]: avgPoints }
      var seasonAvgMap = window.__SEASON_AVG_BY_PLAYER_ID__ || {};
      var seasonAvg =
        seasonAvgMap && Object.prototype.hasOwnProperty.call(
          seasonAvgMap,
          starterEntry.playerId
        )
          ? seasonAvgMap[starterEntry.playerId]
          : null;
  
      var mean;
      var floor;
      var ceiling;
      var source;
  
      if (projRow && Number.isFinite(Number(projRow.proj))) {
        // 1) Explicit projection
        mean = Number(projRow.proj);
        floor = Number.isFinite(Number(projRow.floor))
          ? Number(projRow.floor)
          : null;
        ceiling = Number.isFinite(Number(projRow.ceiling))
          ? Number(projRow.ceiling)
          : null;
        source = "external";
      } else if (Number.isFinite(seasonAvg)) {
        // 2) Season average for this player (preferred fallback)
        mean = seasonAvg;
        floor = null;
        ceiling = null;
        source = "season_avg";
      } else {
        // 3) Last known fantasy points as a rough anchor
        var lastScore = Number.isFinite(starterEntry.fantasyPoints)
          ? starterEntry.fantasyPoints
          : 0;
        mean = lastScore;
        floor = null;
        ceiling = null;
        source = "heuristic";
      }
  
      var sd = estimateSdFromFloorCeiling(mean, floor, ceiling);
      if (!Number.isFinite(sd) || sd <= 0) {
        sd = estimateSdFallback(mean, pos);
      }
  
      var minSd = mean * 0.15;
      var maxSd = mean * 1.2;
      if (sd < minSd) sd = minSd;
      if (sd > maxSd) sd = maxSd;
  
      return {
        mean: mean,
        sd: sd,
        floor: floor != null ? floor : Math.max(0, mean - 3 * sd),
        ceiling: ceiling != null ? ceiling : mean + 3 * sd,
        source: source,
        meta: {
          position: pos,
          nflTeam: starterEntry.nflTeam || null,
          rawProjectionRow: projRow || null
        }
      };
    }
  
    // -----------------------
    // Team-level projections
    // -----------------------
  
    function projectTeam(teamWeekView) {
      if (!teamWeekView || !Array.isArray(teamWeekView.starters)) {
        return Object.assign({}, teamWeekView, { projection: null });
      }
  
      var projectedPlayers = teamWeekView.starters.map(function (starter) {
        var proj = buildPlayerProjection(starter);
        return Object.assign({}, starter, { projection: proj });
      });
  
      var totalMean = 0;
      var totalVar = 0;
  
      projectedPlayers.forEach(function (p) {
        var m = p.projection.mean;
        var sd = p.projection.sd;
        if (!Number.isFinite(m) || !Number.isFinite(sd)) return;
        totalMean += m;
        totalVar += sd * sd;
      });
  
      var totalSd = Math.sqrt(totalVar);
      var rangeLow = Math.max(
        0,
        totalMean - TEAM_CONFIDENCE_SIGMAS * totalSd
      );
      var rangeHigh = totalMean + TEAM_CONFIDENCE_SIGMAS * totalSd;
  
      return Object.assign({}, teamWeekView, {
        projection: {
          players: projectedPlayers,
          totalMean: totalMean,
          totalVariance: totalVar,
          totalSd: totalSd,
          rangeLow: rangeLow,
          rangeHigh: rangeHigh
        }
      });
    }
  
    /**
     * Project both teams in a matchup:
     *   - Generic weekly matchup: { teams: [a, b] }
     *   - Playoff matchup from buildPlayoffMatchups: { teamA, teamB }
     *   - Older highSeedTeam/lowSeedTeam variants.
     */
    function projectMatchup(matchup) {
      if (!matchup) return null;
  
      var teamA =
        matchup.teamA ||
        matchup.highSeedTeam ||
        (matchup.teams && matchup.teams[0]) ||
        null;
      var teamB =
        matchup.teamB ||
        matchup.lowSeedTeam ||
        (matchup.teams && matchup.teams[1]) ||
        null;
  
      if (!teamA || !teamB) {
        return Object.assign({}, matchup, { projected: null });
      }
  
      var projA = projectTeam(teamA);
      var projB = projectTeam(teamB);
  
      return Object.assign({}, matchup, {
        projected: {
          teamA: projA,
          teamB: projB
        },
        roundLabel: matchup.roundLabel || matchup.round || "Matchup",
        bestOf: matchup.bestOf || 1
      });
    }
  
    // -----------------------
    // Monte Carlo Simulation
    // -----------------------
  
    function randn() {
      var u = 0;
      var v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    }
  
    function sampleFantasyScore(mean, sd) {
      if (sd <= 0) return Math.max(0, mean);
      var sample = mean + sd * randn();
      return sample < 0 ? 0 : sample;
    }
  
    /**
     * Run Monte Carlo sims for a projected matchup.
     */
    function simulateMatchup(projectedMatchup, options) {
      options = options || {};
      if (!projectedMatchup || !projectedMatchup.projected) {
        return null;
      }
  
      var teamA = projectedMatchup.projected.teamA;
      var teamB = projectedMatchup.projected.teamB;
      if (!teamA || !teamB || !teamA.projection || !teamB.projection) {
        return null;
      }
  
      var sims = options.sims || DEFAULT_SIM_COUNT;
      var trackScores = options.trackScores || false;
  
      var playersA = teamA.projection.players;
      var playersB = teamB.projection.players;
  
      var winsA = 0;
      var winsB = 0;
      var ties = 0;
  
      var sumA = 0;
      var sumB = 0;
      var sumSqA = 0;
      var sumSqB = 0;
  
      var scoresA = trackScores ? new Float32Array(sims) : null;
      var scoresB = trackScores ? new Float32Array(sims) : null;
  
      for (var i = 0; i < sims; i++) {
        var scoreA = 0;
        var scoreB = 0;
  
        playersA.forEach(function (p) {
          var m = p.projection.mean;
          var sd = p.projection.sd;
          scoreA += sampleFantasyScore(m, sd);
        });
  
        playersB.forEach(function (p) {
          var m = p.projection.mean;
          var sd = p.projection.sd;
          scoreB += sampleFantasyScore(m, sd);
        });
  
        if (trackScores) {
          scoresA[i] = scoreA;
          scoresB[i] = scoreB;
        }
  
        sumA += scoreA;
        sumB += scoreB;
        sumSqA += scoreA * scoreA;
        sumSqB += scoreB * scoreB;
  
        if (scoreA > scoreB) winsA++;
        else if (scoreB > scoreA) winsB++;
        else ties++;
      }
  
      var n = sims;
      var meanA = sumA / n;
      var meanB = sumB / n;
      var varA = sumSqA / n - meanA * meanA;
      var varB = sumSqB / n - meanB * meanB;
  
      return {
        teamAWinPct: winsA / n,
        teamBWinPct: winsB / n,
        tiePct: ties / n,
        sims: {
          teamA: {
            scores: scoresA,
            mean: meanA,
            sd: Math.sqrt(Math.max(varA, 0))
          },
          teamB: {
            scores: scoresB,
            mean: meanB,
            sd: Math.sqrt(Math.max(varB, 0))
          }
        }
      };
    }
  
    // -----------------------
    // Championship odds helper
    // -----------------------
  
    function computeChampionshipOdds(semi1, semi2, finalsMatrix) {
      if (!semi1 || !semi2 || !finalsMatrix) return null;
  
      var tA = semi1.projected.teamA.team.teamDisplayName;
      var tB = semi1.projected.teamB.team.teamDisplayName;
      var tC = semi2.projected.teamA.team.teamDisplayName;
      var tD = semi2.projected.teamB.team.teamDisplayName;
  
      var pA_beat_B = semi1.sim.teamAWinPct;
      var pB_beat_A = semi1.sim.teamBWinPct;
      var pC_beat_D = semi2.sim.teamAWinPct;
      var pD_beat_C = semi2.sim.teamBWinPct;
  
      var pA_to_final = pA_beat_B;
      var pB_to_final = pB_beat_A;
      var pC_to_final = pC_beat_D;
      var pD_to_final = pD_beat_C;
  
      function titleProb(teamKey, semiSide) {
        switch (semiSide) {
          case "A": {
            var vsC = (finalsMatrix[tA] && finalsMatrix[tA][tC]) || 0.5;
            var vsD = (finalsMatrix[tA] && finalsMatrix[tA][tD]) || 0.5;
            return pA_to_final * (pC_to_final * vsC + pD_to_final * vsD);
          }
          case "B": {
            var vsC2 = (finalsMatrix[tB] && finalsMatrix[tB][tC]) || 0.5;
            var vsD2 = (finalsMatrix[tB] && finalsMatrix[tB][tD]) || 0.5;
            return pB_to_final * (pC_to_final * vsC2 + pD_to_final * vsD2);
          }
          case "C": {
            var vsA = (finalsMatrix[tC] && finalsMatrix[tC][tA]) || 0.5;
            var vsB = (finalsMatrix[tC] && finalsMatrix[tC][tB]) || 0.5;
            return pC_to_final * (pA_to_final * vsA + pB_to_final * vsB);
          }
          case "D": {
            var vsA2 = (finalsMatrix[tD] && finalsMatrix[tD][tA]) || 0.5;
            var vsB2 = (finalsMatrix[tD] && finalsMatrix[tD][tB]) || 0.5;
            return pD_to_final * (pA_to_final * vsA2 + pB_to_final * vsB2);
          }
          default:
            return 0;
        }
      }
  
      return {
        [tA]: {
          titleOdds: titleProb(tA, "A"),
          path: { reachFinalPct: pA_to_final }
        },
        [tB]: {
          titleOdds: titleProb(tB, "B"),
          path: { reachFinalPct: pB_to_final }
        },
        [tC]: {
          titleOdds: titleProb(tC, "C"),
          path: { reachFinalPct: pC_to_final }
        },
        [tD]: {
          titleOdds: titleProb(tD, "D"),
          path: { reachFinalPct: pD_to_final }
        }
      };
    }
  
    // -----------------------
    // Public API
    // -----------------------
  
    window.ProjectionEngine = {
      // Player/Team projections
      buildPlayerProjection: buildPlayerProjection,
      projectTeam: projectTeam,
      projectMatchup: projectMatchup,
  
      // Sims
      simulateMatchup: simulateMatchup,
  
      // Championship odds
      computeChampionshipOdds: computeChampionshipOdds
    };
  })();
  