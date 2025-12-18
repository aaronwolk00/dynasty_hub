// ktc_client.js
// -----------------------------------------------------------------------------
// KTCClient – cached interface to KeepTradeCut-style dynasty values.
//
// Responsibilities:
//   • Load ALL KTC rows for this league from Supabase (with pagination).
//   • Cache by Sleeper player id for fast lookups.
//   • Expose a small, simple API:
//
//       KTCClient.whenReady() -> Promise<cache>
//       KTCClient.getBySleeperId(id) -> { ...row... } | null
//       KTCClient.getBestValueForSleeperId(id) -> number | null
//       KTCClient._debugDump() -> deep copy of cache
//
// Configuration (via window.LEAGUE_CONFIG):
//
//   LEAGUE_CONFIG.supabase = {
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
// If Supabase or config is missing, KTCClient becomes a no-op:
//   - whenReady() resolves to {}
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

  // ---------------------------------------------------------------------------
  // Config extraction
  // ---------------------------------------------------------------------------

  const globalCfg =
    (typeof window !== "undefined" && window.LEAGUE_CONFIG) || {};

  const supaCfg = globalCfg.supabase || {};
  const ktcCfg = globalCfg.ktc || {};

  const KTC_TABLE =
    supaCfg.ktcTable || ktcCfg.table || "ktc_values";

  const PAGE_SIZE =
    safeNumber(supaCfg.ktcPageSize, null) ||
    safeNumber(ktcCfg.pageSize, null) ||
    300; // default

  const MAX_PAGES =
    safeNumber(supaCfg.ktcMaxPages, null) ||
    safeNumber(ktcCfg.maxPages, null) ||
    20;

  const HAS_SUPABASE =
    typeof supabase === "object" && supabase !== null &&
    typeof supabase.from === "function";

  if (!HAS_SUPABASE) {
    console.warn(
      "[KTCClient] Supabase client not available. " +
        "Ensure supabase.js exports a configured `supabase` client."
    );
  }

  // ---------------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------------

  let cacheBySleeperId = null; // { sleeperId: { ...normalizedRow } }
  let loadPromise = null;

  // ---------------------------------------------------------------------------
  // Fetching with pagination
  // ---------------------------------------------------------------------------

  async function fetchPage(pageIndex) {
    if (!HAS_SUPABASE || !KTC_TABLE) {
      return { rows: [], done: true, totalCount: null };
    }

    const from = pageIndex * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const { data, error, count } = await supabase
      .from(KTC_TABLE)
      .select("*", { count: "exact", head: false })
      .order("ktc_rank", { ascending: true })
      .range(from, to);

    if (error) {
      console.error("[KTCClient] Supabase error:", error);
      throw error;
    }

    const rows = data || [];
    const totalCount = typeof count === "number" ? count : null;
    const done = rows.length < PAGE_SIZE;

    return { rows, done, totalCount };
  }

  async function loadAllInternal() {
    if (cacheBySleeperId) return cacheBySleeperId;

    if (!HAS_SUPABASE || !KTC_TABLE) {
      console.warn(
        "[KTCClient] Supabase or KTC table not configured. " +
          "KTC values will not be available."
      );
      cacheBySleeperId = {};
      return cacheBySleeperId;
    }

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
            (totalCountSeen != null
              ? " of ~" + totalCountSeen + ")"
              : ")")
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
    }

    const bySleeperId = {};

    allRows.forEach((row) => {
      const sid = row.sleeper_id || row.sleeperId || row.player_id || null;
      if (!sid) return;
      const key = String(sid);

      // If duplicates exist, keep the *best* (highest sf) or latest updated row
      const existing = bySleeperId[key];

      const sf =
        typeof row.sf_value === "number"
          ? row.sf_value
          : typeof row.sf === "number"
          ? row.sf
          : null;

      const oneQb =
        typeof row.one_qb_value === "number"
          ? row.one_qb_value
          : typeof row.one_qb === "number"
          ? row.one_qb
          : null;

      const rank =
        typeof row.rank === "number"
          ? row.rank
          : typeof row.overall_rank === "number"
          ? row.overall_rank
          : null;

      const updatedAt = row.updated_at || row.updated || null;

      const normalized = {
        sleeperId: key,
        playerName: row.player_name || row.name || null,
        position: row.position || null,
        team: row.team || null,
        sfValue: typeof sf === "number" ? sf : null,
        oneQbValue: typeof oneQb === "number" ? oneQb : null,
        rank: typeof rank === "number" ? rank : null,
        updatedAt,
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
        " unique Sleeper IDs into KTC cache."
    );

    return cacheBySleeperId;
  }

  // ---------------------------------------------------------------------------
  // Public-facing helpers
  // ---------------------------------------------------------------------------

  function loadAll() {
    if (loadPromise) return loadPromise;

    if (!HAS_SUPABASE || !KTC_TABLE) {
      // No-op: resolve immediately to empty cache
      loadPromise = Promise.resolve((cacheBySleeperId = {}));
      return loadPromise;
    }

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
