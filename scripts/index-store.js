// ========== SNH48 Live Enhancer - 索引存储与搜索模块 ==========
// 从 background.js 拆分：索引的存储、加载、搜索、加速索引、分片归档等

var SNH48_BG = self.SNH48_BG || (self.SNH48_BG = {});

// 配置常量
const STORAGE_KEY_INDEX = "snh48_full_index";
const STORAGE_KEY_META = "snh48_index_meta";
// [OPT] 索引容量上限：使用 unlimitedStorage 权限，不再限制为 2000
// 实际上限由 chrome.storage.local 配额决定（unlimitedStorage 下无硬性限制）
// 设置软上限用于内存保护，超出时触发分片存储而非丢弃数据
const INDEX_SOFT_LIMIT = 50000; // 软上限：超过此值触发性能优化（分片存储）
const INDEX_SHARD_SIZE = 5000;  // 每个分片的大小

// [FIX 4.7] 内存缓存 + 批量 flush 的索引
// 可变状态直接挂在 SNH48_BG 上，确保跨模块引用一致
SNH48_BG._indexCache = null;          // 内存中的索引
SNH48_BG._indexCacheLoaded = false;
SNH48_BG._indexDirty = false;         // 是否有未保存的修改
SNH48_BG._indexFlushTimer = null;
SNH48_BG._indexSchemaOutdated = false;
const INDEX_FLUSH_INTERVAL = 3000; // 3秒批量写入一次

// [OPT] 搜索加速索引：url → performances 数组下标，name → members 数组下标
SNH48_BG.perfUrlMap = new Map();     // url → index in performances[]
SNH48_BG.memberNameMap = new Map();  // name (lowercase) → index in members[]
// [OPT] 标题倒排索引：title 中的关键词 → Set<performance index>
SNH48_BG.titleKeywordMap = new Map(); // keyword (lowercase) → Set<perfIdx>
const KEYWORD_MIN_LEN = 2;     // 关键词最短长度

// [P2-2.4.3] 简单校验和函数：基于 JSON 字符串的哈希，用于数据损坏检测（非加密用途）
function computeChecksum(obj) {
  const str = JSON.stringify(obj);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

// [FIX H4] 使用计数器生成唯一 ID（避免 Date.now()+Math.random() 碰撞）
let _idCounter = Math.floor(Date.now() / 1000);
function generatePerformanceId() {
  return 'pid_' + (++_idCounter) + '_' + Math.random().toString(36).slice(2, 8);
}

// [FIX H4] 使用快照 + writeInProgress 防止数据丢失
let writeInProgress = false;

// [OPT] 已归档的分片数
let archivedShardCount = 0;

// [P2-2.3.3] URL 前缀表 — 索引时替换为短标记，读取时还原
const URL_PREFIXES = {
  "https://live.48.cn/Index/invideo/club/": "/c/",
  "https://live.48.cn/Index/performance/club/": "/p/",
  "https://live.48.cn/": "/"
};
const URL_PREFIX_REVERSE = {};
for (const [full, short] of Object.entries(URL_PREFIXES)) {
  URL_PREFIX_REVERSE[short] = full;
}

// 压缩 URL：完整 URL → 短路径
function compressUrl(url) {
  if (!url) return url;
  for (const [prefix, replacement] of Object.entries(URL_PREFIXES)) {
    if (url.startsWith(prefix)) {
      return replacement + url.slice(prefix.length);
    }
  }
  return url;
}

// 解压 URL：短路径 → 完整 URL
function decompressUrl(url) {
  if (!url) return url;
  for (const [prefix, replacement] of Object.entries(URL_PREFIXES)) {
    if (url.startsWith(replacement)) {
      return prefix + url.slice(replacement.length);
    }
  }
  return url;
}

// [P1-3.1] 缓存 index meta，供 getSchemaStoredVersion 等使用
SNH48_BG._indexMeta = null;

// 便捷访问器
function getIndexCache() { return SNH48_BG._indexCache; }
function setIndexCache(val) { SNH48_BG._indexCache = val; }
function isIndexDirty() { return SNH48_BG._indexDirty; }
function setIndexDirty(val) { SNH48_BG._indexDirty = val; }

// [P1-3.1] Schema 状态辅助函数
function getSchemaStoredVersion() {
  return SNH48_BG._indexMeta?.schemaVersion || 0;
}

function isSchemaOutdated() {
  return SNH48_BG._indexSchemaOutdated;
}

// 从标题中提取关键词（中文按2-4字分词，英文按空格分词）
// 2-gram：最短粒度，能匹配部分中文名（如"鞠婧"可命中"鞠婧祎"），
// 但误命中率较高；3-gram：更精确，减少"鞠婧"误命中"鞠婧祎"以外
// 的结果。两者互补：2-gram 保证召回率，3-gram 提升精确率
function extractKeywords(title) {
  const keywords = [];
  const lower = title.toLowerCase();
  // 英文词
  const enWords = lower.match(/[a-z0-9]+/g) || [];
  enWords.forEach(w => { if (w.length >= KEYWORD_MIN_LEN) keywords.push(w); });
  // 中文2-gram：短粒度分词，保证部分匹配的召回率
  const cnChars = lower.replace(/[a-z0-9\s]/g, '');
  if (cnChars.length >= KEYWORD_MIN_LEN) {
    for (let i = 0; i <= cnChars.length - KEYWORD_MIN_LEN; i++) {
      keywords.push(cnChars.substring(i, i + KEYWORD_MIN_LEN));
    }
  }
  // 中文3-gram：长粒度分词，减少误命中提升精确率
  if (cnChars.length >= 3) {
    for (let i = 0; i <= cnChars.length - 3; i++) {
      keywords.push(cnChars.substring(i, i + 3));
    }
  }
  return keywords;
}

// 重建加速索引（从 indexCache 重建）
// 索引字段选择：url 用于去重和快速定位已有公演（mergeToIndex 依赖），
// title 用于关键词搜索（searchIndex 路径B 依赖），name 用于成员名
// 精确/模糊匹配（searchIndex 路径A 依赖），三者覆盖主要搜索场景
function rebuildAccelIndex() {
  SNH48_BG.perfUrlMap.clear();
  SNH48_BG.memberNameMap.clear();
  SNH48_BG.titleKeywordMap.clear();
  const indexCache = getIndexCache();
  if (!indexCache || !indexCache.performances) return;
  indexCache.performances.forEach((p, i) => {
    if (p.url) SNH48_BG.perfUrlMap.set(p.url, i);
    // 构建标题关键词索引
    if (p.title) {
      const words = extractKeywords(p.title);
      words.forEach(w => {
        if (!SNH48_BG.titleKeywordMap.has(w)) SNH48_BG.titleKeywordMap.set(w, new Set());
        SNH48_BG.titleKeywordMap.get(w).add(i);
      });
    }
  });
  if (indexCache.members) {
    indexCache.members.forEach((m, i) => {
      if (m.name) SNH48_BG.memberNameMap.set(m.name.toLowerCase(), i);
    });
  }
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

// 加载索引到内存
async function ensureIndexLoaded() {
  if (SNH48_BG._indexCacheLoaded) return getIndexCache();
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_INDEX, STORAGE_KEY_META], (data) => {
      setIndexCache(data[STORAGE_KEY_INDEX] || { performances: [], members: [] });
      SNH48_BG._indexCacheLoaded = true;
      // [P1-3.1] 缓存 meta
      const storedMeta = data[STORAGE_KEY_META] || {};
      SNH48_BG._indexMeta = storedMeta;
      // [P2-2.4.3] 校验和验证：检测数据损坏
      if (storedMeta.checksum) {
        const actualChecksum = computeChecksum(data[STORAGE_KEY_INDEX]);
        if (actualChecksum !== storedMeta.checksum) {
          console.error("[SNH48-Enhancer] 索引数据校验失败，可能已损坏，将重置索引");
          setIndexCache({ performances: [], members: [] });
          setIndexDirty(true);
        }
      }
      // [P0-2.3.1] 检查 schema 版本
      const storedVersion = storedMeta.schemaVersion;
      if (storedVersion !== undefined && storedVersion !== SNH48_INDEX_SCHEMA_VERSION) {
        console.warn(`[SNH48] 索引 schema 版本不一致: 存储版本=${storedVersion}, 当前版本=${SNH48_INDEX_SCHEMA_VERSION}`);
        SNH48_BG._indexSchemaOutdated = true;
      } else {
        SNH48_BG._indexSchemaOutdated = false;
      }
      // [OPT] 加载后重建加速索引
      rebuildAccelIndex();
      resolve(getIndexCache());
    });
  });
}

// 立即 flush 索引到 storage
// [NEW] 异步版 flush，等待写入完成
function flushIndexNowAsync() {
  return new Promise((resolve) => {
    const indexCache = getIndexCache();
    if (!isIndexDirty() || !indexCache) { resolve(false); return; }
    if (writeInProgress) {
      // 已有写入进行中，等待其完成后再尝试
      const wait = setInterval(() => {
        if (!writeInProgress) {
          clearInterval(wait);
          if (isIndexDirty()) flushIndexNowAsync().then(resolve);
          else resolve(false);
        }
      }, 100);
      return;
    }
    writeInProgress = true;
    // [OPT] 使用 structuredClone 代替 JSON.parse(JSON.stringify)，性能更好
    let snapshot;
    try {
      snapshot = typeof structuredClone === 'function'
        ? structuredClone(indexCache)
        : JSON.parse(JSON.stringify(indexCache));
    } catch (e) {
      snapshot = JSON.parse(JSON.stringify(indexCache));
    }
    const toWriteMeta = { lastUpdated: Date.now(), totalItems: snapshot.performances.length + snapshot.members.length, schemaVersion: SNH48_INDEX_SCHEMA_VERSION, checksum: computeChecksum(snapshot) };
    setIndexDirty(false);
    chrome.storage.local.set({
      [STORAGE_KEY_INDEX]: snapshot,
      [STORAGE_KEY_META]: toWriteMeta
    }, () => {
      writeInProgress = false;
      if (chrome.runtime.lastError) {
        console.warn("flushIndex 失败:", chrome.runtime.lastError);
        setIndexDirty(true);
        resolve(false);
      } else {
        if (isIndexDirty()) scheduleFlush();
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
  if (SNH48_BG._indexFlushTimer) return;
  SNH48_BG._indexFlushTimer = setTimeout(() => {
    SNH48_BG._indexFlushTimer = null;
    flushIndexNow();
  }, INDEX_FLUSH_INTERVAL);
}

// 合并到索引（内存修改 + 节流 flush）
// [OPT] 使用 Map 加速查找，增量更新加速索引
async function mergeToIndex(performance) {
  await ensureIndexLoaded();
  const index = getIndexCache();
  if (!index) {
    console.error("[SNH48] mergeToIndex: indexCache is null!");
    return;
  }
  if (!index.performances) index.performances = [];
  if (!index.members) index.members = [];

  // [P2-2.3.3] 压缩 URL 后再存储
  const compressedUrl = compressUrl(performance.url);

  // 1. 更新 performances 数组（使用 perfUrlMap 加速查找）
  const existingIdx = SNH48_BG.perfUrlMap.has(compressedUrl) ? SNH48_BG.perfUrlMap.get(compressedUrl) : -1;
  if (existingIdx >= 0 && existingIdx < index.performances.length) {
    // [OPT] 增量更新：移除旧标题关键词
    const oldPerf = index.performances[existingIdx];
    if (oldPerf.title) {
      extractKeywords(oldPerf.title).forEach(w => {
        const s = SNH48_BG.titleKeywordMap.get(w);
        if (s) s.delete(existingIdx);
      });
    }
    index.performances[existingIdx] = { ...index.performances[existingIdx], ...performance, url: compressedUrl };
    // [OPT] 增量更新：添加新标题关键词
    if (performance.title) {
      extractKeywords(performance.title).forEach(w => {
        if (!SNH48_BG.titleKeywordMap.has(w)) SNH48_BG.titleKeywordMap.set(w, new Set());
        SNH48_BG.titleKeywordMap.get(w).add(existingIdx);
      });
    }
  } else {
    const newIdx = index.performances.length;
    index.performances.push({
      id: generatePerformanceId(),
      ...performance,
      url: compressedUrl
    });
    // [OPT] 增量更新加速索引
    SNH48_BG.perfUrlMap.set(compressedUrl, newIdx);
    if (performance.title) {
      extractKeywords(performance.title).forEach(w => {
        if (!SNH48_BG.titleKeywordMap.has(w)) SNH48_BG.titleKeywordMap.set(w, new Set());
        SNH48_BG.titleKeywordMap.get(w).add(newIdx);
      });
    }
  }

  // 2. 更新 members 反向索引（使用 memberNameMap 加速查找）
  (performance.performers || []).forEach(name => {
    const nameLow = name.toLowerCase();
    const memberIdx = SNH48_BG.memberNameMap.has(nameLow) ? SNH48_BG.memberNameMap.get(nameLow) : -1;
    let member;
    if (memberIdx >= 0 && memberIdx < index.members.length && index.members[memberIdx].name === name) {
      member = index.members[memberIdx];
    } else {
      member = { id: generatePerformanceId(), name, performances: [] };
      index.members.push(member);
      SNH48_BG.memberNameMap.set(nameLow, index.members.length - 1);
    }
    if (!member.performances.includes(compressedUrl)) {
      member.performances.push(compressedUrl);
    }
  });

  // 3. 容量管理（[OPT] 不再裁剪丢弃数据，改为分片存储优化内存）
  // 超过软上限时，将旧数据归档到分片，内存中只保留最近的数据
  if (index.performances.length > INDEX_SOFT_LIMIT) {
    await archiveOldPerformances();
  }

  setIndexDirty(true);
  scheduleFlush();
}

// [OPT] 分片归档：将旧公演数据移到分片存储，释放内存
// 内存中保留最近 INDEX_SHARD_SIZE 条，旧数据按分片持久化到 storage
async function archiveOldPerformances() {
  const indexCache = getIndexCache();
  const perfs = indexCache.performances;
  if (perfs.length <= INDEX_SOFT_LIMIT) return;

  // 按时间排序，最新的在前
  perfs.sort((a, b) => (b.indexedAt || 0) - (a.indexedAt || 0));

  // 需要归档的旧数据
  const toArchive = perfs.slice(INDEX_SHARD_SIZE);
  // 保留在内存中的最新数据
  const toKeep = perfs.slice(0, INDEX_SHARD_SIZE);

  if (toArchive.length === 0) return;

  // 将旧数据按分片写入 storage
  for (let i = 0; i < toArchive.length; i += INDEX_SHARD_SIZE) {
    const shard = toArchive.slice(i, i + INDEX_SHARD_SIZE);
    const shardKey = `snh48_index_shard_${archivedShardCount}`;
    archivedShardCount++;
    try {
      await chrome.storage.local.set({ [shardKey]: shard });
    } catch (e) {
      console.warn("[SNH48] 分片归档写入失败:", e);
      break;
    }
  }

  // 更新内存索引
  indexCache.performances = toKeep;
  // 重建加速索引
  rebuildAccelIndex();

  // 更新 meta 记录归档信息
  const meta = {
    lastUpdated: Date.now(),
    totalItems: toKeep.length + toArchive.length,
    archivedShards: archivedShardCount,
    inMemoryCount: toKeep.length,
    schemaVersion: SNH48_INDEX_SCHEMA_VERSION
  };
  await new Promise(resolve => {
    chrome.storage.local.set({ [STORAGE_KEY_META]: meta }, resolve);
  });
}

// [OPT] 从分片加载归档数据用于搜索（按需加载）
async function loadArchivedShards() {
  const meta = await new Promise(res => {
    chrome.storage.local.get(STORAGE_KEY_META, d => res(d[STORAGE_KEY_META] || {}));
  });
  const shardCount = meta.archivedShards || 0;
  if (shardCount === 0) return [];

  // Batch load all shards in a single storage call
  const shardKeys = [];
  for (let i = 0; i < shardCount; i++) {
    shardKeys.push(`snh48_index_shard_${i}`);
  }
  const allData = await new Promise(res => {
    chrome.storage.local.get(shardKeys, d => res(d));
  });

  const allArchived = [];
  for (let i = 0; i < shardCount; i++) {
    const shardData = allData[shardKeys[i]];
    if (Array.isArray(shardData)) {
      allArchived.push(...shardData);
    }
  }
  return allArchived;
}

// [FIX 4.7] 获取当前索引统计（用内存缓存 + [OPT] 包含归档数据统计）
async function getIndexStats() {
  await ensureIndexLoaded();
  const indexCache = getIndexCache();
  const meta = await new Promise(res => {
    chrome.storage.local.get(STORAGE_KEY_META, d => res(d[STORAGE_KEY_META] || {}));
  });
  const archivedCount = (meta.totalItems || 0) - indexCache.performances.length;

  // [P2-2.3.3] 计算 URL 压缩率
  let compressedSize = 0;
  let originalSize = 0;
  for (const [url] of SNH48_BG.perfUrlMap) {
    compressedSize += url.length;
    originalSize += decompressUrl(url).length;
  }
  const compressionRatio = originalSize > 0 ? (1 - compressedSize / originalSize) : 0;

  return {
    performanceCount: indexCache.performances.length,
    memberCount: indexCache.members.length,
    totalPerformanceCount: meta.totalItems || indexCache.performances.length,
    archivedCount: Math.max(0, archivedCount),
    archivedShards: meta.archivedShards || 0,
    lastUpdated: meta.lastUpdated,
    indexingState: SNH48_BG.indexingState,
    requestRate: SNH48_BG.requestTimestamps ? SNH48_BG.requestTimestamps.length : 0,
    schemaVersion: {
      current: SNH48_INDEX_SCHEMA_VERSION,
      stored: meta.schemaVersion,
      outdated: SNH48_BG._indexSchemaOutdated
    },
    urlCompression: {
      compressedBytes: compressedSize,
      originalBytes: originalSize,
      ratio: compressionRatio
    }
  };
}

// [FIX 4.7] 清空索引（同步清缓存 + 写盘 + [M10] 清 club 缓存 + [OPT] 清加速索引和分片）
async function clearFullIndex() {
  await ensureIndexLoaded();
  setIndexCache({ performances: [], members: [] });
  SNH48_BG._indexCacheLoaded = true;
  setIndexDirty(true);
  // [OPT] 清空加速索引
  SNH48_BG.perfUrlMap.clear();
  SNH48_BG.memberNameMap.clear();
  SNH48_BG.titleKeywordMap.clear();
  // [M10] 同时清除 id→club 缓存
  SNH48_BG.idToClubCache = {};
  // [OPT] 清除所有分片数据
  archivedShardCount = 0;
  const allKeys = await new Promise(res => chrome.storage.local.get(null, d => res(Object.keys(d))));
  const shardKeys = allKeys.filter(k => k.startsWith("snh48_index_shard_"));
  if (shardKeys.length > 0) {
    await chrome.storage.local.remove(shardKeys);
  }
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [STORAGE_KEY_INDEX]: getIndexCache(),
      [STORAGE_KEY_META]: { lastUpdated: Date.now(), totalItems: 0, archivedShards: 0, inMemoryCount: 0 }
    }, async () => {
      setIndexDirty(false);
      // [M10] 持久化清除 club 缓存
      try { await chrome.storage.local.remove("snh48_id_club_cache"); } catch (e) { /* ignore */ }
      resolve({ success: true });
    });
  });
}

// [FIX 4.7] 搜索索引（用内存缓存 + [OPT] 加速索引）
async function searchIndex(query) {
  await ensureIndexLoaded();
  const indexCache = getIndexCache();
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const results = [];
  const seenUrls = new Set();

  // 路径A: 通过 memberNameMap 精确/模糊匹配成员名（O(1) 精确 + 有限模糊）
  const exactMemberIdx = SNH48_BG.memberNameMap.get(q);
  if (exactMemberIdx !== undefined) {
    const m = indexCache.members[exactMemberIdx];
    if (m) {
      (m.performances || []).forEach(url => {
        if (seenUrls.has(url)) return;
        seenUrls.add(url);
        const perfIdx = SNH48_BG.perfUrlMap.get(url);
        const perf = perfIdx !== undefined ? indexCache.performances[perfIdx] : null;
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
    }
  }

  // [OPT] 模糊匹配成员名（遍历 memberNameMap keys，比遍历数组快）
  if (results.length === 0) {
    for (const [nameLow, idx] of SNH48_BG.memberNameMap) {
      if (nameLow === q) continue; // 已精确匹配
      if (nameLow.includes(q)) {
        const m = indexCache.members[idx];
        if (!m) continue;
        (m.performances || []).forEach(url => {
          if (seenUrls.has(url)) return;
          seenUrls.add(url);
          const perfIdx = SNH48_BG.perfUrlMap.get(url);
          const perf = perfIdx !== undefined ? indexCache.performances[perfIdx] : null;
          if (perf) {
            results.push({
            type: "成员参演",
            typeIcon: "⭐",
            title: perf.title,
            url: perf.url,
            meta: (perf.performers || []).slice(0, 3).join(", ") + ((perf.performers || []).length > 3 ? `...+${perf.performers.length - 3}` : ""),
            isMemberPerf: true,
            indexedAt: perf.indexedAt || 0,
            performers: perf.performers || []
          });
        }
      });
        if (results.length >= 20) break; // 限制模糊匹配结果数
      }
    }
  }

  // 路径B: 通过 titleKeywordMap 倒排索引搜索标题（[OPT] 替代全量遍历）
  if (results.length === 0) {
    const queryKeywords = extractKeywords(q);
    // 统计每个 performance 被多少关键词命中
    const hitCount = new Map(); // perfIdx → count
    queryKeywords.forEach(kw => {
      const idxSet = SNH48_BG.titleKeywordMap.get(kw);
      if (idxSet) {
        idxSet.forEach(idx => {
          hitCount.set(idx, (hitCount.get(idx) || 0) + 1);
        });
      }
    });

    // 按命中数排序，取前 20
    const sortedHits = [...hitCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    sortedHits.forEach(([idx]) => {
      const p = indexCache.performances[idx];
      if (!p || seenUrls.has(p.url)) return;
      // 验证匹配（防止误命中）
      const titleMatch = (p.title || "").toLowerCase().includes(q);
      const performerMatch = (p.performers || []).some(n => (n || "").toLowerCase().includes(q));
      if (titleMatch || performerMatch) {
        seenUrls.add(p.url);
        const performers = p.performers || [];
        results.push({
          type: "成员参演",
          typeIcon: "⭐",
          title: p.title,
          url: p.url,
          meta: performers.slice(0, 3).join(", ") + (performers.length > 3 ? `...+${performers.length - 3}` : ""),
          isMemberPerf: true,
          indexedAt: p.indexedAt || 0,
          performers: performers
        });
      }
    });

    // [OPT] 兜底：如果关键词索引未命中，回退到线性搜索（仅限短查询）
    if (results.length === 0 && q.length >= 2) {
      const limit = Math.min(indexCache.performances.length, 500); // 限制搜索范围
      for (let i = 0; i < limit; i++) {
        const p = indexCache.performances[i];
        if (!p || seenUrls.has(p.url)) continue;
        let match = false;
        if ((p.title || "").toLowerCase().includes(q)) match = true;
        if ((p.performers || []).some(n => (n || "").toLowerCase().includes(q))) match = true;
        if (match) {
          seenUrls.add(p.url);
          const performers = p.performers || [];
          results.push({
            type: "成员参演",
            typeIcon: "⭐",
            title: p.title,
            url: p.url,
            meta: performers.slice(0, 3).join(", ") + (performers.length > 3 ? `...+${performers.length - 3}` : ""),
            isMemberPerf: true,
            indexedAt: p.indexedAt || 0,
            performers: performers
          });
          if (results.length >= 20) break;
        }
      }
    }
  }

  // [OPT] 路径C: 内存搜索无结果时，搜索归档分片数据
  if (results.length === 0) {
    try {
      const archived = await loadArchivedShards();
      for (const p of archived) {
        if (seenUrls.has(p.url)) continue;
        let match = false;
        if ((p.title || "").toLowerCase().includes(q)) match = true;
        if ((p.performers || []).some(n => (n || "").toLowerCase().includes(q))) match = true;
        if (match) {
          seenUrls.add(p.url);
          const performers = p.performers || [];
          results.push({
            type: "成员参演",
            typeIcon: "⭐",
            title: p.title,
            url: p.url,
            meta: performers.slice(0, 3).join(", ") + (performers.length > 3 ? `...+${performers.length - 3}` : ""),
            isMemberPerf: true,
            indexedAt: p.indexedAt || 0,
            performers: performers
          });
          if (results.length >= 20) break;
        }
      }
    } catch (e) {
      console.warn("[SNH48] 搜索归档分片失败:", e);
    }
  }

  // [P2-2.3.3] 解压搜索结果中的 URL
  results.forEach(r => {
    r.url = decompressUrl(r.url);
  });

  return results;
}

// [P2-2.4.3] 手动校验索引完整性
function verifyIndexIntegrity() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_INDEX, STORAGE_KEY_META], (data) => {
      const meta = data[STORAGE_KEY_META] || {};
      const index = data[STORAGE_KEY_INDEX] || [];
      if (!meta.checksum) {
        resolve({ valid: true, message: "无校验和（旧数据格式）" });
        return;
      }
      const actual = computeChecksum(index);
      resolve({
        valid: actual === meta.checksum,
        message: actual === meta.checksum ? "数据完整" : "数据可能已损坏",
        expected: meta.checksum,
        actual: actual
      });
    });
  });
}

// [P2-CALENDAR] 获取全部公演数据（供日历视图使用）
async function getAllPerformances() {
  await ensureIndexLoaded();
  const index = getIndexCache();
  if (!index || !index.performances) return [];

  // 合并内存数据 + 归档数据（若存在）
  let allPerfs = index.performances.slice();

  // 尝试加载归档分片
  try {
    const archived = await loadArchivedShards();
    if (archived && archived.length > 0) {
      allPerfs = allPerfs.concat(archived);
    }
  } catch (e) {
    console.warn("[SNH48] 加载归档分片失败:", e);
  }

  // 过滤：只保留有日期信息的公演（无日期的无法在日历中显示）
  // 同时 decompress URL，供调用方直接使用
  return allPerfs
    .filter(p => p.date)
    .map(p => ({
      url: decompressUrl(p.url),
      title: p.title || "",
      date: p.date,
      performers: p.performers || [],
      team: p.team || "",
      indexedAt: p.indexedAt || 0
    }));
}

// 导出
SNH48_BG.STORAGE_KEY_INDEX = STORAGE_KEY_INDEX;
SNH48_BG.STORAGE_KEY_META = STORAGE_KEY_META;

// 通过 getter 函数导出可变状态，确保跨模块访问一致性
SNH48_BG.getIndexCache = getIndexCache;
SNH48_BG.setIndexCache = setIndexCache;
SNH48_BG.isIndexDirty = isIndexDirty;
SNH48_BG.setIndexDirty = setIndexDirty;

SNH48_BG.initEmptyIndex = initEmptyIndex;
SNH48_BG.ensureIndexLoaded = ensureIndexLoaded;
SNH48_BG.flushIndexNowAsync = flushIndexNowAsync;
SNH48_BG.flushIndexNow = flushIndexNow;
SNH48_BG.scheduleFlush = scheduleFlush;
SNH48_BG.mergeToIndex = mergeToIndex;
SNH48_BG.archiveOldPerformances = archiveOldPerformances;
SNH48_BG.loadArchivedShards = loadArchivedShards;
SNH48_BG.getIndexStats = getIndexStats;
SNH48_BG.clearFullIndex = clearFullIndex;
SNH48_BG.searchIndex = searchIndex;
SNH48_BG.rebuildAccelIndex = rebuildAccelIndex;
SNH48_BG.extractKeywords = extractKeywords;
SNH48_BG.getSchemaStoredVersion = getSchemaStoredVersion;
SNH48_BG.isSchemaOutdated = isSchemaOutdated;
SNH48_BG.compressUrl = compressUrl;
SNH48_BG.decompressUrl = decompressUrl;
SNH48_BG.verifyIndexIntegrity = verifyIndexIntegrity;
SNH48_BG.getAllPerformances = getAllPerformances;
