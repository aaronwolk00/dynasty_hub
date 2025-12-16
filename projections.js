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
//
// Design goals:
//
//   - Reusable across seasons and league structures.
//   - Decoupled from the DOM – purely data in, data out.
//   - Works even if only partial projection data is provided.
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    // Namespace guard
    if (!window.LeagueModels) {
      console.error("[projections.js] LeagueModels is not defined. Make sure models.js is loaded first.");
    }
  
    // -----------------------
    // Configuration
    // -----------------------
  
    // Default positional volatility (as a fraction of mean) when we
    // don't have explicit floor/ceiling or historical stats.
    const DEFAULT_SD_FRACTION_BY_POS = {
      QB: 0.35,
      RB: 0.45,
      WR: 0.50,
      TE: 0.55,
      K: 0.25,
      DEF: 0.30,
      // IDP / others
      LB: 0.40,
      DL: 0.45,
      DB: 0.40,
      DEFAULT: 0.45,
    };
  
    // How wide we want a "confident" team range to be in terms of sigma
    const TEAM_CONFIDENCE_SIGMAS = 1.1;
  
    // Maximum sims for Monte Carlo. For browser performance you can tune this
    // down (e.g. 5_000) or up if you’re feeling spicy.
    const DEFAULT_SIM_COUNT = 10000;
  
    // -----------------------
    // Projection data access
    // -----------------------
  
    /**
     * Get the projection source object from the global namespace.
     *
     * Expected optional shape:
     *
     *   window.PROJECTION_DATA = {
     *     byPlayerName: {
     *       "Jalen Hurts": {
     *         pos: "QB",
     *         team: "PHI",
     *         proj: 18.7,
     *         floor: 15.0,
     *         ceiling: 27.8
     *       },
     *       ...
     *     }
     *   }
     */
    function getProjectionSource() {
      return window.PROJECTION_DATA && window.PROJECTION_DATA.byPlayerName
        ? window.PROJECTION_DATA.byPlayerName
        : {};
    }
  
    function normalizeName(name) {
      if (!name || typeof name !== "string") return "";
      return name.trim().toLowerCase().replace(/\s+/g, " ");
    }
  
    /**
     * Try a few strategies to find a projection row for a player:
     *
     *  - Exact name match
     *  - Loose match with suffixes stripped (e.g., Jr., Sr., III)
     */
    function findProjectionForPlayer(playerDisplayName) {
      const source = getProjectionSource();
      const target = normalizeName(playerDisplayName);
      if (!target) return null;
  
      // First pass: exact normalized match
      for (const [name, row] of Object.entries(source)) {
        if (normalizeName(name) === target) {
          return row;
        }
      }
  
      // Second pass: strip common suffixes
      const stripped = target.replace(/\b(jr\.?|sr\.?|ii|iii|iv|v)\b/gi, "").trim();
      if (!stripped) return null;
  
      for (const [name, row] of Object.entries(source)) {
        const norm = normalizeName(name).replace(/\b(jr\.?|sr\.?|ii|iii|iv|v)\b/gi, "").trim();
        if (norm === stripped) {
          return row;
        }
      }
  
      return null;
    }
  
    // -----------------------
    // Player-level projections
    // -----------------------
  
    /**
     * Estimate a standard deviation given floor / mean / ceiling.
     * We treat floor/ceiling as roughly mean ± 2σ by default.
     */
    function estimateSdFromFloorCeiling(mean, floor, ceiling) {
      if (!Number.isFinite(mean)) return null;
      const f = Number.isFinite(floor) ? floor : null;
      const c = Number.isFinite(ceiling) ? ceiling : null;
  
      // If both floor and ceiling are available, use the widest span.
      if (f != null && c != null) {
        const span = Math.max(Math.abs(mean - f), Math.abs(c - mean));
        if (span > 0) return span / 2; // ~2σ
      }
  
      // If only floor:
      if (f != null) {
        const span = mean - f;
        if (span > 0) return span / 2;
      }
  
      // If only ceiling:
      if (c != null) {
        const span = c - mean;
        if (span > 0) return span / 2;
      }
  
      return null;
    }
  
    /**
     * Fallback SD estimate when no detailed range is available.
     * Uses positional multipliers.
     */
    function estimateSdFallback(mean, position) {
      if (!Number.isFinite(mean)) return 0;
      const posKey = position && DEFAULT_SD_FRACTION_BY_POS[position]
        ? position
        : "DEFAULT";
      const frac = DEFAULT_SD_FRACTION_BY_POS[posKey] || DEFAULT_SD_FRACTION_BY_POS.DEFAULT;
      return mean * frac;
    }
  
    /**
     * Build a projection object for a player given:
     *   - The team-week starter entry (from LeagueModels.buildTeamWeekView)
     *   - Optional external projection data (from PROJECTION_DATA)
     *
     * Output:
     *   {
     *     mean,
     *     sd,
     *     floor,
     *     ceiling,
     *     source: "external" | "heuristic",
     *     meta: { position, nflTeam, rawProjectionRow }
     *   }
     */
    function buildPlayerProjection(starterEntry) {
      const name = starterEntry.displayName || starterEntry.playerId;
      const pos = starterEntry.position || null;
      const projRow = findProjectionForPlayer(name);
  
      let mean;
      let floor;
      let ceiling;
      let source;
  
      if (projRow && Number.isFinite(Number(projRow.proj))) {
        mean = Number(projRow.proj);
        floor = Number.isFinite(Number(projRow.floor)) ? Number(projRow.floor) : null;
        ceiling = Number.isFinite(Number(projRow.ceiling)) ? Number(projRow.ceiling) : null;
        source = "external";
      } else {
        // Heuristic baseline: if we have recent fantasyPoints on this starter
        // (e.g., we loaded last week's matchup), we can anchor to that.
        const lastScore = Number.isFinite(starterEntry.fantasyPoints)
          ? starterEntry.fantasyPoints
          : 10; // generic fallback
  
        // For the “semifinal now” use case, this will often get overridden by
        // real projection data anyway.
        mean = lastScore;
        floor = null;
        ceiling = null;
        source = "heuristic";
      }
  
      let sd = estimateSdFromFloorCeiling(mean, floor, ceiling);
      if (!Number.isFinite(sd) || sd <= 0) {
        sd = estimateSdFallback(mean, pos);
      }
  
      // Clamp SD to something sane (avoid insane tails)
      const minSd = mean * 0.15;
      const maxSd = mean * 1.2;
      if (sd < minSd) sd = minSd;
      if (sd > maxSd) sd = maxSd;
  
      return {
        mean,
        sd,
        floor: floor != null ? floor : Math.max(0, mean - 3 * sd),
        ceiling: ceiling != null ? ceiling : mean + 3 * sd,
        source,
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
  
    /**
     * Attach per-player projections and team totals to a teamWeekView.
     *
     * Input: output from LeagueModels.buildTeamWeekView
     *
     * Output:
     *   {
     *     ...teamWeekView,
     *     projection: {
     *       players: [
     *         {
     *           ...starterEntry,
     *           projection: { mean, sd, floor, ceiling, source, meta }
     *         },
     *         ...
     *       ],
     *       totalMean,
     *       totalVariance,
     *       totalSd,
     *       rangeLow,
     *       rangeHigh
     *     }
     *   }
     */
    function projectTeam(teamWeekView) {
      if (!teamWeekView || !Array.isArray(teamWeekView.starters)) {
        return Object.assign({}, teamWeekView, { projection: null });
      }
  
      const projectedPlayers = teamWeekView.starters.map((starter) => {
        const proj = buildPlayerProjection(starter);
        return Object.assign({}, starter, { projection: proj });
      });
  
      let totalMean = 0;
      let totalVar = 0;
  
      projectedPlayers.forEach((p) => {
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
          totalMean,
          totalVariance: totalVar,
          totalSd,
          rangeLow,
          rangeHigh,
        },
      });
    }
  
    /**
     * Project both teams in a head-to-head matchup object:
     *   {
     *     ...matchup,
     *     projected: {
     *       teamA,
     *       teamB
     *     }
     *   }
     *
     * The matchup can either be:
     *  - A playoff matchup object from buildPlayoffMatchups (highSeedTeam, lowSeedTeam)
     *  - A generic week matchup from buildAllMatchupsForWeek (teams[0], teams[1])
     */
    function projectMatchup(matchup) {
      if (!matchup) return null;
  
      // Try to detect structure
      let teamA = matchup.highSeedTeam || (matchup.teams && matchup.teams[0]) || null;
      let teamB = matchup.lowSeedTeam || (matchup.teams && matchup.teams[1]) || null;
  
      if (!teamA || !teamB) {
        // Could be a bye or malformed; return as-is
        return Object.assign({}, matchup, { projected: null });
      }
  
      const projA = projectTeam(teamA);
      const projB = projectTeam(teamB);
  
      return Object.assign({}, matchup, {
        projected: {
          teamA: projA,
          teamB: projB,
        },
      });
    }
  
    // -----------------------
    // Monte Carlo Simulation
    // -----------------------
  
    // Basic Box–Muller transform for standard normal
    function randn() {
      let u = 0,
        v = 0;
      while (u === 0) u = Math.random(); // Avoid 0
      while (v === 0) v = Math.random();
      return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    }
  
    /**
     * Sample a non-negative fantasy score from a normal distribution
     * with the given mean/sd, truncated at 0.
     */
    function sampleFantasyScore(mean, sd) {
      if (sd <= 0) return Math.max(0, mean);
      const sample = mean + sd * randn();
      return sample < 0 ? 0 : sample;
    }
  
    /**
     * Run Monte Carlo sims for a projected matchup.
     *
     * Input: output of projectMatchup(matchup)
     *
     * Output:
     *   {
     *     teamAWinPct,
     *     teamBWinPct,
     *     tiePct,
     *     sims: {
     *       teamA: { scores: Float32Array | null, mean, sd },
     *       teamB: { scores: Float32Array | null, mean, sd }
     *     }
     *   }
     *
     * If `trackScores` is false, we don't store every sim’s score, just
     * accumulate aggregates.
     */
    function simulateMatchup(projectedMatchup, options = {}) {
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
  
        playersA.forEach((p) => {
          const m = p.projection.mean;
          const sd = p.projection.sd;
          scoreA += sampleFantasyScore(m, sd);
        });
  
        playersB.forEach((p) => {
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
  
    /**
     * Given:
     *   - Semifinal matchup A (teamA vs teamB)
     *   - Semifinal matchup B (teamC vs teamD)
     *   - Pairwise win probabilities from simulateMatchup
     *
     * Compute approximate championship odds for all four teams.
     *
     * Input shape (example):
     *   {
     *     semi1: { id, projected, sim: { teamAWinPct, teamBWinPct } },
     *     semi2: { ... },
     *     finalsMatrix: {
     *       A: { C: pA_beats_C, D: pA_beats_D },
     *       B: { C: pB_beats_C, D: pB_beats_D },
     *       ...
     *     }
     *   }
     *
     * Output:
     *   {
     *     [teamKey]: { titleOdds, path: { reachFinalPct } },
     *     ...
     *   }
     *
     * where teamKey is something stable you choose (like rosterId or team name).
     */
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
  
      // Semifinal advance probabilities
      const pA_to_final = pA_beat_B;
      const pB_to_final = pB_beat_A;
      const pC_to_final = pC_beat_D;
      const pD_to_final = pD_beat_C;
  
      function titleProb(teamKey, semiSide) {
        // semiSide: "A", "B", "C", or "D"
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
      // Player/Team projections
      buildPlayerProjection,
      projectTeam,
      projectMatchup,
  
      // Sims
      simulateMatchup,
  
      // Championship odds
      computeChampionshipOdds,
    };
  })();
  