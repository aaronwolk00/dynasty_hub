// league_config.js
(function () {
    "use strict";
  
    const LEAGUE_CONFIG = {
      // Core league
      LEAGUE_ID: "1180559121900638208",
  
      PHRASE_CONFIG: {
        url: "https://mugfsmqcrkfsehdyoruy.supabase.co",
        anonKey: "sb_publishable_z6H9o_SOKq4VngF2JD3Peg_5NmwjMfW",
      },
  
      // Playoffs: 6-team, QF → SF → Final
      PLAYOFFS: {
        enabled: true,
        quarterfinalWeek: 15,
        semifinalWeek: 16,
        championshipWeek: 17,
  
        // Map Sleeper winners_bracket round (r) → label + NFL week
        rounds: {
          1: { label: "Quarterfinals", week: 15 },
          2: { label: "Semifinals", week: 16 },
          3: { label: "Championship", week: 17 },
        },
      },
  
      // For anything else still using these
      SEMIFINAL_WEEK: 16,
      CHAMPIONSHIP_WEEK: 17,
  
      CACHE_TTL_MS: 2 * 60 * 1000,
  
      ui: {
        darkMode: true,
        showIDP: false,
        showBenchByDefault: false,
        maxWeeksSelectable: 17,
      },
    };
  
    window.LEAGUE_CONFIG = LEAGUE_CONFIG;
  })();
  