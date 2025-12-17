// team_profile.js
// -----------------------------------------------------------------------------
// Season Overview / Standings rendering.
//
// Uses the full league bundle (window.__LAST_BUNDLE__) to compute:
//   - Standings (W-L-T, PF, PA, Diff) through *last completed week*
//   - Quick "analytics snapshot" callouts
//
// Assumes bundle shape from SleeperClient.fetchLeagueBundle:
//   {
//     league,
//     users: [],
//     rosters: [],
//     matchupsByWeek: { "1": [ ... ], "2": [ ... ], ... }
//   }
// Each matchup row is a standard Sleeper matchup object:
//   - roster_id
//   - matchup_id
//   - points
//   - players_points (per-player fantasy points)
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    function findLastCompletedWeek(matchupsByWeek) {
      if (!matchupsByWeek) return null;
      const weeks = Object.keys(matchupsByWeek)
        .map((w) => Number(w))
        .filter((w) => Number.isFinite(w))
        .sort((a, b) => a - b);
      if (!weeks.length) return null;
  
      let last = null;
      for (let i = 0; i < weeks.length; i++) {
        const w = weeks[i];
        const weekMatchups = matchupsByWeek[String(w)] || [];
        if (!weekMatchups.length) continue;
  
        const hasScoring = weekMatchups.some((m) => {
          const pts = Number(m.points);
          if (Number.isFinite(pts) && pts > 0) return true;
          const pp = m.players_points || {};
          return Object.values(pp).some((v) => Number(v) > 0);
        });
  
        if (hasScoring) last = w;
      }
      return last;
    }
  
    function computeStandings(bundle) {
      const result = {
        lastCompletedWeek: null,
        teams: [],
      };
  
      if (!bundle || !bundle.rosters || !bundle.matchupsByWeek) {
        return result;
      }
  
      const { users = [], rosters = [], matchupsByWeek } = bundle;
  
      const usersById = {};
      users.forEach((u) => {
        usersById[u.user_id] = u;
      });
  
      const rostersById = {};
      rosters.forEach((r) => {
        rostersById[r.roster_id] = r;
      });
  
      function getTeamName(rosterId) {
        const r = rostersById[rosterId];
        if (!r) return "Team " + rosterId;
        const u = usersById[r.owner_id];
        return (u && u.display_name) || "Team " + rosterId;
      }
  
      const lastCompletedWeek = findLastCompletedWeek(matchupsByWeek);
      result.lastCompletedWeek = lastCompletedWeek;
  
      if (!lastCompletedWeek) {
        return result;
      }
  
      const stats = {};
      rosters.forEach((r) => {
        stats[r.roster_id] = {
          rosterId: r.roster_id,
          teamName: getTeamName(r.roster_id),
          wins: 0,
          losses: 0,
          ties: 0,
          games: 0,
          pf: 0,
          pa: 0,
        };
      });
  
      for (let w = 1; w <= lastCompletedWeek; w++) {
        const weekMatchups = matchupsByWeek[String(w)] || [];
        if (!weekMatchups.length) continue;
  
        const hasScoring = weekMatchups.some((m) => {
          const pts = Number(m.points);
          if (Number.isFinite(pts) && pts > 0) return true;
          const pp = m.players_points || {};
          return Object.values(pp).some((v) => Number(v) > 0);
        });
        if (!hasScoring) continue; // skip unplayed weeks
  
        const groups = new Map();
        weekMatchups.forEach((m) => {
          const mid = m.matchup_id != null ? m.matchup_id : "solo-" + m.roster_id + "-" + w;
          if (!groups.has(mid)) groups.set(mid, []);
          groups.get(mid).push(m);
        });
  
        groups.forEach((group) => {
          if (group.length < 2) {
            // bye or orphan – ignore for standings
            return;
          }
  
          // Assume standard 2-team matchups
          const a = group[0];
          const b = group[1];
          const aId = a.roster_id;
          const bId = b.roster_id;
          if (!stats[aId] || !stats[bId]) return;
  
          const aPts = Number(a.points) || 0;
          const bPts = Number(b.points) || 0;
  
          const sa = stats[aId];
          const sb = stats[bId];
  
          sa.pf += aPts;
          sa.pa += bPts;
          sb.pf += bPts;
          sb.pa += aPts;
  
          sa.games += 1;
          sb.games += 1;
  
          if (aPts > bPts) {
            sa.wins += 1;
            sb.losses += 1;
          } else if (bPts > aPts) {
            sb.wins += 1;
            sa.losses += 1;
          } else {
            sa.ties += 1;
            sb.ties += 1;
          }
        });
      }
  
      const teams = Object.values(stats).map((t) => {
        const totalGames = t.games || 0;
        const winPoints = t.wins + 0.5 * t.ties;
        const winPct = totalGames ? winPoints / totalGames : 0;
        const diff = t.pf - t.pa;
  
        return {
          ...t,
          winPct,
          diff,
        };
      });
  
      teams.sort((a, b) => {
        if (b.winPct !== a.winPct) return b.winPct - a.winPct;
        if (b.diff !== a.diff) return b.diff - a.diff;
        if (b.pf !== a.pf) return b.pf - a.pf;
        return a.teamName.localeCompare(b.teamName);
      });
  
      result.teams = teams;
      return result;
    }
  
    function renderStandings(standingsData) {
      const tbody = document.getElementById("season-standings-body");
      if (!tbody) return;
  
      const { teams, lastCompletedWeek } = standingsData;
  
      if (!teams || !teams.length || !lastCompletedWeek) {
        tbody.innerHTML =
          '<tr><td colspan="6" class="small">Standings will appear once at least one week has been played.</td></tr>';
        return;
      }
  
      const rows = teams
        .map((t, idx) => {
          const seed = idx + 1;
          const wl = t.wins + "-" + t.losses + (t.ties ? "-" + t.ties : "-0");
          const pf = t.pf.toFixed(1);
          const pa = t.pa.toFixed(1);
          const diff =
            (t.diff >= 0 ? "+" : "") + t.diff.toFixed(1);
  
          return (
            "<tr>" +
            "<td>" +
            seed +
            "</td>" +
            "<td>" +
            t.teamName +
            "</td>" +
            "<td>" +
            wl +
            "</td>" +
            "<td>" +
            pf +
            "</td>" +
            "<td>" +
            pa +
            "</td>" +
            "<td>" +
            diff +
            "</td>" +
            "</tr>"
          );
        })
        .join("");
  
      tbody.innerHTML = rows;
    }
  
    function renderSeasonMetrics(standingsData, bundle) {
      const container = document.getElementById("season-metrics-container");
      if (!container) return;
  
      const { teams, lastCompletedWeek } = standingsData;
      if (!teams || !teams.length || !lastCompletedWeek) {
        container.innerHTML =
          '<p class="small">Season metrics will appear here once at least one week has completed with scoring.</p>';
        return;
      }
  
      const leagueName = bundle && bundle.league && bundle.league.name;
  
      let topPF = null;
      let topDiff = null;
      let bestRecord = null;
  
      teams.forEach((t) => {
        if (!topPF || t.pf > topPF.pf) topPF = t;
        if (!topDiff || t.diff > topDiff.diff) topDiff = t;
        if (!bestRecord || t.winPct > bestRecord.winPct) bestRecord = t;
      });
  
      function fmtPct(p) {
        return (p * 100).toFixed(1) + "%";
      }
  
      const lines = [];
  
      if (leagueName) {
        lines.push(
          "<p><strong>" +
            leagueName +
            " through Week " +
            lastCompletedWeek +
            "</strong></p>"
        );
      } else {
        lines.push(
          "<p><strong>Through Week " +
            lastCompletedWeek +
            "</strong></p>"
        );
      }
  
      if (bestRecord) {
        lines.push(
          "<p>• Best record: <strong>" +
            bestRecord.teamName +
            "</strong> at " +
            fmtPct(bestRecord.winPct) +
            " (" +
            bestRecord.wins +
            "-" +
            bestRecord.losses +
            (bestRecord.ties ? "-" + bestRecord.ties : "-0") +
            ").</p>"
        );
      }
  
      if (topPF && topPF !== bestRecord) {
        lines.push(
          "<p>• Highest scoring team: <strong>" +
            topPF.teamName +
            "</strong> with " +
            topPF.pf.toFixed(1) +
            " PF.</p>"
        );
      } else if (topPF) {
        lines.push(
          "<p>• Best record & highest scoring: <strong>" +
            topPF.teamName +
            "</strong> (" +
            topPF.pf.toFixed(1) +
            " PF).</p>"
        );
      }
  
      if (topDiff) {
        lines.push(
          "<p>• Best point differential: <strong>" +
            topDiff.teamName +
            "</strong> at " +
            (topDiff.diff >= 0 ? "+" : "") +
            topDiff.diff.toFixed(1) +
            ".</p>"
        );
      }
  
      lines.push(
        '<p class="small" style="margin-top:8px;">' +
          "<strong>Legend:</strong> PF = Points For, PA = Points Against, Diff = PF - PA. " +
          "Standings ignore unplayed weeks (all-zero scores).</p>"
      );
  
      container.innerHTML = lines.join("\n");
    }
  
    function renderSeasonOverview(bundle, opts) {
      opts = opts || {};
      const standingsData = computeStandings(bundle);
      renderStandings(standingsData);
      renderSeasonMetrics(standingsData, bundle);
    }
  
    window.TeamProfile = {
      renderSeasonOverview,
    };
  })();
  