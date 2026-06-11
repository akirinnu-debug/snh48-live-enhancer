// ========== SNH48 Live Enhancer - Popup Script ==========
// 版本: 2.0.0 - 移除弹幕相关设置，添加嵌入式搜索、隐藏头部等

(function () {
  "use strict";

  var LOG_PREFIX = "[SNH48-Popup]";

  function log(...args) { /* 生产版：已禁用 */ }

  // 默认配置（引用共享模块）
  var DEFAULT_CONFIG = SNH48_DEFAULT_CONFIG;

  // popup 中需要展示的开关项
  var SWITCH_IDS = [
    "darkMode",
    "hideHeader",
    "videoShortcuts",
    "screenshotEnabled",
    "embeddedSearch",
    "memberIndex",
    "quickNav",
    "reminderEnabled",
  ];

  // 加载配置 - [P1-3.1] 使用统一状态管理
  chrome.runtime.sendMessage({ type: SNH48_MSG.GET_STATE, keys: ["config", "indexStats", "schema"] }, function (state) {
    var config = Object.assign({}, DEFAULT_CONFIG);
    if (state) {
      if (state.config) {
        config = Object.assign({}, DEFAULT_CONFIG, state.config);
      }
      if (state.indexStats) {
        updateStatsDisplay(state.indexStats);
      }
      if (state.schemaStatus && state.schemaStatus.outdated) {
        showSchemaWarning(state.schemaStatus);
      }
    }
    log("配置已加载:", config);
    initUI(config);
  });

  function initUI(config) {
    log("初始化UI");

    // 设置开关状态
    SWITCH_IDS.forEach(function (key) {
      var el = document.getElementById(key);
      if (el) {
        el.checked = !!config[key];
        log("设置开关:", key, config[key]);
      } else {
        log("未找到元素:", key);
      }
    });

    // 绑定事件
    bindEvents();
  }

  function bindEvents() {
    SWITCH_IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) {
        el.addEventListener("change", function () {
          log("开关变更:", id, el.checked);
          saveAndUpdate();
        });
      } else {
        log("事件绑定失败, 未找到元素:", id);
      }
    });
  }

  function saveAndUpdate() {
    // 读取当前 storage 中的配置，保留 popup 中没有的字段
    chrome.storage.sync.get("snh48_config", function (data) {
      var oldConfig = data.snh48_config || {};
      // shortcutPanelCollapsed 在 popup 中不直接展示开关，仅通过浮动面板操作
      var shortcutPanelCollapsed =
        oldConfig.shortcutPanelCollapsed !== false; // 默认 true

      var config = {
        darkMode: getChecked("darkMode"),
        videoShortcuts: getChecked("videoShortcuts"),
        shortcutPanelCollapsed: shortcutPanelCollapsed,
        quickNav: getChecked("quickNav"),
        memberIndex: getChecked("memberIndex"),
        embeddedSearch: getChecked("embeddedSearch"),
        autoPiP: oldConfig.autoPiP || false,
        screenshotEnabled: getChecked("screenshotEnabled"),
        hideHeader: getChecked("hideHeader"),
        reminderEnabled: getChecked("reminderEnabled"),
        reminderMinutesBefore: oldConfig.reminderMinutesBefore || 15,
      };

      log("保存配置:", config);

      chrome.storage.sync.set({ snh48_config: config }, function () {
        if (chrome.runtime.lastError) {
          log("保存失败:", chrome.runtime.lastError);
        } else {
          log("配置已保存");
        }
      });

      // 通知当前标签页
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          if (tabs[0] && tabs[0].url && tabs[0].url.includes("live.48.cn")) {
            log("发送配置更新到标签页:", tabs[0].id);
            chrome.tabs.sendMessage(
              tabs[0].id,
              { type: SNH48_MSG.CONFIG_UPDATED, config: config },
              function (response) {
                if (chrome.runtime.lastError) {
                  log("消息发送失败:", chrome.runtime.lastError.message);
                } else {
                  log("消息发送成功:", response);
                }
              }
            );
          } else {
            log("当前标签页不是 live.48.cn，跳过消息发送");
          }
        });
      } catch (e) {
        log("消息发送异常:", e);
      }
    });
  }

  function getChecked(id) {
    var el = document.getElementById(id);
    return el ? el.checked : false;
  }

  // [P1-3.1] 统一状态管理：索引统计展示
  function updateStatsDisplay(stats) {
    var statusText = document.querySelector(".status-text");
    if (!statusText || !stats) return;
    var total = stats.totalPerformanceCount || stats.performanceCount || 0;
    var members = stats.memberCount || 0;
    statusText.textContent = total + " 场 / " + members + " 人";
  }

  // [P1-3.1] 统一状态管理：Schema 版本过旧警告
  function showSchemaWarning(schemaStatus) {
    var statusBar = document.querySelector(".status-bar");
    if (!statusBar || !schemaStatus) return;
    var existing = statusBar.querySelector(".snh48-schema-warning");
    if (existing) return;
    var warning = document.createElement("div");
    warning.className = "snh48-schema-warning";
    warning.style.cssText = "margin-top:8px;padding:6px 10px;background:rgba(255,165,0,0.12);border:1px solid rgba(255,165,0,0.3);border-radius:6px;font-size:11px;color:#ffa500;";
    warning.textContent = "⚠️ 索引 Schema 版本过旧 (v" + schemaStatus.storedVersion + " → v" + schemaStatus.currentVersion + ")，建议重建索引";
    statusBar.parentNode.insertBefore(warning, statusBar.nextSibling);
  }

  // ---- 配置导出/导入 ----
  var KNOWN_CONFIG_KEYS = [
    "darkMode", "hideHeader", "videoShortcuts", "screenshotEnabled",
    "embeddedSearch", "memberIndex", "quickNav", "reminderEnabled",
    "shortcutPanelCollapsed", "autoPiP", "reminderMinutesBefore"
  ];

  var exportBtn = document.getElementById("exportConfigBtn");
  var importBtn = document.getElementById("importConfigBtn");
  var importFile = document.getElementById("importConfigFile");

  if (exportBtn) {
    exportBtn.addEventListener("click", function () {
      chrome.storage.sync.get("snh48_config", function (data) {
        var cfg = data.snh48_config || {};
        var exportData = {
          version: "3.0.0",
          type: "snh48-enhancer-config",
          config: cfg,
          exportedAt: new Date().toISOString()
        };
        var json = JSON.stringify(exportData, null, 2);
        var blob = new Blob([json], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = "snh48-enhancer-config.json";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });
    });
  }

  if (importBtn && importFile) {
    importBtn.addEventListener("click", function () {
      importFile.value = "";
      importFile.click();
    });

    importFile.addEventListener("change", function () {
      var file = importFile.files && importFile.files[0];
      if (!file) return;

      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var data = JSON.parse(e.target.result);
          if (!data || data.type !== "snh48-enhancer-config" || typeof data.config !== "object" || !data.config) {
            alert("无效的配置文件：格式不正确");
            return;
          }
          // 验证至少包含一个已知配置键
          var hasKnownKey = KNOWN_CONFIG_KEYS.some(function (k) { return k in data.config; });
          if (!hasKnownKey) {
            alert("无效的配置文件：未找到有效的配置项");
            return;
          }

          // 合并到现有配置
          chrome.storage.sync.get("snh48_config", function (oldData) {
            var oldCfg = oldData.snh48_config || {};
            var merged = Object.assign({}, DEFAULT_CONFIG, oldCfg, data.config);

            chrome.storage.sync.set({ snh48_config: merged }, function () {
              if (chrome.runtime.lastError) {
                alert("导入失败：" + chrome.runtime.lastError.message);
                return;
              }
              // 刷新 UI
              initUI(merged);
              // 通知当前标签页
              try {
                chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
                  if (tabs[0] && tabs[0].url && tabs[0].url.includes("live.48.cn")) {
                    chrome.tabs.sendMessage(
                      tabs[0].id,
                      { type: SNH48_MSG.CONFIG_UPDATED, config: merged },
                      function () {
                        if (chrome.runtime.lastError) {
                          log("消息发送失败:", chrome.runtime.lastError.message);
                        }
                      }
                    );
                  }
                });
              } catch (err) {
                log("消息发送异常:", err);
              }
              alert("配置导入成功！");
            });
          });
        } catch (err) {
          alert("导入失败：文件内容不是有效的 JSON");
        }
      };
      reader.readAsText(file);
    });
  }
})();
