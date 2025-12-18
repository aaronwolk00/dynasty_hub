// supabase.js (ES module wrapper around UMD global)
// Must be loaded with: <script type="module" src="supabase.js"></script>

const leagueCfg = (window.LEAGUE_CONFIG && window.LEAGUE_CONFIG.supabase) || {};
const SUPABASE_URL = leagueCfg.url || null;
const SUPABASE_ANON_KEY = leagueCfg.anonKey || null;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    "[supabase] Missing LEAGUE_CONFIG.supabase.url or .anonKey – exported client will be null."
  );
}

export const supabase =
  window.supabase && SUPABASE_URL && SUPABASE_ANON_KEY
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;
