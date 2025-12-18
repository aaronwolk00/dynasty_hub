// supabase.js
// -----------------------------------------------------------------------------
// ES module wrapper around the UMD Supabase client.
//
// Usage in HTML:
//   <!-- UMD Supabase (sets window.supabase) -->
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
//
//   <!-- League config defines LEAGUE_CONFIG.supabase.{url, anonKey} -->
//   <script src="league_config.js"></script>
//
//   <!-- This module creates a single shared client and exports it -->
//   <script type="module" src="supabase.js"></script>
//   <script type="module" src="ktc_client.js"></script>
// -----------------------------------------------------------------------------

const leagueCfg =
  (typeof window !== "undefined" &&
    window.LEAGUE_CONFIG &&
    window.LEAGUE_CONFIG.supabase) ||
  {};

const SUPABASE_URL = leagueCfg.url || null;
const SUPABASE_ANON_KEY = leagueCfg.anonKey || null;

let client = null;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    "[supabase] Missing LEAGUE_CONFIG.supabase.url or .anonKey – exported client will be null."
  );
} else if (!window.supabase || typeof window.supabase.createClient !== "function") {
  console.warn(
    "[supabase] window.supabase.createClient is not available. " +
      "Ensure the UMD @supabase/supabase-js script tag is loaded before supabase.js."
  );
} else {
  // Reuse a single client across modules / reloads to avoid multiple GoTrueClient instances.
  if (window.__SUPABASE_LEAGUE_CLIENT__) {
    client = window.__SUPABASE_LEAGUE_CLIENT__;
  } else {
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    window.__SUPABASE_LEAGUE_CLIENT__ = client;
  }
}

export const supabase = client;
