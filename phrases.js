// phrases.js
// -----------------------------------------------------------------------------
// Supabase-backed phrase engine for recap / headline snippets.
//
// Table assumption in Supabase (table name: `phrases`):
//   id          bigint (PK)
//   template    text   -- e.g. '{winner} routed {loser} {score1}-{score2} behind {player}\'s {player_points}'
//   category    text   -- 'blowout' | 'close' | 'nailbiter' | 'generic' | 'any' (optional)
//   min_margin  numeric (optional)
//   max_margin  numeric (optional)
//   mode        text   -- 'results' | 'projections' | 'both' (optional)
//
// You can change the table/column names below if your schema differs.
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    // ---------------------------------------------------------------------------
    // 1. Supabase client
    // ---------------------------------------------------------------------------
    //
    // IMPORTANT: Replace these two values with your actual project URL + anon key
    // from Supabase (Project Settings → API).
    //
    // These are PUBLIC keys – they belong in the browser.
    // ---------------------------------------------------------------------------
  
    const SUPABASE_URL = "https://mugfsmqcrkfsehdyoruy.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_z6H9o_SOKq4VngF2JD3Peg_5NmwjMfW";
  
    if (!window.supabase) {
      console.warn(
        "[phrases.js] Supabase client library not found. " +
          "Include https://unpkg.com/@supabase/supabase-js@2 before phrases.js."
      );
      return;
    }
  
    const client = window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_ANON_KEY
    );
  
    // Cached phrase rows so we only hit Supabase once per session
    let cachedPhrases = null;
    let loadingPromise = null;
  
    async function loadAllPhrasesOnce() {
      if (cachedPhrases) return cachedPhrases;
      if (loadingPromise) return loadingPromise;
  
      loadingPromise = client
        .from("phrases")
        .select("*")
        .then(({ data, error }) => {
          loadingPromise = null;
          if (error) {
            console.error("[phrases.js] Failed to load phrases:", error);
            cachedPhrases = [];
            return cachedPhrases;
          }
          cachedPhrases = Array.isArray(data) ? data : [];
          console.log("[phrases.js] Loaded", cachedPhrases.length, "phrases");
          return cachedPhrases;
        });
  
      return loadingPromise;
    }
  
    // ---------------------------------------------------------------------------
    // 2. Helpers: classification, template filling
    // ---------------------------------------------------------------------------
  
    function classifyMargin(margin) {
      if (!Number.isFinite(margin)) return "generic";
      if (margin >= 35) return "blowout";
      if (margin >= 18) return "comfortable";
      if (margin <= 7) return "nailbiter";
      if (margin <= 14) return "close";
      return "generic";
    }
  
    function selectTemplateRow(rows, context) {
      if (!rows || !rows.length) return null;
  
      const margin = context.marginAbs;
      const mode = context.mode || "results";
      const category = classifyMargin(margin);
  
      const candidates = rows.filter((r) => {
        // Mode filter
        if (r.mode && r.mode !== mode && r.mode !== "both") return false;
  
        // Category filter
        if (r.category && r.category !== category && r.category !== "any") {
          return false;
        }
  
        // Margin range filter
        const minMargin =
          typeof r.min_margin === "number" ? r.min_margin : null;
        const maxMargin =
          typeof r.max_margin === "number" ? r.max_margin : null;
        if (minMargin != null && margin < minMargin) return false;
        if (maxMargin != null && margin > maxMargin) return false;
  
        return true;
      });
  
      if (!candidates.length) return null;
      const idx = Math.floor(Math.random() * candidates.length);
      return candidates[idx];
    }
  
    function fillTemplateString(template, context) {
      if (!template) return "";
      return template.replace(/\{(\w+)\}/g, function (_, key) {
        const val = context[key];
        return val != null ? String(val) : "{" + key + "}";
      });
    }
  
    function buildContextFromMatchup(payload) {
      const model = payload.model;
      const entry = payload.entry;
      const week = payload.week;
      const leagueName = payload.leagueName;
      const mode = payload.mode || "results";
  
      const team1 = model.nameA;
      const team2 = model.nameB;
      const score1 = Number(model.muA);
      const score2 = Number(model.muB);
      const margin = Math.abs(score1 - score2);
      const winner = score1 >= score2 ? team1 : team2;
      const loser = winner === team1 ? team2 : team1;
      const total = score1 + score2;
  
      // Simple "star of the game" heuristic: top fantasy scorer in the matchup
      let topPlayerName = null;
      let topPlayerPoints = null;
  
      if (entry && entry.historical && entry.teams && entry.teams.length) {
        entry.teams.forEach((t) => {
          (t.starters || []).forEach((p) => {
            const pts = Number(p.fantasyPoints);
            if (!Number.isFinite(pts)) return;
            if (topPlayerPoints == null || pts > topPlayerPoints) {
              topPlayerPoints = pts;
              topPlayerName = p.displayName || p.playerId;
            }
          });
        });
      }
  
      return {
        // score / matchup
        week,
        leagueName,
        mode,
        team1,
        team2,
        score1: Number.isFinite(score1) ? score1.toFixed(1) : "",
        score2: Number.isFinite(score2) ? score2.toFixed(1) : "",
        winner,
        loser,
        margin,
        marginAbs: margin,
        total: Number.isFinite(total) ? total.toFixed(1) : "",
  
        // aliases for convenience in templates
        team_1: team1,
        team_2: team2,
        player: topPlayerName,
        player_points:
          topPlayerPoints != null ? topPlayerPoints.toFixed(1) : null,
      };
    }
  
    // ---------------------------------------------------------------------------
    // 3. Public API
    // ---------------------------------------------------------------------------
  
    function buildResultSentence(payload) {
      if (!cachedPhrases) {
        // Not loaded yet – caller should have called init() first.
        return null;
      }
      const ctx = buildContextFromMatchup(
        Object.assign({}, payload, { mode: "results" })
      );
      const row = selectTemplateRow(cachedPhrases, ctx);
      if (!row || !row.template) return null;
      return fillTemplateString(row.template, ctx);
    }
  
    // Optional async helper if you ever want to build a sentence
    // before calling init() yourself.
    async function buildResultSentenceAsync(payload) {
      await loadAllPhrasesOnce();
      return buildResultSentence(payload);
    }
  
    window.PhraseEngine = {
      // Call once somewhere early (newsletter.js will do this in results mode).
      init: loadAllPhrasesOnce,
  
      // Synchronous builder – assumes init() has run.
      buildResultSentence,
  
      // Async convenience (not used by newsletter.js right now).
      buildResultSentenceAsync,
    };
  })();
  