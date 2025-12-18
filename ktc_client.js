// ktc_client.js
// -----------------------------------------------------------------------------
// KTCClient – cached interface to KeepTradeCut-style dynasty values.
//
// Responsibilities:
//   • Load ALL KTC rows from Supabase (with pagination).
//   • Map rows to Sleeper player ids using:
//       - explicit sleeper_id column when present, OR
//       - fuzzy match on player_name + position (+ team) vs __SLEEPER_PLAYER_MAP__.
//   • Cache by Sleeper player id for fast lookups.
//   • Expose:
//
//       KTCClient.whenReady() -> Promise<cache>
//       KTCClient.loadAll() -> Promise<cache> (alias)
//       KTCClient.getBySleeperId(id) -> { ...normalizedRow } | null
//       KTCClient.getBestValueForSleeperId(id) -> number | null
//       KTCClient._debugDump() -> deep copy of cache
//
// Configuration (via window.LEAGUE_CONFIG):
//
//   LEAGUE_CONFIG.supabase = {
//     url: "https://...supabase.co",
//     anonKey: "sb_publishable_...",
//     ktcTable: "ktc_values",   // optional (fallback to LEAGUE_CONFIG.ktc.table)
//     ktcPageSize: 300,         // optional
//     ktcMaxPages: 20,          // optional
//   }
//
//   LEAGUE_CONFIG.ktc = {
//     table: "ktc_values",
//     pageSize: 300,
//     maxPages: 20,
//   }
//
// If no Supabase client is available, KTCClient becomes a no-op:
//   - whenReady()/loadAll() resolve to {}
//   - all getters return null
// -----------------------------------------------------------------------------

import { supabase } from "./supabase.js";

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Local helpers
  // ---------------------------------------------------------------------------

  function deepClone(obj) {
    if (obj == null) return obj;
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch (_e) {
      return obj;
    }
  }

  function safeNumber(x, fallback) {
    if (fallback === void 0) fallback = 0;
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
  }

  function normalizeName(str) {
    return String(str || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  
  async function waitForPlayerMapReady() {
    // If the preload script exposed a promise, use it
    const p = window.__PLAYER_MAP_READY__;
    if (p && typeof p.then === "function") {
      try {
        await p;
        return;
      } catch {
        // swallow; we'll just fall back to whatever __SLEEPER_PLAYER_MAP__ is
      }
    }
  
    // Fallback: small delay to give the preload script time to run
    await sleep(300);
  }
  

  // ---------------------------------------------------------------------------
  // Config extraction
  // ---------------------------------------------------------------------------

  const globalCfg =
    (typeof window !== "undefined" && window.LEAGUE_CONFIG) || {};

  const supaCfg = globalCfg.supabase || {};
  const ktcCfg = globalCfg.ktc || {};

  const KTC_TABLE = supaCfg.ktcTable || ktcCfg.table || "ktc_values";

  const PAGE_SIZE =
    safeNumber(supaCfg.ktcPageSize, null) ||
    safeNumber(ktcCfg.pageSize, null) ||
    300; // default

  const MAX_PAGES =
    safeNumber(supaCfg.ktcMaxPages, null) ||
    safeNumber(ktcCfg.maxPages, null) ||
    20;

  // ---------------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------------

  let cacheBySleeperId = null; // { [sleeperId]: NormalizedRow }
  let loadPromise = null;

  // ---------------------------------------------------------------------------
  // Fetching with pagination (uses shared Supabase client from supabase.js)
  // ---------------------------------------------------------------------------

  async function fetchPage(pageIndex) {
    if (!supabase) {
      return { rows: [], done: true, totalCount: null };
    }

    const from = pageIndex * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const { data, error, count } = await supabase
      .from(KTC_TABLE)
      .select("*", { count: "exact", head: false })
      .range(from, to)
      .order("ktc_rank", { ascending: true });

    if (error) {
      console.error("[KTCClient] Supabase error:", error);
      throw error;
    }

    const rows = data || [];
    const totalCount = typeof count === "number" ? count : null;
    const done = rows.length < PAGE_SIZE;

    return { rows, done, totalCount };
  }

  // ---------------------------------------------------------------------------
  // Sleeper mapping helpers – join KTC rows to Sleeper IDs
  // ---------------------------------------------------------------------------

  function buildSleeperIndex() {
    const playerMap = window.__SLEEPER_PLAYER_MAP__ || {};
    const idx = {}; // key: "normalizedName|POS" -> [ { sleeperId, team } ]

    Object.entries(playerMap).forEach(([sleeperId, meta]) => {
      const name = meta.full_name || "";
      const pos = (meta.position || "").toUpperCase();
      const team = (meta.team || "").toUpperCase();
      const keyName = normalizeName(name);
      if (!keyName || !pos) return;

      const key = keyName + "|" + pos;
      if (!idx[key]) idx[key] = [];
      idx[key].push({ sleeperId, team });
    });

    return idx;
  }

  function guessSleeperIdFromRow(row, sleeperIndex) {
    if (!sleeperIndex) return null;

    const name =
      row.player_name || row.name || row.full_name || row.player || "";
    const pos = (row.position || row.pos || "").toUpperCase();
    const team = (row.team || row.nfl_team || "").toUpperCase();

    const keyName = normalizeName(name);
    if (!keyName || !pos) return null;

    const key = keyName + "|" + pos;
    const candidates = sleeperIndex[key];
    if (!candidates || !candidates.length) return null;

    if (team) {
      const exact = candidates.find((c) => c.team === team);
      if (exact) return exact.sleeperId;
    }

    // Fallback: first candidate
    return candidates[0].sleeperId;
  }

  // ---------------------------------------------------------------------------
  // Core loader with join logic
  // ---------------------------------------------------------------------------

  async function loadAllInternal() {
    if (cacheBySleeperId) return cacheBySleeperId;

    if (!supabase) {
      console.warn(
        "[KTCClient] Supabase client is not available – KTC values disabled."
      );
      cacheBySleeperId = {};
      return cacheBySleeperId;
    }

    await waitForPlayerMapReady();

    console.log(
      "[KTCClient] Loading KTC values from Supabase table `" +
        KTC_TABLE +
        "` (pageSize=" +
        PAGE_SIZE +
        ", maxPages=" +
        MAX_PAGES +
        ")"
    );

    let page = 0;
    let allRows = [];
    let totalCountSeen = null;

    while (page < MAX_PAGES) {
      const out = await fetchPage(page);

      if (out.rows && out.rows.length) {
        allRows = allRows.concat(out.rows);
        if (out.totalCount != null && totalCountSeen == null) {
          totalCountSeen = out.totalCount;
        }
        console.log(
          "[KTCClient] Page " +
            (page + 1) +
            " fetched " +
            out.rows.length +
            " rows (running total " +
            allRows.length +
            (totalCountSeen != null ? " of ~" + totalCountSeen + ")" : ")")
        );
      } else {
        console.log(
          "[KTCClient] Page " + (page + 1) + " returned 0 rows."
        );
      }

      if (out.done) break;
      page += 1;
    }

    if (!allRows.length) {
      console.warn(
        "[KTCClient] No rows returned from `" +
          KTC_TABLE +
          "`. Check that this table exists and is populated."
      );
      cacheBySleeperId = {};
      return cacheBySleeperId;
    }

    const sample = allRows[0];
    if (sample) {
      console.log("[KTCClient] Sample KTC row keys:", Object.keys(sample));
    }

    // Build Sleeper index once (if player map exists)
    const playerMap = window.__SLEEPER_PLAYER_MAP__ || {};
    const hasPlayerMap = playerMap && Object.keys(playerMap).length > 0;
    const sleeperIndex = hasPlayerMap ? buildSleeperIndex() : null;

    if (!hasPlayerMap) {
      console.warn(
        "[KTCClient] __SLEEPER_PLAYER_MAP__ not available or empty. " +
          "Only rows with explicit Sleeper IDs will be usable."
      );
    }

    const bySleeperId = {};
    let explicitMapped = 0;
    let fuzzyMapped = 0;
    let skippedNoId = 0;

    allRows.forEach((row) => {
      // 1) Try explicit Sleeper id columns (prefer `sleeper_id`)
      let sidRaw =
        row.sleeper_id ||
        row.sleeperId ||
        row.sleeperid ||
        row.sleeper_player_id ||
        row.sleeper_playerid ||
        row.player_id ||
        row.playerId ||
        row.playerid ||
        null;

      let mappingType = null;

      if (sidRaw) {
        mappingType = "explicit";
        explicitMapped += 1;
      } else if (sleeperIndex) {
        // 2) Fallback: join by name/pos/team against Sleeper map
        const guessed = guessSleeperIdFromRow(row, sleeperIndex);
        if (guessed) {
          sidRaw = guessed;
          mappingType = "fuzzy";
          fuzzyMapped += 1;
        }
      }

      if (!sidRaw) {
        skippedNoId += 1;
        return;
      }

      const key = String(sidRaw);
      const existing = bySleeperId[key];

      // ----------------------------
      // Value extraction:
      //   • Prefer explicit SF/1QB columns if present.
      //   • Else fall back to ktc_value (from your ktc_values table).
      // ----------------------------
      const ktcVal =
        typeof row.ktc_value === "number"
          ? row.ktc_value
          : safeNumber(row.ktc_value, null);

      const sf =
        typeof row.sf_value === "number"
          ? row.sf_value
          : typeof row.sf === "number"
          ? row.sf
          : typeof row.superflex_value === "number"
          ? row.superflex_value
          : typeof ktcVal === "number"
          ? ktcVal
          : null;

      const oneQb =
        typeof row.one_qb_value === "number"
          ? row.one_qb_value
          : typeof row.one_qb === "number"
          ? row.one_qb
          : typeof row.one_qb_rank_value === "number"
          ? row.one_qb_rank_value
          : null;

      const rank =
        typeof row.rank === "number"
          ? row.rank
          : typeof row.overall_rank === "number"
          ? row.overall_rank
          : typeof row.sf_rank === "number"
          ? row.sf_rank
          : typeof row.ktc_rank === "number"
          ? row.ktc_rank
          : null;

      const updatedAt =
        row.updated_at ||
        row.updated ||
        row.last_updated ||
        row.as_of_date ||
        null;

      const normalized = {
        sleeperId: key,
        playerName: row.player_name || row.name || row.full_name || null,
        position: row.position || row.pos || null,
        team: row.team || row.nfl_team || null,
        sfValue: typeof sf === "number" ? sf : null,
        oneQbValue: typeof oneQb === "number" ? oneQb : null,
        rank: typeof rank === "number" ? rank : null,
        updatedAt,
        mappingType,
        raw: row,
      };

      if (!existing) {
        bySleeperId[key] = normalized;
        return;
      }

      // Prefer higher SF value; break ties by more recent updatedAt.
      const existingVal =
        typeof existing.sfValue === "number"
          ? existing.sfValue
          : existing.oneQbValue || 0;
      const newVal =
        typeof normalized.sfValue === "number"
          ? normalized.sfValue
          : normalized.oneQbValue || 0;

      if (newVal > existingVal + 0.0001) {
        bySleeperId[key] = normalized;
        return;
      }

      if (
        newVal === existingVal &&
        normalized.updatedAt &&
        (!existing.updatedAt ||
          new Date(normalized.updatedAt) > new Date(existing.updatedAt))
      ) {
        bySleeperId[key] = normalized;
      }
    });

    cacheBySleeperId = bySleeperId;

    console.log(
      "[KTCClient] Loaded " +
        Object.keys(cacheBySleeperId).length +
        " unique Sleeper IDs into KTC cache " +
        `(explicit=${explicitMapped}, fuzzy=${fuzzyMapped}, skipped=${skippedNoId}).`
    );

    if (!Object.keys(cacheBySleeperId).length) {
      console.warn(
        "[KTCClient] No usable KTC rows after mapping. " +
          "Check your ktc_values name/position columns, Sleeper player map, and sleeper_id population."
      );
    }

    return cacheBySleeperId;
  }

  // ---------------------------------------------------------------------------
  // Public-facing helpers
  // ---------------------------------------------------------------------------

  function loadAll() {
    if (loadPromise) return loadPromise;
    loadPromise = loadAllInternal().catch((err) => {
      console.error("[KTCClient] Failed to load KTC values:", err);
      cacheBySleeperId = {};
      return cacheBySleeperId;
    });
    return loadPromise;
  }

  function whenReady() {
    return loadAll();
  }

  function getBySleeperId(sleeperId) {
    if (!cacheBySleeperId) return null;
    const key = String(sleeperId);
    return cacheBySleeperId[key] || null;
  }

  function getBestValueForSleeperId(sleeperId) {
    const row = getBySleeperId(sleeperId);
    if (!row) return null;
    if (typeof row.sfValue === "number") return row.sfValue;
    if (typeof row.oneQbValue === "number") return row.oneQbValue;
    return null;
  }

  function debugDump() {
    return cacheBySleeperId ? deepClone(cacheBySleeperId) : {};
  }

  // ---------------------------------------------------------------------------
  // Attach to window
  // ---------------------------------------------------------------------------

  window.KTCClient = {
    whenReady,
    loadAll,
    getBySleeperId,
    getBestValueForSleeperId,
    _debugDump: debugDump,
  };
})();
