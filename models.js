// models.js
// -----------------------------------------------------------------------------
// Data modeling layer for the Sleeper-based playoff hub.
//
// Responsibility:
//   - Take raw Sleeper data (league, users, rosters, matchups, winners bracket)
//   - Normalize it into clean "teams" and "matchups" objects
//   - Build a playoff bracket (semifinals/finals) based on seeds + bracket
//
// No DOM work here. No projections or jokes here.
// Other modules (projections.js, newsletter.js, index.html) consume this.
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
      return obj == null ? obj : JSON.parse(JSON.stringify(obj));
    }
  
    // -----------------------
    // Owners / users
    // -----------------------
  
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
  
    function inferTeamName(roster, owner) {
      const meta = roster && roster.metadata;
      if (meta && typeof meta.team_name === "string" && meta.team_name.trim()) {
        return meta.team_name.trim();
      }
  
      if (owner && owner.displayName) {
        return `${owner.displayName}'s Team`;
      }
  
      return `Roster ${roster && roster.roster_id != null ? roster.roster_id : "?"}`;
    }
  
    /**
     * Build league "teams" (one per roster) keyed by roster_id.
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
    // Matchups + team-week views
    // -----------------------
  
    function indexMatchupsByRosterId(matchups) {
      const index = {};
      (matchups || []).forEach((m) => {
        if (!m || typeof m.roster_id === "undefined") return;
        index[String(m.roster_id)] = m;
      });
      return index;
    }
  
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
        const meta =
          (playerMap && playerMap[pid]) ||
          (window.__SLEEPER_PLAYER_MAP__ && window.__SLEEPER_PLAYER_MAP__[pid]) ||
          null;
        const fantasyPoints = safeNumber(playersPoints[pid], 0);
  
        return {
          playerId: pid,
          displayName:
            meta && meta.full_name
              ? meta.full_name
              : pid,
          position: meta && (meta.position || meta.pos) ? (meta.position || meta.pos) : null,
          nflTeam: meta && meta.team ? meta.team : null,
          slotIndex: idx,
          fantasyPoints,
        };
      });
    }
  
    /**
     * Build a "team in a specific week" view, combining roster + matchup.
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
  
    // -----------------------
    // League bootstrap
    // -----------------------
  
    /**
     * Convert the fetchLeagueBundle() result into a "leagueState" object
     * that newsletter.js and other modules can use.
     */
    function bootstrapFromSleeper(bundle, config) {
      const cfg = config || window.LEAGUE_CONFIG || {};
      const league = bundle.league || {};
      const users = bundle.users || [];
      const rosters = bundle.rosters || [];
      const matchupsByWeek = bundle.matchupsByWeek || {};
      const winnersBracket = bundle.winnersBracket || [];
  
      const teamsByRosterId = buildTeams(league, users, rosters);
  
      const weeks = {};
      Object.entries(matchupsByWeek).forEach(([wkStr, arr]) => {
        const wk = safeNumber(wkStr, null);
        if (!wk) return;
        weeks[wk] = {
          week: wk,
          matchups: arr,
          matchupsByRosterId: indexMatchupsByRosterId(arr),
        };
      });
  
      const playoff = {
        winnersBracket,
        semifinalWeek: cfg.SEMIFINAL_WEEK || null,
        championshipWeek: cfg.CHAMPIONSHIP_WEEK || null,
      };
  
      const leagueState = {
        league,
        users,
        rosters,
        teamsByRosterId,
        weeks,
        playoff,
      };
  
      // Rough currentWeek default: use semifinalWeek if set, else whatever Sleeper has
      leagueState.currentWeek =
        playoff.semifinalWeek ||
        safeNumber(league.settings && league.settings.matchup_week, null);
  
      return leagueState;
    }
  
    // -----------------------
    // Playoff matchups (semis / finals)
    // -----------------------
  
    /**
     * Build matchup objects for a given week.
     *
     * Works for:
     *   - Playoff weeks with winners bracket (matchup_id often null, use bracket.t1/t2).
     *   - Regular-season weeks with matchup_id pairs.
     *
     * Output shape (for each game):
     *   {
     *     id,
     *     roundLabel,
     *     bestOf,
     *     week,
     *     teamA: <teamWeekView>,
     *     teamB: <teamWeekView>
     *   }
     */
     function buildPlayoffMatchups(snapshot, config) {
        config = config || {};
        const league = snapshot.league || {};
        const users = snapshot.users || [];
        const rosters = snapshot.rosters || [];
        const matchups = snapshot.matchups || [];
        const winnersBracket =
          snapshot.winnersBracket ||
          (window.__LAST_BUNDLE__ && window.__LAST_BUNDLE__.winnersBracket) ||
          [];
  
        const teamsByRosterId = buildTeams(league, users, rosters);
        const matchupsByRosterId = indexMatchupsByRosterId(matchups);
        const playerMap =
          typeof window !== "undefined" && window.__SLEEPER_PLAYER_MAP__
            ? window.__SLEEPER_PLAYER_MAP__
            : null;
  
        const week =
          (matchups.length && safeNumber(matchups[0].week, null)) ||
          (typeof config.SEMIFINAL_WEEK === "number"
            ? config.SEMIFINAL_WEEK
            : null);
  
        const result = [];
  
        // ---------- Case 1: Winners bracket present (playoffs, often matchup_id=null) ----------
        if (Array.isArray(winnersBracket) && winnersBracket.length) {
          winnersBracket.forEach(function (g, idx) {
            if (!g || !g.t1 || !g.t2) return;
            if (!matchupsByRosterId[g.t1] || !matchupsByRosterId[g.t2]) return;
  
            const twA = buildTeamWeekView({
              teamsByRosterId: teamsByRosterId,
              rosters: rosters,
              matchupsByRosterId: matchupsByRosterId,
              rosterId: g.t1,
              week: week,
              playerMap: playerMap,
            });
            const twB = buildTeamWeekView({
              teamsByRosterId: teamsByRosterId,
              rosters: rosters,
              matchupsByRosterId: matchupsByRosterId,
              rosterId: g.t2,
              week: week,
              playerMap: playerMap,
            });
  
            if (!twA || !twB) return;
  
            var roundLabel = "Playoffs";
            if (g.r === 3) roundLabel = "Championship";
            else if (g.r === 2) roundLabel = "Semifinal";
  
            result.push({
              id:
                "playoff_" +
                (week != null ? week : "w") +
                "_m" +
                (g.m != null ? g.m : idx + 1),
              roundLabel: roundLabel,
              bestOf: 1,
              week: week,
              teamA: twA,
              teamB: twB,
            });
          });
  
          if (result.length) return result;
        }
  
        // ---------- Case 2: Regular-season style (matchup_id groups) ----------
        const groups = {};
        (matchups || []).forEach(function (m) {
          if (!m || m.matchup_id == null) return;
          const key = String(m.matchup_id);
          if (!groups[key]) groups[key] = [];
          groups[key].push(m);
        });
  
        Object.keys(groups).forEach(function (key) {
          const group = groups[key];
          if (!group || !group.length) return;
  
          const sorted = group.slice().sort(function (a, b) {
            return safeNumber(a.roster_id) - safeNumber(b.roster_id);
          });
  
          if (sorted.length < 2) return;
  
          const first = sorted[0];
          const second = sorted[1];
  
          const twA = buildTeamWeekView({
            teamsByRosterId: teamsByRosterId,
            rosters: rosters,
            matchupsByRosterId: matchupsByRosterId,
            rosterId: first.roster_id,
            week: week,
            playerMap: playerMap,
          });
          const twB = buildTeamWeekView({
            teamsByRosterId: teamsByRosterId,
            rosters: rosters,
            matchupsByRosterId: matchupsByRosterId,
            rosterId: second.roster_id,
            week: week,
            playerMap: playerMap,
          });
  
          if (!twA || !twB) return;
  
          result.push({
            id:
              "week" +
              (week != null ? week : "w") +
              "_m" +
              key,
            roundLabel: "Week " + (week != null ? week : "?"),
            bestOf: 1,
            week: week,
            teamA: twA,
            teamB: twB,
          });
        });
  
        return result;
      }
  
  
    // -----------------------
    // Generic “all matchups for a week” helper (snapshot-based)
    // -----------------------
  
    function buildAllMatchupsForWeek(snapshot, playerMap = null) {
      const league = snapshot.league || {};
      const rosters = snapshot.rosters || [];
      const matchups = snapshot.matchups || [];
      const users = snapshot.users || [];
  
      const teamsByRosterId = buildTeams(league, users, rosters);
      const matchupsByRosterId = indexMatchupsByRosterId(matchups);
  
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
        const sorted = entries.slice().sort(
          (a, b) => safeNumber(a.roster_id) - safeNumber(b.roster_id)
        );
  
        const teamViews = sorted.map((entry) =>
          buildTeamWeekView({
            teamsByRosterId,
            rosters,
            matchupsByRosterId,
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
      bootstrapFromSleeper,
      buildPlayoffMatchups,
      buildAllMatchupsForWeek,
    };
  })();
  