// models.js
// -----------------------------------------------------------------------------
// Data modeling layer for the Sleeper-based playoff hub.
//
// Responsibilities:
//   • Normalize raw Sleeper data (league, users, rosters, matchups)
//   • Build rich "team" objects from rosters + owner info
//   • Construct week-level "team views" (score + starters + metadata)
//   • Infer playoff structure from seeds + config (4- or 6-team bracket)
//   • Build:
//        - Generic weekly matchups (regular season + consolation)
//        - Playoff-only matchups with explicit round labels
//
// No DOM work here. Pure data in, pure data out.
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    // ===========================================================================
    // Small utilities
    // ===========================================================================
  
    function safeNumber(value, fallback) {
      if (fallback === void 0) fallback = 0;
      var n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    }
  
    function deepClone(obj) {
      if (obj == null) return obj;
      return JSON.parse(JSON.stringify(obj));
    }
  
    function mean(values) {
      var n = values.length;
      if (!n) return 0;
      var s = 0;
      for (var i = 0; i < n; i++) s += values[i];
      return s / n;
    }
  
    function variance(values, mu) {
      var n = values.length;
      if (!n) return 0;
      if (mu == null) mu = mean(values);
      var s = 0;
      for (var i = 0; i < n; i++) {
        var d = values[i] - mu;
        s += d * d;
      }
      return s / n;
    }
  
    function stdDev(values, mu) {
      var v = variance(values, mu);
      return Math.sqrt(v);
    }
  
    // ===========================================================================
    // Owner / user modeling
    // ===========================================================================
  
    /**
     * Build an index of owners keyed by user_id.
     */
    function buildOwnerIndex(users) {
      var index = {};
      (users || []).forEach(function (u) {
        if (!u || !u.user_id) return;
  
        var displayName =
          (u.metadata && u.metadata.team_name) ||
          u.display_name ||
          u.username ||
          "Owner " + u.user_id;
  
        index[String(u.user_id)] = {
          userId: String(u.user_id),
          displayName: displayName,
          avatar: u.avatar || null,
          raw: u
        };
      });
  
      return index;
    }
  
    // ===========================================================================
    // Teams / rosters
    // ===========================================================================
  
    function inferTeamName(roster, owner) {
      var meta = roster && roster.metadata;
      if (meta && typeof meta.team_name === "string" && meta.team_name.trim()) {
        return meta.team_name.trim();
      }
      if (owner && owner.displayName) {
        return owner.displayName + "'s Team";
      }
      return "Roster " + (roster && roster.roster_id != null ? roster.roster_id : "?");
    }
  
    function computeLeagueContext(rosters) {
      var points = [];
      (rosters || []).forEach(function (r) {
        if (!r || !r.settings) return;
        var s = r.settings;
        var fpts = safeNumber(s.fpts);
        var fDec = safeNumber(s.fpts_decimal);
        var pf = fpts + fDec / 100;
        if (pf > 0) points.push(pf);
      });
  
      if (!points.length) {
        return {
          meanPF: 0,
          sdPF: 0
        };
      }
  
      var mu = mean(points);
      var sd = stdDev(points, mu);
  
      return {
        meanPF: mu,
        sdPF: sd
      };
    }
  
    /**
     * Build league "teams" (one per roster) keyed by roster_id.
     * Adds basic derived metrics (win%, PF z-score) that can be used
     * downstream by the Insights module.
     */
    function buildTeams(league, users, rosters) {
      var owners = buildOwnerIndex(users);
      var leagueContext = computeLeagueContext(rosters);
      var muPF = leagueContext.meanPF;
      var sdPF = leagueContext.sdPF || 1; // avoid divide by 0
  
      var teamsByRosterId = {};
  
      (rosters || []).forEach(function (r) {
        if (!r || typeof r.roster_id === "undefined") return;
  
        var rosterId = String(r.roster_id);
        var owner = owners[String(r.owner_id)] || null;
        var settings = r.settings || {};
  
        var wins = safeNumber(settings.wins);
        var losses = safeNumber(settings.losses);
        var ties = safeNumber(settings.ties);
        var fpts = safeNumber(settings.fpts);
        var fptsDecimal = safeNumber(settings.fpts_decimal);
        var pointsFor = fpts + fptsDecimal / 100;
  
        var games = wins + losses + ties;
        var winPct = games > 0 ? wins / games : 0;
  
        var seedRaw = settings.playoff_seed;
        var seed =
          typeof seedRaw === "number" && Number.isFinite(seedRaw)
            ? seedRaw
            : null;
  
        var teamDisplayName = inferTeamName(r, owner);
        var pfZ = (pointsFor - muPF) / sdPF;
  
        teamsByRosterId[rosterId] = {
          rosterId: rosterId,
          ownerId: owner ? owner.userId : null,
          ownerDisplayName: owner ? owner.displayName : "Unknown Owner",
          teamDisplayName: teamDisplayName,
          seed: seed,
          record: {
            wins: wins,
            losses: losses,
            ties: ties,
            games: games,
            winPct: winPct,
            pointsFor: pointsFor,
            pointsForRaw: { fpts: fpts, fptsDecimal: fptsDecimal },
            pointsForZ: pfZ
          },
          metadata: {
            avatar: owner ? owner.avatar : null,
            leagueSeason: league && league.season ? String(league.season) : null,
            original: {
              roster: deepClone(r),
              owner: owner ? deepClone(owner.raw) : null
            }
          }
        };
      });
  
      return teamsByRosterId;
    }
  
    // ===========================================================================
    // Matchup helpers
    // ===========================================================================
  
    function indexMatchupsByRosterId(matchups) {
      var index = {};
      (matchups || []).forEach(function (m) {
        if (!m || typeof m.roster_id === "undefined") return;
        index[String(m.roster_id)] = m;
      });
      return index;
    }
  
    /**
     * Build starter entries for a given roster+matchup.
     *
     * If playerMap is supplied, it should be:
     *   { [playerId]: { full_name, position, team, ... } }
     */
    function buildStarterEntries(roster, matchup, playerMap) {
      var starters =
        (matchup &&
          Array.isArray(matchup.starters) &&
          matchup.starters.length
          ? matchup.starters
          : roster && Array.isArray(roster.starters)
          ? roster.starters
          : []) || [];
  
      var playersPoints =
        (matchup && matchup.players_points) ||
        (matchup && matchup.custom_points) ||
        {};
  
      return starters.map(function (playerId, idx) {
        var pid = String(playerId);
        var meta = playerMap ? playerMap[pid] : null;
        var fantasyPoints = safeNumber(playersPoints[pid], 0);
  
        return {
          playerId: pid,
          displayName: meta && meta.full_name ? meta.full_name : pid,
          position: meta && meta.position ? meta.position : null,
          nflTeam: meta && meta.team ? meta.team : null,
          slotIndex: idx,
          fantasyPoints: fantasyPoints
        };
      });
    }
  
    /**
     * Build a "team in a specific week" view, combining roster + matchup.
     */
    function buildTeamWeekView(args) {
      var teamsByRosterId = args.teamsByRosterId;
      var rosters = args.rosters;
      var matchupsByRosterId = args.matchupsByRosterId;
      var rosterId = args.rosterId;
      var week = args.week;
      var playerMap = args.playerMap;
  
      var rid = String(rosterId);
      var baseTeam = teamsByRosterId[rid];
      if (!baseTeam) return null;
  
      var matchup = matchupsByRosterId[rid] || null;
      var roster =
        (rosters || []).find(function (r) {
          return String(r.roster_id) === rid;
        }) || null;
  
      var pointsField =
        matchup && typeof matchup.points !== "undefined"
          ? "points"
          : "custom_points";
      var score =
        matchup && typeof matchup[pointsField] !== "undefined"
          ? safeNumber(matchup[pointsField])
          : 0;
  
      var starters = buildStarterEntries(roster, matchup, playerMap);
  
      return {
        team: baseTeam,
        rosterId: rid,
        week: week,
        score: score,
        starters: starters,
        rawMatchup: matchup ? deepClone(matchup) : null
      };
    }
  
    // ===========================================================================
    // Playoff structure inference
    // ===========================================================================
  
    /**
     * Infer playoff configuration from:
     *   - Explicit LEAGUE_CONFIG.playoff fields (preferred)
     *   - Observed seeds on rosters (fallback)
     */
    function inferPlayoffConfig(league, rosters, cfg) {
      cfg = cfg || {};
      var playoffCfg = cfg.playoff || {};
  
      var seeds = [];
      (rosters || []).forEach(function (r) {
        var s = r && r.settings && r.settings.playoff_seed;
        if (typeof s === "number" && Number.isFinite(s) && s > 0) {
          seeds.push(s);
        }
      });
  
      if (!seeds.length) {
        return {
          numPlayoffTeams: 0,
          startWeek: null,
          quarterfinalWeek: null,
          semifinalWeek: cfg.SEMIFINAL_WEEK || playoffCfg.semifinalWeek || null,
          finalWeek: playoffCfg.finalWeek || null
        };
      }
  
      seeds.sort(function (a, b) { return a - b; });
      var maxSeed = seeds[seeds.length - 1];
  
      // Heuristic: if we see seeds up to 6, assume a 6-team bracket.
      // Otherwise, fall back to 4-team.
      var numPlayoffTeams =
        playoffCfg.numPlayoffTeams ||
        (maxSeed >= 6 ? 6 : Math.min(4, maxSeed));
  
      var explicitSemiWeek =
        cfg.SEMIFINAL_WEEK ||
        playoffCfg.semifinalWeek ||
        null;
  
      var startWeek =
        playoffCfg.startWeek ||
        playoffCfg.quarterfinalWeek ||
        explicitSemiWeek ||
        null;
  
      var quarterfinalWeek = playoffCfg.quarterfinalWeek || null;
      var semifinalWeek = explicitSemiWeek;
      var finalWeek = playoffCfg.finalWeek || null;
  
      // If only a semifinal week is known, derive QF / final around it for 6-team.
      if (numPlayoffTeams === 6 && explicitSemiWeek && !quarterfinalWeek) {
        quarterfinalWeek = explicitSemiWeek - 1;
        if (!finalWeek) finalWeek = explicitSemiWeek + 1;
      }
  
      // For 4-team: only semis + final.
      if (numPlayoffTeams === 4 && explicitSemiWeek) {
        if (!finalWeek) finalWeek = explicitSemiWeek + 1;
      }
  
      if (!startWeek) {
        startWeek = quarterfinalWeek || semifinalWeek || null;
      }
  
      return {
        numPlayoffTeams: numPlayoffTeams,
        startWeek: startWeek,
        quarterfinalWeek: quarterfinalWeek,
        semifinalWeek: semifinalWeek,
        finalWeek: finalWeek
      };
    }
  
    /**
     * Given week + seeds + inferred playoff config, decide if a matchup
     * is part of the main playoff bracket and, if so, which round.
     *
     * Returns:
     *   null                              -> not a playoff matchup
     *   { roundKey, roundLabel }          -> main bracket
     *   { roundKey: "consolation", ... }  -> consolation (optional use)
     */
    function determinePlayoffRound(week, seedA, seedB, playoffMeta) {
      if (!week || !playoffMeta || !playoffMeta.numPlayoffTeams) return null;
  
      var num = playoffMeta.numPlayoffTeams;
      var qWeek = playoffMeta.quarterfinalWeek;
      var sWeek = playoffMeta.semifinalWeek;
      var fWeek = playoffMeta.finalWeek;
  
      if (!seedA || !seedB) return null;
  
      var maxSeed = Math.max(seedA, seedB);
      var minSeed = Math.min(seedA, seedB);
  
      // Outside main playoff teams ⇒ maybe consolation
      if (maxSeed > num) {
        if (
          (week === qWeek || week === sWeek || week === fWeek) &&
          minSeed <= num
        ) {
          return {
            roundKey: "consolation",
            roundLabel: "Consolation"
          };
        }
        return null;
      }
  
      // 6-team bracket: QF in qWeek, semis in sWeek (with top-2 seeds),
      // final in fWeek.
      if (num === 6) {
        if (week === qWeek) {
          // Only seeds 3–6 should be in true quarterfinals.
          if (minSeed >= 3 && maxSeed <= 6) {
            return {
              roundKey: "quarterfinal",
              roundLabel: "Quarterfinal"
            };
          }
          // Seeds 1–2 should be on bye; anything else here is consolation.
          return {
            roundKey: "consolation",
            roundLabel: "Consolation"
          };
        }
  
        if (week === sWeek) {
          // Semis: one top seed (1 or 2) vs a non-bye seed (>=3, <=6).
          var hasTopSeed = seedA <= 2 || seedB <= 2;
          if (hasTopSeed && maxSeed <= 6) {
            return {
              roundKey: "semifinal",
              roundLabel: "Semifinal"
            };
          }
          return {
            roundKey: "consolation",
            roundLabel: "Consolation"
          };
        }
  
        if (week === fWeek) {
          // Championship: both teams are playoff teams (1–6). In most
          // leagues this will be the title game; consolation finals are
          // filtered by seeds > num or separate bracket configs.
          if (maxSeed <= 6) {
            return {
              roundKey: "final",
              roundLabel: "Championship"
            };
          }
          return {
            roundKey: "consolation",
            roundLabel: "Consolation"
          };
        }
  
        return null;
      }
  
      // 4-team bracket: semis + final.
      if (num === 4) {
        if (week === sWeek) {
          if (maxSeed <= 4) {
            return {
              roundKey: "semifinal",
              roundLabel: "Semifinal"
            };
          }
          return {
            roundKey: "consolation",
            roundLabel: "Consolation"
          };
        }
  
        if (week === fWeek) {
          if (maxSeed <= 4) {
            return {
              roundKey: "final",
              roundLabel: "Championship"
            };
          }
          return {
            roundKey: "consolation",
            roundLabel: "Consolation"
          };
        }
  
        return null;
      }
  
      // Other sizes (8 team etc.) – not yet modeled explicitly.
      // We leave them unlabeled rather than guessing.
      return null;
    }
  
    // ===========================================================================
    // Generic weekly matchups
    // ===========================================================================
  
    /**
     * Internal helper shared by:
     *   - buildAllMatchupsForWeek (full slate)
     *   - buildPlayoffMatchups (filtered to playoff-only)
     */
    function buildAllMatchupsInternal(snapshot, playerMap, cfg, options) {
      if (playerMap === void 0) playerMap = null;
      options = options || {};
      var playoffOnly = !!options.playoffOnly;
  
      var league = snapshot.league || {};
      var rosters = snapshot.rosters || [];
      var matchups = snapshot.matchups || [];
      var users = snapshot.users || [];
  
      if (!matchups.length) {
        return [];
      }
  
      var teamsByRosterId = buildTeams(league, users, rosters);
      var playoffMeta = inferPlayoffConfig(league, rosters, cfg);
      var matchupsByRosterId = indexMatchupsByRosterId(matchups);
  
      // Group by matchup_id, skipping invalid ids
      var groups = {};
      matchups.forEach(function (m) {
        if (!m) return;
        if (m.matchup_id == null || !Number.isFinite(Number(m.matchup_id))) {
          // Sleeper often uses null for "no matchup" (byes, etc.)
          return;
        }
        var mId = String(m.matchup_id);
        if (!groups[mId]) groups[mId] = [];
        groups[mId].push(m);
      });
  
      var anyMatchup = matchups[0];
      var week = safeNumber(anyMatchup && anyMatchup.week, null);
      var results = [];
  
      Object.keys(groups).forEach(function (matchupId) {
        var entries = groups[matchupId];
        if (!entries || !entries.length) return;
  
        var sorted = entries.slice().sort(function (a, b) {
          return safeNumber(a.roster_id) - safeNumber(b.roster_id);
        });
  
        var teamViews = sorted
          .map(function (entry) {
            return buildTeamWeekView({
              teamsByRosterId: teamsByRosterId,
              rosters: rosters,
              matchupsByRosterId: matchupsByRosterId,
              rosterId: entry.roster_id,
              week: week,
              playerMap: playerMap
            });
          })
          .filter(Boolean);
  
        if (!teamViews.length) return;
  
        var isBye = teamViews.length === 1;
  
        var seedA = teamViews[0].team && teamViews[0].team.seed;
        var seedB = teamViews[1] && teamViews[1].team && teamViews[1].team.seed;
        var roundInfo =
          teamViews.length === 2
            ? determinePlayoffRound(week, seedA, seedB, playoffMeta)
            : null;
  
        if (playoffOnly) {
          if (!roundInfo || (roundInfo.roundKey !== "quarterfinal" &&
                             roundInfo.roundKey !== "semifinal" &&
                             roundInfo.roundKey !== "final")) {
            return; // skip non-playoff matchups in playoffOnly mode
          }
        }
  
        results.push({
          id: "week" + week + "_m" + matchupId,
          week: week,
          matchupId: matchupId,
          teams: teamViews,
          isBye: isBye,
          isPlayoff: !!roundInfo && roundInfo.roundKey !== "consolation",
          roundKey: roundInfo ? roundInfo.roundKey : null,
          roundLabel: roundInfo ? roundInfo.roundLabel : null
        });
      });
  
      return results;
    }
  
    /**
     * Public: generic helper for any given week (not just playoffs).
     * Groups all rosters that have a valid matchup_id into paired matchups.
     *
     * Round information (quarterfinal / semifinal / championship) is inferred
     * from seeds + LEAGUE_CONFIG.playoff; regular-season games will have
     * roundKey = null, roundLabel = null.
     */
    function buildAllMatchupsForWeek(snapshot, playerMap) {
      var cfg =
        (typeof window !== "undefined" && window.LEAGUE_CONFIG) || {};
      return buildAllMatchupsInternal(snapshot, playerMap, cfg, {
        playoffOnly: false
      });
    }
  
    // ===========================================================================
    // Playoff matchups (main bracket only)
    // ===========================================================================
  
    /**
     * Public: Build playoff-only matchups for a given week.
     *
     * This does two jobs:
     *
     *  1) For weeks where Sleeper has already generated matchups
     *     (i.e., snapshot.matchups has data), we:
     *       - Build week views via buildAllMatchupsInternal(..., playoffOnly=true)
     *       - Return only quarterfinal / semifinal / championship games,
     *         tagged with roundKey + roundLabel.
     *
     *  2) For future weeks where Sleeper has not yet attached matchups,
     *     we fall back to seed-based construction (4-team bracket only).
     *
     * The returned objects are shaped so ProjectionEngine.projectMatchup()
     * can handle them directly: we provide both a {teams: [...] } array
     * and convenience aliases teamA/teamB.
     */
    function buildPlayoffMatchups(snapshot, config, options) {
      config = config || {};
      options = options || {};
  
      var week = options.week;
      var playerMap = options.playerMap || null;
  
      if (!week) {
        var any = (snapshot.matchups || [])[0];
        week = safeNumber(any && any.week, null);
      }
  
      var league = snapshot.league || {};
      var rosters = snapshot.rosters || [];
      var users = snapshot.users || [];
      var matchups = snapshot.matchups || [];
  
      var teamsByRosterId = buildTeams(league, users, rosters);
      var playoffMeta = inferPlayoffConfig(league, rosters, config);
  
      // Case 1: Sleeper already gives us matchups – filter to playoff-only.
      if (matchups && matchups.length) {
        var playoffMatchups = buildAllMatchupsInternal(
          snapshot,
          playerMap,
          config,
          { playoffOnly: true }
        );
  
        // For downstream tools (ProjectionEngine, charts), expose teamA/teamB.
        playoffMatchups.forEach(function (m) {
          if (m.teams && m.teams.length >= 2) {
            m.teamA = m.teams[0];
            m.teamB = m.teams[1];
          } else {
            m.teamA = m.teams && m.teams[0] ? m.teams[0] : null;
            m.teamB = null;
          }
        });
  
        return playoffMatchups;
      }
  
      // Case 2: No matchups yet (e.g., pre-playoffs) – seed-based bracket
      // construction. We only attempt a deterministic bracket for 4-team
      // playoffs; 6-team with byes is much more dependent on platform rules,
      // and is better driven by Sleeper once data exists.
      var seeded = (rosters || [])
        .map(function (r) {
          var s = r && r.settings && r.settings.playoff_seed;
          return {
            rosterId: String(r.roster_id),
            seed: typeof s === "number" && Number.isFinite(s) ? s : Infinity
          };
        })
        .filter(function (x) {
          return Number.isFinite(x.seed) && x.seed > 0;
        })
        .sort(function (a, b) {
          return a.seed - b.seed;
        });
  
      var num = playoffMeta.numPlayoffTeams;
      if (!num || seeded.length < Math.min(num, 4)) {
        return [];
      }
  
      var matchupsOut = [];
  
      // 4-team deterministic bracket:
      //   Semifinals: 1 vs 4, 2 vs 3 (semifinalWeek)
      //   Final: winners (finalWeek – but we can't know teams here a priori)
      if (num === 4 && playoffMeta.semifinalWeek && week === playoffMeta.semifinalWeek) {
        var s1 = seeded[0];
        var s2 = seeded[1];
        var s3 = seeded[2];
        var s4 = seeded[3];
  
        var matchupsByRosterId = {}; // empty – future week, no scores
        var rostersArr = rosters;
  
        function buildTV(r) {
          return buildTeamWeekView({
            teamsByRosterId: teamsByRosterId,
            rosters: rostersArr,
            matchupsByRosterId: matchupsByRosterId,
            rosterId: r.rosterId,
            week: week,
            playerMap: playerMap
          });
        }
  
        var m1A = buildTV(s1);
        var m1B = buildTV(s4);
        var m2A = buildTV(s2);
        var m2B = buildTV(s3);
  
        if (m1A && m1B) {
          matchupsOut.push({
            id: "semi1",
            week: week,
            matchupId: "semi1",
            teams: [m1A, m1B],
            teamA: m1A,
            teamB: m1B,
            isBye: false,
            isPlayoff: true,
            roundKey: "semifinal",
            roundLabel: "Semifinal"
          });
        }
  
        if (m2A && m2B) {
          matchupsOut.push({
            id: "semi2",
            week: week,
            matchupId: "semi2",
            teams: [m2A, m2B],
            teamA: m2A,
            teamB: m2B,
            isBye: false,
            isPlayoff: true,
            roundKey: "semifinal",
            roundLabel: "Semifinal"
          });
        }
  
        return matchupsOut;
      }
  
      // For 6-team or other shapes with no Sleeper data yet, we prefer
      // to wait for real matchups rather than inventing a bracket that
      // might not match your platform’s rules (re-seeding, consolation, etc.).
      return [];
    }
  
    // ===========================================================================
    // Public API
    // ===========================================================================
  
    window.LeagueModels = {
      buildOwnerIndex: buildOwnerIndex,
      buildTeams: buildTeams,
      buildTeamWeekView: buildTeamWeekView,
      buildPlayoffMatchups: buildPlayoffMatchups,
      buildAllMatchupsForWeek: buildAllMatchupsForWeek
    };
  })();
  