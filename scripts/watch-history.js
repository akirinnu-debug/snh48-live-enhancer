// ========== SNH48 Live Enhancer - Watch History ==========
(function () {
  "use strict";

  var SNH48 = window.SNH48 || (window.SNH48 = {});
  var log = SNH48.log;
  var error = SNH48.error;
  var safeStorageSet = SNH48.safeStorageSet;
  var _extSetInterval = SNH48._extSetInterval;

  var HISTORY_KEY = "snh48_watch_history";
  var MAX_HISTORY = 200;

  var history = {};

  function loadHistory() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(HISTORY_KEY, function (data) {
          if (chrome.runtime.lastError) {
            resolve();
            return;
          }
          history = data[HISTORY_KEY] || {};
          SNH48.watchHistory = history;
          log("观看历史已加载, 条目数:", Object.keys(history).length);
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  function saveHistory() {
    safeStorageSet({ [HISTORY_KEY]: history });
  }

  function recordVisit(url, title) {
    if (!url || !url.includes("live.48.cn")) return;
    history[url] = {
      title: title || "",
      ts: Date.now(),
      count: (history[url] ? history[url].count || 0 : 0) + 1
    };
    // Prune if over limit (LRU by timestamp)
    var keys = Object.keys(history);
    if (keys.length > MAX_HISTORY) {
      keys.sort(function (a, b) { return (history[a].ts || 0) - (history[b].ts || 0); });
      while (keys.length > MAX_HISTORY) {
        delete history[keys.shift()];
      }
    }
    saveHistory();
  }

  function isWatched(url) {
    return !!history[url];
  }

  function getRecent(count) {
    var entries = Object.keys(history).map(function (url) {
      return { url: url, title: history[url].title, ts: history[url].ts, count: history[url].count };
    });
    entries.sort(function (a, b) { return b.ts - a.ts; });
    return entries.slice(0, count || 10);
  }

  function clearHistory() {
    history = {};
    SNH48.watchHistory = history;
    safeStorageSet({ [HISTORY_KEY]: {} });
  }

  // Auto-record current page if it's a performance page
  function autoRecordCurrentPage() {
    var url = window.location.href;
    // Only record on performance pages
    if (!url.match(/live\.48\.cn\/Index\/invideo\/club\//)) return;

    // Wait for title to be available
    setTimeout(function () {
      var titleEl = document.querySelector(".title1") || document.querySelector("h1");
      var title = titleEl ? titleEl.textContent.trim() : document.title;
      recordVisit(url, title);
    }, 2000);
  }

  // Expose
  SNH48.loadWatchHistory = loadHistory;
  SNH48.recordVisit = recordVisit;
  SNH48.isWatched = isWatched;
  SNH48.getRecentWatched = getRecent;
  SNH48.clearWatchHistory = clearHistory;
  SNH48.autoRecordCurrentPage = autoRecordCurrentPage;
  SNH48.watchHistory = history;
})();
