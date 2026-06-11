// ========== SNH48 Live Enhancer - 消息路由与广播模块 ==========
// 从 background.js 拆分：chrome.runtime.onMessage 处理、右键菜单、sendToActiveTab 等

var SNH48_BG = self.SNH48_BG || (self.SNH48_BG = {});

// 发送消息到当前活动标签
async function sendToActiveTab(type, payload) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type, payload });
    } catch (e) {
      console.warn("无法发送到标签:", e);
    }
  }
}

// 安装/更新事件
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.storage.sync.set({ snh48_config: SNH48_DEFAULT_CONFIG }, () => {
      if (chrome.runtime.lastError) {
          console.error("默认配置初始化失败:", chrome.runtime.lastError);
      }
    });
    SNH48_BG.initEmptyIndex();
  } else if (details.reason === "update") {
    chrome.storage.sync.get("snh48_config", (data) => {
      const oldConfig = data.snh48_config || {};
      // 移除废弃字段
      delete oldConfig.memberSearch;
      delete oldConfig.danmuKeywords;
      delete oldConfig.danmuOpacity;
      delete oldConfig.danmuDensity;
      delete oldConfig.danmuSpeed;
      const cleanConfig = {
        ...SNH48_DEFAULT_CONFIG,
        ...oldConfig
      };
      chrome.storage.sync.set({ snh48_config: cleanConfig }, () => {});
    });
  }

  // 添加右键菜单
  if (chrome.contextMenus) {
    chrome.contextMenus.create({
      id: "snh48-indexing",
      title: "SNH48 索引工具",
      contexts: ["all"]
    });
    chrome.contextMenus.create({
      id: "snh48-indexing-status",
      parentId: "snh48-indexing",
      title: "查看索引状态",
      contexts: ["all"]
    });
    chrome.contextMenus.create({
      id: "snh48-indexing-clear",
      parentId: "snh48-indexing",
      title: "清空后台索引",
      contexts: ["all"]
    });
  }
});

// 菜单点击事件
if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "snh48-indexing-clear") {
      await SNH48_BG.clearFullIndex();
    } else if (info.menuItemId === "snh48-indexing-status") {
      await sendToActiveTab(SNH48_MSG.SHOW_INDEXING_STATUS, {});
    }
  });
}

// 处理来自 content.js/popup 的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case SNH48_MSG.INDEX_CURRENT_PAGE:
      (async () => {
        try {
          const perf = await SNH48_BG.parsePerformancePage(msg.url);
          if (perf) {
            await SNH48_BG.mergeToIndex(perf);
            sendResponse({ success: true, data: perf });
          } else {
            sendResponse({ success: false, error: "未解析到有效数据" });
          }
        } catch (err) {
          console.error("索引失败:", err);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;

    case SNH48_MSG.GET_INDEX_STATS:
      SNH48_BG.getIndexStats().then(stats => sendResponse(stats));
      return true;

    case SNH48_MSG.CLEAR_FULL_INDEX:
      SNH48_BG.clearFullIndex().then(() => sendResponse({ success: true }));
      return true;

    case SNH48_MSG.SEARCH_INDEX:
      SNH48_BG.searchIndex(msg.query).then(results => sendResponse(results));
      return true;

    case SNH48_MSG.GET_ALL_PERFORMANCES:
      SNH48_BG.getAllPerformances().then(results => sendResponse(results));
      return true;

    case SNH48_MSG.START_RANGE_INDEX:
      sendResponse(SNH48_BG.startRangeIndex(msg.startId, msg.endId, msg.mode));
      return false;

    case SNH48_MSG.STOP_RANGE_INDEX:
      SNH48_BG.stopRangeIndex().then(res => sendResponse(res));
      return true;

    case SNH48_MSG.GET_INDEXING_STATE:
      sendResponse(SNH48_BG.getIndexingState());
      return true;

    case SNH48_MSG.GET_SCHEMA_STATUS:
      (async () => {
        await SNH48_BG.ensureIndexLoaded();
        const meta = await new Promise(res => {
          chrome.storage.local.get(SNH48_BG.STORAGE_KEY_META, d => res(d[SNH48_BG.STORAGE_KEY_META] || {}));
        });
        sendResponse({
          currentVersion: SNH48_INDEX_SCHEMA_VERSION,
          storedVersion: meta.schemaVersion,
          outdated: SNH48_BG._indexSchemaOutdated
        });
      })();
      return true;

    case SNH48_MSG.GET_STATE:
      (async () => {
        const keys = msg.keys;
        const result = {};
        if (keys?.includes("config")) {
          const data = await new Promise(res => chrome.storage.sync.get("snh48_config", res));
          result.config = data.snh48_config || null;
        }
        if (keys?.includes("indexingState")) {
          result.indexingState = SNH48_BG.getIndexingState();
        }
        if (keys?.includes("indexStats")) {
          result.indexStats = await SNH48_BG.getIndexStats();
        }
        if (keys?.includes("schema")) {
          await SNH48_BG.ensureIndexLoaded();
          result.schemaStatus = {
            currentVersion: SNH48_INDEX_SCHEMA_VERSION,
            storedVersion: SNH48_BG.getSchemaStoredVersion(),
            outdated: SNH48_BG.isSchemaOutdated()
          };
        }
        sendResponse(result);
      })();
      return true;

    default:
      break;
  }
});

// 导出
SNH48_BG.sendToActiveTab = sendToActiveTab;
