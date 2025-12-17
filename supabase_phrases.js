// supabase_phrases.js
// ------------------------------------------------------------
// Tiny client to fetch newsletter phrase templates from Supabase.
// Exposes window.PhrasesClient.getRandomPhrase({ category }).
// ------------------------------------------------------------

(function () {
    "use strict";
  
    if (!window.supabase || !window.supabase.createClient) {
      console.error("[phrases] Supabase JS not loaded");
      return;
    }
  
    // TODO: fill these in from your Supabase project settings
    const SUPABASE_URL = "https://mugfsmqcrkfsehdyoruy.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_z6H9o_SOKq4VngF2JD3Peg_5NmwjMfW";
  
    const { createClient } = window.supabase;
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  
    /**
     * Fetch a random active phrase.
     *
     * @param {Object} opts
     * @param {string} [opts.category] - e.g. "blowout", "close_game"
     * @returns {Promise<string|null>}
     */
    async function getRandomPhrase(opts) {
      const category = opts && opts.category ? opts.category : null;
  
      let query = client
        .from("nlg_phrases")
        .select("template")
        .eq("is_active", true);
  
      if (category) {
        query = query.eq("category", category);
      }
  
      const { data, error } = await query;
      if (error) {
        console.warn("[phrases] Supabase error:", error);
        return null;
      }
      if (!data || !data.length) {
        return null;
      }
  
      const idx = Math.floor(Math.random() * data.length);
      return data[idx].template;
    }
  
    window.PhrasesClient = {
      getRandomPhrase,
    };
  })();
  