// models.js
// -----------------------------------------------------------------------------
// Data modeling layer for the Sleeper-based playoff hub.
//
// Responsibility:
//   - Take raw Sleeper data (league, users, rosters, matchups)
//   - Normalize it into clean "teams" and "matchups" objects
//   - Build playoff matchups based on seeds (4-team bracket)
//   - Build generic weekly matchups from Sleeper matchup_id
//
// No DOM work here.
// ----------------------------------------------------------------------------- 

(function () {
    "use strict";
  
    // -----------------------
    // Utility helpers
    // -----------------------
  
    function safeNumber(value, fallback) {
      if (fallback === void 0) fallback = 0;
      var n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    }
  
    function clone(obj) {
      return JSON.parse(JSON.stringify(obj));
    }
  
    // -----------------------
    // Owners / users
    // -----------------------
  
    function buildOwnerIndex(users) {
      var index = {};
      (users || []).forEach(function (u) {
        if (!u || !u.user_id) return;
        var displayName =
          (u.metadata && u.metadata.team_name) ||
          u.display_name ||
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
  
    // -----------------------
    // Teams / rosters
    // -----------------------
  
    function inferTeamName(roster, owner) {
      var meta = roster && roster.metadata;
      if (meta && typeof meta.team_name === "string" && meta.team_name.trim()) {
        return meta.team_name.trim();
      }
      if (owner && owner.displayName) {
        return owner.displayName + "'s Team";
      }
      return "Roster " + (roster.roster_id != null ? roster.roster_id : "?");
    }
  
    /**
     * Build league "teams" (one per roster) keyed by roster_id.
     */
    function buildTeams(league, users, rosters) {
      var owners = buildOwnerIndex(users);
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
        var fptsDecimal = safeNumber(settings.fpts_decimal, 0);
        var pointsFor = fpts + fptsDecimal / 100;
  
        var seedRaw = settings.playoff_seed;
        var seed =
          typeof seedRaw === "number" && Number.isFinite(seedRaw)
            ? seedRaw
            : null;
  
        var teamDisplayName = inferTeamName(r, owner);
  
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
            pointsFor: pointsFor,
            pointsForRaw: { fpts: fpts, fptsDecimal: fptsDecimal }
          },
          metadata: {
            avatar: owner ? owner.avatar : null,
            leagueSeason:
              league && league.season ? String(league.season) : null,
            original: {
              roster: clone(r),
              owner: owner ? clone(owner.raw) : null
            }
          }
        };
      });
  
      return teamsByRosterId;
    }
  
    // -----------------------
    // Matchups helpers
    // -----------------------
  
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
          displayName:
            meta && meta.full_name ? meta.full_name : pid,
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
        rawMatchup: matchup ? clone(matchup) : null
      };
    }
  
    // -----------------------
    // Playoff matchups (4-team bracket)
  // -----------------------
  
    /**
     * Build playoff semifinals based purely on seeds:
     *   1 vs 4, 2 vs 3
     *
     * We do NOT rely on Sleeper's matchup_id (which is often null
     * for upcoming playoff weeks), only on roster.settings.playoff_seed.
     *
     * Returns objects shaped so ProjectionEngine.projectMatchup()
     * can consume them directly:
     *
     *   {
     *     id,
     *     roundLabel: "Semifinal",
     *     bestOf: 1,
     *     teamA: <teamWeekView for higher seed>,
     *     teamB: <teamWeekView for lower seed>
     *   }
     */
    function buildPlayoffMatchups(snapshot, config, options) {
      config = config || {};
      options = options || {};
  
      var week =
        options.week ||
        config.SEMIFINAL_WEEK ||
        (config.playoff && config.playoff.semifinalWeek) ||
        null;
      var playerMap = options.playerMap || null;
  
      var league = snapshot.league || {};
      var rosters = snapshot.rosters || [];
      var users = snapshot.users || [];
      var matchups = snapshot.matchups || [];
  
      if (!week) {
        return [];
      }
  
      var teamsByRosterId = buildTeams(league, users, rosters);
      var matchupsByRosterId = indexMatchupsByRosterId(matchups);
  
      // Seeded rosters
      var seeded = (rosters || [])
        .map(function (r) {
          var settings = r.settings || {};
          var seed = safeNumber(settings.playoff_seed, Infinity);
          return {
            rosterId: String(r.roster_id),
            seed: seed
          };
        })
        .filter(function (x) {
          return Number.isFinite(x.seed);
        })
        .sort(function (a, b) {
          return a.seed - b.seed;
        });
  
      // Assume a 4-team playoff for now.
      if (seeded.length < 4) {
        return [];
      }
  
      var pairs = [
        [seeded[0], seeded[3]], // 1 vs 4
        [seeded[1], seeded[2]]  // 2 vs 3
      ];
  
      var results = [];
  
      pairs.forEach(function (pair, idx) {
        var high = pair[0];
        var low = pair[1];
        if (!high || !low) return;
  
        var highTeam = buildTeamWeekView({
          teamsByRosterId: teamsByRosterId,
          rosters: rosters,
          matchupsByRosterId: matchupsByRosterId,
          rosterId: high.rosterId,
          week: week,
          playerMap: playerMap
        });
        var lowTeam = buildTeamWeekView({
          teamsByRosterId: teamsByRosterId,
          rosters: rosters,
          matchupsByRosterId: matchupsByRosterId,
          rosterId: low.rosterId,
          week: week,
          playerMap: playerMap
        });
  
        if (!highTeam || !lowTeam) return;
  
        results.push({
          id: "semi" + (idx + 1),
          roundLabel: "Semifinal",
          bestOf: 1,
          teamA: highTeam,
          teamB: lowTeam
        });
      });
  
      return results;
    }
  
    // -----------------------
    // Generic weekly matchups
    // -----------------------
  
    /**
     * Generic helper for any given week (not just playoffs).
     * Groups all rosters that have a VALID matchup_id into paired matchups.
     *
     * We explicitly ignore rows with null / non-numeric matchup_id so we
     * don't invent fake matchups from playoff bye teams.
     */
    function buildAllMatchupsForWeek(snapshot, playerMap) {
      if (playerMap === void 0) playerMap = null;
  
      var league = snapshot.league || {};
      var rosters = snapshot.rosters || [];
      var matchups = snapshot.matchups || [];
      var users = snapshot.users || [];
  
      if (!matchups.length) {
        return [];
      }
  
      var teamsByRosterId = buildTeams(league, users, rosters);
  
      // Group by matchup_id, skipping invalid ids
      var groups = {};
      matchups.forEach(function (m) {
        if (!m) return;
        if (m.matchup_id == null || !Number.isFinite(Number(m.matchup_id))) {
          // Sleeper often uses null for "no matchup" (e.g., byes, future weeks)
          return;
        }
        var mId = String(m.matchup_id);
        if (!groups[mId]) groups[mId] = [];
        groups[mId].push(m);
      });
  
      var anyMatchup = matchups[0];
      var week = safeNumber(anyMatchup && anyMatchup.week, null);
      var result = [];
      var matchupsByRosterId = indexMatchupsByRosterId(matchups);
  
      Object.keys(groups).forEach(function (matchupId) {
        var entries = groups[matchupId];
        if (!entries || !entries.length) return;
  
        var sorted = entries.slice().sort(function (a, b) {
          return safeNumber(a.roster_id) - safeNumber(b.roster_id);
        });
  
        var teamViews = sorted.map(function (entry) {
          return buildTeamWeekView({
            teamsByRosterId: teamsByRosterId,
            rosters: rosters,
            matchupsByRosterId: matchupsByRosterId,
            rosterId: entry.roster_id,
            week: week,
            playerMap: playerMap
          });
        });
  
        var isBye = teamViews.length === 1;
  
        result.push({
          id: "week" + week + "_m" + matchupId,
          week: week,
          matchupId: matchupId,
          teams: teamViews,
          isBye: isBye
        });
      });
  
      return result;
    }
  
    // -----------------------
    // Public API
    // -----------------------
  
    window.LeagueModels = {
      buildOwnerIndex: buildOwnerIndex,
      buildTeams: buildTeams,
      buildTeamWeekView: buildTeamWeekView,
      buildPlayoffMatchups: buildPlayoffMatchups,
      buildAllMatchupsForWeek: buildAllMatchupsForWeek
    };
  })();
  