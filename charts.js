// charts.js
// -----------------------------------------------------------------------------
// Light wrapper around Chart.js for visualizing:
//   - Championship odds (bar chart)
//   - Semifinal win odds (stacked bar per matchup)
//   - Optional score distribution curves
// -----------------------------------------------------------------------------
//
// Exposes:
//   window.PlayoffCharts = {
//     renderChampionshipOdds(canvasId, oddsArray),
//     renderSemifinalOdds(canvasId, semifinalArray),
//     renderScoreDistribution(canvasId, distConfig)
//   };
// -----------------------------------------------------------------------------

(function () {
    "use strict";
  
    if (!window.Chart) {
      console.warn("[charts.js] Chart.js not found – chart rendering will be skipped.");
    }
  
    const chartsById = {};
  
    function getContext(canvasId) {
      const el = document.getElementById(canvasId);
      if (!el) {
        console.warn("[charts.js] Canvas not found:", canvasId);
        return null;
      }
      return el.getContext("2d");
    }
  
    function cleanupChart(canvasId) {
      const existing = chartsById[canvasId];
      if (existing) {
        existing.destroy();
        delete chartsById[canvasId];
      }
    }
  
    function renderChampionshipOdds(canvasId, oddsArray) {
      if (!window.Chart || !Array.isArray(oddsArray) || oddsArray.length === 0) return;
      const ctx = getContext(canvasId);
      if (!ctx) return;
  
      cleanupChart(canvasId);
  
      const labels = oddsArray.map((o) => o.teamName);
      const percents = oddsArray.map((o) =>
        Math.round((o.probability || 0) * 1000) / 10
      );
  
      chartsById[canvasId] = new Chart(ctx, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: "Title Odds (%)",
              data: percents,
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (context) => `${context.parsed.y.toFixed(1)}%`,
              },
            },
          },
          scales: {
            x: {
              ticks: {
                maxRotation: 30,
                minRotation: 0,
              },
              grid: { display: false },
            },
            y: {
              beginAtZero: true,
              suggestedMax: 50,
              ticks: {
                callback: (val) => `${val}%`,
              },
            },
          },
        },
      });
    }
  
    function renderSemifinalOdds(canvasId, semifinalArray) {
      if (!window.Chart || !Array.isArray(semifinalArray) || semifinalArray.length === 0)
        return;
      const ctx = getContext(canvasId);
      if (!ctx) return;
  
      cleanupChart(canvasId);
  
      const labels = semifinalArray.map(
        (m) => m.label || `${m.favoriteName} vs ${m.underdogName}`
      );
      const favPercents = semifinalArray.map((m) =>
        Math.round((m.favoriteWinProb || 0) * 1000) / 10
      );
      const dogPercents = semifinalArray.map((m) => {
        const p = m.favoriteWinProb != null ? 1 - m.favoriteWinProb : 0;
        return Math.round(p * 1000) / 10;
      });
  
      chartsById[canvasId] = new Chart(ctx, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: "Favorite",
              data: favPercents,
              borderWidth: 1,
              stack: "stack0",
            },
            {
              label: "Underdog",
              data: dogPercents,
              borderWidth: 1,
              stack: "stack0",
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            tooltip: {
              callbacks: {
                label: (context) =>
                  `${context.dataset.label}: ${context.parsed.y.toFixed(1)}%`,
              },
            },
          },
          scales: {
            x: {
              stacked: true,
              grid: { display: false },
            },
            y: {
              stacked: true,
              beginAtZero: true,
              max: 100,
              ticks: {
                callback: (val) => `${val}%`,
              },
            },
          },
        },
      });
    }
  
    function renderScoreDistribution(canvasId, distConfig) {
      if (!window.Chart || !distConfig || !Array.isArray(distConfig.points)) return;
      const ctx = getContext(canvasId);
      if (!ctx) return;
  
      cleanupChart(canvasId);
  
      const xs = distConfig.points.map((p) => p.x);
      const ys = distConfig.points.map((p) => p.y);
  
      chartsById[canvasId] = new Chart(ctx, {
        type: "line",
        data: {
          labels: xs,
          datasets: [
            {
              label: distConfig.label || "Score Distribution",
              data: ys,
              borderWidth: 2,
              tension: 0.25,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (context) =>
                  `P(score ≈ ${context.label}): ${(context.parsed.y * 100).toFixed(
                    1
                  )}%`,
              },
            },
          },
          scales: {
            x: {
              title: { display: true, text: "Fantasy Points" },
              grid: { display: false },
            },
            y: {
              title: { display: true, text: "Probability" },
              beginAtZero: true,
            },
          },
        },
      });
    }
  
    window.PlayoffCharts = {
      renderChampionshipOdds,
      renderSemifinalOdds,
      renderScoreDistribution,
    };
  })();
  