// projections.js
// -----------------------------------------------------------------------------
// Universal Projection + Simulation Layer for the Sleeper Fantasy Hub.
//
// Responsibilities:
//   - Take a team-week view from LeagueModels (or minimal team objects with starters).
//   - Attach per-player projections or fallback estimates.
//   - Produce team total mean, variance, and range.
//   - Run Monte Carlo simulations for win probabilities.
//   - Compute optional championship odds from two semifinals.
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    if (!window.LeagueModels) {
      console.error("[projections.js] LeagueModels not found – load models.js first.");
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
  
      // First pass: exact normalized match
      for (const key in source) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        if (normalizeName(key) === target) return source[key];
      }
  
      // Second pass: strip common suffixes
      const stripped = target.replace(/\b(jr\.?|sr\.?|ii|iii|iv|v)\b/gi, "").trim();
      if (!stripped) return null;
  
      for (const key in source) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const norm = normalizeName(key)
          .replace(/\b(jr\.?|sr\.?|ii|iii|iv|v)\b/gi, "")
          .trim();
        if (norm === stripped) return source[key];
      }
  
      return null;
    }
  
    // -----------------------
    // Player-level projections
    // -----------------------
  
    function estimateSdFromRange(mean, floor, ceiling) {
      if (!Number.isFinite(mean)) return null;
      const f = Number.isFinite(floor) ? floor : null;
      const c = Number.isFinite(ceiling) ? ceiling : null;
  
      if (f != null && c != null) {
        const span = Math.max(Math.abs(mean - f), Math.abs(c - mean));
        if (span > 0) return span / 2;
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
      const key =
        position && DEFAULT_SD_FRACTION_BY_POS[position]
          ? position
          : "DEFAULT";
      const frac =
        DEFAULT_SD_FRACTION_BY_POS[key] || DEFAULT_SD_FRACTION_BY_POS.DEFAULT;
      return mean * frac;
    }
  
    function buildPlayerProjection(starterEntry) {
      const name = starterEntry.displayName || starterEntry.playerId;
      const pos = starterEntry.position || starterEntry.pos || null;
      const projRow = findProjectionForPlayer(name);
  
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
      } else {
        const lastScore = Number.isFinite(starterEntry.fantasyPoints)
          ? starterEntry.fantasyPoints
          : 10;
        mean = lastScore;
        floor = null;
        ceiling = null;
        source = "heuristic";
      }
  
      let sd = estimateSdFromRange(mean, floor, ceiling);
      if (!Number.isFinite(sd) || sd <= 0) {
        sd = estimateSdFallback(mean, pos);
      }
  
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
          nflTeam: starterEntry.nflTeam || starterEntry.team || null,
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
      var u = 0;
      var v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    }
  
    function sampleFantasyScore(mean, sd) {
      if (!Number.isFinite(mean)) return 0;
      if (!Number.isFinite(sd) || sd <= 0) return Math.max(0, mean);
      const sample = mean + sd * randn();
      return sample < 0 ? 0 : sample;
    }
  
    function simulateMatchup(projectedMatchup, options) {
      options = options || {};
      if (!projectedMatchup || !projectedMatchup.projected) {
        return null;
      }
  
      const teams = projectedMatchup.projected;
      const teamA = teams.teamA;
      const teamB = teams.teamB;
  
      if (!teamA || !teamB || !teamA.projection || !teamB.projection) {
        return null;
      }
  
      const playersA = teamA.projection.players || [];
      const playersB = teamB.projection.players || [];
  
      const sims = options.sims || DEFAULT_SIM_COUNT;
      const trackScores = !!options.trackScores;
  
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
          scoreA += sampleFantasyScore(p.projection.mean, p.projection.sd);
        });
        playersB.forEach(function (p) {
          scoreB += sampleFantasyScore(p.projection.mean, p.projection.sd);
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
  
    // Approximate standard normal CDF (Abramowitz & Stegun 7.1.26)
    function normalCdf(x) {
      var t = 1 / (1 + 0.2316419 * Math.abs(x));
      var d = 0.3989423 * Math.exp(-0.5 * x * x);
      var prob =
        d *
        t *
        (0.3193815 +
          t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
      if (x > 0) prob = 1 - prob;
      return prob;
    }
  
    /**
     * Given two semifinal result objects:
     *   semi = { matchup: <projectedMatchup>, sim: <simResult> }
     *
     * Compute approximate championship odds for all four teams.
     */
    function computeChampionshipOdds(semi1, semi2) {
      if (!semi1 || !semi2) return null;
  
      const m1 = semi1.matchup;
      const m2 = semi2.matchup;
      const s1 = semi1.sim;
      const s2 = semi2.sim;
  
      if (!m1 || !m2 || !m1.projected || !m2.projected || !s1 || !s2) {
        return null;
      }
  
      const a = m1.projected.teamA;
      const b = m1.projected.teamB;
      const c = m2.projected.teamA;
      const d = m2.projected.teamB;
  
      const nameA = a.team.teamDisplayName;
      const nameB = b.team.teamDisplayName;
      const nameC = c.team.teamDisplayName;
      const nameD = d.team.teamDisplayName;
  
      const muA = a.projection.totalMean;
      const muB = b.projection.totalMean;
      const muC = c.projection.totalMean;
      const muD = d.projection.totalMean;
  
      const sdA = a.projection.totalSd;
      const sdB = b.projection.totalSd;
      const sdC = c.projection.totalSd;
      const sdD = d.projection.totalSd;
  
      const pA_semis = s1.teamAWinPct;
      const pB_semis = s1.teamBWinPct;
      const pC_semis = s2.teamAWinPct;
      const pD_semis = s2.teamBWinPct;
  
      function finalsWinProb(muX, sdX, muY, sdY) {
        const varDiff = sdX * sdX + sdY * sdY || 1;
        const z = (muX - muY) / Math.sqrt(varDiff);
        return normalCdf(z);
      }
  
      const pA_title =
        pA_semis *
        (pC_semis * finalsWinProb(muA, sdA, muC, sdC) +
          pD_semis * finalsWinProb(muA, sdA, muD, sdD));
  
      const pB_title =
        pB_semis *
        (pC_semis * finalsWinProb(muB, sdB, muC, sdC) +
          pD_semis * finalsWinProb(muB, sdB, muD, sdD));
  
      const pC_title =
        pC_semis *
        (pA_semis * finalsWinProb(muC, sdC, muA, sdA) +
          pB_semis * finalsWinProb(muC, sdC, muB, sdB));
  
      const pD_title =
        pD_semis *
        (pA_semis * finalsWinProb(muD, sdD, muA, sdA) +
          pB_semis * finalsWinProb(muD, sdD, muB, sdB));
  
      return {
        [nameA]: {
          titleOdds: pA_title,
          path: { reachFinalPct: pA_semis },
        },
        [nameB]: {
          titleOdds: pB_title,
          path: { reachFinalPct: pB_semis },
        },
        [nameC]: {
          titleOdds: pC_title,
          path: { reachFinalPct: pC_semis },
        },
        [nameD]: {
          titleOdds: pD_title,
          path: { reachFinalPct: pD_semis },
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
  