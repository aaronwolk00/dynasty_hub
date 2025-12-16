// models.js
// -----------------------------------------------------------------------------
// Data modeling layer for the Sleeper-based playoff hub.
//
// Responsibility:
//   - Take raw Sleeper data (league, users, rosters, matchups)
//   - Normalize it into clean "teams" and "matchups" objects
//   - Build a playoff bracket (semifinals/finals) based on seeds
//
// No DOM work here. No projections or jokes here.
// Other modules (projections.js, newsletter.js, main.js) consume this.
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    // -----------------------
    // Utility helpers
    // -----------------------
  
    function safeNumber(value, fallback = 0) {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    }
  
    function clone(obj) {
      return JSON.parse(JSON.stringify(obj));
    }
  
    // -----------------------
    // Owners / users
    // -----------------------
  
    /**
     * Build a lookup of Sleeper users by user_id.
     *
     * @param {Array<Object>} users
     * @returns {Object<string, Object>}
     */
    function buildOwnerIndex(users) {
      const index = {};
  
      (users || []).forEach((u) => {
        if (!u || !u.user_id) return;
        const displayName =
          (u.metadata && u.metadata.team_name) ||
          u.display_name ||
          `Owner ${u.user_id}`;
  
        index[String(u.user_id)] = {
          userId: String(u.user_id),
          displayName,
          avatar: u.avatar || null,
          raw: u,
        };
      });
  
      return index;
    }
  
    // -----------------------
    // Teams / rosters
    // -----------------------
  
    /**
     * Infer a team display name using roster metadata and owner display name.
     *
     * @param {Object} roster
     * @param {Object|null} owner
     * @returns {string}
     */
    function inferTeamName(roster, owner) {
      const meta = roster && roster.metadata;
      if (meta && typeof meta.team_name === "string" && meta.team_name.trim()) {
        return meta.team_name.trim();
      }
  
      if (owner && owner.displayName) {
        return `${owner.displayName}'s Team`;
      }
  
      return `Roster ${roster.roster_id ?? "?"}`;
    }
  
    /**
     * Build league "teams" (one per roster) keyed by roster_id.
     *
     * Output shape:
     *   {
     *     "1": {
     *       rosterId: "1",
     *       ownerId: "12345",
     *       ownerDisplayName: "Akshay",
     *       teamDisplayName: "The Jeffersons",
     *       seed: 1,
     *       record: { wins, losses, ties, pointsFor, pointsForRaw },
     *       metadata: { avatar, original: { roster, owner } }
     *     },
     *     ...
     *   }
     *
     * @param {Object} league - Sleeper league object
     * @param {Array<Object>} users
     * @param {Array<Object>} rosters
     * @returns {Object<string, Object>}
     */
    function buildTeams(league, users, rosters) {
      const owners = buildOwnerIndex(users);
      const teamsByRosterId = {};
  
      (rosters || []).forEach((r) => {
        if (!r || typeof r.roster_id === "undefined") return;
        const rosterId = String(r.roster_id);
        const owner = owners[String(r.owner_id)] || null;
        const settings = r.settings || {};
  
        const wins = safeNumber(settings.wins);
        const losses = safeNumber(settings.losses);
        const ties = safeNumber(settings.ties);
        const fpts = safeNumber(settings.fpts);
        const fptsDecimal = safeNumber(settings.fpts_decimal, 0);
        const pointsFor = fpts + fptsDecimal / 100;
  
        const seedRaw = settings.playoff_seed;
        const seed =
          typeof seedRaw === "number" && Number.isFinite(seedRaw)
            ? seedRaw
            : null;
  
        const teamDisplayName = inferTeamName(r, owner);
  
        teamsByRosterId[rosterId] = {
          rosterId,
          ownerId: owner ? owner.userId : null,
          ownerDisplayName: owner ? owner.displayName : "Unknown Owner",
          teamDisplayName,
          seed,
          record: {
            wins,
            losses,
            ties,
            pointsFor,
            pointsForRaw: { fpts, fptsDecimal },
          },
          metadata: {
            avatar: owner ? owner.avatar : null,
            leagueSeason: league && league.season ? String(league.season) : null,
            original: {
              roster: clone(r),
              owner: owner ? clone(owner.raw) : null,
            },
          },
        };
      });
  
      return teamsByRosterId;
    }
  
    // -----------------------
    // Matchups
    // -----------------------
  
    /**
     * Index matchups by roster_id for a given week.
     * Sleeper returns one matchup record per roster per week.
     *
     * Output shape:
     *   {
     *     "1": matchupObjForRoster1,
     *     "2": matchupObjForRoster2,
     *     ...
     *   }
     *
     * @param {Array<Object>} matchups
     * @returns {Object<string, Object>}
     */
    function indexMatchupsByRosterId(matchups) {
      const index = {};
      (matchups || []).forEach((m) => {
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
     *
     * Output entries:
     *   {
     *     playerId,
     *     displayName,
     *     position,
     *     nflTeam,
     *     slotIndex,
     *     fantasyPoints
     *   }
     *
     * @param {Object} roster
     * @param {Object|null} matchup
     * @param {Object|null} playerMap
     * @returns {Array<Object>}
     */
    function buildStarterEntries(roster, matchup, playerMap) {
      const starters =
        (matchup && Array.isArray(matchup.starters) && matchup.starters.length
          ? matchup.starters
          : roster && Array.isArray(roster.starters)
          ? roster.starters
          : []) || [];
  
      const playersPoints =
        (matchup && matchup.players_points) ||
        (matchup && matchup.custom_points) ||
        {};
  
      return starters.map((playerId, idx) => {
        const pid = String(playerId);
        const meta = playerMap ? playerMap[pid] : null;
        const fantasyPoints = safeNumber(playersPoints[pid], 0);
  
        return {
          playerId: pid,
          displayName: meta && meta.full_name ? meta.full_name : pid,
          position: meta && meta.position ? meta.position : null,
          nflTeam: meta && meta.team ? meta.team : null,
          slotIndex: idx,
          fantasyPoints,
        };
      });
    }
  
    /**
     * Build a "team in a specific week" view, combining roster + matchup.
     *
     * Output shape:
     *   {
     *     team: <team object from buildTeams>,
     *     rosterId: "1",
     *     week: 16,
     *     score: 143.2,
     *     starters: [...],
     *     rawMatchup: {...}
     *   }
     *
     * @param {Object} args
     * @param {Object} args.teamsByRosterId
     * @param {Array<Object>} args.rosters
     * @param {Object} args.matchupsByRosterId
     * @param {string|number} args.rosterId
     * @param {number} args.week
     * @param {Object|null} args.playerMap
     * @returns {Object|null}
     */
    function buildTeamWeekView({
      teamsByRosterId,
      rosters,
      matchupsByRosterId,
      rosterId,
      week,
      playerMap,
    }) {
      const rid = String(rosterId);
      const baseTeam = teamsByRosterId[rid];
      if (!baseTeam) return null;
  
      const matchup = matchupsByRosterId[rid] || null;
      const roster =
        (rosters || []).find((r) => String(r.roster_id) === rid) || null;
  
      const pointsField =
        matchup && typeof matchup.points !== "undefined"
          ? "points"
          : "custom_points";
      const score =
        matchup && typeof matchup[pointsField] !== "undefined"
          ? safeNumber(matchup[pointsField])
          : 0;
  
      const starters = buildStarterEntries(roster, matchup, playerMap);
  
      return {
        team: baseTeam,
        rosterId: rid,
        week,
        score,
        starters,
        rawMatchup: matchup ? clone(matchup) : null,
      };
    }
  
    /**
     * Build playoff matchups for semifinals based on:
     *   - LEAGUE_CONFIG.playoff.bracketBySeed
     *   - rosters.settings.playoff_seed
     *
     * This does NOT care about Sleeper's matchup_id. It simply pairs the
     * seeded rosters for the given week.
     *
     * Output shape:
     *   [
     *     {
     *       id: "semi1",
     *       round: "semifinal",
     *       week: 16,
     *       highSeed: 1,
     *       lowSeed: 4,
     *       highSeedTeam: <teamWeekView>,
     *       lowSeedTeam: <teamWeekView>
     *     },
     *     ...
     *   ]
     *
     * @param {Object} snapshot - { league, users, rosters, matchups }
     * @param {Object} [config] - LEAGUE_CONFIG override, optional
     * @param {Object|null} [playerMap] - optional player meta
     * @returns {Array<Object>}
     */
    function buildPlayoffMatchups(snapshot, config, playerMap = null) {
      const league = snapshot.league || {};
      const rosters = snapshot.rosters || [];
      const matchups = snapshot.matchups || [];
      const users = snapshot.users || [];
  
      const cfg = config || window.LEAGUE_CONFIG || {};
      const playoffCfg = cfg.playoff || {};
      const semisWeek = playoffCfg.semifinalsWeek || cfg.season?.defaultWeek || 16;
  
      const teamsByRosterId = buildTeams(league, users, rosters);
      const matchupsByRosterId = indexMatchupsByRosterId(matchups);
  
      // Build seed → rosterId map
      const seedToRosterId = {};
      Object.values(teamsByRosterId).forEach((team) => {
        if (team.seed != null) {
          seedToRosterId[team.seed] = team.rosterId;
        }
      });
  
      const result = [];
  
      (playoffCfg.bracketBySeed || []).forEach((slot) => {
        const highSeed = slot.highSeed;
        const lowSeed = slot.lowSeed;
  
        const highRosterId = seedToRosterId[highSeed];
        const lowRosterId = seedToRosterId[lowSeed];
  
        if (!highRosterId || !lowRosterId) {
          // If playoff seeds aren't set yet, skip this matchup.
          return;
        }
  
        const highSeedTeam = buildTeamWeekView({
          teamsByRosterId,
          rosters,
          matchupsByRosterId,
          rosterId: highRosterId,
          week: semisWeek,
          playerMap,
        });
  
        const lowSeedTeam = buildTeamWeekView({
          teamsByRosterId,
          rosters,
          matchupsByRosterId,
          rosterId: lowRosterId,
          week: semisWeek,
          playerMap,
        });
  
        result.push({
          id: slot.id || `semi_${highSeed}_vs_${lowSeed}`,
          round: slot.round || "semifinal",
          week: semisWeek,
          highSeed,
          lowSeed,
          highSeedTeam,
          lowSeedTeam,
        });
      });
  
      return result;
    }
  
    /**
     * Generic helper for any given week (not just playoffs).
     * Groups all rosters that have a matchup for that week into paired matchups.
     *
     * Output shape:
     *   [
     *     {
     *       id: "week16_m1",
     *       week: 16,
     *       matchupId: 1,
     *       teams: [ teamWeekViewA, teamWeekViewB ],
     *       isBye: false
     *     },
     *     ...
     *   ]
     *
     * @param {Object} snapshot - { league, users, rosters, matchups }
     * @param {Object|null} playerMap
     * @returns {Array<Object>}
     */
    function buildAllMatchupsForWeek(snapshot, playerMap = null) {
      const league = snapshot.league || {};
      const rosters = snapshot.rosters || [];
      const matchups = snapshot.matchups || [];
      const users = snapshot.users || [];
  
      const teamsByRosterId = buildTeams(league, users, rosters);
  
      // Group by matchup_id
      const groups = {};
      matchups.forEach((m) => {
        if (!m || typeof m.matchup_id === "undefined") return;
        const mId = String(m.matchup_id);
        if (!groups[mId]) groups[mId] = [];
        groups[mId].push(m);
      });
  
      const week = safeNumber(matchups[0] && matchups[0].week, null);
      const result = [];
  
      Object.entries(groups).forEach(([matchupId, entries]) => {
        const sorted = entries.slice().sort((a, b) => {
          return safeNumber(a.roster_id) - safeNumber(b.roster_id);
        });
  
        const teamViews = sorted.map((entry) =>
          buildTeamWeekView({
            teamsByRosterId,
            rosters,
            matchupsByRosterId: indexMatchupsByRosterId(matchups),
            rosterId: entry.roster_id,
            week,
            playerMap,
          })
        );
  
        const isBye = teamViews.length === 1;
  
        result.push({
          id: `week${week}_m${matchupId}`,
          week,
          matchupId,
          teams: teamViews,
          isBye,
        });
      });
  
      return result;
    }
  
    // -----------------------
    // Public API
    // -----------------------
  
    window.LeagueModels = {
      buildOwnerIndex,
      buildTeams,
      buildTeamWeekView,
      buildPlayoffMatchups,
      buildAllMatchupsForWeek,
    };
  })();
  