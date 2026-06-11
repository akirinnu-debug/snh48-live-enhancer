// ========== SNH48 Live Enhancer - 共享配置 ==========
// DEFAULT_CONFIG 的唯一权威来源
// content.js / background.js / popup.js 均引用此文件

var SNH48_DEFAULT_CONFIG = {
  darkMode: false,
  videoShortcuts: true,
  shortcutPanelCollapsed: true,
  quickNav: true,
  memberIndex: true,
  embeddedSearch: true,
  autoPiP: false,
  screenshotEnabled: true,
  hideHeader: false,
  reminderEnabled: false,
  reminderMinutesBefore: 15,
  shortcutBindings: {
    speedUp: "]",
    speedDown: "[",
    speedReset: "0",
    screenshot: "s",
    pip: "p",
    fullscreen: "f",
    volumeUp: "ArrowUp",
    volumeDown: "ArrowDown",
    mute: "m",
    seekForward: "ArrowRight",
    seekBackward: "ArrowLeft"
  },
};

// 索引数据 schema 版本（用于检测数据格式变更，触发增量重索引）
var SNH48_INDEX_SCHEMA_VERSION = 1;
