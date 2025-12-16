// sleeper_client.js
// -----------------------------------------------------------------------------
// Thin browser client for the Sleeper Fantasy Football API.
//
// Goals:
//   - Abstract all raw HTTP calls into a single place.
//   - Provide simple helpers for:
//       • League metadata
//       • Users (owners)
//       • Rosters
//       • Weekly matchups
//       • Playoff bracket
//   - Add light caching + basic error handling.
//   - Stay framework-free and browser-only (no Node, no bundler).
//
// This file does NOT impose any opinionated shape beyond some light
// normalization. Higher-level transformation into "TeamWeekView" etc.
// is done in models.js / newsletter.js.
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    const BASE_URL = "https://api.sleeper.app/v1";
  
    // Fallback config if league_config.js is missing
    const DEFAULT_LEAGUE_CONFIG = {
      LEAGUE_ID: null,
      CURRENT_SEASON: null,
      SEMIFINAL_WEEK: null,
      CHAMPIONSHIP_WEEK: null,
      CACHE_TTL_MS: 60 * 1000, // 1 minute default
    };
  
    const CONFIG = (window.LEAGUE_CONFIG
      ? Object.assign({}, DEFAULT_LEAGUE_CONFIG, window.LEAGUE_CONFIG)
      : DEFAULT_LEAGUE_CONFIG
    );
  
    // ---------------
    // Helpers
    // ---------------
  
    function assertLeagueId() {
      if (!CONFIG.LEAGUE_ID) {
        throw new Error(
          "[SleeperClient] LEAGUE_ID is not configured. Set window.LEAGUE_CONFIG.LEAGUE_ID first."
        );
      }
      return CONFIG.LEAGUE_ID;
    }
  
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
        const bodyText = await res.text().catch(() => "");
        throw new Error(
          `[SleeperClient] HTTP ${res.status} for ${url} – ${
            bodyText || "No body"
          }`
        );
      }
      return res.json();
    }
  
    // Basic localStorage cache wrapper
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
      } catch {
        return null;
      }
    }
  
    function setCache(key, data) {
      try {
        const payload = JSON.stringify({ ts: Date.now(), data });
        window.localStorage.setItem(key, payload);
      } catch {
        // Ignore cache errors (quota, unsupported, etc.)
      }
    }
  
    function cacheKey(...parts) {
      return ["sleeper_cache", CONFIG.LEAGUE_ID || "no_league", ...parts].join(
        "__"
      );
    }
  
    // ---------------
    // Core API calls
    // ---------------
  
    async function getLeague(leagueIdOverride) {
      const leagueId = leagueIdOverride || assertLeagueId();
      const key = cacheKey("league");
      const cached = getCache(key);
      if (cached) return cached;
  
      const data = await fetchJson(`/league/${leagueId}`);
      setCache(key, data);
      return data;
    }
  
    async function getLeagueUsers(leagueIdOverride) {
      const leagueId = leagueIdOverride || assertLeagueId();
      const key = cacheKey("users");
      const cached = getCache(key);
      if (cached) return cached;
  
      const data = await fetchJson(`/league/${leagueId}/users`);
      setCache(key, data);
      return data;
    }
  
    async function getLeagueRosters(leagueIdOverride) {
      const leagueId = leagueIdOverride || assertLeagueId();
      const key = cacheKey("rosters");
      const cached = getCache(key);
      if (cached) return cached;
  
      const data = await fetchJson(`/league/${leagueId}/rosters`);
      setCache(key, data);
      return data;
    }
  
    async function getMatchupsForWeek(week, leagueIdOverride) {
      const leagueId = leagueIdOverride || assertLeagueId();
      if (!Number.isFinite(Number(week))) {
        throw new Error(`[SleeperClient] Invalid week: ${week}`);
      }
      const wk = Number(week);
      const key = cacheKey("matchups", wk);
      const cached = getCache(key);
      if (cached) return cached;
  
      const data = await fetchJson(`/league/${leagueId}/matchups/${wk}`);
      setCache(key, data);
      return data;
    }
  
    async function getPlayoffBracket(leagueIdOverride) {
      const leagueId = leagueIdOverride || assertLeagueId();
      const key = cacheKey("winners_bracket");
      const cached = getCache(key);
      if (cached) return cached;
  
      const data = await fetchJson(`/league/${leagueId}/winners_bracket`);
      setCache(key, data);
      return data;
    }
  
    // Optional: losers bracket if you care later
    async function getLosersBracket(leagueIdOverride) {
      const leagueId = leagueIdOverride || assertLeagueId();
      const key = cacheKey("losers_bracket");
      const cached = getCache(key);
      if (cached) return cached;
  
      const data = await fetchJson(`/league/${leagueId}/losers_bracket`);
      setCache(key, data);
      return data;
    }
  
    // ---------------
    // Higher-level bundle helpers
    // ---------------
  
    /**
     * Fetch all core league data needed for the newsletter:
     *
     *   - league
     *   - users
     *   - rosters
     *   - matchups for specific weeks
     *   - winners bracket
     *
     * Returns an object with all the raw pieces, ready to be fed into LeagueModels.
     */
    async function fetchLeagueBundle(options = {}) {
      const leagueId = options.leagueId || CONFIG.LEAGUE_ID || assertLeagueId();
  
      const weeks = Array.isArray(options.weeks)
        ? options.weeks
        : [CONFIG.SEMIFINAL_WEEK, CONFIG.CHAMPIONSHIP_WEEK].filter(Boolean);
  
      const uniqueWeeks = [
        ...new Set(
          weeks.filter((w) => Number.isFinite(Number(w)))
        ),
      ];
  
      const [league, users, rosters] = await Promise.all([
        getLeague(leagueId),
        getLeagueUsers(leagueId),
        getLeagueRosters(leagueId),
      ]);
  
      const matchupsByWeek = {};
      for (const wk of uniqueWeeks) {
        matchupsByWeek[wk] = await getMatchupsForWeek(wk, leagueId);
      }
  
      let winnersBracket = null;
      try {
        winnersBracket = await getPlayoffBracket(leagueId);
      } catch (err) {
        console.warn("[SleeperClient] Failed to fetch winners bracket:", err);
      }
  
      const bundle = {
        league,
        users,
        rosters,
        matchupsByWeek,
        winnersBracket,
      };
  
      // Expose for debugging / other modules
      window.__LAST_BUNDLE__ = bundle;
      return bundle;
    }
  
    /**
     * Convenience: "snapshot" for a single week, same shape you logged earlier:
     *   { league, users, rosters, matchups, winnersBracket }
     */
    async function getLeagueSnapshot(week, leagueIdOverride) {
      const wk = Number(week);
      if (!Number.isFinite(wk)) {
        throw new Error(`[SleeperClient] Invalid week for snapshot: ${week}`);
      }
  
      const bundle = await fetchLeagueBundle({
        leagueId: leagueIdOverride,
        weeks: [wk],
      });
  
      const snapshot = {
        league: bundle.league,
        users: bundle.users,
        rosters: bundle.rosters,
        matchups: bundle.matchupsByWeek[wk] || [],
        winnersBracket: bundle.winnersBracket || [],
        week: wk,
      };
  
      window.__LAST_SNAPSHOT__ = snapshot;
      return snapshot;
    }
  
    // ---------------
    // Minimal normalization helpers
    // ---------------
  
    function buildUserMap(users) {
      const map = {};
      (users || []).forEach((u) => {
        if (!u || !u.user_id) return;
        map[u.user_id] = u;
      });
      return map;
    }
  
    function findOwnerForRoster(roster, users) {
      if (!roster || !Array.isArray(users)) return null;
      const ownerId = roster.owner_id;
      return users.find((u) => u.user_id === ownerId) || null;
    }
  
    // ---------------
    // Attach to window
    // ---------------
  
    window.SleeperClient = {
      // Raw data fetchers
      getLeague,
      getLeagueUsers,
      getLeagueRosters,
      getMatchupsForWeek,
      getPlayoffBracket,
      getLosersBracket,
  
      // Bundled fetch
      fetchLeagueBundle,
      getLeagueSnapshot,
  
      // Small helpers
      buildUserMap,
      findOwnerForRoster,
    };
  })();
  