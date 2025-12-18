// ktc_client.js
// -----------------------------------------------------------------------------
// KTCClient – cached interface to KeepTradeCut-style dynasty values.
//
// Responsibilities:
//   • Load ALL KTC rows for this league from Supabase (with pagination).
//   • If no Sleeper ID column is present, map rows to Sleeper players using
//     name + position (+ team) via window.__SLEEPER_PLAYER_MAP__.
//   • Cache by Sleeper player id for fast lookups.
//   • Expose:
//
//       KTCClient.whenReady() -> Promise<cache>
//       KTCClient.getBySleeperId(id) -> { ...row... } | null
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
// If no Supabase config is present, KTCClient will be a harmless no-op:
//   - whenReady() resolves to {}
//   - all getters return null
// -----------------------------------------------------------------------------

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
  
    // ---------------------------------------------------------------------------
    // Config extraction
    // ---------------------------------------------------------------------------
  
    const globalCfg =
      (typeof window !== "undefined" && window.LEAGUE_CONFIG) || {};
  
    const supaCfg = globalCfg.supabase || {};
    const ktcCfg = globalCfg.ktc || {};
  
    const SUPABASE_URL = supaCfg.url || null;
    const SUPABASE_KEY = supaCfg.anonKey || null;
  
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
  
    let supaClient = null;
    let cacheBySleeperId = null; // { sleeperId: { ...normalizedRow } }
    let loadPromise = null;
  
    // ---------------------------------------------------------------------------
    // Supabase wiring
    // ---------------------------------------------------------------------------
  
    function ensureSupabaseClient() {
      if (supaClient) return supaClient;
  
      if (!window.supabase || typeof window.supabase.createClient !== "function") {
        console.warn(
          "[KTCClient] Supabase UMD is not available (supabase.createClient). " +
            "Verify the supabase-js script tag is loaded before ktc_client.js."
        );
        return null;
      }
  
      if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.warn(
          "[KTCClient] Supabase not configured. Expected LEAGUE_CONFIG.supabase.url and anonKey. " +
            "KTC values will not be available."
        );
        return null;
      }
  
      supaClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      return supaClient;
    }
  
    // ---------------------------------------------------------------------------
    // Fetching with pagination
    // ---------------------------------------------------------------------------
  
    async function fetchPage(pageIndex) {
      const client = ensureSupabaseClient();
      if (!client) return { rows: [], done: true, totalCount: null };
  
      const from = pageIndex * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
  
      const query = client
        .from(KTC_TABLE)
        .select("*", { count: "exact", head: false })
        .range(from, to)
        .order("ktc_rank", { ascending: true });
  
      const res = await query;
      if (res.error) {
        console.error("[KTCClient] Supabase error:", res.error);
        throw res.error;
      }
  
      const rows = res.data || [];
      const totalCount = typeof res.count === "number" ? res.count : null;
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
  
      if (!ensureSupabaseClient()) {
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
      } else {
        const sample = allRows[0];
        if (sample) {
          console.log(
            "[KTCClient] Sample KTC row keys:",
            Object.keys(sample)
          );
        }
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
        // 1) Try explicit Sleeper id columns
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
  
        // Value columns – be permissive about names
        const sf =
          typeof row.sf_value === "number"
            ? row.sf_value
            : typeof row.sf === "number"
            ? row.sf
            : typeof row.superflex_value === "number"
            ? row.superflex_value
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
            : null;
  
        const updatedAt =
          row.updated_at || row.updated || row.last_updated || null;
  
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
          return;
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
            "Check your ktc_values name/position columns and Sleeper player map."
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
  