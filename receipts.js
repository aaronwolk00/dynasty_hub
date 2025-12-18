// receipts.js
// -----------------------------------------------------------------------------
// "Receipts" – Transaction Grades for Trades & Waivers
//
// Uses:
//   - Sleeper data bundle:  window.__LAST_BUNDLE__
//       { league, users, rosters, matchupsByWeek: { "1": [...], ... } }
//
//   - Supabase transactions table (pre-scraped via backend script):
//       Expected columns (minimal):
//         league_id    (text)
//         season       (text or int)
//         week         (int)
//         type         (text: "trade", "waiver", "free_agent", "faab_bid", etc.)
//         executed_at  (timestamp / text)
//         data         (jsonb) – raw Sleeper transaction payload
//
//   - KTC client:
//       window.KTCClient.getBestValueForSleeperId(playerId)
//
// Renders into (to be wired in index.html later):
//   <div id="tab-receipts" class="tab-panel">
//     <h2>Receipts</h2>
//     <div id="receipts-summary"></div>
//     <div id="receipts-list"></div>
//   </div>
//
// Design goals:
//   - Show who got fleeced in trades (KTC delta by side, using current values).
//   - Show waiver efficiency: FAAB spent vs points scored since acquisition.
//   - Robust to missing KTC / Supabase / bundle.
//   - No external dependencies beyond supabase-js and existing globals.
//
// ----------------------------------------------------------------------------- 

(function () {
    "use strict";
  
    // ---------------------------------------------------------------------------
    // Small utilities
    // ---------------------------------------------------------------------------
  
    const EPS = 1e-6;
  
    function safeNumber(x, fallback) {
      if (fallback === void 0) fallback = 0;
      const n = Number(x);
      return Number.isFinite(n) ? n : fallback;
    }
  
    function formatNumber(n, digits) {
      const x = safeNumber(n);
      return x.toFixed(digits != null ? digits : 1);
    }
  
    function formatPercent(n, digits) {
      const x = safeNumber(n);
      return (x * 100).toFixed(digits != null ? digits : 1) + "%";
    }
  
    function shortName(name, maxLen) {
      if (!name) return "";
      if (name.length <= maxLen) return name;
      return name.slice(0, maxLen - 1) + "…";
    }
  
    function formatDateISO(ts) {
      if (!ts) return "";
      // Accept Date, timestamp, or ISO-ish strings.
      try {
        const d =
          ts instanceof Date
            ? ts
            : typeof ts === "number"
            ? new Date(ts)
            : new Date(String(ts));
        if (isNaN(d.getTime())) return "";
        // Just date + short time for readability
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        return `${y}-${m}-${day} ${hh}:${mm}`;
      } catch (_e) {
        return "";
      }
    }
  
    function groupBy(arr, keyFn) {
      const map = new Map();
      (arr || []).forEach((item) => {
        const key = keyFn(item);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(item);
      });
      return map;
    }
  
    // ---------------------------------------------------------------------------
    // Global-ish state for this module
    // ---------------------------------------------------------------------------
  
    let receiptsSupabase = null;
    let lastBundleToken = null;
    let cachedTransactions = null;
    let isLoadingTransactions = false;
  
    // ---------------------------------------------------------------------------
    // Environment wiring: leagueId + Supabase client + KTC + bundle
    // ---------------------------------------------------------------------------
  
    function getLeagueId() {
      const cfg = window.LEAGUE_CONFIG || {};
      return (
        cfg.leagueId ||
        cfg.LEAGUE_ID ||
        cfg.sleeperLeagueId ||
        cfg.SLEEPER_LEAGUE_ID ||
        (cfg.league && (cfg.league.id || cfg.league.leagueId)) ||
        null
      );
    }
  
    function getSupabaseConfig() {
      const cfg = window.LEAGUE_CONFIG || {};
      const fromCfg = cfg.supabase || {};
      const explicit = window.SUPABASE_CONFIG || {};
  
      const url = fromCfg.url || explicit.url || null;
      const anonKey = fromCfg.anonKey || explicit.anonKey || null;
  
      if (!url || !anonKey) return null;
      return { url, anonKey };
    }
  
    function getSupabaseClient() {
      if (receiptsSupabase) return receiptsSupabase;
      if (!window.supabase || typeof window.supabase.createClient !== "function") {
        console.warn("[receipts] Supabase UMD not available (supabase.createClient).");
        return null;
      }
      const cfg = getSupabaseConfig();
      if (!cfg) {
        console.warn("[receipts] No Supabase config found (LEAGUE_CONFIG.supabase or SUPABASE_CONFIG).");
        return null;
      }
      receiptsSupabase = window.supabase.createClient(cfg.url, cfg.anonKey);
      return receiptsSupabase;
    }
  
    function isKtcAvailable() {
      return (
        window.KTCClient &&
        typeof window.KTCClient.getBestValueForSleeperId === "function"
      );
    }
  
    function getPlayerKtc(playerId) {
      if (!isKtcAvailable()) return null;
      const raw = window.KTCClient.getBestValueForSleeperId(String(playerId));
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
  
    // Bundle token so we only recompute when it changes meaningfully.
    function bundleToken(bundle) {
      if (!bundle) return null;
      const weeks = bundle.matchupsByWeek
        ? Object.keys(bundle.matchupsByWeek).length
        : 0;
      const rosters = (bundle.rosters || []).length;
      const season =
        bundle.league && bundle.league.season
          ? String(bundle.league.season)
          : "na";
      return `${season}|w${weeks}|r${rosters}`;
    }
  
    // ---------------------------------------------------------------------------
    // Data preparation from Sleeper bundle
    // ---------------------------------------------------------------------------
  
    function buildTeamNameIndex(bundle) {
      const users = bundle.users || [];
      const rosters = bundle.rosters || [];
  
      const teamByRoster = {};
  
      rosters.forEach((r) => {
        if (!r || typeof r.roster_id === "undefined") return;
        const rid = Number(r.roster_id);
        const owner = users.find((u) => u.user_id === r.owner_id) || null;
  
        const ownerName =
          (owner && (owner.display_name || owner.username)) || null;
  
        const teamNameFromMeta =
          (r.metadata && r.metadata.team_name) || r.team_name || null;
  
        const teamName =
          teamNameFromMeta ||
          (ownerName ? `${ownerName}` : `Team ${rid}`);
  
        teamByRoster[rid] = {
          rosterId: rid,
          teamName,
          ownerName: ownerName || teamName,
        };
      });
  
      return teamByRoster;
    }
  
    // Build player → { totalPoints, pointsAfterWeek[w >= N], pointsSinceWeekN }
    function buildPlayerPointsIndex(bundle) {
      const matchupsByWeek = bundle.matchupsByWeek || {};
      const index = {}; // { playerId: { total: number, perWeek: { week: pts } } }
  
      Object.keys(matchupsByWeek).forEach((wkStr) => {
        const wk = Number(wkStr);
        if (!Number.isFinite(wk)) return;
  
        const weekMatchups = matchupsByWeek[wkStr] || [];
        weekMatchups.forEach((m) => {
          const playersPoints = m.players_points || {};
          Object.entries(playersPoints).forEach(([pid, val]) => {
            const pts = safeNumber(val, 0);
            if (!index[pid]) {
              index[pid] = { total: 0, perWeek: {} };
            }
            index[pid].total += pts;
            index[pid].perWeek[wk] = (index[pid].perWeek[wk] || 0) + pts;
          });
        });
      });
  
      function getPointsSince(pid, weekInclusive) {
        const entry = index[pid];
        if (!entry) return 0;
        const perWeek = entry.perWeek || {};
        let sum = 0;
        Object.keys(perWeek).forEach((wkStr) => {
          const wk = Number(wkStr);
          if (!Number.isFinite(wk)) return;
          if (wk >= weekInclusive) {
            sum += perWeek[wk];
          }
        });
        return sum;
      }
  
      return {
        rawIndex: index,
        getPointsSince,
      };
    }
  
    // ---------------------------------------------------------------------------
    // Transactions fetching (Supabase)
    // ---------------------------------------------------------------------------
  
    async function fetchTransactionsForLeague() {
      const client = getSupabaseClient();
      if (!client) return null;
  
      const leagueId = getLeagueId();
      if (!leagueId) {
        console.warn("[receipts] No leagueId; cannot query transactions.");
        return null;
      }
  
      try {
        isLoadingTransactions = true;
  
        // Table name can be overridden via LEAGUE_CONFIG.supabase.transactionsTable
        const cfg = window.LEAGUE_CONFIG || {};
        const tableName =
          (cfg.supabase && cfg.supabase.transactionsTable) || "transactions";
  
        const { data, error } = await client
          .from(tableName)
          .select("*")
          .eq("league_id", String(leagueId))
          .order("season", { ascending: true })
          .order("week", { ascending: true })
          .order("executed_at", { ascending: true });
  
        if (error) {
          console.warn("[receipts] Supabase query error:", error);
          return null;
        }
  
        return data || [];
      } catch (err) {
        console.warn("[receipts] fetchTransactionsForLeague error:", err);
        return null;
      } finally {
        isLoadingTransactions = false;
      }
    }
  
    // ---------------------------------------------------------------------------
    // Core grading logic
    // ---------------------------------------------------------------------------
  
    function normalizeTransactionRow(row) {
      // We expect row.data to contain raw Sleeper transaction.
      const data = row.data || row.raw || row.payload || {};
      const tType = row.type || data.type || "unknown";
  
      return {
        id: row.id || data.transaction_id || `${row.season}-${row.week}-${Math.random()}`,
        leagueId: row.league_id || data.league_id || null,
        season: row.season || data.season || null,
        week: safeNumber(row.week || data.week, null),
        type: tType,
        executedAt: row.executed_at || data.status_updated || data.created || null,
        raw: data,
      };
    }
  
    function extractTradeSides(txn, teamNameIndex) {
      const raw = txn.raw || {};
      const adds = raw.adds || {};
      const drops = raw.drops || {};
      const rosterIds = raw.roster_ids || raw.consenter_ids || [];
  
      // Build per-roster "received" and "sent" sets from adds/drops.
      const sides = [];
  
      rosterIds.forEach((ridVal) => {
        const rid = Number(ridVal);
        if (!Number.isFinite(rid)) return;
  
        const received = [];
        const sent = [];
  
        Object.entries(adds).forEach(([playerId, toRoster]) => {
          if (Number(toRoster) === rid) {
            received.push(String(playerId));
          }
        });
  
        Object.entries(drops).forEach(([playerId, fromRoster]) => {
          if (Number(fromRoster) === rid) {
            sent.push(String(playerId));
          }
        });
  
        const teamInfo = teamNameIndex[rid] || {
          rosterId: rid,
          teamName: `Team ${rid}`,
          ownerName: `Team ${rid}`,
        };
  
        sides.push({
          rosterId: rid,
          teamName: teamInfo.teamName,
          ownerName: teamInfo.ownerName,
          received,
          sent,
        });
      });
  
      return sides;
    }
  
    function gradeTrade(txn, teamNameIndex) {
      const sides = extractTradeSides(txn, teamNameIndex);
      if (!sides.length) return null;
  
      const gradedSides = [];
      let totalNetSum = 0;
  
      sides.forEach((side) => {
        let ktcReceived = 0;
        let ktcSent = 0;
  
        side.received.forEach((pid) => {
          const v = getPlayerKtc(pid);
          if (v != null) ktcReceived += v;
        });
  
        side.sent.forEach((pid) => {
          const v = getPlayerKtc(pid);
          if (v != null) ktcSent += v;
        });
  
        const net = ktcReceived - ktcSent;
        totalNetSum += net;
  
        gradedSides.push({
          rosterId: side.rosterId,
          teamName: side.teamName,
          ownerName: side.ownerName,
          received: side.received,
          sent: side.sent,
          ktcReceived,
          ktcSent,
          netKtc: net,
        });
      });
  
      // If KTC is missing for all players, bail
      const hasAnyKtc = gradedSides.some(
        (s) =>
          Number.isFinite(s.ktcReceived) && s.ktcReceived > 0 ||
          Number.isFinite(s.ktcSent) && s.ktcSent > 0
      );
      if (!hasAnyKtc) return null;
  
      // Small sanity check: net across sides should be near 0.
      if (Math.abs(totalNetSum) > 0.001) {
        // It's fine; future picks or non-KTC assets may be missing.
      }
  
      return {
        kind: "trade",
        txn,
        sides: gradedSides,
      };
    }
  
    function extractWaiverMove(txn, teamNameIndex) {
      const raw = txn.raw || {};
      const adds = raw.adds || {};
      const drops = raw.drops || {};
      const rosterIds = raw.roster_ids || [];
  
      const ridRaw =
        (rosterIds && rosterIds.length && rosterIds[0]) ||
        (Object.values(adds)[0]) ||
        null;
      const rid = Number(ridRaw);
      if (!Number.isFinite(rid)) return null;
  
      const teamInfo = teamNameIndex[rid] || {
        rosterId: rid,
        teamName: `Team ${rid}`,
        ownerName: `Team ${rid}`,
      };
  
      const addedPlayers = Object.entries(adds)
        .filter(([_pid, toRid]) => Number(toRid) === rid)
        .map(([pid]) => String(pid));
  
      const droppedPlayers = Object.entries(drops)
        .filter(([_pid, fromRid]) => Number(fromRid) === rid)
        .map(([pid]) => String(pid));
  
      const faab =
        safeNumber(raw.waiver_bid) ||
        safeNumber(raw.faab) ||
        safeNumber(txn.raw.metadata && txn.raw.metadata.faab, 0);
  
      return {
        rosterId: rid,
        teamName: teamInfo.teamName,
        ownerName: teamInfo.ownerName,
        addedPlayers,
        droppedPlayers,
        faabSpent: faab,
      };
    }
  
    function gradeWaiver(txn, teamNameIndex, playerPointsIndex) {
      const move = extractWaiverMove(txn, teamNameIndex);
      if (!move || !move.addedPlayers.length) return null;
  
      const week = txn.week || safeNumber(txn.raw.week, null);
      const effectiveWeek = Number.isFinite(week) ? week : 1;
  
      let totalPoints = 0;
      const perPlayer = [];
  
      move.addedPlayers.forEach((pid) => {
        const pts = playerPointsIndex.getPointsSince(pid, effectiveWeek);
        totalPoints += pts;
        perPlayer.push({
          playerId: pid,
          pointsSince: pts,
        });
      });
  
      const faab = safeNumber(move.faabSpent, 0);
      let faabPerPoint = null;
      if (faab > 0 && totalPoints > EPS) {
        faabPerPoint = faab / totalPoints;
      } else if (faab > 0 && totalPoints <= EPS) {
        faabPerPoint = Infinity;
      }
  
      // Classification for fun
      let label = "Neutral";
      if (faab > 0) {
        if (!Number.isFinite(faabPerPoint) || faabPerPoint > 10) {
          label = "Waiver Waste";
        } else if (faabPerPoint < 2 && totalPoints >= 40) {
          label = "Smash Pickup";
        } else if (faabPerPoint < 4) {
          label = "Solid Value";
        }
      } else if (totalPoints >= 25) {
        label = "Free Gem";
      }
  
      return {
        kind: "waiver",
        txn,
        move,
        totalPoints,
        faabPerPoint,
        label,
        perPlayer,
      };
    }
  
    // ---------------------------------------------------------------------------
    // Build "receipt" objects from bundle + transactions
    // ---------------------------------------------------------------------------
  
    function computeReceipts(bundle, txRowsRaw) {
      if (!bundle || !txRowsRaw || !txRowsRaw.length) return { trades: [], waivers: [], receipts: [] };
  
      const teamNameIndex = buildTeamNameIndex(bundle);
      const playerPointsIndex = buildPlayerPointsIndex(bundle);
  
      const txns = txRowsRaw.map(normalizeTransactionRow);
  
      const tradeReceipts = [];
      const waiverReceipts = [];
      const allReceipts = [];
  
      txns.forEach((txn) => {
        const tType = (txn.type || "").toLowerCase();
  
        if (tType === "trade") {
          const graded = gradeTrade(txn, teamNameIndex);
          if (graded) {
            tradeReceipts.push(graded);
            allReceipts.push(graded);
          }
          return;
        }
  
        if (
          tType === "waiver" ||
          tType === "free_agent" ||
          tType === "faab_bid" ||
          tType === "add"
        ) {
          const graded = gradeWaiver(txn, teamNameIndex, playerPointsIndex);
          if (graded) {
            waiverReceipts.push(graded);
            allReceipts.push(graded);
          }
          return;
        }
  
        // Other types (drops, IR moves, etc.) ignored for now.
      });
  
      // Sort receipts chronologically (season, week, executedAt)
      allReceipts.sort((a, b) => {
        const sA = String(a.txn.season || "");
        const sB = String(b.txn.season || "");
        if (sA !== sB) return sA.localeCompare(sB);
  
        const wA = safeNumber(a.txn.week, 0);
        const wB = safeNumber(b.txn.week, 0);
        if (wA !== wB) return wA - wB;
  
        const tA = new Date(a.txn.executedAt || 0).getTime();
        const tB = new Date(b.txn.executedAt || 0).getTime();
        return tA - tB;
      });
  
      return {
        trades: tradeReceipts,
        waivers: waiverReceipts,
        receipts: allReceipts,
      };
    }
  
    // ---------------------------------------------------------------------------
    // Rendering
    // ---------------------------------------------------------------------------
  
    function maybeRenderLoading(message) {
      const container = document.getElementById("receipts-list");
      if (!container) return;
      container.innerHTML = `<div class="loading">${message}</div>`;
    }
  
    function renderSummary(receiptsData) {
      const summaryEl = document.getElementById("receipts-summary");
      if (!summaryEl) return;
  
      const trades = receiptsData.trades || [];
      const waivers = receiptsData.waivers || [];
  
      if (!trades.length && !waivers.length) {
        summaryEl.innerHTML =
          '<p class="small">No graded trades or waivers available yet. Once your Supabase transactions table is populated, this tab will show transaction grades, fleeces, and waiver efficiency.</p>';
        return;
      }
  
      // Trade extremes: biggest fleeces (netKtc)
      const tradeSides = [];
      trades.forEach((t) => {
        t.sides.forEach((side) => {
          tradeSides.push({
            trade: t,
            rosterId: side.rosterId,
            teamName: side.teamName,
            ownerName: side.ownerName,
            netKtc: side.netKtc,
          });
        });
      });
  
      tradeSides.sort((a, b) => b.netKtc - a.netKtc);
      const topFleece = tradeSides[0] || null;
      const worstFleece = tradeSides[tradeSides.length - 1] || null;
  
      // Waiver extremes: worst and best faabPerPoint
      const gradedWaivers = waivers.filter(
        (w) => w.move.faabSpent > 0 && Number.isFinite(w.faabPerPoint)
      );
      gradedWaivers.sort((a, b) => b.faabPerPoint - a.faabPerPoint);
      const worstWaiver = gradedWaivers[0] || null;
      const bestWaiver = gradedWaivers[gradedWaivers.length - 1] || null;
  
      let html = "";
  
      html += "<div class=\"receipts-summary-block\">";
  
      if (topFleece) {
        html += `<p><strong>Biggest Fleece (by KTC):</strong> ${topFleece.teamName} is +${formatNumber(
          topFleece.netKtc,
          0
        )} KTC in their favor on a single trade.</p>`;
      }
  
      if (worstFleece && worstFleece !== topFleece) {
        html += `<p><strong>On the Wrong End:</strong> ${worstFleece.teamName} is ${
          worstFleece.netKtc > 0 ? "+" : ""
        }${formatNumber(
          worstFleece.netKtc,
          0
        )} KTC on their worst trade (current values).</p>`;
      }
  
      if (bestWaiver) {
        html += `<p><strong>Best FAAB Value:</strong> ${bestWaiver.move.teamName} spent ${
          bestWaiver.move.faabSpent
        } FAAB for ${formatNumber(
          bestWaiver.totalPoints,
          1
        )} pts (${formatNumber(
          bestWaiver.faabPerPoint,
          2
        )} FAAB/pt).</p>`;
      }
  
      if (worstWaiver && worstWaiver !== bestWaiver) {
        html += `<p><strong>Worst FAAB Efficiency:</strong> ${worstWaiver.move.teamName} spent ${
          worstWaiver.move.faabSpent
        } FAAB for ${formatNumber(
          worstWaiver.totalPoints,
          1
        )} pts (${formatNumber(
          worstWaiver.faabPerPoint,
          2
        )} FAAB/pt).</p>`;
      }
  
      html +=
        '<p class="small">Trade grades are based on current KTC dynasty values, not past values at the time of the transaction. Waiver grades compare FAAB spent to realized fantasy points after the move.</p>';
  
      html += "</div>";
  
      summaryEl.innerHTML = html;
    }
  
    function renderReceiptCard(receipt) {
      const txn = receipt.txn;
      const season = txn.season || "";
      const week = Number.isFinite(txn.week) ? txn.week : "?";
      const ts = formatDateISO(txn.executedAt);
  
      if (receipt.kind === "trade") {
        const sidesHtml = receipt.sides
          .map((s) => {
            const sentList =
              s.sent && s.sent.length
                ? s.sent.map((pid) => shortName(pid, 12)).join(", ")
                : "None";
            const receivedList =
              s.received && s.received.length
                ? s.received.map((pid) => shortName(pid, 12)).join(", ")
                : "None";
            const netStr =
              s.netKtc > 0
                ? `+${formatNumber(s.netKtc, 0)}`
                : formatNumber(s.netKtc, 0);
  
            return `
              <div class="receipt-side">
                <div class="receipt-side-header">
                  <span class="receipt-team">${s.teamName}</span>
                  <span class="receipt-net">Net KTC: ${netStr}</span>
                </div>
                <div class="receipt-row small">
                  <span class="label">Sent:</span> <span>${sentList}</span>
                </div>
                <div class="receipt-row small">
                  <span class="label">Received:</span> <span>${receivedList}</span>
                </div>
              </div>
            `;
          })
          .join("");
  
        return `
          <article class="receipt-card">
            <header class="receipt-header">
              <div>
                <div class="receipt-tag trade">Trade</div>
                <div class="receipt-meta small">Season ${season} • Week ${week}${
          ts ? " • " + ts : ""
        }</div>
              </div>
            </header>
            <div class="receipt-body">
              ${sidesHtml}
            </div>
          </article>
        `;
      }
  
      if (receipt.kind === "waiver") {
        const m = receipt.move;
        const pts = formatNumber(receipt.totalPoints, 1);
        const faab = m.faabSpent;
        const fpp = Number.isFinite(receipt.faabPerPoint)
          ? formatNumber(receipt.faabPerPoint, 2) + " FAAB/pt"
          : faab > 0
          ? "No points yet"
          : "Free";
  
        const players = m.addedPlayers.length
          ? m.addedPlayers.map((pid) => shortName(pid, 12)).join(", ")
          : "Unknown";
  
        return `
          <article class="receipt-card">
            <header class="receipt-header">
              <div>
                <div class="receipt-tag waiver">${receipt.label}</div>
                <div class="receipt-meta small">Season ${season} • Week ${week}${
          ts ? " • " + ts : ""
        }</div>
              </div>
            </header>
            <div class="receipt-body">
              <div class="receipt-side">
                <div class="receipt-side-header">
                  <span class="receipt-team">${m.teamName}</span>
                  <span class="receipt-net">FAAB: ${faab}</span>
                </div>
                <div class="receipt-row small">
                  <span class="label">Added:</span> <span>${players}</span>
                </div>
                <div class="receipt-row small">
                  <span class="label">Points Since:</span> <span>${pts}</span>
                </div>
                <div class="receipt-row small">
                  <span class="label">Efficiency:</span> <span>${fpp}</span>
                </div>
              </div>
            </div>
          </article>
        `;
      }
  
      return "";
    }
  
    function renderReceipts(receiptsData) {
      const listEl = document.getElementById("receipts-list");
      if (!listEl) return;
  
      const receipts = receiptsData.receipts || [];
  
      if (!receipts.length) {
        listEl.innerHTML =
          '<p class="small">No graded transactions found. Once your Supabase <code>transactions</code> table has data for this league, we’ll start showing trade and waiver receipts here.</p>';
        return;
      }
  
      // Group by season, then week
      const bySeason = groupBy(receipts, (r) => r.txn.season || "Unknown");
      const seasonsSorted = Array.from(bySeason.keys()).sort((a, b) =>
        String(a).localeCompare(String(b))
      );
  
      let html = "";
  
      seasonsSorted.forEach((season) => {
        const seasonReceipts = bySeason.get(season) || [];
        const byWeek = groupBy(seasonReceipts, (r) => r.txn.week || "?");
        const weeksSorted = Array.from(byWeek.keys()).sort(
          (a, b) => safeNumber(a) - safeNumber(b)
        );
  
        html += `<section class="receipts-season-block">
          <h3 class="season-subheading">Season ${season}</h3>
        `;
  
        weeksSorted.forEach((week) => {
          const weekReceipts = byWeek.get(week) || [];
          html += `<h4 class="receipts-week-heading">Week ${week}</h4>`;
          weekReceipts.forEach((r) => {
            html += renderReceiptCard(r);
          });
        });
  
        html += `</section>`;
      });
  
      listEl.innerHTML = html;
    }
  
    // ---------------------------------------------------------------------------
    // Orchestration: load + compute + render
    // ---------------------------------------------------------------------------
  
    async function refreshFromBundleInternal(bundle) {
      const tab = document.getElementById("tab-receipts");
      if (!tab) {
        // If there is no Receipts tab in the DOM yet, silently do nothing.
        return;
      }
  
      if (!bundle) {
        maybeRenderLoading("Waiting for season data to load…");
        return;
      }
  
      const token = bundleToken(bundle);
      if (!token) {
        maybeRenderLoading("Waiting for season data to load…");
        return;
      }
  
      // Fetch transactions if we don't have them yet
      if (!cachedTransactions && !isLoadingTransactions) {
        maybeRenderLoading("Loading transactions from Supabase…");
        cachedTransactions = await fetchTransactionsForLeague();
      }
  
      if (!cachedTransactions || !cachedTransactions.length) {
        renderSummary({ trades: [], waivers: [], receipts: [] });
        renderReceipts({ trades: [], waivers: [], receipts: [] });
        return;
      }
  
      // Compute receipts using current KTC + matchups
      const receiptsData = computeReceipts(bundle, cachedTransactions);
      renderSummary(receiptsData);
      renderReceipts(receiptsData);
      lastBundleToken = token;
    }
  
    function refreshIfBundleChanged() {
      const bundle = window.__LAST_BUNDLE__;
      if (!bundle) return;
  
      const token = bundleToken(bundle);
      if (!token || token === lastBundleToken) return;
  
      // Fire async, but don't await here.
      refreshFromBundleInternal(bundle);
    }
  
    // ---------------------------------------------------------------------------
    // Bootstrap
    // ---------------------------------------------------------------------------
  
    document.addEventListener("DOMContentLoaded", () => {
      // Passive polling: whenever __LAST_BUNDLE__ changes (week select / refresh),
      // recompute receipts if the Receipts tab exists.
      setInterval(refreshIfBundleChanged, 2000);
  
      // If KTC loads later (via KTCClient.whenReady), re-run grading.
      if (window.KTCClient && typeof window.KTCClient.whenReady === "function") {
        window.KTCClient
          .whenReady()
          .then(() => {
            // Force recompute next time
            lastBundleToken = null;
            refreshIfBundleChanged();
          })
          .catch((err) => {
            console.warn("[receipts] KTCClient.whenReady error:", err);
          });
      }
    });
  
    // ---------------------------------------------------------------------------
    // Public API (optional)
    // ---------------------------------------------------------------------------
  
    window.ReceiptsApp = {
      refreshFromBundle: function (bundle) {
        return refreshFromBundleInternal(bundle || window.__LAST_BUNDLE__);
      },
    };
  })();
  