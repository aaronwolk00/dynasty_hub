// league_config.js
// -----------------------------------------------------------------------------
// Central config for the Dynasty Playoff Hub.
//
// Key pieces used elsewhere:
//   • LEAGUE_CONFIG.LEAGUE_ID / SLEEPER_LEAGUE_ID
//   • LEAGUE_CONFIG.PHRASE_CONFIG  (Supabase project for recap phrases)
//   • LEAGUE_CONFIG.supabase       (generic Supabase for KTC, receipts, etc.)
//   • LEAGUE_CONFIG.ktc            (KTC-specific tuning)
//   • LEAGUE_CONFIG.PLAYOFFS       (rounds, weeks, labels)
//   • LEAGUE_CONFIG.ui             (front-end toggles)
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    // Single Supabase project used for:
    //   - nlg_phrases
    //   - ktc_values / ktc_latest_values
    //   - receipts / transactions (later)
    //   - sleeper_snapshots
    const PROJECT_SUPABASE_URL = "https://mugfsmqcrkfsehdyoruy.supabase.co";
    const PROJECT_SUPABASE_ANON =
      "sb_publishable_z6H9o_SOKq4VngF2JD3Peg_5NmwjMfW";
  
    const LEAGUE_ID = "1180559121900638208";
  
    const LEAGUE_CONFIG = {
      // -------------------------------------------------------------------------
      // Core Sleeper league identity
      // -------------------------------------------------------------------------
      LEAGUE_ID,
      // Backwards-compat alias some scripts might still reference
      SLEEPER_LEAGUE_ID: LEAGUE_ID,
  
      // -------------------------------------------------------------------------
      // Phrases / recap engine Supabase config
      // -------------------------------------------------------------------------
      PHRASE_CONFIG: {
        url: PROJECT_SUPABASE_URL,
        anonKey: PROJECT_SUPABASE_ANON,
      },
  
      // -------------------------------------------------------------------------
      // Generic Supabase config for app data (KTC, receipts, snapshots, etc.)
      // -------------------------------------------------------------------------
      supabase: {
        url: PROJECT_SUPABASE_URL,
        anonKey: PROJECT_SUPABASE_ANON,
  
        // Used by ktc_client.js
        ktcTable: "ktc_values",
        ktcPageSize: 300,
        ktcMaxPages: 20,
      },
  
      // -------------------------------------------------------------------------
      // KTC-specific settings (used by ktc_client.js)
      // -------------------------------------------------------------------------
      ktc: {
        table: "ktc_values",
        pageSize: 300,
        maxPages: 20,
        // If you ever move KTC to a dedicated Supabase project,
        // extend this with its own url/anonKey and update ktc_client.js.
      },
  
      // -------------------------------------------------------------------------
      // Playoffs: 6-team, QF → SF → Final
      // -------------------------------------------------------------------------
      PLAYOFFS: {
        enabled: true,
        quarterfinalWeek: 15,
        semifinalWeek: 16,
        championshipWeek: 17,
  
        // Map Sleeper winners_bracket round -> label + NFL week
        rounds: {
          1: { label: "Quarterfinals", week: 15 },
          2: { label: "Semifinals", week: 16 },
          3: { label: "Championship", week: 17 },
        },
      },
  
      // Legacy fields (some older scripts may still read these)
      SEMIFINAL_WEEK: 16,
      CHAMPIONSHIP_WEEK: 17,
  
      // -------------------------------------------------------------------------
      // Caching / UX
      // -------------------------------------------------------------------------
      CACHE_TTL_MS: 2 * 60 * 1000, // 2 minutes
  
      ui: {
        darkMode: true,
        showIDP: false,
        showBenchByDefault: false,
        maxWeeksSelectable: 17,
      },
    };
  
    // Expose main config first so other scripts can safely read it.
    window.LEAGUE_CONFIG = LEAGUE_CONFIG;
  
    // ---------------------------------------------------------------------------
    // Bridge: SleeperClient Supabase config for sleeper_snapshots
    //
    // Used by sleeper_client.js (getSupabaseClient / persistSnapshotToSupabase).
    // ---------------------------------------------------------------------------
    window.SUPABASE_CONFIG = {
      ENABLED: true,
      SUPABASE_URL: LEAGUE_CONFIG.supabase.url,
      SUPABASE_ANON_KEY: LEAGUE_CONFIG.supabase.anonKey,
      TABLE_NAME: "sleeper_snapshots",
      // We manually persist snapshots from newsletter.js, but leaving this true
      // keeps getLeagueSnapshot() useful if you ever call it directly.
      AUTO_PERSIST_SNAPSHOTS: true,
    };
  })();
  