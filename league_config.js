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
  
    const PHRASE_SUPABASE_URL =
      "https://mugfsmqcrkfsehdyoruy.supabase.co";
    const PHRASE_SUPABASE_ANON =
      "sb_publishable_z6H9o_SOKq4VngF2JD3Peg_5NmwjMfW";
  
    const LEAGUE_CONFIG = {
      // -------------------------------------------------------------------------
      // Core Sleeper league identity
      // -------------------------------------------------------------------------
      LEAGUE_ID: "1180559121900638208",
  
      // Backwards-compat alias some scripts might still reference
      SLEEPER_LEAGUE_ID: "1180559121900638208",
  
      // -------------------------------------------------------------------------
      // Phrases / recap engine Supabase config (existing)
      // -------------------------------------------------------------------------
      PHRASE_CONFIG: {
        url: PHRASE_SUPABASE_URL,
        anonKey: PHRASE_SUPABASE_ANON,
      },
  
      // -------------------------------------------------------------------------
      // Generic Supabase config for app data (KTC, receipts, etc.)
      // -------------------------------------------------------------------------
      supabase: {
        // If you use the same project for everything, just reuse the phrase one:
        url: PHRASE_SUPABASE_URL,
        anonKey: PHRASE_SUPABASE_ANON,
  
        // Optional: override table + pagination for ktc_client.js
        ktcTable: "ktc_values", // table containing your KTC dump
        ktcPageSize: 300,       // rows per page to pull
        ktcMaxPages: 20,        // safety cap, 300 * 20 = 6000 rows max
      },
  
      // -------------------------------------------------------------------------
      // KTC-specific settings (used by ktc_client.js)
      // -------------------------------------------------------------------------
      ktc: {
        table: "ktc_values",
        pageSize: 300,
        maxPages: 20,
        // If you ever move KTC to a dedicated Supabase project,
        // you can extend this with its own url/anonKey and update
        // ktc_client.js to prefer ktc.supabaseOverride.
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
  
    window.LEAGUE_CONFIG = LEAGUE_CONFIG;
  })();
  