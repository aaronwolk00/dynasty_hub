// season_overview.js
// -----------------------------------------------------------------------------
// Season Overview tab renderer for your current index.html.
//
// Targets:
//   - Standings tbody:     #season-standings-body
//   - Metrics container:   #season-metrics-container
//
// Listens for:
//   - window event "playoffhub:bundle" { detail: { bundle, week } }
// Also exposes:
//   - window.SeasonOverview.renderForWeek(bundle, week)
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    function $(sel, root) {
      return (root || document).querySelector(sel);
    }
  
    function escapeHtml(str) {
      const s = String(str == null ? "" : str);
      return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }
  
    function fmt(x, d) {
      if (!Number.isFinite(x)) return "–";
      return Number(x).toFixed(d);
    }
  
    function getRosterNameMaps(rosters, users) {
      const userById = {};
      (users || []).forEach((u) => u && u.user_id && (userById[u.user_id] = u));
  
      const nameByRosterId = {};
      (rosters || []).forEach((r) => {
        const u = userById[r.owner_id];
        const metaName =
          (u && u.metadata && (u.metadata.team_name || u.metadata.team_name_update)) || "";
        const name = metaName || (u && (u.display_name || u.username)) || `Team ${r.roster_id}`;
        nameByRosterId[r.roster_id] = name;
      });
  
      return { nameByRosterId };
    }
  
    function median(nums) {
      if (!nums || !nums.length) return null;
      const s = nums.slice().sort((a, b) => a - b);
      const mid = (s.length - 1) / 2;
      if (Number.isInteger(mid)) return s[mid];
      return (s[Math.floor(mid)] + s[Math.ceil(mid)]) / 2;
    }
  
    // Detect whether a matchup week is "played"
    function weekHasPlayedScoresTeamsShape(weekMatchups) {
      return (weekMatchups || []).some((m) => {
        const teams = m && m.teams;
        if (!Array.isArray(teams)) return false;
        return teams.some((t) => Number(t?.score) > 0) ||
               teams.some((t) => {
                 const pp = t?.players_points;
                 return pp && Object.values(pp).some((v) => Number(v) > 0);
               });
      });
    }
  
    function weekHasPlayedScoresRosterShape(weekEntries) {
      return (weekEntries || []).some((e) => Number(e?.points) > 0) ||
             (weekEntries || []).some((e) => {
               const pp = e?.players_points;
               return pp && Object.values(pp).some((v) => Number(v) > 0);
             });
    }
  
    function buildSeasonSummary(bundle, currentWeek) {
      if (!bundle || !bundle.matchupsByWeek) return null;
  
      const rosters = bundle.rosters || [];
      const users = bundle.users || [];
      const { nameByRosterId } = getRosterNameMaps(rosters, users);
  
      const teams = {};
      rosters.forEach((r) => {
        teams[r.roster_id] = {
          rosterId: r.roster_id,
          name: nameByRosterId[r.roster_id] || `Team ${r.roster_id}`,
          wins: 0,
          losses: 0,
          ties: 0,
          games: 0,
          pf: 0,
          pa: 0,
          medianWins: 0,
        };
      });
  
      const matchupsByWeek = bundle.matchupsByWeek || {};
      const weeks = Object.keys(matchupsByWeek)
        .map((w) => Number(w))
        .filter((w) => Number.isFinite(w))
        .sort((a, b) => a - b);
  
      const upto = Number.isFinite(currentWeek) && currentWeek > 1 ? currentWeek - 1 : null;
      let lastPlayedWeek = null;
  
      for (const wk of weeks) {
        if (upto != null && wk > upto) continue;
  
        const raw = matchupsByWeek[String(wk)] || [];
        if (!raw.length) continue;
  
        // Two possible shapes:
        // 1) teams-shape: [{ teams:[{rosterId,score}, {rosterId,score}] }, ...]
        // 2) roster-shape: [{ roster_id, matchup_id, points }, ...]
        const isTeamsShape = raw[0] && Array.isArray(raw[0].teams);
        const isRosterShape = raw[0] && (raw[0].roster_id != null || raw[0].matchup_id != null);
  
        if (isTeamsShape) {
          if (!weekHasPlayedScoresTeamsShape(raw)) continue;
          lastPlayedWeek = wk;
  
          const scores = [];
          raw.forEach((m) => {
            (m.teams || []).forEach((t) => {
              const s = Number(t?.score);
              if (Number.isFinite(s)) scores.push(s);
            });
          });
          const med = median(scores);
          if (!Number.isFinite(med)) continue;
  
          raw.forEach((m) => {
            const a = m.teams?.[0];
            const b = m.teams?.[1];
            if (!a || !b) return;
  
            const ridA = a.rosterId ?? a.roster_id;
            const ridB = b.rosterId ?? b.roster_id;
            const ptsA = Number(a.score);
            const ptsB = Number(b.score);
  
            if (!teams[ridA] || !teams[ridB]) return;
            if (!Number.isFinite(ptsA) || !Number.isFinite(ptsB)) return;
  
            const tA = teams[ridA];
            const tB = teams[ridB];
  
            tA.pf += ptsA; tA.pa += ptsB; tA.games += 1;
            tB.pf += ptsB; tB.pa += ptsA; tB.games += 1;
  
            if (ptsA > ptsB) { tA.wins += 1; tB.losses += 1; }
            else if (ptsB > ptsA) { tB.wins += 1; tA.losses += 1; }
            else { tA.ties += 1; tB.ties += 1; }
  
            if (ptsA > med) tA.medianWins += 1;
            else if (ptsA === med) tA.medianWins += 0.5;
  
            if (ptsB > med) tB.medianWins += 1;
            else if (ptsB === med) tB.medianWins += 0.5;
          });
  
          continue;
        }
  
        if (isRosterShape) {
          if (!weekHasPlayedScoresRosterShape(raw)) continue;
          lastPlayedWeek = wk;
  
          const scores = raw
            .map((e) => Number(e.points))
            .filter((v) => Number.isFinite(v) && v > 0);
          const med = median(scores);
          if (!Number.isFinite(med)) continue;
  
          const byMatchup = {};
          raw.forEach((e) => {
            const mid = e.matchup_id;
            if (mid == null) return;
            if (!byMatchup[mid]) byMatchup[mid] = [];
            byMatchup[mid].push(e);
          });
  
          Object.values(byMatchup).forEach((pair) => {
            if (!pair || pair.length < 2) return;
            const a = pair[0];
            const b = pair[1];
  
            const ridA = a.roster_id;
            const ridB = b.roster_id;
            const ptsA = Number(a.points);
            const ptsB = Number(b.points);
  
            if (!teams[ridA] || !teams[ridB]) return;
            if (!Number.isFinite(ptsA) || !Number.isFinite(ptsB)) return;
            if (ptsA === 0 && ptsB === 0) return;
  
            const tA = teams[ridA];
            const tB = teams[ridB];
  
            tA.pf += ptsA; tA.pa += ptsB; tA.games += 1;
            tB.pf += ptsB; tB.pa += ptsA; tB.games += 1;
  
            if (ptsA > ptsB) { tA.wins += 1; tB.losses += 1; }
            else if (ptsB > ptsA) { tB.wins += 1; tA.losses += 1; }
            else { tA.ties += 1; tB.ties += 1; }
  
            if (ptsA > med) tA.medianWins += 1;
            else if (ptsA === med) tA.medianWins += 0.5;
  
            if (ptsB > med) tB.medianWins += 1;
            else if (ptsB === med) tB.medianWins += 0.5;
          });
  
          continue;
        }
      }
  
      const rows = Object.values(teams);
      rows.forEach((t) => {
        t.winPct = t.games ? (t.wins + 0.5 * t.ties) / t.games : 0;
        t.diff = t.pf - t.pa;
        t.ppg = t.games ? t.pf / t.games : 0;
        t.luck = t.wins - t.medianWins;
      });
  
      rows.sort((a, b) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        if (b.pf !== a.pf) return b.pf - a.pf;
        return a.name.localeCompare(b.name);
      });
  
      return { teams: rows, lastPlayedWeek };
    }
  
    function render(summary) {
      const tbody = document.getElementById("season-standings-body");
      const metrics = document.getElementById("season-metrics-container");
  
      if (!tbody) {
        console.warn("[SeasonOverview] Missing #season-standings-body (DOM overwritten?)");
        return;
      }
  
      if (!summary || !summary.teams || !summary.teams.length) {
        tbody.innerHTML = `
          <tr>
            <td colspan="7" class="small">Standings will populate once historical scores are available.</td>
          </tr>
        `;
        if (metrics) metrics.innerHTML = `<p class="small">No completed games yet.</p>`;
        return;
      }
  
      tbody.innerHTML = summary.teams.map((t, idx) => {
        const record = t.ties ? `${t.wins}-${t.losses}-${t.ties}` : `${t.wins}-${t.losses}`;
        return `
          <tr>
            <td>${idx + 1}</td>
            <td>${escapeHtml(t.name)}</td>
            <td>${escapeHtml(record)}</td>
            <td>${escapeHtml((t.winPct <= 1 ? t.winPct * 100 : t.winPct).toFixed(1))}%</td>
            <td>${escapeHtml(fmt(t.pf, 1))}</td>
            <td>${escapeHtml(fmt(t.pa, 1))}</td>
            <td>${t.diff >= 0 ? "+" : ""}${escapeHtml(fmt(t.diff, 1))}</td>
          </tr>
        `;
      }).join("");
  
      if (metrics) {
        const byPF = summary.teams.slice().sort((a, b) => b.pf - a.pf);
        const byDiff = summary.teams.slice().sort((a, b) => b.diff - a.diff);
        const byLuck = summary.teams.slice().sort((a, b) => b.luck - a.luck);
        const byUnluck = summary.teams.slice().sort((a, b) => a.luck - b.luck);
  
        metrics.innerHTML =
          `<p><strong>Through Week:</strong> ${summary.lastPlayedWeek ?? "—"}</p>` +
          `<p><strong>Top PF:</strong> ${escapeHtml(byPF[0].name)} (${fmt(byPF[0].pf, 1)})</p>` +
          `<p><strong>Best Diff:</strong> ${escapeHtml(byDiff[0].name)} (${byDiff[0].diff >= 0 ? "+" : ""}${fmt(byDiff[0].diff, 1)})</p>` +
          `<p><strong>Luckiest:</strong> ${escapeHtml(byLuck[0].name)} (Luck ${fmt(byLuck[0].luck, 1)})</p>` +
          `<p><strong>Unluckiest:</strong> ${escapeHtml(byUnluck[0].name)} (Luck ${fmt(byUnluck[0].luck, 1)})</p>` +
          `<p class="small">Luck = actual wins − median wins (weekly all-play median).</p>`;
      }
    }
  
    function renderForWeek(bundle, week) {
      const summary = buildSeasonSummary(bundle, week);
      render(summary);
      console.log("[SeasonOverview] Rendered", { week, lastPlayedWeek: summary?.lastPlayedWeek });
    }
  
    window.SeasonOverview = { renderForWeek };
  
    window.addEventListener("playoffhub:bundle", (e) => {
      const b = e?.detail?.bundle;
      const w = e?.detail?.week;
      if (b) renderForWeek(b, w);
    });
  })();
  