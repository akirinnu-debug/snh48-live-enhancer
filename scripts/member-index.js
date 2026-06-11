// ========== SNH48 Live Enhancer - Member-Performance Reverse Index ==========
(function () {
  "use strict";

  var SNH48 = window.SNH48 || (window.SNH48 = {});
  const log = SNH48.log;
  const isExtensionContextAlive = SNH48.isExtensionContextAlive;
  const safeSendMessage = SNH48.safeSendMessage;
  const safeStorageSet = SNH48.safeStorageSet;
  const _extSetTimeout = SNH48._extSetTimeout;
  const _extClearTimer = SNH48._extClearTimer;

  const MEMBER_INDEX_KEY = "snh48_member_index";
  // 索引总条目上限：50000 条约占用 8-10MB 存储，在 chrome.storage.local
// 的 10MB 限制内留有余量，同时覆盖 SNH48 历年全部公演记录
const MEMBER_INDEX_MAX_ENTRIES = 50000;
// 每成员最多记录 200 条公演：单个成员参演公演数极少超过 200，
// 此上限防止单个活跃成员占用过多存储空间
const MEMBER_INDEX_MAX_PER_MEMBER = 200;
  let memberIndex = {};
  let memberIndexSaveTimer = null;
  const memberIndexStats = { members: 0, performances: 0 };

  const loadMemberIndex = () => {
    return new Promise((resolve) => {
      if (!isExtensionContextAlive()) { resolve(); return; }
      try {
        chrome.storage.local.get(MEMBER_INDEX_KEY, (data) => {
          if (chrome.runtime.lastError) {
            memberIndex = {};
            SNH48.memberIndex = memberIndex;
            resolve();
            return;
          }
          memberIndex = data[MEMBER_INDEX_KEY] || {};
          SNH48.memberIndex = memberIndex;
          updateMemberIndexStats();
          log("成员索引已加载:", memberIndexStats);
          resolve();
        });
      } catch (e) {
        memberIndex = {};
        SNH48.memberIndex = memberIndex;
        resolve();
      }
    });
  };

  const saveMemberIndexNow = () => {
    if (!isExtensionContextAlive()) return;
    if (memberIndexSaveTimer) {
      _extClearTimer(memberIndexSaveTimer);
      memberIndexSaveTimer = null;
    }
    try {
      const startTime = performance.now();
      const json = JSON.stringify(memberIndex);
      const elapsed = performance.now() - startTime;
      if (elapsed > 100) {
        console.warn(`[SNH48-Enhancer] JSON.stringify 耗时 ${elapsed.toFixed(1)}ms, 数据量 ${(json.length / 1024).toFixed(1)}KB`);
      }
      if (json.length > 3 * 1024 * 1024) {
        console.warn(`[SNH48-Enhancer] 索引数据较大 (${(json.length / 1024 / 1024).toFixed(1)}MB)，建议清理旧数据`);
      }
      if (json.length > 4 * 1024 * 1024) {
        pruneMemberIndex(true);
      }
      const writeStart = performance.now();
      safeStorageSet({ [MEMBER_INDEX_KEY]: memberIndex }, () => {
        const writeElapsed = performance.now() - writeStart;
        if (writeElapsed > 500) {
          console.warn(`[SNH48-Enhancer] storage.write 耗时 ${writeElapsed.toFixed(1)}ms`);
        }
      });
    } catch (e) {}
  };

  const saveMemberIndex = () => {
    if (!isExtensionContextAlive()) return;
    if (memberIndexSaveTimer) {
      _extClearTimer(memberIndexSaveTimer);
    }
    memberIndexSaveTimer = _extSetTimeout(() => {
      memberIndexSaveTimer = null;
      saveMemberIndexNow();
    }, 800);
  };

  // [FIX 4.8] 注册卸载前兜底（仅注册一次）
  if (typeof window !== "undefined" && !window._snh48_persist_registered) {
    window._snh48_persist_registered = true;
    const persistHandler = () => {
      try { saveMemberIndexNow(); } catch (e) { /* ignore */ }
    };
    window.addEventListener("pagehide", persistHandler);
    window.addEventListener("beforeunload", persistHandler);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") persistHandler();
    });
  }

  const updateMemberIndexStats = () => {
    let total = 0;
    const members = Object.keys(memberIndex).length;
    Object.keys(memberIndex).forEach((k) => {
      total += memberIndex[k].length;
    });
    memberIndexStats.members = members;
    memberIndexStats.performances = total;
  };

  const pruneMemberIndex = (aggressive) => {
    let totalEntries = 0;
    Object.keys(memberIndex).forEach((k) => {
      totalEntries += memberIndex[k].length;
    });

    if (!aggressive && totalEntries <= MEMBER_INDEX_MAX_ENTRIES) return;

    const all = [];
    Object.keys(memberIndex).forEach((name) => {
      memberIndex[name].forEach((entry) => {
        all.push({ name, entry });
      });
    });
    all.sort((a, b) => a.entry.ts - b.entry.ts);

    // 80% 保留率：裁剪时保留大部分数据，仅淘汰最旧的 20%，
    // 在释放有意义空间的同时避免频繁裁剪导致的热数据丢失
    const keepCount = aggressive ? MEMBER_INDEX_MAX_ENTRIES : Math.floor(MEMBER_INDEX_MAX_ENTRIES * 0.8);
    const toRemove = all.length - keepCount;
    if (toRemove <= 0) return;

    for (let i = 0; i < toRemove; i++) {
      const item = all[i];
      const arr = memberIndex[item.name];
      const idx = arr.indexOf(item.entry);
      if (idx !== -1) arr.splice(idx, 1);
      if (arr.length === 0) delete memberIndex[item.name];
    }
    updateMemberIndexStats();
    log("索引已裁剪:", memberIndexStats);
  };

  const indexCurrentPagePerformers = () => {
    const config = SNH48.config;
    if (!config.memberIndex) return;

    const imglist = document.querySelector(".imglist");
    if (!imglist) return;

    const titleEl =
      document.querySelector(".titles h1") ||
      document.querySelector(".titles .title1") ||
      document.querySelector("h1") ||
      document.querySelector(".v-text h2");
    const title = titleEl ? titleEl.textContent.trim() : document.title;
    const group = guessGroupFromUrl();
    const url = location.href;
    const ts = Date.now();
    let changed = false;
    const names = [];

    imglist.querySelectorAll(".imgbox .name").forEach((el) => {
      const name = el.textContent.trim();
      if (!name) return;
      names.push(name);
      if (!memberIndex[name]) memberIndex[name] = [];

      const exists = memberIndex[name].some((e) => e.url === url);
      if (exists) return;

      memberIndex[name].push({ title, url, ts, group });
      if (memberIndex[name].length > MEMBER_INDEX_MAX_PER_MEMBER) {
        memberIndex[name].sort((a, b) => a.ts - b.ts);
        memberIndex[name].splice(0, memberIndex[name].length - MEMBER_INDEX_MAX_PER_MEMBER);
      }
      changed = true;
    });

    if (changed) {
      updateMemberIndexStats();
      saveMemberIndex();
      log("本地成员索引已更新:", title, "→", names.length, "人 (总计:", memberIndexStats, ")");
    }

    // 去重：同一 URL 60 秒内不重复发送索引请求
    if (SNH48.shouldIndexPage && !SNH48.shouldIndexPage(url)) {
      log("索引请求已去重，跳过:", url);
    } else {
      safeSendMessage({ type: SNH48_MSG.INDEX_CURRENT_PAGE, url }, (resp) => {
        if (resp && resp.success) log("当前公演已成功同步到后台索引!");
      });
    }
  };

  const guessGroupFromUrl = () => {
    const m = location.pathname.match(/\/club\/(\d+)/);
    if (!m) return "";
    const map = { "1": "SNH48", "2": "BEJ48", "3": "GNZ48", "4": "SHY48", "5": "CKG48", "6": "CGT48" };
    return map[m[1]] || "";
  };

  const clearMemberIndex = () => {
    memberIndex = {};
    SNH48.memberIndex = memberIndex;
    updateMemberIndexStats();
    if (!isExtensionContextAlive()) return;
    try {
      chrome.storage.local.remove(MEMBER_INDEX_KEY, () => {
        log("成员索引已清空");
      });
    } catch (e) {}
  };

  const searchMemberIndex = (query) => {
    const q = query.toLowerCase().trim();
    if (!q || Object.keys(memberIndex).length === 0) return [];

    const nameMap = {};
    Object.keys(memberIndex).forEach((k) => {
      nameMap[k.toLowerCase()] = k;
    });

    const results = [];
    const exactName = nameMap[q];
    if (exactName) {
      memberIndex[exactName].forEach((entry) => {
        results.push({
          member: exactName,
          title: entry.title,
          url: entry.url,
          ts: entry.ts,
          group: entry.group,
        });
      });
    }
    const fuzzyNames = Object.keys(nameMap)
      .filter((n) => n !== q && n.includes(q))
      .slice(0, 3)
      .map((low) => nameMap[low]);
    fuzzyNames.forEach((name) => {
      memberIndex[name]
        .slice()
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 5)
        .forEach((entry) => {
          results.push({
            member: name,
            title: entry.title,
            url: entry.url,
            ts: entry.ts,
            group: entry.group,
          });
        });
    });

    results.sort((a, b) => b.ts - a.ts);
    return results.slice(0, 15);
  };

  const formatRelativeTime = (ts) => {
    const diff = Date.now() - ts;
    const day = 24 * 60 * 60 * 1000;
    if (diff < day) return "今天";
    if (diff < 2 * day) return "昨天";
    if (diff < 7 * day) return Math.floor(diff / day) + "天前";
    if (diff < 30 * day) return Math.floor(diff / (7 * day)) + "周前";
    return Math.floor(diff / (30 * day)) + "月前";
  };

  SNH48.memberIndex = memberIndex;
  SNH48.loadMemberIndex = loadMemberIndex;
  SNH48.indexCurrentPagePerformers = indexCurrentPagePerformers;
  SNH48.clearMemberIndex = clearMemberIndex;
  SNH48.searchMemberIndex = searchMemberIndex;
  SNH48.memberIndexStats = memberIndexStats;
  SNH48.saveMemberIndex = saveMemberIndex;
  SNH48.formatRelativeTime = formatRelativeTime;
})();
