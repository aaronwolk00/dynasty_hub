// league_config.js
// -----------------------------------------------------------------------------
// Static configuration for your Sleeper league frontend.
// This DOES NOT hardcode team names or seeds – those come from Sleeper.
//
// Other scripts will:
//   - Read LEAGUE_ID to know which league to query
//   - Use SEMIFINAL_WEEK / CHAMPIONSHIP_WEEK to map bracket rounds to weeks
//   - Read ui.* for small front-end preferences
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    const LEAGUE_CONFIG = {
      // Your Sleeper league ID
      LEAGUE_ID: "1180559121900638208",
  
      // Postseason structure for this specific season
      SEMIFINAL_WEEK: 16,
      CHAMPIONSHIP_WEEK: 17,
  
      // Optional cache TTL (ms) for Sleeper API responses
      CACHE_TTL_MS: 2 * 60 * 1000, // 2 minutes
  
      // UI preferences for the front-end
      ui: {
        darkMode: true,
        // whether to display IDP/defensive players in shared views
        showIDP: false,
        // whether to show bench players in matchup breakdowns by default
        showBenchByDefault: false,
        // max number of weeks to offer in a week selector dropdown
        maxWeeksSelectable: 17,
      },
    };
  
    // Attach to window so other scripts can access LEAGUE_CONFIG
    window.LEAGUE_CONFIG = LEAGUE_CONFIG;
  })();
  