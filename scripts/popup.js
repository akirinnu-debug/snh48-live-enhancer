// ========== SNH48 Live Enhancer - Popup Script ==========
// 版本: 2.0.0 - 移除弹幕相关设置，添加嵌入式搜索、隐藏头部等

(function () {
  "use strict";

  var LOG_PREFIX = "[SNH48-Popup]";

  function log(...args) { /* 生产版：已禁用 */ }

  // 默认配置（与 background.js / content.js 保持一致）
  var DEFAULT_CONFIG = {
    darkMode: false,
    videoShortcuts: true,
    shortcutPanelCollapsed: true, // 快捷键面板默认折叠
    quickNav: true,
    memberIndex: true, // 成员-公演反向索引
    embeddedSearch: true, // 网页顶部嵌入搜索入口
    autoPiP: false,
    screenshotEnabled: true,
    hideHeader: false, // 隐藏头部以获得更大播放区
    reminderEnabled: false,
    reminderMinutesBefore: 15,
  };

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

  // 加载配置
  chrome.storage.sync.get("snh48_config", function (data) {
    var config = Object.assign({}, DEFAULT_CONFIG, data.snh48_config || {});
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
              { type: "CONFIG_UPDATED", config: config },
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
})();
