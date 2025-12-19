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
// Renders into index.html:
//
//   <section id="tab-receipts" class="tab-panel" ...>
//     <h2>Receipts</h2>
//     <div id="receipts-summary"></div>
//     <div id="receipts-list"></div>
//   </section>
//
// Design goals:
//   - Clean split between Trades and Free Agency / Waivers.
//   - Compact list rows; clicking a row opens a modal with full detail.
//   - Detail card shows what each team RECEIVED, with per-player KTC and
//     fantasy stats since the trade (points + positional rank).
//   - Draft picks show up as first-class assets and (optionally) carry KTC.
//   - Robust to missing KTC / Supabase / bundle.
// -----------------------------------------------------------------------------

import { supabase } from "./supabase.js";

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------------

  const EPS = 1e-6;

  function safeNumber(x, fallback = 0) {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
  }

  function formatFixed(n, digits = 1) {
    const x = safeNumber(n);
    return x.toFixed(digits);
  }

  function formatSignedInt(n) {
    const x = Math.round(safeNumber(n));
    if (!Number.isFinite(x)) return "0";
    const body = Math.abs(x).toLocaleString();
    return (x >= 0 ? "+" : "–") + body;
  }

  function formatDateISO(ts) {
    if (!ts) return "";
    try {
      const d =
        ts instanceof Date
          ? ts
          : typeof ts === "number"
          ? new Date(ts)
          : new Date(String(ts));
      if (isNaN(d.getTime())) return "";
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

  function shortName(name, maxLen) {
    if (!name) return "";
    if (name.length <= maxLen) return name;
    return name.slice(0, maxLen - 1) + "…";
  }

  function ordinal(nRaw) {
    const n = safeNumber(nRaw, 0);
    const v = n % 100;
    if (v >= 11 && v <= 13) return `${n}th`;
    switch (n % 10) {
      case 1:
        return `${n}st`;
      case 2:
        return `${n}nd`;
      case 3:
        return `${n}rd`;
      default:
        return `${n}th`;
    }
  }

    // ---------------------------------------------------------------------------
  // Draft pick round → KTC value (very simple model)
  // ---------------------------------------------------------------------------

  const PICK_ROUND_KTC = {
    1: 5000,
    2: 2700,
    3: 1250,
    4: 700,
    5: 500,
  };


  // ---------------------------------------------------------------------------
  // Environment wiring: config, Supabase, league id
  // ---------------------------------------------------------------------------

  const globalCfg =
    (typeof window !== "undefined" && window.LEAGUE_CONFIG) || {};
  const supaCfg = globalCfg.supabase || {};

  const HAS_SUPABASE =
    typeof supabase === "object" &&
    supabase !== null &&
    typeof supabase.from === "function";

  const TRANSACTIONS_TABLE = supaCfg.transactionsTable || "transactions";

  let lastBundleToken = null;
  let cachedTransactions = null;
  let isLoadingTransactions = false;

  // For modal lookups
  const receiptsIndexById = new Map();

  // Detail dialog elements
  let detailDialog = null;
  let detailDialogTitle = null;
  let detailDialogBody = null;

  function getLeagueId() {
    const cfg = globalCfg || {};
    return (
      cfg.leagueId ||
      cfg.LEAGUE_ID ||
      cfg.sleeperLeagueId ||
      cfg.SLEEPER_LEAGUE_ID ||
      (cfg.league && (cfg.league.id || cfg.league.leagueId)) ||
      null
    );
  }

  // ---------------------------------------------------------------------------
  // Sleeper player meta helpers (names / positions / teams)
  // ---------------------------------------------------------------------------

  function getSleeperPlayerMeta(playerId) {
    const id = String(playerId);
    const map =
      (typeof window !== "undefined" && window.__SLEEPER_PLAYER_MAP__) || {};
    return map[id] || {};
  }

  function getPlayerName(playerId) {
    const meta = getSleeperPlayerMeta(playerId);
    const name =
      meta.full_name ||
      ((meta.first_name || "") + " " + (meta.last_name || "")).trim();
    return name || String(playerId);
  }

  function getPlayerPos(playerId) {
    const meta = getSleeperPlayerMeta(playerId);
    return meta.position || "";
  }

  function getPlayerTeamAbbr(playerId) {
    const meta = getSleeperPlayerMeta(playerId);
    return meta.team || meta.team_abbr || meta.team_id || "";
  }

  function getPlayerLabel(playerId) {
    const name = getPlayerName(playerId);
    const pos = getPlayerPos(playerId);
    return pos ? `${pos} ${name}` : name;
  }

  function formatPlayerList(ids) {
    if (!ids || !ids.length) return "None";
    return ids.map((pid) => getPlayerLabel(pid)).join(", ");
  }

  // ---------------------------------------------------------------------------
  // KTC helpers (players + draft picks)
  // ---------------------------------------------------------------------------

  function isKtcAvailable() {
    return (
      typeof window !== "undefined" &&
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

  function getDraftPickKtc(pick) {
    if (!pick) return null;
    const round =
      safeNumber(pick.round ?? pick.draft_round ?? pick.draft_round_start, NaN);
    if (!Number.isFinite(round)) return null;

    const ktc = PICK_ROUND_KTC[round];
    return typeof ktc === "number" ? ktc : null;
  }


  function describeDraftPick(pick, teamNameIndex) {
    const season = pick.season || pick.draft_season || "????";
    const round = ordinal(pick.round || pick.draft_round || "?");
    const ownerRid = safeNumber(
      pick.roster_id || pick.owner_id || pick.previous_owner_id,
      null
    );
    const owner =
      (Number.isFinite(ownerRid) &&
        teamNameIndex[ownerRid] &&
        teamNameIndex[ownerRid].teamName) ||
      (Number.isFinite(ownerRid) ? `Roster ${ownerRid}` : "Unknown team");

    return `${season} ${round} (${owner})`;
  }

  // ---------------------------------------------------------------------------
  // Bundle token / basic indices
  // ---------------------------------------------------------------------------

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
        teamNameFromMeta || (ownerName ? `${ownerName}` : `Team ${rid}`);

      teamByRoster[rid] = {
        rosterId: rid,
        teamName,
        ownerName: ownerName || teamName,
      };
    });

    return teamByRoster;
  }

  // Build player → { total, perWeek }, plus helper getPointsSince(startWeek)
  function buildPlayerPointsIndex(bundle) {
    const matchupsByWeek = bundle.matchupsByWeek || {};
    const index = {};

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
          index[pid].perWeek[wk] =
            (index[pid].perWeek[wk] || 0) + pts;
        });
      });
    });

    function getPointsSince(pid, startWeekInclusive) {
      const entry = index[pid];
      if (!entry) return 0;
      const perWeek = entry.perWeek || {};
      let sum = 0;
      Object.keys(perWeek).forEach((wkStr) => {
        const wk = Number(wkStr);
        if (!Number.isFinite(wk)) return;
        if (wk >= startWeekInclusive) {
          sum += perWeek[wk];
        }
      });
      return sum;
    }

    function getAllPlayerIds() {
      return Object.keys(index);
    }

    return {
      rawIndex: index,
      getPointsSince,
      getAllPlayerIds,
    };
  }

  // Build a cache of positional ranks for any "start week":
  //   rankCache.getRanks(startWeek) -> Map(playerId -> { pos, rank, points })
  function buildPosRankCache(playerPointsIndex) {
    const cache = new Map();

    function getRanks(startWeek) {
      if (cache.has(startWeek)) return cache.get(startWeek);

      const allIds = playerPointsIndex.getAllPlayerIds();
      const buckets = new Map(); // pos -> [{ playerId, points }]

      allIds.forEach((pid) => {
        const pos = getPlayerPos(pid);
        if (!pos) return;
        const pts = playerPointsIndex.getPointsSince(pid, startWeek);
        if (pts <= 0) return;

        if (!buckets.has(pos)) buckets.set(pos, []);
        buckets.get(pos).push({ playerId: pid, points: pts });
      });

      const rankMap = new Map();

      buckets.forEach((arr, pos) => {
        arr.sort((a, b) => b.points - a.points);
        arr.forEach((row, idx) => {
          rankMap.set(row.playerId, {
            pos,
            rank: idx + 1,
            points: row.points,
          });
        });
      });

      cache.set(startWeek, rankMap);
      return rankMap;
    }

    return {
      getRanks,
    };
  }

  // ---------------------------------------------------------------------------
  // Transactions fetching (Supabase)
  // ---------------------------------------------------------------------------

  async function fetchTransactionsForLeague() {
    if (!HAS_SUPABASE) {
      console.warn(
        "[receipts] Supabase client not available. Ensure supabase.js exports a configured `supabase` client."
      );
      return null;
    }

    const leagueId = getLeagueId();
    if (!leagueId) {
      console.warn("[receipts] No leagueId; cannot query transactions.");
      return null;
    }

    try {
      isLoadingTransactions = true;

      const { data, error } = await supabase
        .from(TRANSACTIONS_TABLE)
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
    const data = row.data || row.raw || row.payload || {};
    const tType = row.type || data.type || "unknown";

    return {
      id:
        row.id ||
        data.transaction_id ||
        `${row.season}-${row.week}-${Math.random()}`,
      leagueId: row.league_id || data.league_id || null,
      season: row.season || data.season || null,
      week: safeNumber(row.week || data.week, null),
      type: tType,
      executedAt:
        row.executed_at || data.status_updated || data.created || null,
      raw: data,
    };
  }

  // Pull out players + picks received/sent by each roster
  function extractTradeSides(txn, teamNameIndex) {
    const raw = txn.raw || {};
    const adds = raw.adds || {};
    const drops = raw.drops || {};
    const draftPicks = raw.draft_picks || [];

    const rosterIds = raw.roster_ids || raw.consenter_ids || [];

    const sides = [];

    rosterIds.forEach((ridVal) => {
      const rid = Number(ridVal);
      if (!Number.isFinite(rid)) return;

      const receivedPlayers = [];
      const sentPlayers = [];
      const receivedPicks = [];
      const sentPicks = [];

      // Players
      Object.entries(adds).forEach(([playerId, toRoster]) => {
        if (Number(toRoster) === rid) {
          receivedPlayers.push(String(playerId));
        }
      });

      Object.entries(drops).forEach(([playerId, fromRoster]) => {
        if (Number(fromRoster) === rid) {
          sentPlayers.push(String(playerId));
        }
      });

      // Draft picks
      draftPicks.forEach((pick) => {
        const currentRid = safeNumber(pick.roster_id || pick.owner_id, null);
        const prevRid = safeNumber(
          pick.previous_owner_id != null
            ? pick.previous_owner_id
            : pick.owner_id,
          null
        );
        if (!Number.isFinite(currentRid) || !Number.isFinite(prevRid)) return;
        if (currentRid === prevRid) return;

        if (currentRid === rid) {
          receivedPicks.push(pick);
        }
        if (prevRid === rid) {
          sentPicks.push(pick);
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
        receivedPlayers,
        sentPlayers,
        receivedPicks,
        sentPicks,
      });
    });

    return sides;
  }

  function gradeTrade(txn, teamNameIndex) {
    const sidesRaw = extractTradeSides(txn, teamNameIndex);
    if (!sidesRaw.length) return null;

    const gradedSides = [];
    let hasAnyKtc = false;

    sidesRaw.forEach((sideRaw) => {
      let ktcReceived = 0;
      let ktcSent = 0;

      const receivedAssets = [];
      const sentAssets = [];

      // Players – received
      sideRaw.receivedPlayers.forEach((pid) => {
        const playerId = String(pid);
        const ktc = getPlayerKtc(playerId);
        if (ktc != null) {
          ktcReceived += ktc;
          hasAnyKtc = true;
        }

        receivedAssets.push({
          kind: "player",
          playerId,
          name: getPlayerName(playerId),
          pos: getPlayerPos(playerId),
          teamAbbr: getPlayerTeamAbbr(playerId),
          ktc,
          pointsSince: null, // filled later
          posRankSince: null, // filled later
        });
      });

      // Players – sent
      sideRaw.sentPlayers.forEach((pid) => {
        const playerId = String(pid);
        const ktc = getPlayerKtc(playerId);
        if (ktc != null) {
          ktcSent += ktc;
          hasAnyKtc = true;
        }

        sentAssets.push({
          kind: "player",
          playerId,
          name: getPlayerName(playerId),
          pos: getPlayerPos(playerId),
          teamAbbr: getPlayerTeamAbbr(playerId),
          ktc,
          pointsSince: null,
          posRankSince: null,
        });
      });

      // Picks – received
      sideRaw.receivedPicks.forEach((pick) => {
        const label = describeDraftPick(pick, teamNameIndex);
        const ktc = getDraftPickKtc(pick);
        if (ktc != null) {
          ktcReceived += ktc;
          hasAnyKtc = true;
        }

        receivedAssets.push({
          kind: "pick",
          pick,
          label,
          ktc,
        });
      });

      // Picks – sent
      sideRaw.sentPicks.forEach((pick) => {
        const label = describeDraftPick(pick, teamNameIndex);
        const ktc = getDraftPickKtc(pick);
        if (ktc != null) {
          ktcSent += ktc;
          hasAnyKtc = true;
        }

        sentAssets.push({
          kind: "pick",
          pick,
          label,
          ktc,
        });
      });

      const netKtc = ktcReceived - ktcSent;

      gradedSides.push({
        rosterId: sideRaw.rosterId,
        teamName: sideRaw.teamName,
        ownerName: sideRaw.ownerName,
        ktcReceived,
        ktcSent,
        netKtc,
        receivedAssets,
        sentAssets,
      });
    });

    if (!hasAnyKtc) return null;

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

    const droppedPlayers = Object.entries(drops || {})
      .filter(([_pid, fromRid]) => Number(fromRid) === rid)
      .map(([pid]) => String(pid));

    const faab =
      safeNumber(raw.waiver_bid) ||
      safeNumber(raw.faab) ||
      safeNumber(raw.metadata && raw.metadata.faab, 0);

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

    const week = txn.week || safeNumber(txn.raw && txn.raw.week, null);
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

  // Attach fantasy points + positional rank since trade for each RECEIVED player
  function decorateTradesWithStats(trades, playerPointsIndex) {
    if (!trades.length) return;

    const rankCache = buildPosRankCache(playerPointsIndex);

    trades.forEach((trade) => {
      const txnWeek = safeNumber(trade.txn.week, 0);
      const startWeek = Number.isFinite(txnWeek) && txnWeek > 0 ? txnWeek + 1 : 1;
      const ranksForWindow = rankCache.getRanks(startWeek);

      trade.sides.forEach((side) => {
        side.receivedAssets.forEach((asset) => {
          if (asset.kind !== "player") return;

          const pid = asset.playerId;
          const pts = playerPointsIndex.getPointsSince(pid, startWeek);
          asset.pointsSince = pts;

          const rankEntry = ranksForWindow.get(pid) || null;
          asset.posRankSince = rankEntry ? rankEntry.rank : null;
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Build "receipt" objects from bundle + transactions
  // ---------------------------------------------------------------------------

  function computeReceipts(bundle, txRowsRaw) {
    if (!bundle || !txRowsRaw || !txRowsRaw.length) {
      return { trades: [], waivers: [], receipts: [] };
    }

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

      // commissioner moves, drops-only, etc. ignored for grading.
    });

    // Attach fantasy stats for trade players (received side only)
    decorateTradesWithStats(tradeReceipts, playerPointsIndex);

    // Sort all receipts chronologically
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
  // Rendering helpers + modal
  // ---------------------------------------------------------------------------

  function maybeRenderLoading(message) {
    const container = document.getElementById("receipts-list");
    if (!container) return;
    container.innerHTML = `<div class="loading">${message}</div>`;
  }

  function ensureDetailDialog() {
    if (detailDialog) return;

    detailDialog = document.createElement("dialog");
    detailDialog.id = "receipts-detail-dialog";
    detailDialog.className = "summary-dialog receipts-dialog";

    detailDialog.innerHTML = `
      <form method="dialog" class="summary-dialog-inner receipts-dialog-inner">
        <header class="summary-dialog-header receipts-dialog-header">
          <div>
            <div class="kicker">Transaction Detail</div>
            <div id="receipts-detail-title" class="summary-title">—</div>
          </div>
          <button type="submit" class="ghost-btn">Close</button>
        </header>
        <div id="receipts-detail-body" class="summary-dialog-body small"></div>
      </form>
    `;

    document.body.appendChild(detailDialog);
    detailDialogTitle = detailDialog.querySelector("#receipts-detail-title");
    detailDialogBody = detailDialog.querySelector("#receipts-detail-body");

    // backdrop close
    detailDialog.addEventListener("click", (e) => {
      const rect = detailDialog.getBoundingClientRect();
      const inDialog =
        rect.top <= e.clientY &&
        e.clientY <= rect.top + rect.height &&
        rect.left <= e.clientX &&
        e.clientX <= rect.left + rect.width;
      if (!inDialog) {
        try {
          detailDialog.close();
        } catch (_) {}
      }
    });
  }

  function openReceiptDetail(receipt) {
    if (!receipt) return;
    ensureDetailDialog();

    const txn = receipt.txn || {};
    const season = txn.season || "";
    const week = Number.isFinite(txn.week) ? txn.week : "?";
    const ts = formatDateISO(txn.executedAt);

    let title = "";
    if (receipt.kind === "trade") {
      const teams = Array.from(
        new Set((receipt.sides || []).map((s) => s.teamName))
      );
      title = `Trade – ${teams.join(" ↔ ")}`;
    } else if (receipt.kind === "waiver") {
      title = `${receipt.label} – ${receipt.move.teamName}`;
    } else {
      title = "Transaction";
    }

    const metaPieces = [`Season ${season}`, `Week ${week}`];
    if (ts) metaPieces.push(ts);
    const metaLine = metaPieces.join(" • ");

    detailDialogTitle.textContent = title;
    detailDialogBody.innerHTML =
      receipt.kind === "trade"
        ? renderTradeDetailCard(receipt, metaLine)
        : renderWaiverDetailCard(receipt, metaLine);

    if (typeof detailDialog.showModal === "function") {
      detailDialog.showModal();
    }
  }

  // ---- Trade detail card: two columns, only "Received" for each team ----

  function renderTradeDetailCard(receipt, metaLine) {
    const sidesHtml = (receipt.sides || [])
      .map((s) => renderTradeSideDetail(s))
      .join("");

    return `
      <article class="receipt-card receipt-card--detail">
        <header class="receipt-header">
          <div>
            <div class="receipt-tag trade">Trade</div>
            <div class="receipt-meta small">${metaLine}</div>
          </div>
        </header>
        <div class="receipt-body receipt-body--two-col">
          ${sidesHtml}
        </div>
      </article>
    `;
  }

  function renderTradeSideDetail(side) {
    const netStr = formatSignedInt(side.netKtc);

    // Gave up summary (names only)
    const gaveUpNames = side.sentAssets
      .filter((a) => a.kind === "player")
      .map((a) => a.name);
    const gaveUpLine = gaveUpNames.length
      ? gaveUpNames.join(", ")
      : "No outgoing assets recorded.";

    const receivedMarkup = side.receivedAssets
      .map((asset) => renderReceivedAssetRow(asset))
      .join("");

    return `
      <section class="receipt-side">
        <header class="receipt-side-header">
          <span class="receipt-team">${side.teamName}</span>
          <span class="receipt-net small">Net KTC: <strong>${netStr}</strong></span>
        </header>

        <div class="receipt-row small">
          <span class="label">Received</span>
        </div>

        <div class="receipt-assets">
          ${receivedMarkup || `<div class="small muted">No incoming assets recorded.</div>`}
        </div>

        <div class="receipt-gaveup small">
          Gave up: <span>${gaveUpLine}</span>
        </div>
      </section>
    `;
  }

  function renderReceivedAssetRow(asset) {
    if (asset.kind === "player") {
      const statsBits = [];

      if (typeof asset.pointsSince === "number" && asset.pointsSince > 0) {
        statsBits.push(`${asset.pointsSince.toFixed(1)} pts since`);
      }

      if (typeof asset.posRankSince === "number") {
        statsBits.push(`${asset.pos}${asset.posRankSince}`);
      }

      const statsText = statsBits.join(" • ");

      const teamLine = [
        asset.pos || "",
        asset.teamAbbr || "",
      ]
        .filter(Boolean)
        .join(" • ");

      const ktcText =
        asset.ktc != null ? `${Math.round(asset.ktc).toLocaleString()} KTC` : "—";

      return `
        <div class="receipt-asset">
          <div class="receipt-asset-main">
            <div class="receipt-asset-name">${asset.name}</div>
            <div class="receipt-asset-sub small">${teamLine}</div>
          </div>
          <div class="receipt-asset-meta">
            <div class="receipt-asset-ktc">${ktcText}</div>
            ${
              statsText
                ? `<div class="receipt-asset-stat small">${statsText}</div>`
                : ""
            }
          </div>
        </div>
      `;
    }

    if (asset.kind === "pick") {
      const ktcText =
        asset.ktc != null ? `${Math.round(asset.ktc).toLocaleString()} KTC` : "—";

      return `
        <div class="receipt-asset">
          <div class="receipt-asset-main">
            <div class="receipt-asset-name">${asset.label}</div>
            <div class="receipt-asset-sub small">Draft pick</div>
          </div>
          <div class="receipt-asset-meta">
            <div class="receipt-asset-ktc">${ktcText}</div>
          </div>
        </div>
      `;
    }

    return "";
  }

  // ---- Waiver detail card (same as before, just split into its own fn) ----

  function renderWaiverDetailCard(receipt, metaLine) {
    const m = receipt.move;
    const pts = formatFixed(receipt.totalPoints, 1);
    const faab = m.faabSpent;
    const fpp = Number.isFinite(receipt.faabPerPoint)
      ? formatFixed(receipt.faabPerPoint, 2) + " FAAB/pt"
      : faab > 0
      ? "No points yet"
      : "Free";

    const players = m.addedPlayers.length
      ? formatPlayerList(m.addedPlayers)
      : "Unknown";

    return `
      <article class="receipt-card receipt-card--detail">
        <header class="receipt-header">
          <div>
            <div class="receipt-tag waiver">${receipt.label}</div>
            <div class="receipt-meta small">${metaLine}</div>
          </div>
        </header>
        <div class="receipt-body">
          <div class="receipt-side">
            <div class="receipt-side-header">
              <span class="receipt-team">${m.teamName}</span>
              <span class="receipt-net">FAAB: ${faab}</span>
            </div>
            <div class="receipt-row small">
              <span class="label">Added:</span>
              <span>${players}</span>
            </div>
            <div class="receipt-row small">
              <span class="label">Points Since:</span>
              <span>${pts}</span>
            </div>
            <div class="receipt-row small">
              <span class="label">Efficiency:</span>
              <span>${fpp}</span>
            </div>
          </div>
        </div>
      </article>
    `;
  }

  // ---------------------------------------------------------------------------
  // Summary strip at the top of the tab
  // ---------------------------------------------------------------------------

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

    const gradedWaivers = waivers.filter(
      (w) => w.move.faabSpent > 0 && Number.isFinite(w.faabPerPoint)
    );
    gradedWaivers.sort((a, b) => b.faabPerPoint - a.faabPerPoint);
    const worstWaiver = gradedWaivers[0] || null;
    const bestWaiver =
      gradedWaivers[gradedWaivers.length - 1] || null;

    let html = "";
    html += '<div class="receipts-summary-block">';

    if (topFleece) {
      html += `<p><strong>Biggest Fleece (by KTC):</strong> ${
        topFleece.teamName
      } is ${formatSignedInt(
        topFleece.netKtc
      )} KTC in their favor on a single trade.</p>`;
    }

    if (worstFleece && worstFleece !== topFleece) {
      html += `<p><strong>On the Wrong End:</strong> ${
        worstFleece.teamName
      } is ${formatSignedInt(
        worstFleece.netKtc
      )} KTC on their worst trade (current values).</p>`;
    }

    if (bestWaiver) {
      html += `<p><strong>Best FAAB Value:</strong> ${
        bestWaiver.move.teamName
      } spent ${bestWaiver.move.faabSpent} FAAB for ${formatFixed(
        bestWaiver.totalPoints,
        1
      )} pts (${formatFixed(
        bestWaiver.faabPerPoint,
        2
      )} FAAB/pt).</p>`;
    }

    if (worstWaiver && worstWaiver !== bestWaiver) {
      html += `<p><strong>Worst FAAB Efficiency:</strong> ${
        worstWaiver.move.teamName
      } spent ${worstWaiver.move.faabSpent} FAAB for ${formatFixed(
        worstWaiver.totalPoints,
        1
      )} pts (${formatFixed(
        worstWaiver.faabPerPoint,
        2
      )} FAAB/pt).</p>`;
    }

    html +=
      '<p class="small">Trade grades are based on current KTC dynasty values, not past values at the time of the transaction. Waiver grades compare FAAB spent to realized fantasy points after the move.</p>';

    html += "</div>";

    summaryEl.innerHTML = html;
  }

  // ---------------------------------------------------------------------------
  // List layout: Trades + Free Agency sections
  // ---------------------------------------------------------------------------

  function indexReceiptsForModal(receiptsData) {
    receiptsIndexById.clear();
    (receiptsData.receipts || []).forEach((r) => {
      const id = r.txn && r.txn.id;
      if (id) receiptsIndexById.set(String(id), r);
    });
  }

  function renderTradeList(trades) {
    if (!trades.length) {
      return '<p class="small">No trades recorded yet.</p>';
    }

    const sorted = [...trades].sort((a, b) => {
      const tA = new Date(a.txn.executedAt || 0).getTime();
      const tB = new Date(b.txn.executedAt || 0).getTime();
      return tB - tA; // newest first
    });

    const rows = sorted
      .map((t) => {
        const txn = t.txn || {};
        const id = String(txn.id);
        const week = Number.isFinite(txn.week) ? txn.week : "?";
        const ts = formatDateISO(txn.executedAt);
        const teams = Array.from(
          new Set((t.sides || []).map((s) => s.teamName))
        );
        const label = teams.join(" ↔ ");

        const bestSide =
          (t.sides || []).reduce(
            (best, s) => (best == null || s.netKtc > best.netKtc ? s : best),
            null
          ) || null;

        const bestDelta =
          bestSide && Number.isFinite(bestSide.netKtc)
            ? formatSignedInt(bestSide.netKtc)
            : null;

        const metaPieces = [`Week ${week}`];
        if (ts) metaPieces.push(ts);
        const meta = metaPieces.join(" • ");

        const badgeText = bestDelta
          ? `${shortName(bestSide.teamName, 14)} ${bestDelta}`
          : "View";

        return `
          <button
            type="button"
            class="receipts-row receipts-row--trade"
            data-receipt-id="${id}"
          >
            <div class="receipts-row-main">
              <div class="receipts-row-title">${label}</div>
              <div class="receipts-row-meta small">${meta}</div>
            </div>
            <div class="receipts-row-badge small">
              ${badgeText}
            </div>
          </button>
        `;
      })
      .join("");

    return `
      <div class="receipts-section-body receipts-section-body--trades">
        ${rows}
      </div>
    `;
  }

  function renderWaiverList(waivers) {
    if (!waivers.length) {
      return '<p class="small">No free agency or waiver pickups graded yet.</p>';
    }

    const sorted = [...waivers].sort((a, b) => {
      const tA = new Date(a.txn.executedAt || 0).getTime();
      const tB = new Date(b.txn.executedAt || 0).getTime();
      return tB - tA; // newest first
    });

    const rows = sorted
      .map((w) => {
        const txn = w.txn || {};
        const id = String(txn.id);
        const week = Number.isFinite(txn.week) ? txn.week : "?";
        const ts = formatDateISO(txn.executedAt);

        const m = w.move;
        const primary =
          m.addedPlayers && m.addedPlayers.length
            ? getPlayerLabel(m.addedPlayers[0])
            : "Player";
        const extraCount = (m.addedPlayers || []).length - 1;
        const playerLabel =
          extraCount > 0 ? `${primary} +${extraCount}` : primary;

        const metaPieces = [`Week ${week}`];
        if (ts) metaPieces.push(ts);
        const meta = metaPieces.join(" • ");

        const pts = formatFixed(w.totalPoints, 1);
        const faab = m.faabSpent;
        const rightLabel =
          faab > 0
            ? `${faab} FAAB → ${pts} pts`
            : `${pts} pts`;

        return `
          <button
            type="button"
            class="receipts-row receipts-row--waiver"
            data-receipt-id="${id}"
          >
            <div class="receipts-row-main">
              <div class="receipts-row-title">${m.teamName}</div>
              <div class="receipts-row-meta small">
                ${playerLabel} • ${meta}
              </div>
            </div>
            <div class="receipts-row-badge small">
              <span class="receipts-row-label">${w.label}</span>
              <span class="receipts-row-stat">${rightLabel}</span>
            </div>
          </button>
        `;
      })
      .join("");

    return `
      <div class="receipts-section-body receipts-section-body--waivers">
        ${rows}
      </div>
    `;
  }

  function renderReceipts(receiptsData) {
    const listEl = document.getElementById("receipts-list");
    if (!listEl) return;

    const trades = receiptsData.trades || [];
    const waivers = receiptsData.waivers || [];

    indexReceiptsForModal(receiptsData);

    if (!trades.length && !waivers.length) {
      listEl.innerHTML =
        '<p class="small">No graded transactions found. Once your Supabase <code>transactions</code> table has data for this league, we’ll start showing trade and waiver receipts here.</p>';
      return;
    }

    let html = "";
    html += `<div class="receipts-columns">`;

    html += `
      <section class="receipts-section receipts-section--trades">
        <h3 class="season-subheading">Trades</h3>
        <p class="small" style="margin-bottom:8px;">
          Ranked by most recent. Click a row to see the full breakdown, KTC deltas, and per-player results since the trade.
        </p>
        ${renderTradeList(trades)}
      </section>
    `;

    html += `
      <section class="receipts-section receipts-section--waivers">
        <h3 class="season-subheading">Free Agency & Waivers</h3>
        <p class="small" style="margin-bottom:8px;">
          FAAB efficiency and free-gem pickups since each move was made.
        </p>
        ${renderWaiverList(waivers)}
      </section>
    `;

    html += `</div>`;

    listEl.innerHTML = html;

    // Row click handler (single delegated listener)
    listEl.onclick = function (e) {
      const btn = e.target.closest("[data-receipt-id]");
      if (!btn) return;
      const id = btn.getAttribute("data-receipt-id");
      const receipt = receiptsIndexById.get(String(id));
      if (receipt) {
        openReceiptDetail(receipt);
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Orchestration: load + compute + render
  // ---------------------------------------------------------------------------

  async function refreshFromBundleInternal(bundle) {
    const tab = document.getElementById("tab-receipts");
    if (!tab) {
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

    if (!cachedTransactions && !isLoadingTransactions) {
      maybeRenderLoading("Loading transactions from Supabase…");
      cachedTransactions = await fetchTransactionsForLeague();
    }

    if (!cachedTransactions || !cachedTransactions.length) {
      renderSummary({ trades: [], waivers: [], receipts: [] });
      renderReceipts({ trades: [], waivers: [], receipts: [] });
      return;
    }

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
    if (
      window.KTCClient &&
      typeof window.KTCClient.whenReady === "function"
    ) {
      window.KTCClient
        .whenReady()
        .then(() => {
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
      return refreshFromBundleInternal(
        bundle || window.__LAST_BUNDLE__
      );
    },
  };
})();
