// ktc_client.js
// -----------------------------------------------------------------------------
// KTCClient – cached interface to KeepTradeCut-style dynasty values.
//
// Responsibilities:
//   • Load ALL KTC rows from Supabase (with pagination).
//   • Build a "Rosetta Stone" mapping from Sleeper player ids → KTC values
//       using:
//         - explicit sleeper_id in ktc_values when present, OR
//         - fuzzy match on normalized(player_name) + normalized(position)
//           against window.__SLEEPER_PLAYER_MAP__.
//   • Cache by Sleeper player id for fast lookups.
//   • Expose:
//
//       KTCClient.whenReady() -> Promise<cache>
//       KTCClient.loadAll() -> Promise<cache> (alias)
//       KTCClient.getBySleeperId(id) -> { sleeperId, value, ... } | null
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
// This implementation assumes a table shaped roughly like:
//
//   ktc_values(
//     id                bigserial,
//     ktc_player_id     text,
//     player_name       text,
//     position          text,   -- e.g. 'QB1', 'WR5', 'RB2', 'TE1', ...
//     nfl_team          text,
//     format            text,
//     ktc_rank          integer,
//     ktc_value         numeric,
//     as_of_date        date,
//     inserted_at       timestamptz,
//     sleeper_id        text,
//     sleeper_match_confidence numeric,
//     sleeper_player_id text
//   );
//
// If no Supabase client is available, KTCClient becomes a no-op.
// -----------------------------------------------------------------------------

import { supabase } from "./supabase.js";

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Small helpers
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
    if (fallback === void 0) fallback = null;
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
  }

  // "Secret sauce" name normalizer:
  // - lowercase
  // - strip non-alphanumerics
  // - drop suffixes (III, II, Jr, Sr)
  // - handle a few common nickname stems
  function normalizeName(name) {
    if (!name) return "";
    let s = String(name).toLowerCase();
    s = s.replace(/[^a-z0-9]/g, ""); // remove spaces, dots, apostrophes, hyphens
    s = s.replace(/iii$/g, "");
    s = s.replace(/ii$/g, "");
    s = s.replace(/jr$/g, "");
    s = s.replace(/sr$/g, "");

    // Common nickname mappings – extend as you find new cases
    s = s.replace(/^gabriel/, "gabe");
    s = s.replace(/^kenneth/, "ken");
    s = s.replace(/^matthew/, "matt");
    s = s.replace(/^christopher/, "chris");
    s = s.replace(/^joshua/, "josh");

    return s;
  }

  // Normalize positions like "QB1", "WR5", "RB2" -> "qb", "wr", "rb"
  // so they line up with Sleeper "QB", "WR", etc.
  function normalizePosition(pos) {
    if (!pos) return "";
    const raw = String(pos).toLowerCase();
    // keep only letters, then drop trailing digits just in case
    return raw.replace(/[^a-z]/g, "").replace(/\d+$/, "");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForPlayerMapReady() {
    const p = typeof window !== "undefined" && window.__PLAYER_MAP_READY__;
    if (p && typeof p.then === "function") {
      try {
        await p;
        return;
      } catch (_err) {
        // fall through to small delay
      }
    }
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
    safeNumber(supaCfg.ktcPageSize) ||
    safeNumber(ktcCfg.pageSize) ||
    300;

  const MAX_PAGES =
    safeNumber(supaCfg.ktcMaxPages) ||
    safeNumber(ktcCfg.maxPages) ||
    20;

  // ---------------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------------

  /**
   * cacheBySleeperId: {
   *   [sleeperId: string]: {
   *     sleeperId: string,
   *     value: number,          // primary dynasty value (e.g. ktc_value)
   *     playerName: string,
   *     position: string,
   *     team: string,
   *     mappingType: 'explicit' | 'fuzzy',
   *     raw: any                // original row
   *   }
   * }
   */
  let cacheBySleeperId = null;
  let loadPromise = null;

  // ---------------------------------------------------------------------------
  // Supabase pagination
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
      .order("as_of_date", { ascending: false }) // newest first
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

  // ---------------------------------------------------------------------------
  // Core loader: fetch all KTC rows, build lookup, then map to Sleeper
  // ---------------------------------------------------------------------------

  function addMapping(bySleeperId, sleeperId, row, mappingType) {
    const sid = String(sleeperId);
    const value = safeNumber(row.ktc_value, null);
    if (value == null) return;

    const existing = bySleeperId[sid];

    const mapped = {
      sleeperId: sid,
      value,
      playerName: row.player_name || row.name || row.full_name || null,
      position: row.position || null,
      team: row.nfl_team || row.team || null,
      mappingType,
      raw: row,
    };

    if (!existing) {
      bySleeperId[sid] = mapped;
      return;
    }

    // Prefer higher value if there's a conflict; if equal, keep existing
    if (mapped.value > existing.value) {
      bySleeperId[sid] = mapped;
    }
  }

  async function loadAllInternal() {
    if (cacheBySleeperId) {
      return cacheBySleeperId;
    }

    if (!supabase) {
      console.warn(
        "[KTCClient] Supabase client is not available – KTC values disabled."
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
            (totalCountSeen != null ? " of ~" + totalCountSeen + ")" : ")")
        );
      } else {
        console.log("[KTCClient] Page " + (page + 1) + " returned 0 rows.");
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

    // -----------------------------------------------------------------------
    // Step 1 – Build "normalizedName_position" → { value, row } lookup
    // -----------------------------------------------------------------------
    const ktcLookup = {}; // key: "nameKey_posKey" => { value, row }
    let usableKtcRows = 0;

    allRows.forEach((row) => {
      const rawName =
        row.player_name || row.name || row.full_name || row.player || "";
      const nameKey = normalizeName(rawName);
      const posKey = normalizePosition(row.position);

      const value = safeNumber(row.ktc_value, null);

      if (!nameKey || !posKey || value == null) {
        return;
      }

      const key = nameKey + "_" + posKey;

      // We ordered by as_of_date DESC, so first row for a key is the freshest.
      if (!ktcLookup[key]) {
        ktcLookup[key] = { value, row };
        usableKtcRows += 1;
      }
    });

    console.log(
      "[KTCClient] Built KTC lookup with " +
        usableKtcRows +
        " usable rows (normalized name + position)."
    );

    // -----------------------------------------------------------------------
    // Step 2 – Wait for Sleeper player map and map SleeperId -> KTC
    // -----------------------------------------------------------------------
    await waitForPlayerMapReady();
    const sleeperMap = (typeof window !== "undefined" && window.__SLEEPER_PLAYER_MAP__) || {};
    const sleeperIds = Object.keys(sleeperMap || {});

    if (!sleeperIds.length) {
      console.warn(
        "[KTCClient] __SLEEPER_PLAYER_MAP__ not available or empty. " +
          "KTC mapping cannot be built."
      );
      cacheBySleeperId = {};
      return cacheBySleeperId;
    }

    const bySleeperId = {};
    let explicitMapped = 0;
    let fuzzyMapped = 0;

    // 2A. Explicit mapping from rows with sleeper_id populated
    allRows.forEach((row) => {
      const sid =
        row.sleeper_id ||
        row.sleeper_player_id ||
        row.sleeperId ||
        row.sleeper_playerid ||
        null;

      if (!sid) return;
      addMapping(bySleeperId, sid, row, "explicit");
      explicitMapped += 1;
    });

    // 2B. Fuzzy mapping via normalizedName + normalizedPosition
    sleeperIds.forEach((sleeperId) => {
      // If we already have an explicit mapping, keep it.
      if (bySleeperId[sleeperId]) return;

      const meta = sleeperMap[sleeperId];
      if (!meta) return;

      const fullName =
        meta.full_name ||
        (meta.first_name && meta.last_name
          ? meta.first_name + " " + meta.last_name
          : null) ||
        meta.search_full_name ||
        meta.display_name ||
        "";

      const nameKey = normalizeName(fullName);
      const posKey = normalizePosition(meta.position);

      if (!nameKey || !posKey) return;

      const key = nameKey + "_" + posKey;
      const hit = ktcLookup[key];
      if (!hit) return;

      addMapping(bySleeperId, sleeperId, hit.row, "fuzzy");
      fuzzyMapped += 1;
    });

    const mappedCount = Object.keys(bySleeperId).length;
    cacheBySleeperId = bySleeperId;

    console.log(
      "[KTCClient] Mapped " +
        mappedCount +
        " Sleeper IDs to KTC values (explicit=" +
        explicitMapped +
        ", fuzzy=" +
        fuzzyMapped +
        ", totalKtcPlayers=" +
        usableKtcRows +
        ")."
    );

    if (!mappedCount) {
      console.warn(
        "[KTCClient] No usable KTC rows after mapping. " +
          "Check ktc_values.player_name / .position formats and the Sleeper player map."
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
    const v = safeNumber(row.value, null);
    return v == null ? null : v;
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
    _normalizeName: normalizeName,
    _normalizePosition: normalizePosition,
  };
})();
