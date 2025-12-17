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
  
    const DEFAULT_SD_FRACTION_BY_POS = {
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
      DEFAULT: 0.45,
    };
  
    const TEAM_CONFIDENCE_SIGMAS = 1.1;
    const DEFAULT_SIM_COUNT = 10000;
  
    // -----------------------
    // Projection data access
    // -----------------------
  
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
      const source = getProjectionSource();
      const target = normalizeName(playerDisplayName);
      if (!target) return null;
  
      // Exact match
      for (const key in source) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        if (normalizeName(key) === target) {
          return source[key];
        }
      }
  
      // Strip suffixes
      const stripped = target
        .replace(/\b(jr\.?|sr\.?|ii|iii|iv|v)\b/gi, "")
        .trim();
      if (!stripped) return null;
  
      for (const key in source) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const norm = normalizeName(key)
          .replace(/\b(jr\.?|sr\.?|ii|iii|iv|v)\b/gi, "")
          .trim();
        if (norm === stripped) {
          return source[key];
        }
      }
  
      return null;
    }
  
    // -----------------------
    // Player-level projections
    // -----------------------
  
    function estimateSdFromFloorCeiling(mean, floor, ceiling) {
      if (!Number.isFinite(mean)) return null;
      const f = Number.isFinite(floor) ? floor : null;
      const c = Number.isFinite(ceiling) ? ceiling : null;
  
      if (f != null && c != null) {
        const span = Math.max(Math.abs(mean - f), Math.abs(c - mean));
        if (span > 0) return span / 2; // treat as ~2σ
      }
  
      if (f != null) {
        const span = mean - f;
        if (span > 0) return span / 2;
      }
  
      if (c != null) {
        const span = c - mean;
        if (span > 0) return span / 2;
      }
  
      return null;
    }
  
    function estimateSdFallback(mean, position) {
      if (!Number.isFinite(mean)) return 0;
      const posKey =
        position && DEFAULT_SD_FRACTION_BY_POS[position]
          ? position
          : "DEFAULT";
      const frac =
        DEFAULT_SD_FRACTION_BY_POS[posKey] ||
        DEFAULT_SD_FRACTION_BY_POS.DEFAULT;
      return mean * frac;
    }
  
    /**
     * Build a projection object for a player given:
     *   - The team-week starter entry (from LeagueModels.buildTeamWeekView)
     *   - Optional external projection data (from PROJECTION_DATA)
     *   - Optional season averages (window.__SEASON_AVG_BY_PLAYER_ID__)
     *
     * Priority:
     *   1) External projection row (if available)
     *   2) Season average for this player_id
     *   3) Last score from matchup (or generic 10 pts)
     */
    function buildPlayerProjection(starterEntry) {
      const name = starterEntry.displayName || starterEntry.playerId;
      const pos = starterEntry.position || null;
  
      const projRow = findProjectionForPlayer(name);
      const seasonAvgMap = window.__SEASON_AVG_BY_PLAYER_ID__ || {};
      const seasonAvg = seasonAvgMap[starterEntry.playerId];
  
      let mean;
      let floor;
      let ceiling;
      let source;
  
      if (projRow && Number.isFinite(Number(projRow.proj))) {
        mean = Number(projRow.proj);
        floor = Number.isFinite(Number(projRow.floor))
          ? Number(projRow.floor)
          : null;
        ceiling = Number.isFinite(Number(projRow.ceiling))
          ? Number(projRow.ceiling)
          : null;
        source = "external";
      } else if (Number.isFinite(seasonAvg)) {
        // Season-average fallback (ignoring DNP zeros in the aggregation step)
        mean = seasonAvg;
        floor = null;
        ceiling = null;
        source = "season_avg";
      } else {
        // Last-score heuristic fallback
        const lastScore = Number.isFinite(starterEntry.fantasyPoints)
          ? starterEntry.fantasyPoints
          : 10;
        mean = lastScore || 10;
        floor = null;
        ceiling = null;
        source = "heuristic";
      }
  
      let sd = estimateSdFromFloorCeiling(mean, floor, ceiling);
      if (!Number.isFinite(sd) || sd <= 0) {
        sd = estimateSdFallback(mean, pos);
      }
  
      // clamp SD to something sane
      const minSd = mean * 0.15;
      const maxSd = mean * 1.2;
      if (sd < minSd) sd = minSd;
      if (sd > maxSd) sd = maxSd;
  
      // Default range: tighter than 3σ to avoid "everything goes to 0"
      const defaultFloor = Math.max(0, mean - 2 * sd);
      const defaultCeiling = mean + 2.5 * sd;
  
      return {
        mean: mean,
        sd: sd,
        floor: floor != null ? floor : defaultFloor,
        ceiling: ceiling != null ? ceiling : defaultCeiling,
        source: source,
        meta: {
          position: pos,
          nflTeam: starterEntry.nflTeam || null,
          rawProjectionRow: projRow || null,
        },
      };
    }
  
    // -----------------------
    // Team-level projections
    // -----------------------
  
    function projectTeam(teamWeekView) {
      if (!teamWeekView || !Array.isArray(teamWeekView.starters)) {
        return Object.assign({}, teamWeekView, { projection: null });
      }
  
      const projectedPlayers = teamWeekView.starters.map(function (starter) {
        const proj = buildPlayerProjection(starter);
        return Object.assign({}, starter, { projection: proj });
      });
  
      let totalMean = 0;
      let totalVar = 0;
  
      projectedPlayers.forEach(function (p) {
        const m = p.projection.mean;
        const sd = p.projection.sd;
        if (!Number.isFinite(m) || !Number.isFinite(sd)) return;
        totalMean += m;
        totalVar += sd * sd;
      });
  
      const totalSd = Math.sqrt(totalVar);
      const rangeLow = Math.max(0, totalMean - TEAM_CONFIDENCE_SIGMAS * totalSd);
      const rangeHigh = totalMean + TEAM_CONFIDENCE_SIGMAS * totalSd;
  
      return Object.assign({}, teamWeekView, {
        projection: {
          players: projectedPlayers,
          totalMean: totalMean,
          totalVariance: totalVar,
          totalSd: totalSd,
          rangeLow: rangeLow,
          rangeHigh: rangeHigh,
        },
      });
    }
  
    /**
     * Project both teams in a matchup:
     *   - Playoff matchup from buildPlayoffMatchups: { teamA, teamB }
     *   - Generic weekly matchup: { teams: [a, b] }
     */
    function projectMatchup(matchup) {
      if (!matchup) return null;
  
      const teamA =
        matchup.teamA ||
        matchup.highSeedTeam ||
        (matchup.teams && matchup.teams[0]) ||
        null;
      const teamB =
        matchup.teamB ||
        matchup.lowSeedTeam ||
        (matchup.teams && matchup.teams[1]) ||
        null;
  
      if (!teamA || !teamB) {
        return Object.assign({}, matchup, { projected: null });
      }
  
      const projA = projectTeam(teamA);
      const projB = projectTeam(teamB);
  
      return Object.assign({}, matchup, {
        projected: {
          teamA: projA,
          teamB: projB,
        },
        roundLabel: matchup.roundLabel || "Playoff",
        bestOf: matchup.bestOf || 1,
      });
    }
  
    // -----------------------
    // Monte Carlo Simulation
    // -----------------------
  
    function randn() {
      let u = 0;
      let v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    }
  
    function sampleFantasyScore(mean, sd) {
      if (sd <= 0) return Math.max(0, mean);
      const sample = mean + sd * randn();
      return sample < 0 ? 0 : sample;
    }
  
    function simulateMatchup(projectedMatchup, options) {
      options = options || {};
      if (!projectedMatchup || !projectedMatchup.projected) {
        return null;
      }
  
      const { teamA, teamB } = projectedMatchup.projected;
      const sims = options.sims || DEFAULT_SIM_COUNT;
      const trackScores = options.trackScores || false;
  
      if (!teamA.projection || !teamB.projection) {
        return null;
      }
  
      const playersA = teamA.projection.players;
      const playersB = teamB.projection.players;
  
      let winsA = 0;
      let winsB = 0;
      let ties = 0;
  
      let sumA = 0;
      let sumB = 0;
      let sumSqA = 0;
      let sumSqB = 0;
  
      const scoresA = trackScores ? new Float32Array(sims) : null;
      const scoresB = trackScores ? new Float32Array(sims) : null;
  
      for (let i = 0; i < sims; i++) {
        let scoreA = 0;
        let scoreB = 0;
  
        playersA.forEach(function (p) {
          const m = p.projection.mean;
          const sd = p.projection.sd;
          scoreA += sampleFantasyScore(m, sd);
        });
  
        playersB.forEach(function (p) {
          const m = p.projection.mean;
          const sd = p.projection.sd;
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
  
      const n = sims;
      const meanA = sumA / n;
      const meanB = sumB / n;
      const varA = sumSqA / n - meanA * meanA;
      const varB = sumSqB / n - meanB * meanB;
  
      return {
        teamAWinPct: winsA / n,
        teamBWinPct: winsB / n,
        tiePct: ties / n,
        sims: {
          teamA: {
            scores: scoresA,
            mean: meanA,
            sd: Math.sqrt(Math.max(varA, 0)),
          },
          teamB: {
            scores: scoresB,
            mean: meanB,
            sd: Math.sqrt(Math.max(varB, 0)),
          },
        },
      };
    }
  
    // -----------------------
    // Championship odds helper
    // -----------------------
  
    function computeChampionshipOdds(semi1, semi2, finalsMatrix) {
      if (!semi1 || !semi2 || !finalsMatrix) return null;
  
      const tA = semi1.projected.teamA.team.teamDisplayName;
      const tB = semi1.projected.teamB.team.teamDisplayName;
      const tC = semi2.projected.teamA.team.teamDisplayName;
      const tD = semi2.projected.teamB.team.teamDisplayName;
  
      const pA_beat_B = semi1.sim.teamAWinPct;
      const pB_beat_A = semi1.sim.teamBWinPct;
      const pC_beat_D = semi2.sim.teamAWinPct;
      const pD_beat_C = semi2.sim.teamBWinPct;
  
      const pA_to_final = pA_beat_B;
      const pB_to_final = pB_beat_A;
      const pC_to_final = pC_beat_D;
      const pD_to_final = pD_beat_C;
  
      function titleProb(teamKey, semiSide) {
        switch (semiSide) {
          case "A": {
            const vsC = (finalsMatrix[tA] && finalsMatrix[tA][tC]) || 0.5;
            const vsD = (finalsMatrix[tA] && finalsMatrix[tA][tD]) || 0.5;
            return pA_to_final * (pC_to_final * vsC + pD_to_final * vsD);
          }
          case "B": {
            const vsC = (finalsMatrix[tB] && finalsMatrix[tB][tC]) || 0.5;
            const vsD = (finalsMatrix[tB] && finalsMatrix[tB][tD]) || 0.5;
            return pB_to_final * (pC_to_final * vsC + pD_to_final * vsD);
          }
          case "C": {
            const vsA = (finalsMatrix[tC] && finalsMatrix[tC][tA]) || 0.5;
            const vsB = (finalsMatrix[tC] && finalsMatrix[tC][tB]) || 0.5;
            return pC_to_final * (pA_to_final * vsA + pB_to_final * vsB);
          }
          case "D": {
            const vsA = (finalsMatrix[tD] && finalsMatrix[tD][tA]) || 0.5;
            const vsB = (finalsMatrix[tD] && finalsMatrix[tD][tB]) || 0.5;
            return pD_to_final * (pA_to_final * vsA + pB_to_final * vsB);
          }
          default:
            return 0;
        }
      }
  
      return {
        [tA]: {
          titleOdds: titleProb(tA, "A"),
          path: { reachFinalPct: pA_to_final },
        },
        [tB]: {
          titleOdds: titleProb(tB, "B"),
          path: { reachFinalPct: pB_to_final },
        },
        [tC]: {
          titleOdds: titleProb(tC, "C"),
          path: { reachFinalPct: pC_to_final },
        },
        [tD]: {
          titleOdds: titleProb(tD, "D"),
          path: { reachFinalPct: pD_to_final },
        },
      };
    }
  
    // -----------------------
    // Public API
    // -----------------------
  
    window.ProjectionEngine = {
      buildPlayerProjection,
      projectTeam,
      projectMatchup,
      simulateMatchup,
      computeChampionshipOdds,
    };
  })();
  