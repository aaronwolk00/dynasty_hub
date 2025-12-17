// phrases.js
// -----------------------------------------------------------------------------
// PhraseEngine – data-driven recap generator
//
// - Loads nlg_phrases from Supabase once (init)
// - analyzeGameContext(ctx) builds meta stats + narrative flags
// - buildResultSentence(ctx) picks a lead + color template and renders it
//
// Expects LEAGUE_CONFIG.PHRASE_CONFIG.{url, anonKey} to exist.
// Supabase table: nlg_phrases
//   slot: "lead" | "color"
//   text_template: string with {{winner_name}}, {{margin}}, etc.
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    const TABLE_NAME = "nlg_phrases";
  
    const state = {
      supabase: null,
      loaded: false,
      degraded: false, // if true, PhraseEngine becomes a no-op
      leads: [],
      colors: [],
      usedLeadIds: new Set(),
      usedColorIds: new Set(),
      currentWeek: null,
    };
  
    // ------------------------------------------------------------
    // Supabase wiring
    // ------------------------------------------------------------
  
    function getSupabaseClient() {
      if (state.supabase) return state.supabase;
  
      const cfg =
        (window.LEAGUE_CONFIG && window.LEAGUE_CONFIG.PHRASE_CONFIG) || null;
  
      if (!cfg || !cfg.url || !cfg.anonKey) {
        console.error(
          "[PhraseEngine] Supabase PHRASE_CONFIG missing in league_config.js."
        );
        throw new Error("Supabase config missing for PhraseEngine");
      }
  
      if (!window.supabase || !window.supabase.createClient) {
        console.error(
          "[PhraseEngine] supabase.js UMD client not available on window."
        );
        throw new Error("Supabase client library not loaded");
      }
  
      state.supabase = window.supabase.createClient(cfg.url, cfg.anonKey, {
        auth: { persistSession: false },
      });
  
      return state.supabase;
    }
  
    async function init() {
      if (state.loaded) return;
      let client;
  
      try {
        client = getSupabaseClient();
      } catch (err) {
        state.degraded = true;
        throw err;
      }
  
      const { data, error } = await client.from(TABLE_NAME).select("*");
  
      if (error) {
        console.error("[PhraseEngine] Supabase query error:", error);
        state.degraded = true;
        throw error;
      }
  
      if (!Array.isArray(data)) {
        console.error("[PhraseEngine] Unexpected Supabase payload:", data);
        state.degraded = true;
        throw new Error("Invalid nlg_phrases payload");
      }
  
      const leads = data.filter((row) => row.slot === "lead");
      const colors = data.filter((row) => row.slot === "color");
  
      state.leads = leads;
      state.colors = colors;
      state.loaded = true;
      state.degraded = false;
      state.usedLeadIds = new Set();
      state.usedColorIds = new Set();
  
      console.log(
        `[PhraseEngine] Loaded ${leads.length} lead templates and ${colors.length} color templates from Supabase.`
      );
  
      if (!leads.length || !colors.length) {
        console.error(
          "[PhraseEngine] nlg_phrases has no lead or color rows. Check the `slot` column values."
        );
        state.degraded = true;
        throw new Error("nlg_phrases has no leads/colors");
      }
    }
  
    // ------------------------------------------------------------
    // Context analysis – meta stats for a matchup
    // ------------------------------------------------------------
  
    function safeNumber(x, fallback) {
      const v = Number(x);
      return Number.isFinite(v) ? v : fallback;
    }
  
    function sumPointsFromObjects(arr) {
      if (!Array.isArray(arr)) return 0;
      return arr.reduce((acc, p) => {
        if (!p || typeof p !== "object") return acc;
        const val = safeNumber(
          p.fantasyPoints != null
            ? p.fantasyPoints
            : p.points != null
            ? p.points
            : p.score,
          0
        );
        return acc + (val > 0 ? val : 0);
      }, 0);
    }
  
    function analyzeGameContext(ctx) {
      const { model, entry, week, leagueName, allScoresThisWeek } = ctx || {};
      const teams = (entry && entry.teams) || [];
      const teamA = teams[0] || {};
      const teamB = teams[1] || {};
  
      const scoreA = safeNumber(teamA.score, safeNumber(model && model.muA, 0));
      const scoreB = safeNumber(teamB.score, safeNumber(model && model.muB, 0));
  
      let winnerTeam = teamA;
      let loserTeam = teamB;
      let winnerScore = scoreA;
      let loserScore = scoreB;
      let winnerName =
        (teamA.team && teamA.team.teamDisplayName) || (model && model.nameA) || "";
      let loserName =
        (teamB.team && teamB.team.teamDisplayName) || (model && model.nameB) || "";
  
      if (scoreB > scoreA) {
        winnerTeam = teamB;
        loserTeam = teamA;
        winnerScore = scoreB;
        loserScore = scoreA;
        winnerName =
          (teamB.team && teamB.team.teamDisplayName) ||
          (model && model.nameB) ||
          "";
        loserName =
          (teamA.team && teamA.team.teamDisplayName) ||
          (model && model.nameA) ||
          "";
      }
  
      const margin = Math.abs(winnerScore - loserScore);
      const total = winnerScore + loserScore;
  
      // Margin buckets
      let marginBucket = "normal";
      if (margin < 1.0) marginBucket = "razor";
      else if (margin < 5.0) marginBucket = "close";
      else if (margin >= 50.0) marginBucket = "historic";
      else if (margin >= 30.0) marginBucket = "blowout";
  
      // Bench choke – loser left enough on the bench to flip result?
      const loserStarters = Array.isArray(loserTeam.starters)
        ? loserTeam.starters
        : [];
      const loserBench = Array.isArray(loserTeam.bench)
        ? loserTeam.bench
        : [];
  
      const loserStarterPts = sumPointsFromObjects(loserStarters);
      const loserBenchPts = sumPointsFromObjects(loserBench);
  
      const benchGap = loserBenchPts - loserStarterPts;
      const benchChoke =
        loserBenchPts > loserScore && loserBenchPts >= loserScore + margin - 1;
  
      // All-play robbery – loser beats ~75% of league but loses
      let valiantLoss = false;
      if (Array.isArray(allScoresThisWeek) && allScoresThisWeek.length > 3) {
        const sorted = allScoresThisWeek
          .map((v) => Number(v))
          .filter((v) => Number.isFinite(v))
          .sort((a, b) => a - b);
        if (sorted.length) {
          const cutoffIdx = Math.floor(sorted.length * 0.75);
          const thresh = sorted[cutoffIdx] ?? sorted[sorted.length - 1];
          valiantLoss = loserScore >= thresh;
        }
      }
  
      // Toilet bowl – both teams bad
      const toiletBowl = total < 180;
  
      // Carry job – one player is >= 35% of winner’s points
      const winnerStarters = Array.isArray(winnerTeam.starters)
        ? winnerTeam.starters
        : [];
      let carryPlayer = null;
      let carryPts = 0;
  
      winnerStarters.forEach((p) => {
        if (!p || typeof p !== "object") return;
        const pts = safeNumber(
          p.fantasyPoints != null
            ? p.fantasyPoints
            : p.points != null
            ? p.points
            : p.score,
          0
        );
        if (pts > carryPts) {
          carryPts = pts;
          carryPlayer = p;
        }
      });
  
      const carryShare = winnerScore > 0 ? carryPts / winnerScore : 0;
      const carryJob = carryShare >= 0.35;
  
      const narratives = [];
      if (benchChoke) narratives.push("bench_choke");
      if (valiantLoss) narratives.push("valiant_loss");
      if (toiletBowl) narratives.push("toilet_bowl");
      if (carryJob) narratives.push("carry_job");
      narratives.push("margin_" + marginBucket);
  
      return {
        week: week,
        leagueName: leagueName || "",
        winnerName,
        loserName,
        winnerScore,
        loserScore,
        margin,
        totalScore: total,
        loserBenchPoints: loserBenchPts,
        benchGap,
        carryShare,
        carryPlayerName:
          (carryPlayer && (carryPlayer.displayName || carryPlayer.full_name)) ||
          null,
        carryPlayerPoints: carryPts,
        marginBucket,
        benchChoke,
        valiantLoss,
        toiletBowl,
        carryJob,
        narratives,
      };
    }
  
    // ------------------------------------------------------------
    // Week-scoped reuse control
    // ------------------------------------------------------------
  
    function beginWeek(week) {
      state.currentWeek = week;
      state.usedLeadIds = new Set();
      state.usedColorIds = new Set();
    }
  
    // ------------------------------------------------------------
    // Template rendering (supports {{snake_case}} and {UPPER_CASE})
    // ------------------------------------------------------------
  
    function buildTokenMap(meta) {
      const m = meta || {};
      const tokens = {};
  
      function put(key, value, formatter) {
        if (value == null) return;
        tokens[key] = formatter ? formatter(value) : String(value);
      }
  
      const winnerScoreStr = Number.isFinite(m.winnerScore)
        ? m.winnerScore.toFixed(1)
        : "";
      const loserScoreStr = Number.isFinite(m.loserScore)
        ? m.loserScore.toFixed(1)
        : "";
      const marginStr = Number.isFinite(m.margin) ? m.margin.toFixed(1) : "";
      const totalStr = Number.isFinite(m.totalScore)
        ? m.totalScore.toFixed(1)
        : "";
      const benchStr = Number.isFinite(m.loserBenchPoints)
        ? m.loserBenchPoints.toFixed(1)
        : "";
      const carryPtsStr = Number.isFinite(m.carryPlayerPoints)
        ? m.carryPlayerPoints.toFixed(1)
        : "";
  
      // Names / labels
      put("winner_name", m.winnerName);
      put("WINNER_NAME", m.winnerName);
      put("loser_name", m.loserName);
      put("LOSER_NAME", m.loserName);
      put("league_name", m.leagueName);
      put("LEAGUE_NAME", m.leagueName);
  
      // Scores
      put("winner_score", winnerScoreStr);
      put("WINNER_SCORE", winnerScoreStr);
      put("loser_score", loserScoreStr);
      put("LOSER_SCORE", loserScoreStr);
      put("margin", marginStr);
      put("MARGIN", marginStr);
      put("total_score", totalStr);
      put("TOTAL_SCORE", totalStr);
      put("total", totalStr);
      put("TOTAL", totalStr);
  
      // Week
      put("week", m.week);
      put("WEEK", m.week);
  
      // Bench / carry info
      put("loser_bench_points", benchStr);
      put("LOSER_BENCH_POINTS", benchStr);
      put("bench_gap", m.benchGap, (v) => v.toFixed(1));
      put("BENCH_GAP", m.benchGap, (v) => v.toFixed(1));
  
      put("carry_player_name", m.carryPlayerName);
      put("CARRY_PLAYER_NAME", m.carryPlayerName);
      put("carry_player_points", carryPtsStr);
      put("CARRY_PLAYER_POINTS", carryPtsStr);
  
      const carrySharePct =
        m.carryShare != null && Number.isFinite(m.carryShare)
          ? (m.carryShare * 100).toFixed(1) + "%"
          : "";
      put("carry_share", carrySharePct);
      put("CARRY_SHARE", carrySharePct);
  
      return tokens;
    }
  
    function renderTemplate(templateText, meta) {
      if (!templateText || typeof templateText !== "string") return "";
      const tokens = buildTokenMap(meta);
  
      function replacer(match, key) {
        const trimmed = String(key).trim();
        if (Object.prototype.hasOwnProperty.call(tokens, trimmed)) {
          return tokens[trimmed];
        }
        return match;
      }
  
      // Handle {{snake_case}} style
      let out = templateText.replace(/\{\{\s*([^}]+?)\s*\}\}/g, replacer);
  
      // Handle legacy {UPPER_CASE} style (used by older local templates)
      out = out.replace(/\{([A-Z0-9_]+)\}/g, replacer);
  
      return out;
    }
  
    // Local fallback (kept for emergencies but not used in normal flow)
    const LOCAL_LEADS = [
      "{WINNER_NAME} edges out {LOSER_NAME} by {MARGIN} in Week {WEEK}.",
      "{WINNER_NAME} cruises past {LOSER_NAME}, {WINNER_SCORE}–{LOSER_SCORE}.",
    ];
    const LOCAL_COLORS = [
      "Tough scene for {LOSER_NAME}, who’s going to replay this matchup all week.",
      "{WINNER_NAME} stays in the mix while {LOSER_NAME} heads back to the drawing board.",
    ];
  
    function pickRandom(arr) {
      if (!Array.isArray(arr) || !arr.length) return null;
      const idx = Math.floor(Math.random() * arr.length);
      return arr[idx];
    }
  
    function buildLocalSentence(meta) {
      const leadT = pickRandom(LOCAL_LEADS);
      const colorT = pickRandom(LOCAL_COLORS);
      const lead = leadT ? renderTemplate(leadT, meta) : "";
      const color = colorT ? renderTemplate(colorT, meta) : "";
      return (lead + " " + color).trim();
    }
  
    // ------------------------------------------------------------
    // Phrase selection from Supabase cache
    // ------------------------------------------------------------
  
    function chooseTemplatesFromSupabase(meta) {
      if (!state.loaded || state.degraded) {
        return { leadText: "", colorText: "" };
      }
  
      const margin = meta.margin;
      const total = meta.totalScore;
      const benchChoke = meta.benchChoke;
      const valiant = meta.valiantLoss;
      const carry = meta.carryJob;
  
      function matchesRow(row) {
        // Margin window
        if (row.min_margin != null && margin < row.min_margin) return false;
        if (row.max_margin != null && margin > row.max_margin) return false;
  
        // Combined score window
        if (row.min_total_score != null && total < row.min_total_score)
          return false;
        if (row.max_total_score != null && total > row.max_total_score)
          return false;
  
        // Flags
        if (row.requires_bench_choke && !benchChoke) return false;
        if (row.requires_valiant_loss && !valiant) return false;
        if (row.requires_carry_job && !carry) return false;
  
        return true;
      }
  
      function weightedPick(rows, usedIdsSet) {
        if (!rows.length) return null;
  
        let candidates = rows.filter((r) => !usedIdsSet.has(r.id));
        if (!candidates.length) {
          candidates = rows; // allow reuse if everything has been used
        }
  
        const weights = candidates.map((r) =>
          Number.isFinite(r.weight) && r.weight > 0 ? r.weight : 1
        );
        const totalWeight = weights.reduce((a, b) => a + b, 0);
        let roll = Math.random() * totalWeight;
  
        for (let i = 0; i < candidates.length; i++) {
          roll -= weights[i];
          if (roll <= 0) return candidates[i];
        }
        return candidates[candidates.length - 1];
      }
  
      const eligibleLeads = state.leads.filter(matchesRow);
      const eligibleColors = state.colors.filter(matchesRow);
  
      const pickedLead = weightedPick(eligibleLeads, state.usedLeadIds);
      const pickedColor = weightedPick(eligibleColors, state.usedColorIds);
  
      if (pickedLead) state.usedLeadIds.add(pickedLead.id);
      if (pickedColor) state.usedColorIds.add(pickedColor.id);
  
      return {
        leadText: pickedLead ? pickedLead.text_template : "",
        colorText: pickedColor ? pickedColor.text_template : "",
      };
    }
  
    // ------------------------------------------------------------
    // Public: buildResultSentence
    // ------------------------------------------------------------
  
    function buildResultSentence(ctx) {
      if (!state.loaded || state.degraded) {
        console.warn(
          "[PhraseEngine] buildResultSentence called before phrases were loaded or in degraded mode."
        );
        return "";
      }
  
      const meta = analyzeGameContext(ctx);
  
      const picked = chooseTemplatesFromSupabase(meta);
  
      if (!picked || (!picked.leadText && !picked.colorText)) {
        console.warn(
          "[PhraseEngine] No suitable Supabase phrases found for matchup:",
          meta
        );
        // optional local fallback:
        return buildLocalSentence(meta);
      }
  
      const leadRendered = picked.leadText
        ? renderTemplate(picked.leadText, meta)
        : "";
      const colorRendered = picked.colorText
        ? renderTemplate(picked.colorText, meta)
        : "";
  
      return (leadRendered + " " + colorRendered).trim();
    }
  
    // ------------------------------------------------------------
    // Expose
    // ------------------------------------------------------------
  
    window.PhraseEngine = {
      init,
      analyzeGameContext,
      buildResultSentence,
      beginWeek,
    };
  })();
  