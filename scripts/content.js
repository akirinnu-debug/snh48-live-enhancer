// ========== SNH48 Live Enhancer - Content Script (Main Entry) ==========
// 版本: 2.0.0
// 此文件仅包含配置加载与初始化入口，功能模块已拆分至独立文件

(function () {
  "use strict";

  var SNH48 = window.SNH48 || (window.SNH48 = {});

  // ---- 配置 ----
  var DEFAULT_CONFIG = SNH48_DEFAULT_CONFIG;
  SNH48.DEFAULT_CONFIG = DEFAULT_CONFIG;

  var config = Object.assign({}, DEFAULT_CONFIG);
  SNH48.config = config;

  function loadConfig() {
    return new Promise(function (resolve) {
      if (!SNH48.isExtensionContextAlive()) { resolve(config); return; }
      try {
        chrome.storage.sync.get("snh48_config", function (data) {
          if (chrome.runtime.lastError) {
            resolve(config);
            return;
          }
          if (data.snh48_config) {
            config = Object.assign({}, DEFAULT_CONFIG, data.snh48_config);
            SNH48.config = config;
          }
          SNH48.log("配置已加载:", config);
          resolve(config);
        });
      } catch (e) {
        resolve(config);
      }
    });
  }

  function saveConfig() {
    if (!SNH48.isExtensionContextAlive()) return;
    try {
      chrome.storage.sync.set({ snh48_config: config }, function () {
        if (chrome.runtime.lastError) return;
      });
    } catch (e) {
      SNH48.error("saveConfig 异常:", e);
    }
  }

  // ---- 隐藏头部 ----
  function applyHideHeader() {
    if (config.hideHeader) {
      document.body.classList.add("snh48-hide-header");
    }
  }

  // 导出到全局命名空间
  SNH48.saveConfig = saveConfig;
  SNH48.applyHideHeader = applyHideHeader;

  // ---- 初始化 ----
  async function init() {
    SNH48.log("初始化开始, URL:", window.location.href);
    await loadConfig();

    // 监听配置变更（跨标签页/弹窗同步）
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === "sync" && changes.snh48_config) {
          var newConfig = changes.snh48_config.newValue;
          if (newConfig) {
            config = Object.assign({}, DEFAULT_CONFIG, newConfig);
            SNH48.config = config;
            // 应用变更
            if (SNH48.applyDarkMode) SNH48.applyDarkMode(config.darkMode);
            if (SNH48.applyHideHeader) SNH48.applyHideHeader();
            // 更新浮动面板开关状态
            var panel = document.getElementById("snh48-float-panel");
            if (panel) {
              Object.keys(newConfig).forEach(function (key) {
                var checkbox = panel.querySelector('input[data-key="' + key + '"]');
                if (checkbox) checkbox.checked = newConfig[key];
              });
            }
            SNH48.log("配置已从其他标签页同步");
          }
        }
      });
    }

    await SNH48.loadMemberIndex();
    await SNH48.loadWatchHistory();

    function go() {
      SNH48.log("DOM ready, body:", !!document.body);
      // 暗黑模式尽早应用
      SNH48.applyDarkMode(config.darkMode);
      applyHideHeader();

      // 等待 body
      function waitBody(cb) {
        if (document.body) cb();
        else setTimeout(function () { waitBody(cb); }, 100);
      }

      waitBody(function () {
        requestAnimationFrame(function () {
          setTimeout(function () {
            try {
              SNH48.injectEmbeddedSearch();
              SNH48.createFloatPanel();
              SNH48.setupVideoShortcuts();
              SNH48.setupVideoProgressMemory();
              SNH48.createQuickNav();
              SNH48.setupReminder();
              // 公演页：建立成员-公演反向索引
              SNH48.indexCurrentPagePerformers();
              SNH48.autoRecordCurrentPage();
              SNH48.log("所有功能初始化完成");
            } catch (e) {
              SNH48.error("初始化异常:", e);
            }
          }, 300);
        });
      });
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", go);
    } else {
      go();
    }
  }

  init();
})();
