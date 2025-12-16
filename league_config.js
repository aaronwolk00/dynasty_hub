// league_config.js
// -----------------------------------------------------------------------------
// Static configuration for your Sleeper league frontend.
// This DOES NOT hardcode team names or seeds – those come from Sleeper.
// Instead, it defines:
//   - Which league to target
//   - Which weeks are semifinals / finals
//   - How the playoff bracket is structured by SEED
//
// Other scripts (models.js, projections.js, newsletter.js, main.js) will:
//
//   1) Pull league + roster data from Sleeper via SleeperAPI.LEAGUE_ID
//   2) Read each roster's `settings.playoff_seed` and current record
//   3) Match seeds into this bracket structure
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    const LEAGUE_CONFIG = {
      // Your Sleeper league ID
      LEAGUE_ID: "1180559121900638208",
      SEMIFINAL_WEEK: 16,
      CHAMPIONSHIP_WEEK: 17,
  
      // UI preferences for the front-end
      ui: {
        darkMode: true,
        // whether to display IDP/defensive players in the same views
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
  