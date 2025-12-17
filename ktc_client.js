// ktc_client.js
// -----------------------------------------------------------------------------
// KTCClient – typed, cached interface to KeepTradeCut-style dynasty values.
//
// Design goals:
//   • Pull *all* relevant rows (not just first 100) via Supabase pagination.
//   • Cache results in memory and expose simple lookups by Sleeper player id.
//   • Be resilient: if KTC or Supabase are misconfigured, fail gracefully.
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    var globalCfg = (typeof window !== "undefined" && window.LEAGUE_CONFIG) || {};
    var supaCfg = globalCfg.supabase || {};
    var ktcCfg = globalCfg.ktc || {};
  
    var SUPABASE_URL = supaCfg.url || null;
    var SUPABASE_KEY = supaCfg.anonKey || null;
    var KTC_TABLE = ktcCfg.table || "ktc_values";
    var PAGE_SIZE = ktcCfg.pageSize || 200;
    var MAX_PAGES = ktcCfg.maxPages || 20;
  
    var supaClient = null;
    var cacheBySleeperId = null;
    var loadPromise = null;
  
    function ensureSupabaseClient() {
      if (supaClient) return supaClient;
      if (!window.supabase || !SUPABASE_URL || !SUPABASE_KEY) {
        console.warn(
          "[KTCClient] Supabase not configured (check LEAGUE_CONFIG.supabase). " +
            "KTC values will not be available."
        );
        return null;
      }
      supaClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      return supaClient;
    }
  
    async function fetchPage(pageIndex) {
      var client = ensureSupabaseClient();
      if (!client) return { rows: [], done: true };
  
      var from = pageIndex * PAGE_SIZE;
      var to = from + PAGE_SIZE - 1;
  
      var query = client
        .from(KTC_TABLE)
        .select("*", { count: "exact", head: false })
        .range(from, to)
        .order("rank", { ascending: true });
  
      var res = await query;
      if (res.error) {
        console.error("[KTCClient] Supabase error:", res.error);
        throw res.error;
      }
  
      var rows = res.data || [];
      var done = rows.length < PAGE_SIZE;
      return { rows: rows, done: done };
    }
  
    async function loadAllInternal() {
      if (cacheBySleeperId) {
        return cacheBySleeperId;
      }
  
      if (!ensureSupabaseClient()) {
        cacheBySleeperId = {};
        return cacheBySleeperId;
      }
  
      console.log(
        "[KTCClient] Loading KTC values with pageSize=" +
          PAGE_SIZE +
          ", maxPages=" +
          MAX_PAGES
      );
  
      var page = 0;
      var allRows = [];
  
      while (page < MAX_PAGES) {
        var out = await fetchPage(page);
        if (out.rows && out.rows.length) {
          allRows = allRows.concat(out.rows);
          console.log(
            "[KTCClient] Page " +
              (page + 1) +
              " fetched " +
              out.rows.length +
              " rows (total " +
              allRows.length +
              ")."
          );
        }
        if (out.done) break;
        page += 1;
      }
  
      var bySleeperId = {};
      allRows.forEach(function (row) {
        var sid = row.sleeper_id || row.sleeperId || null;
        if (!sid) return;
        var key = String(sid);
        bySleeperId[key] = {
          sleeperId: key,
          playerName: row.player_name || row.name || null,
          position: row.position || null,
          team: row.team || null,
          sfValue:
            typeof row.sf_value === "number"
              ? row.sf_value
              : typeof row.sf === "number"
              ? row.sf
              : null,
          oneQbValue:
            typeof row.one_qb_value === "number"
              ? row.one_qb_value
              : typeof row.one_qb === "number"
              ? row.one_qb
              : null,
          rank:
            typeof row.rank === "number"
              ? row.rank
              : typeof row.overall_rank === "number"
              ? row.overall_rank
              : null,
          updatedAt: row.updated_at || row.updated || null,
          raw: row
        };
      });
  
      cacheBySleeperId = bySleeperId;
  
      console.log(
        "[KTCClient] Loaded " +
          Object.keys(cacheBySleeperId).length +
          " rows into cache."
      );
  
      return cacheBySleeperId;
    }
  
    function loadAll() {
      if (loadPromise) return loadPromise;
      loadPromise = loadAllInternal().catch(function (err) {
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
      var key = String(sleeperId);
      return cacheBySleeperId[key] || null;
    }
  
    function getBestValueForSleeperId(sleeperId) {
      var row = getBySleeperId(sleeperId);
      if (!row) return null;
      if (typeof row.sfValue === "number") return row.sfValue;
      if (typeof row.oneQbValue === "number") return row.oneQbValue;
      return null;
    }
  
    function debugDump() {
      return cacheBySleeperId ? deepClone(cacheBySleeperId) : {};
    }
  
    window.KTCClient = {
      whenReady: whenReady,
      loadAll: loadAll,
      getBySleeperId: getBySleeperId,
      getBestValueForSleeperId: getBestValueForSleeperId,
      _debugDump: debugDump
    };
  })();
  