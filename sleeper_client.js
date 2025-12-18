// sleeper_client.js
// -----------------------------------------------------------------------------
// Thin browser client for the Sleeper Fantasy Football API + optional Supabase
// snapshot persistence.
//
// Responsibilities:
//   • Wrap raw HTTP calls to Sleeper (league, users, rosters, matchups, brackets)
//   • Provide higher-level helpers (bundles + single-week snapshot)
//   • Optionally persist snapshots into a Supabase table (e.g. sleeper_snapshots)
//   • Stay framework-free and browser-only (no bundler, no modules)
//
// This file does NOT transform the data into “view models”; that’s handled by
// models.js / newsletter.js / insights.js on top of the snapshots / bundles.
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    // ---------------------------------------------------------------------------
    // Sleeper config
    // ---------------------------------------------------------------------------
  
    const BASE_URL = "https://api.sleeper.app/v1";
  
    const DEFAULT_LEAGUE_CONFIG = {
      LEAGUE_ID: null,
      CURRENT_SEASON: null,
      SEMIFINAL_WEEK: null,
      CHAMPIONSHIP_WEEK: null,
      CACHE_TTL_MS: 60 * 1000, // 1 minute default
    };
  
    const CONFIG =
      window.LEAGUE_CONFIG
        ? Object.assign({}, DEFAULT_LEAGUE_CONFIG, window.LEAGUE_CONFIG)
        : DEFAULT_LEAGUE_CONFIG;
  
    function assertLeagueId() {
      if (!CONFIG.LEAGUE_ID) {
        throw new Error(
          "[SleeperClient] LEAGUE_ID is not configured. Set window.LEAGUE_CONFIG.LEAGUE_ID first."
        );
      }
      return CONFIG.LEAGUE_ID;
    }
  
    // ---------------------------------------------------------------------------
    // Supabase config (optional)
    // ---------------------------------------------------------------------------
    //
    // Preferred config (under LEAGUE_CONFIG):
    //
    //   window.LEAGUE_CONFIG = {
    //     ...,
    //     supabase: {
    //       url: "https://xxx.supabase.co",
    //       anonKey: "public-anon-key",
    //
    //       // Optional overrides:
    //       snapshotTable: "sleeper_snapshots",
    //       autoPersistSnapshots: true,  // auto insert on getLeagueSnapshot()
    //     }
    //   }
    //
    // Legacy fallback (if you already wired this earlier):
    //
    //   window.SUPABASE_CONFIG = {
    //     ENABLED: true,
    //     SUPABASE_URL: "https://xxx.supabase.co",
    //     SUPABASE_ANON_KEY: "public-anon-key",
    //     TABLE_NAME: "sleeper_snapshots",
    //     AUTO_PERSIST_SNAPSHOTS: true,
    //   }
    //
    // You must also include the Supabase browser client:
    //   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
    // ---------------------------------------------------------------------------
  
    const leagueSupabaseCfg =
      (window.LEAGUE_CONFIG && window.LEAGUE_CONFIG.supabase) || {};
  
    const legacySupabaseCfg = window.SUPABASE_CONFIG || {};
  
    const SUPABASE_CONFIG = {
      // Base from LEAGUE_CONFIG.supabase
      url: leagueSupabaseCfg.url || null,
      anonKey: leagueSupabaseCfg.anonKey || null,
      snapshotTable: leagueSupabaseCfg.snapshotTable || "sleeper_snapshots",
      autoPersistSnapshots: !!leagueSupabaseCfg.autoPersistSnapshots,
  
      // Flag – will be recomputed after legacy override
      enabled: false,
    };
  
    // Legacy overrides (if present)
    if (typeof legacySupabaseCfg.ENABLED === "boolean") {
      SUPABASE_CONFIG.enabled = legacySupabaseCfg.ENABLED;
    }
    if (legacySupabaseCfg.SUPABASE_URL) {
      SUPABASE_CONFIG.url = legacySupabaseCfg.SUPABASE_URL;
    }
    if (legacySupabaseCfg.SUPABASE_ANON_KEY) {
      SUPABASE_CONFIG.anonKey = legacySupabaseCfg.SUPABASE_ANON_KEY;
    }
    if (legacySupabaseCfg.TABLE_NAME) {
      SUPABASE_CONFIG.snapshotTable = legacySupabaseCfg.TABLE_NAME;
    }
    if (typeof legacySupabaseCfg.AUTO_PERSIST_SNAPSHOTS === "boolean") {
      SUPABASE_CONFIG.autoPersistSnapshots =
        legacySupabaseCfg.AUTO_PERSIST_SNAPSHOTS;
    }
  
    // If url + anonKey exist and we didn’t explicitly disable, treat as enabled
    if (!("ENABLED" in legacySupabaseCfg)) {
      SUPABASE_CONFIG.enabled = !!(SUPABASE_CONFIG.url && SUPABASE_CONFIG.anonKey);
    }
  
    let supabaseClient = null;
  
    function getSupabaseClient() {
      if (!SUPABASE_CONFIG.enabled) return null;
      if (supabaseClient) return supabaseClient;
  
      if (!window.supabase || typeof window.supabase.createClient !== "function") {
        console.warn(
          "[SleeperClient] Supabase is enabled but window.supabase.createClient is not available. " +
            "Make sure you added the Supabase UMD script before sleeper_client.js."
        );
        return null;
      }
  
      if (!SUPABASE_CONFIG.url || !SUPABASE_CONFIG.anonKey) {
        console.warn(
          "[SleeperClient] Supabase config missing url or anonKey. " +
            "Set LEAGUE_CONFIG.supabase.url and .anonKey (or SUPABASE_CONFIG.SUPABASE_URL / _ANON_KEY)."
        );
        return null;
      }
  
      // Single client for this file
      supabaseClient = window.supabase.createClient(
        SUPABASE_CONFIG.url,
        SUPABASE_CONFIG.anonKey
      );
  
      return supabaseClient;
    }
  
    // ---------------------------------------------------------------------------
    // Local cache helpers (localStorage)
    // ---------------------------------------------------------------------------
  
    function buildUrl(path) {
      if (!path.startsWith("/")) path = "/" + path;
      return BASE_URL + path;
    }
  
    async function fetchJson(path) {
      const url = buildUrl(path);
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });
  
      if (!res.ok) {
        const bodyText = await res.text().catch(function () {
          return "";
        });
        throw new Error(
          "[SleeperClient] HTTP " +
            res.status +
            " for " +
            url +
            " – " +
            (bodyText || "No body")
        );
      }
  
      return res.json();
    }
  
    function cacheKey() {
      var parts = ["sleeper_cache", CONFIG.LEAGUE_ID || "no_league"];
      for (var i = 0; i < arguments.length; i++) {
        parts.push(String(arguments[i]));
      }
      return parts.join("__");
    }
  
    function getCache(key) {
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
  
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return null;
  
        const now = Date.now();
        const ttl = CONFIG.CACHE_TTL_MS || 60_000;
  
        if (typeof parsed.ts !== "number" || now - parsed.ts > ttl) {
          return null;
        }
  
        return parsed.data;
      } catch (_e) {
        return null;
      }
    }
  
    function setCache(key, data) {
      try {
        const payload = JSON.stringify({ ts: Date.now(), data: data });
        window.localStorage.setItem(key, payload);
      } catch (_e) {
        // ignore quota / unsupported errors
      }
    }
  
    // ---------------------------------------------------------------------------
    // Core Sleeper calls
    // ---------------------------------------------------------------------------
  
    async function getLeague(leagueIdOverride) {
      const leagueId = leagueIdOverride || assertLeagueId();
      const key = cacheKey("league");
      const cached = getCache(key);
      if (cached) return cached;
  
      const data = await fetchJson("/league/" + leagueId);
      setCache(key, data);
      return data;
    }
  
    async function getLeagueUsers(leagueIdOverride) {
      const leagueId = leagueIdOverride || assertLeagueId();
      const key = cacheKey("users");
      const cached = getCache(key);
      if (cached) return cached;
  
      const data = await fetchJson("/league/" + leagueId + "/users");
      setCache(key, data);
      return data;
    }
  
    async function getLeagueRosters(leagueIdOverride) {
      const leagueId = leagueIdOverride || assertLeagueId();
      const key = cacheKey("rosters");
      const cached = getCache(key);
      if (cached) return cached;
  
      const data = await fetchJson("/league/" + leagueId + "/rosters");
      setCache(key, data);
      return data;
    }
  
    async function getMatchupsForWeek(week, leagueIdOverride) {
      const leagueId = leagueIdOverride || assertLeagueId();
      const wkNum = Number(week);
  
      if (!Number.isFinite(wkNum)) {
        throw new Error("[SleeperClient] Invalid week: " + week);
      }
  
      const key = cacheKey("matchups", wkNum);
      const cached = getCache(key);
      if (cached) return cached;
  
      const data = await fetchJson(
        "/league/" + leagueId + "/matchups/" + String(wkNum)
      );
      setCache(key, data);
      return data;
    }
  
    async function getPlayoffBracket(leagueIdOverride) {
      const leagueId = leagueIdOverride || assertLeagueId();
      const key = cacheKey("winners_bracket");
      const cached = getCache(key);
      if (cached) return cached;
  
      const data = await fetchJson("/league/" + leagueId + "/winners_bracket");
      setCache(key, data);
      return data;
    }
  
    async function getLosersBracket(leagueIdOverride) {
      const leagueId = leagueIdOverride || assertLeagueId();
      const key = cacheKey("losers_bracket");
      const cached = getCache(key);
      if (cached) return cached;
  
      const data = await fetchJson("/league/" + leagueId + "/losers_bracket");
      setCache(key, data);
      return data;
    }
  
    // ---------------------------------------------------------------------------
    // Higher-level bundle + snapshot
    // ---------------------------------------------------------------------------
  
    /**
     * Fetch all core league data needed for your “hub” views:
     *   - league
     *   - users
     *   - rosters
     *   - matchupsByWeek (for the requested weeks)
     *   - winnersBracket
     *
     * options:
     *   {
     *     leagueId?: string,
     *     weeks?: number[]  // if omitted, uses [SEMIFINAL_WEEK, CHAMPIONSHIP_WEEK].filter(Boolean)
     *   }
     */
    async function fetchLeagueBundle(options) {
      const opts = options || {};
      const leagueId = opts.leagueId || CONFIG.LEAGUE_ID || assertLeagueId();
  
      const weeksArray = Array.isArray(opts.weeks)
        ? opts.weeks
        : [CONFIG.SEMIFINAL_WEEK, CONFIG.CHAMPIONSHIP_WEEK].filter(function (w) {
            return Number.isFinite(Number(w));
          });
  
      const uniqueWeeks = Array.from(
        new Set(
          weeksArray
            .map(function (w) {
              return Number(w);
            })
            .filter(function (w) {
              return Number.isFinite(w);
            })
        )
      );
  
      const results = await Promise.all([
        getLeague(leagueId),
        getLeagueUsers(leagueId),
        getLeagueRosters(leagueId),
      ]);
  
      const league = results[0];
      const users = results[1];
      const rosters = results[2];
  
      const matchupsByWeek = {};
      for (let i = 0; i < uniqueWeeks.length; i++) {
        const wk = uniqueWeeks[i];
        matchupsByWeek[wk] = await getMatchupsForWeek(wk, leagueId);
      }
  
      let winnersBracket = null;
      try {
        winnersBracket = await getPlayoffBracket(leagueId);
      } catch (err) {
        console.warn("[SleeperClient] Failed to fetch winners bracket:", err);
      }
  
      const bundle = {
        league: league,
        users: users,
        rosters: rosters,
        matchupsByWeek: matchupsByWeek,
        winnersBracket: winnersBracket,
      };
  
      // Expose for other scripts (newsletter.js, insights.js, roster tab, etc.)
      window.__LAST_BUNDLE__ = bundle;
      return bundle;
    }
  
    /**
     * Persist a full snapshot into Supabase (if configured).
     *
     * Snapshot shape:
     *   {
     *     league,
     *     users,
     *     rosters,
     *     matchups,
     *     winnersBracket,
     *     week
     *   }
     *
     * extraMeta (optional) is merged into the inserted row, e.g.:
     *   { source: "playoff_hub", note: "semifinal_week" }
     *
     * Expected Supabase schema for the snapshot table (default: sleeper_snapshots):
     *
     *   CREATE TABLE public.sleeper_snapshots (
     *     id          bigserial primary key,
     *     league_id   text,
     *     season      integer,
     *     week        integer,
     *     snapshot    jsonb not null,
     *     captured_at timestamptz default now()
     *   );
     */
    // ---------------------------------------------------------------------------
    // Supabase: persist a snapshot row
    // ---------------------------------------------------------------------------
    async function persistSnapshotToSupabase(snapshot) {
        const client = getSupabaseClient();
        if (!client) {
        console.warn(
            "[SleeperClient] Supabase client unavailable; skipping snapshot persist."
        );
        return null;
        }
    
        // Make sure we have a valid table name
        const tableName =
        (SUPABASE_CONFIG &&
            typeof SUPABASE_CONFIG.TABLE_NAME === "string" &&
            SUPABASE_CONFIG.TABLE_NAME.trim()) ||
        "sleeper_snapshots";
    
        if (!tableName) {
        console.warn(
            "[SleeperClient] Cannot persist snapshot – TABLE_NAME is empty in SUPABASE_CONFIG."
        );
        return null;
        }
    
        try {
        const leagueIdFromSnapshot =
            (snapshot &&
            snapshot.league &&
            (snapshot.league.league_id || snapshot.league.leagueId)) ||
            CONFIG.LEAGUE_ID ||
            null;
    
        const weekFromSnapshot =
            snapshot && typeof snapshot.week === "number"
            ? snapshot.week
            : null;
    
        const row = {
            league_id: leagueIdFromSnapshot ? String(leagueIdFromSnapshot) : null,
            week: weekFromSnapshot,
            snapshot, // jsonb column
            captured_at: new Date().toISOString(),
        };
    
        const { data, error } = await client
            .from(tableName)
            .insert(row)
            // only select columns we know exist
            .select("id, league_id, week, captured_at")
            .maybeSingle();
    
        if (error) {
            console.warn(
            "[SleeperClient] Failed to persist snapshot to Supabase table `" +
                tableName +
                "`:",
            error
            );
            return null;
        }
    
        console.log(
            "[SleeperClient] Snapshot persisted to `" +
            tableName +
            "`:",
            data
        );
    
        return data || null;
        } catch (err) {
        console.warn(
            "[SleeperClient] Unexpected error persisting snapshot:",
            err
        );
        return null;
        }
    }
    
      
      
  
    /**
     * Convenience: produce a single-week snapshot and (optionally) write it
     * straight into Supabase.
     *
     * Returns:
     *   {
     *     league,
     *     users,
     *     rosters,
     *     matchups,
     *     winnersBracket,
     *     week
     *   }
     *
     * Usage:
     *   const snapshot = await SleeperClient.getLeagueSnapshot(15);
     *
     * If Supabase is configured and autoPersistSnapshots is true, you’ll also get
     * a new row inserted in `sleeper_snapshots` for that week.
     */
     async function getLeagueSnapshot(week, leagueIdOverride) {
        const wkNum = Number(week);
        if (!Number.isFinite(wkNum)) {
          throw new Error("[SleeperClient] Invalid week for snapshot: " + week);
        }
      
        const bundle = await fetchLeagueBundle({
          leagueId: leagueIdOverride,
          weeks: [wkNum],
        });
      
        const snapshot = {
          league: bundle.league,
          users: bundle.users,
          rosters: bundle.rosters,
          matchups: bundle.matchupsByWeek[wkNum] || [],
          winnersBracket: bundle.winnersBracket || [],
          week: wkNum,
        };
      
        // --- NEW: embed dynasty KTC totals per roster into the snapshot ---
        try {
          const ktcClient = window.KTCClient || null;
      
          if (ktcClient && typeof ktcClient.getBestValueForSleeperId === "function") {
            const dynastyTotals = {};
            const perPlayerKtc = {}; // optional: only if you want per-player in SQL later
      
            (bundle.rosters || []).forEach((r) => {
              const rid = String(r.roster_id);
              const players = Array.isArray(r.players) && r.players.length
                ? r.players
                : (r.starters || []);
      
              let total = 0;
              perPlayerKtc[rid] = [];
      
              players.forEach((pid) => {
                const sleeperId = String(pid);
                const v = ktcClient.getBestValueForSleeperId(sleeperId);
                if (typeof v === "number" && Number.isFinite(v) && v > 0) {
                  total += v;
                }
                // store per-player detail if you care
                perPlayerKtc[rid].push({
                  sleeper_id: sleeperId,
                  ktc_value: Number.isFinite(v) ? v : null,
                });
              });
      
              dynastyTotals[rid] = total;
            });
      
            snapshot.dynasty_totals = dynastyTotals;  // { "1": 12345, "2": 9876, ... }
            snapshot.dynasty_players = perPlayerKtc;  // optional detailed breakdown
          } else {
            console.warn(
              "[SleeperClient] KTCClient not available; snapshot will not include dynasty_totals."
            );
          }
        } catch (err) {
          console.warn("[SleeperClient] Error computing dynasty_totals for snapshot:", err);
        }
        // --- END NEW STUFF ---
      
        window.__LAST_SNAPSHOT__ = snapshot;
      
        if (SUPABASE_CONFIG.enabled && SUPABASE_CONFIG.autoPersistSnapshots) {
          persistSnapshotToSupabase(snapshot).catch(function (err) {
            console.warn(
              "[SleeperClient] Error auto-persisting snapshot to Supabase:",
              err
            );
          });
        }
      
        return snapshot;
      }
      
      
  
    // ---------------------------------------------------------------------------
    // Small normalization helpers
    // ---------------------------------------------------------------------------
  
    function buildUserMap(users) {
      const map = {};
      (users || []).forEach(function (u) {
        if (!u || !u.user_id) return;
        map[u.user_id] = u;
      });
      return map;
    }
  
    function findOwnerForRoster(roster, users) {
      if (!roster || !Array.isArray(users)) return null;
      const ownerId = roster.owner_id;
      return users.find(function (u) {
        return u && u.user_id === ownerId;
      }) || null;
    }
  
    // ---------------------------------------------------------------------------
    // Expose public API
    // ---------------------------------------------------------------------------
  
    window.SleeperClient = {
      // Raw data fetchers
      getLeague: getLeague,
      getLeagueUsers: getLeagueUsers,
      getLeagueRosters: getLeagueRosters,
      getMatchupsForWeek: getMatchupsForWeek,
      getPlayoffBracket: getPlayoffBracket,
      getLosersBracket: getLosersBracket,
  
      // Bundled helpers
      fetchLeagueBundle: fetchLeagueBundle,
      getLeagueSnapshot: getLeagueSnapshot,
  
      // Supabase
      persistSnapshotToSupabase: persistSnapshotToSupabase,
  
      // Small helpers
      buildUserMap: buildUserMap,
      findOwnerForRoster: findOwnerForRoster,
  
      // Debugging
      _config: CONFIG,
      _supabaseConfig: SUPABASE_CONFIG,
      _getSupabaseClient: getSupabaseClient,
    };
  })();
  