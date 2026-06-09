// 配置
const STORAGE_KEY_INDEX = "snh48_full_index";
const STORAGE_KEY_META = "snh48_index_meta";
const MAX_INDEX_ITEMS = 2000;

// 批量抓取状态
let indexingState = {
  running: false,
  startId: null,
  endId: null,
  currentId: null,
  success: 0,
  failed: 0,
  skipped: 0,
  notFound: 0,       // [M3] 补全缺失字段
  networkError: 0,
  retryCount: 0,
  startTime: null,
  lastTitle: "",
  phase: "idle"     // idle | preparing | indexing | done
};

// 默认配置
const DEFAULT_CONFIG = {
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
  reminderMinutesBefore: 15
};

// 初始化
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.storage.sync.set({ snh48_config: DEFAULT_CONFIG }, () => {
      if (chrome.runtime.lastError) {
          console.error("默认配置初始化失败:", chrome.runtime.lastError);
      }
    });
    initEmptyIndex();
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
        ...DEFAULT_CONFIG,
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
      await clearFullIndex();
    } else if (info.menuItemId === "snh48-indexing-status") {
      await sendToActiveTab("SHOW_INDEXING_STATUS", {});
    }
  });
}

// 初始化空索引
function initEmptyIndex() {
  chrome.storage.local.set({
    [STORAGE_KEY_INDEX]: { performances: [], members: [] },
    [STORAGE_KEY_META]: {
      lastUpdated: null,
      isIndexing: false,
      totalItems: 0
    }
  });
}

// 辅助函数：延迟
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// 团→club 编号映射（用于已知团时直接构造 URL）
const CLUB_IDS = {
  SNH48: 1,
  BEJ48: 2,
  GNZ48: 3,
  SHY48: 4,
  CKG48: 5,
  CGT48: 6
};

// 已知团列表（用于"遍历多 club"逻辑）
const ALL_CLUBS = [1, 2, 3, 4, 5, 6];

// [FIX 4.1] 缓存 id → club 映射
// 来源：抓取列表页时从 <a href="/Index/invideo/club/{club}/id/{id}"> 提取
// 避免硬编码 club/1
let idToClubCache = {};
let cacheLoaded = false;

async function loadIdClubCache() {
  if (cacheLoaded) return;
  try {
    const data = await chrome.storage.local.get("snh48_id_club_cache");
    if (data.snh48_id_club_cache) {
      idToClubCache = data.snh48_id_club_cache;
    }
  } catch (e) {
    console.warn("加载 id-club 缓存失败:", e);
  }
  cacheLoaded = true;
}

async function saveIdClubCache() {
  try {
    await chrome.storage.local.set({ snh48_id_club_cache: idToClubCache });
  } catch (e) {
    console.warn("保存 id-club 缓存失败:", e);
  }
}

// [FIX 4.1] 从 ID 构造 URL（多策略 + [NEW] 多 club 回退）
// 策略 1: 已知 club（调用者提供）
// 策略 2: 缓存命中（idToClubCache）
// 策略 3: 多 club 回退（由调用者在 404 时触发，此处不做）
// 策略 4: 默认 SNH48（兼容旧行为）
function buildUrlFromId(id, knownClub) {
  if (knownClub && ALL_CLUBS.includes(Number(knownClub))) {
    return `https://live.48.cn/Index/invideo/club/${knownClub}/id/${id}`;
  }
  const cachedClub = idToClubCache[id];
  if (cachedClub && ALL_CLUBS.includes(Number(cachedClub))) {
    return `https://live.48.cn/Index/invideo/club/${cachedClub}/id/${id}`;
  }
  return `https://live.48.cn/Index/invideo/club/1/id/${id}`;
}

// [FIX H1] 多 club 回退：对给定 ID，逐个 club 尝试直到成功
// 同时利用相邻 ID 的 club 缓存加速
async function tryFetchWithClubFallback(id, preferredClub) {
  // [FIX H1] 优先使用相邻 ID 的 club 缓存（±50 范围内）
  let adjClub = null;
  if (!preferredClub && idToClubCache[id] === undefined) {
    for (let offset = 1; offset <= 50; offset++) {
      const clubDown = idToClubCache[id - offset];
      if (clubDown && ALL_CLUBS.includes(Number(clubDown))) { adjClub = Number(clubDown); break; }
      const clubUp = idToClubCache[id + offset];
      if (clubUp && ALL_CLUBS.includes(Number(clubUp))) { adjClub = Number(clubUp); break; }
    }
  }

  const clubsToTry = [];
  const addClub = (c) => { const n = Number(c); if (!clubsToTry.includes(n)) clubsToTry.push(n); };

  if (adjClub) addClub(adjClub);
  if (preferredClub) addClub(preferredClub);
  const cached = idToClubCache[id];
  if (cached) addClub(cached);
  ALL_CLUBS.forEach(c => addClub(c));

  for (const club of clubsToTry) {
    const url = `https://live.48.cn/Index/invideo/club/${club}/id/${id}`;
    const result = await parsePerformancePageWithRetry(url);
    if (result.status === "ok") {
      if (!idToClubCache[id] || idToClubCache[id] !== String(club)) {
        idToClubCache[id] = String(club);
        saveIdClubCache();
      }
      return { result, club };
    }
    if (result.status === "not_found") continue;
    if (result.status === "network_error") continue;
    continue;
  }
  const fallbackUrl = buildUrlFromId(id, preferredClub || adjClub);
  return { result: await parsePerformancePageWithRetry(fallbackUrl), club: preferredClub || adjClub || 1 };
}

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

// [FIX 4.7] 内存缓存 + 批量 flush 的索引
let indexCache = null;          // 内存中的索引
let indexCacheLoaded = false;
let indexDirty = false;         // 是否有未保存的修改
let indexFlushTimer = null;
const INDEX_FLUSH_INTERVAL = 3000; // 3秒批量写入一次

// 加载索引到内存
async function ensureIndexLoaded() {
  if (indexCacheLoaded) return indexCache;
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_INDEX, STORAGE_KEY_META], (data) => {
      indexCache = data[STORAGE_KEY_INDEX] || { performances: [], members: [] };
      indexCacheLoaded = true;
      resolve(indexCache);
    });
  });
}

// 立即 flush 索引到 storage
// [FIX H4] 使用快照 + writeInProgress 防止数据丢失
let writeInProgress = false;
// [NEW] 异步版 flush，等待写入完成
function flushIndexNowAsync() {
  return new Promise((resolve) => {
    if (!indexDirty || !indexCache) { resolve(false); return; }
    if (writeInProgress) {
      // 已有写入进行中，等待其完成后再尝试
      const wait = setInterval(() => {
        if (!writeInProgress) {
          clearInterval(wait);
          if (indexDirty) flushIndexNowAsync().then(resolve);
          else resolve(false);
        }
      }, 100);
      return;
    }
    writeInProgress = true;
    const snapshot = JSON.parse(JSON.stringify(indexCache));
    const toWriteMeta = { lastUpdated: Date.now(), totalItems: snapshot.performances.length + snapshot.members.length };
    indexDirty = false;
    chrome.storage.local.set({
      [STORAGE_KEY_INDEX]: snapshot,
      [STORAGE_KEY_META]: toWriteMeta
    }, () => {
      writeInProgress = false;
      if (chrome.runtime.lastError) {
        console.warn("flushIndex 失败:", chrome.runtime.lastError);
        indexDirty = true;
        resolve(false);
      } else {
        if (indexDirty) scheduleFlush();
        resolve(true);
      }
    });
  });
}
function flushIndexNow() {
  // 兼容旧调用：仅 fire-and-forget
  flushIndexNowAsync();
}

// 节流 flush
function scheduleFlush() {
  if (indexFlushTimer) return;
  indexFlushTimer = setTimeout(() => {
    indexFlushTimer = null;
    flushIndexNow();
  }, INDEX_FLUSH_INTERVAL);
}

// [FIX H6] 使用计数器生成唯一 ID（避免 Date.now()+Math.random() 碰撞）
let _idCounter = Math.floor(Date.now() / 1000);
function generatePerformanceId() {
  return 'pid_' + (++_idCounter) + '_' + Math.random().toString(36).slice(2, 8);
}

// 合并到索引（内存修改 + 节流 flush）
async function mergeToIndex(performance) {
  await ensureIndexLoaded();
  const index = indexCache;
  if (!index) {
    console.error("[SNH48] mergeToIndex: indexCache is null!");
    return;
  }
  if (!index.performances) index.performances = [];
  if (!index.members) index.members = [];

  // 1. 更新 performances 数组
  const existingIdx = index.performances.findIndex(p => p.url === performance.url);
  if (existingIdx >= 0) {
    index.performances[existingIdx] = { ...index.performances[existingIdx], ...performance };
  } else {
    index.performances.push({
      id: generatePerformanceId(),
      ...performance
    });
  }

  // 2. 更新 members 反向索引
  (performance.performers || []).forEach(name => {
    let member = index.members.find(m => m.name === name);
    if (!member) {
      member = { id: generatePerformanceId(), name, performances: [] };
      index.members.push(member);
    }
    if (!member.performances.includes(performance.url)) {
      member.performances.push(performance.url);
    }
  });

  // 3. 容量裁剪
  if (index.performances.length > MAX_INDEX_ITEMS) {
    index.performances.sort((a, b) => (b.indexedAt || 0) - (a.indexedAt || 0));
    index.performances = index.performances.slice(0, MAX_INDEX_ITEMS);
  }

  indexDirty = true;
  scheduleFlush();
}

// [FIX 4.7] 获取当前索引统计（用内存缓存）
async function getIndexStats() {
  await ensureIndexLoaded();
  const meta = await new Promise(res => {
    chrome.storage.local.get(STORAGE_KEY_META, d => res(d[STORAGE_KEY_META] || {}));
  });
  return {
    performanceCount: indexCache.performances.length,
    memberCount: indexCache.members.length,
    lastUpdated: meta.lastUpdated,
    indexingState: indexingState
  };
}

// [FIX 4.7] 清空索引（同步清缓存 + 写盘 + [M10] 清 club 缓存）
async function clearFullIndex() {
  await ensureIndexLoaded();
  indexCache = { performances: [], members: [] };
  indexCacheLoaded = true;
  indexDirty = true;
  // [M10] 同时清除 id→club 缓存
  idToClubCache = {};
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [STORAGE_KEY_INDEX]: indexCache,
      [STORAGE_KEY_META]: { lastUpdated: Date.now(), totalItems: 0 }
    }, async () => {
      indexDirty = false;
      // [M10] 持久化清除 club 缓存
      try { await chrome.storage.local.remove("snh48_id_club_cache"); } catch (e) { /* ignore */ }
      resolve({ success: true });
    });
  });
}

// [FIX 4.7] 搜索索引（用内存缓存）
async function searchIndex(query) {
  await ensureIndexLoaded();
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const results = [];
  const seenUrls = new Set();

  // 路径A: 通过 members 反向索引精确匹配成员名（更快、更准）
  indexCache.members.forEach(m => {
    if (!m.name || !m.name.toLowerCase().includes(q)) return;
    (m.performances || []).forEach(url => {
      if (seenUrls.has(url)) return;
      seenUrls.add(url);
      const perf = indexCache.performances.find(p => p.url === url);
      if (perf) {
        results.push({
          type: "成员参演",
          typeIcon: "⭐",
          title: perf.title,
          url: perf.url,
          meta: (perf.performers || []).slice(0, 3).join(", ") + ((perf.performers || []).length > 3 ? `...+${perf.performers.length - 3}` : ""),
          isMemberPerf: true
        });
      }
    });
  });

  // 路径B: 按 title + performers 模糊搜索（兜底）
  if (results.length === 0) {
    indexCache.performances.forEach(p => {
      let match = false;
      if ((p.title || "").toLowerCase().includes(q)) match = true;
      if ((p.performers || []).some(n => (n || "").toLowerCase().includes(q))) match = true;
      if (match) {
        const performers = p.performers || [];
        results.push({
          type: "成员参演",
          typeIcon: "⭐",
          title: p.title,
          url: p.url,
          meta: performers.slice(0, 3).join(", ") + (performers.length > 3 ? `...+${performers.length - 3}` : ""),
          isMemberPerf: true
        });
      }
    });
  }

  return results;
}

// [FIX 4.3] 增强版 HTML 解析
// 真实页面结构（已验证多种版本）：
//   2020+ 新版：<span class="title1">《因为喜欢你》剧场公演</span>
//             <span class="title2">作品展演：柏绚妤、刘思正 2026-06-07 19:05:00</span>
//   2017 旧版：<span class="title1">《因为喜欢你》剧场公演</span>
//             <span class="title2">TeamJ剧场公演 2017-11-26 14:00:00</span>
//             <ul class="memberlist">...</ul>  // 人气榜，非参演成员
//   2018 过渡：可能使用 <div class="titles"> 或带 h1/h2 标题
// [FIX 4.2] 旧版公演虽然 .title2 无"作品展演"前缀，但页面可能仍有 .imglist
//             旧版 .imglist 也在 <div class="imglist"> 内，需要兼容
function parseHtmlSimple(html) {
  // ---- [FIX 4.3] 提取标题：多模式兼容 ----
  var title = "";

  // 模式1: <span class="title1">
  var title1Match = html.match(/<span[^>]*class=["']title1["'][^>]*>([\s\S]*?)<\/span>/i);
  if (title1Match) {
    title = stripHtml(title1Match[1]).trim();
  }

  // 模式2: <h1> 或 <h2>
  if (!title) {
    var h1Match = html.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
    if (h1Match) title = stripHtml(h1Match[1]).trim();
  }

  // 模式3: <div class="titles"> 内的 h1
  if (!title) {
    var titlesMatch = html.match(/<div[^>]*class=["']titles["'][^>]*>[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (titlesMatch) title = stripHtml(titlesMatch[1]).trim();
  }

  // 模式4: <title> 标签
  if (!title) {
    var titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleTag) title = stripHtml(titleTag[1]).trim().split(/[_\-—|/]/)[0].trim();
  }

  // ---- 提取副标题：.title2 ----
  var subtitle = "";
  var title2Match = html.match(/<span[^>]*class=["']title2["'][^>]*>([\s\S]*?)<\/span>/i);
  if (title2Match) {
    subtitle = stripHtml(title2Match[1]).trim();
  }

  // ---- [FIX v4] 提取参演成员：全面重写 ----
  // 三层数据来源：A) subtitle 关键词  B) title 内嵌  C) .memberlist DOM
  var performers = [];

  // [L1 FIX] 清除零宽字符的工具函数
  function stripInvisibleChars(s) {
    return String(s).replace(/[\u200B-\u200D\uFEFF\u2060\u2028-\u2029\u00AD]/g, "").trim();
  }

  // [L1+L2 FIX] 宽松关键词匹配：用 includes 替代 indexOf，兼容零宽字符和变体前缀
  function tryExtractKeywords(text, keywords) {
    if (!text) return [];
    var clean = stripInvisibleChars(text);
    if (!clean) return [];

    for (var i = 0; i < keywords.length; i++) {
      var kw = keywords[i];
      // 在清理后的文本中查找关键词（放宽：用 includes 而非 starts-with）
      var idx = clean.indexOf(kw);
      if (idx === -1) continue;
      // 从关键词后面截取
      var after = clean.substring(idx + kw.length);
      // 跳过冒号类字符和空白
      after = after.replace(/^[：:﹕∶\s]+/, "");
      if (!after) continue;
      // 按分隔符提取成员名
      var found = parsePerformerList(after);
      if (found.length > 0) return found;
    }
    return [];
  }

  // 来源 A：subtitle 关键词提取
  var textBeforeDate = subtitle;
  var dateBoundary = subtitle.match(/\s+\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/);
  if (dateBoundary) {
    textBeforeDate = subtitle.substring(0, dateBoundary.index).trim();
  }

  // 按优先级尝试关键词列表（支持变体前缀，如"年度青春盛典作品展演"匹配"作品展演"）
  performers = tryExtractKeywords(textBeforeDate, [
    "作品展演",          // 覆盖 "作品展演" 和 "年度青春盛典作品展演"
    "参加成员",          // "参加成员：xxx xxx xxx"
    "出演",
    "参演"
  ]);

  // 来源 C [L5 FIX]：<ul class="memberlist"> → <li> → <p class="listname">
  if (performers.length === 0) {
    var memberListMatch = html.match(/<ul[^>]*class=["'][^"']*memberlist[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i);
    if (memberListMatch) {
      // 提取所有 .listname 内的文本
      var listNameRegex = /<p[^>]*class=["'][^"']*listname[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi;
      var ml;
      while ((ml = listNameRegex.exec(memberListMatch[1])) !== null) {
        var memberName = stripHtml(ml[1]).trim();
        if (memberName && memberName.length < 20 && performers.indexOf(memberName) === -1) {
          performers.push(memberName);
        }
      }
    }
  }

  // 旧 imglist 兼容（保留，但降低优先级到 memberlist 之后）
  if (performers.length === 0) {
    var imglistMatch = html.match(/<div[^>]*class=["'][^"']*imglist[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?:<div|<ul|<\/div>\s*<script)/i);
    if (imglistMatch) {
      var nameRegex = /<div[^>]*class=["'][^"']*imgbox[^"']*["'][^>]*>[\s\S]*?<[^>]*class=["'][^"']*name[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi;
      var mn;
      while ((mn = nameRegex.exec(imglistMatch[1])) !== null) {
        var n = stripHtml(mn[1]).trim();
        if (n && n.length < 20 && performers.indexOf(n) === -1) performers.push(n);
      }
    }
  }

  // 来源 B [L3 FIX]：title 中可能含成员名（如"宁轲生日"→"宁轲"，"xxx作品展演"→xxx）
  if (performers.length === 0) {
    // 尝试从 title 提取"xxx生日"和"xxx作品展演"模式
    var titleClean = stripInvisibleChars(title);
    // birthday pattern: "xxx生日公演" / "xxx生日环节" / "xxx生日会"
    var bdayMatch = titleClean.match(/([^\s《》〈〉]+?)(?:生日公演|生日环节|生日会|生日)/);
    if (bdayMatch) {
      var bdayName = bdayMatch[1].replace(/&amp;/g, "&").trim();
      if (bdayName && bdayName.length < 20 && performers.indexOf(bdayName) === -1) {
        performers.push(bdayName);
      }
    }
    // "xxx作品展演" pattern in title
    var titlePerf = tryExtractKeywords(titleClean, ["作品展演", "出演", "参演"]);
    performers = performers.concat(titlePerf);
  }

  // ---- 提取日期 ----
  var dateStr = "";
  var dateMatches = subtitle.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (!dateMatches) dateMatches = title.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (dateMatches) {
    dateStr = `${dateMatches[1]}-${String(dateMatches[2]).padStart(2, "0")}-${String(dateMatches[3]).padStart(2, "0")}`;
  }

  // ---- 提取团名 ----
  var team = "";
  var teamMatch = subtitle.match(/Team\s*([A-Z]+)/i);
  if (teamMatch) team = "Team " + teamMatch[1];

  return { title, subtitle, performers, date: dateStr, team };
}

// 辅助：剥离 HTML 标签
function stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

// 辅助：解析成员名列表（支持 、 ， , 等多种分隔符）
function parsePerformerList(text) {
  if (!text) return [];
  return text
    .split(/[、，,\s]+/)
    .map(n => n.replace(/剧场公演|特别公演/g, "").trim())
    .filter(n => n && n.length > 0 && n.length < 20 && !/^[\d\W]+$/.test(n));
}

// 解析公演页面
async function parsePerformancePage(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const html = await response.text();
    if (html.length < 500) return null;

    // 页面可能跳到登录页或错误页，关键词检测
    if (html.indexOf("title1") === -1) return null;

    const parsed = parseHtmlSimple(html);

    return {
      url: url,
      title: parsed.title,
      subtitle: parsed.subtitle,
      date: parsed.date,
      team: parsed.team,
      performers: parsed.performers,
      indexedAt: Date.now()
    };
  } catch (err) {
    console.error("解析公演页面失败:", url, err);
    return null;
  }
}

// 开始批量索引（不阻塞，立即返回）
function startRangeIndex(startId, endId) {
  if (indexingState.running) return { success: false, error: "已有任务进行中" };

  if (!Number.isFinite(Number(startId)) || !Number.isFinite(Number(endId))) {
    return { success: false, error: "ID必须是数字" };
  }

  const s = Number(startId), e = Number(endId);
  if (s > e) return { success: false, error: "起始ID必须小于结束ID" };
  if (e - s > 10000) return { success: false, error: "单次范围不能超过10000" };

  indexingState = {
    running: true,
    startId: s,
    endId: e,
    currentId: s,
    success: 0,
    failed: 0,
    skipped: 0,
    notFound: 0,       // [FIX 4.6] HTTP 404
    networkError: 0,   // [FIX 4.6] 网络错误
    retryCount: 0,     // [FIX 4.6] 重试次数
    startTime: Date.now(),
    lastTitle: "",
    phase: "preparing" // [FIX 4.1] preparing / listing / indexing
  };

  // [P1] 开始批量索引前自动清空旧索引（避免脏数据累积）
  indexCache.performances = [];
  indexCache.members = [];
  idToClubCache = {};
  indexDirty = true;
  scheduleFlush();
  runRangeIndex();
  return { success: true };
}

// [P2 FIX] 广播进度
function broadcastProgress(type, payload) {
  chrome.runtime.sendMessage({ type, payload }).catch(() => {});
}

// ============================================================
// 批量索引
// ============================================================

// [FIX 5.2]
async function parsePerformancePageWithRetry(url, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await parsePerformancePageWithStatus(url);
      if (result.status === "network_error" && attempt < maxRetries) {
        indexingState.retryCount++;
        await delay(1000 * (attempt + 1));
        continue;
      }
      return result;
    } catch (err) {
      if (attempt >= maxRetries) {
        return { status: "network_error", data: null, error: err.message };
      }
      indexingState.retryCount++;
      await delay(1000 * (attempt + 1));
    }
  }
  return { status: "network_error", data: null, error: "max retries" };
}

// [FIX 4.6] 返回结果带 HTTP 状态
async function parsePerformancePageWithStatus(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      }
    });
    if (response.status === 404) {
      return { status: "not_found", data: null };
    }
    if (!response.ok) {
      return { status: "server_error", data: null, httpStatus: response.status };
    }
    const html = await response.text();
    if (html.length < 500) {
      return { status: "invalid", data: null };
    }
    // [FIX H2] 多维度页面有效性检测
    // 1. 检查是否为登录重定向/反爬页面
    if (html.indexOf("/Index/login") !== -1 || html.indexOf("verify") !== -1) {
      return { status: "no_data", data: null, reason: "login_or_captcha" };
    }
    // 2. 检查是否包含公演页特征标记
    const hasTitle1 = html.indexOf("title1") !== -1;
    const hasTitle2 = html.indexOf("title2") !== -1;
    const hasVideo = html.indexOf("<video") !== -1 || html.indexOf("videoplay") !== -1;
    const hasH1 = /<h[12][^>]*>[\s\S]*?<\/h[12]>/i.test(html);
    if (!hasTitle1 && !hasTitle2 && !hasVideo && !hasH1) {
      return { status: "no_data", data: null, reason: "no_valid_markers" };
    }
    const parsed = parseHtmlSimple(html);
    if (!parsed.title) {
      return { status: "no_data", data: null };
    }
    return {
      status: "ok",
      data: {
        url, ...parsed, indexedAt: Date.now()
      }
    };
  } catch (err) {
    return { status: "network_error", data: null, error: err.message };
  }
}

// [FIX 5.2] 执行批量索引（移除问题重重的 listing 阶段，直接索引）
async function runRangeIndex() {
  await loadIdClubCache();
  const start = indexingState.startId;
  const end = indexingState.endId;
  const total = end - start + 1;

  indexingState.phase = "indexing";
  indexingState.currentId = start - 1; // 首个 ID 前

  for (let id = start; id <= end; id++) {
    if (!indexingState.running) break;
    indexingState.currentId = id;

    // [FIX 5.2] 使用多 club 回退策略
    const url = buildUrlFromId(id);
    let result = await parsePerformancePageWithRetry(url);

    // [NEW] 如果默认 URL 返回 not_found，尝试其他 club
    if (result.status === "not_found" || result.status === "no_data") {
      const fallback = await tryFetchWithClubFallback(id, 1);
      result = fallback.result;
    }

    switch (result.status) {
      case "ok":
        await mergeToIndex(result.data);
        indexingState.success++;
        indexingState.lastTitle = result.data.title;
        break;
      case "not_found":
        indexingState.notFound = (indexingState.notFound || 0) + 1;
        indexingState.lastTitle = "[404]";
        break;
      case "network_error":
        indexingState.networkError = (indexingState.networkError || 0) + 1;
        indexingState.failed++;
        indexingState.lastTitle = "[网络错误]";
        break;
      case "server_error":
        indexingState.failed++;
        indexingState.lastTitle = `[${result.httpStatus || "?"}]`;
        break;
      case "no_data":
      case "invalid":
      default:
        indexingState.skipped++;
        indexingState.lastTitle = "";
    }

    // [FIX 5.2] 每 10 个 ID 广播一次进度（降低通信频率）
    if ((id - start) % 10 === 0 || id === end) {
      broadcastProgress("INDEXING_PROGRESS", { ...indexingState });
    }

    // [FIX H7] 自适应延迟：成功/404 用短延迟，出错用长延迟
    await delay(result.status === "ok" || result.status === "not_found" || result.status === "no_data" ? 200 : 500);

    // [FIX] 每 50 个 ID 强制落盘一次，防止 SW 闲置被终止丢失内存数据
    if ((id - start) % 50 === 0 && indexDirty) {
      await flushIndexNowAsync();
    }
  }

  indexingState.running = false;
  indexingState.phase = "done";
  await flushIndexNowAsync();
  broadcastProgress("INDEXING_COMPLETE", { ...indexingState });
}

// 简单日志
function log(msg) { /* 生产版：已禁用 */ }

// 停止索引
async function stopRangeIndex() {
  indexingState.running = false;
  flushIndexNow(); // [FIX 4.7] 停止时也 flush
  broadcastProgress("INDEXING_COMPLETE", { ...indexingState });
  return { success: true };
}

// 处理来自 content.js/popup 的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "INDEX_CURRENT_PAGE":
      (async () => {
        try {
          const perf = await parsePerformancePage(msg.url);
          if (perf) {
            await mergeToIndex(perf);
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

    case "GET_INDEX_STATS":
      getIndexStats().then(stats => sendResponse(stats));
      return true;

    case "CLEAR_FULL_INDEX":
      clearFullIndex().then(() => sendResponse({ success: true }));
      return true;

    case "SEARCH_INDEX":
      searchIndex(msg.query).then(results => sendResponse(results));
      return true;

    case "START_RANGE_INDEX":
      sendResponse(startRangeIndex(msg.startId, msg.endId));
      return false;

    case "STOP_RANGE_INDEX":
      stopRangeIndex().then(res => sendResponse(res));
      return true;

    case "GET_INDEXING_STATE":
      sendResponse(indexingState);
      return true;

    default:
      break;
  }
});
