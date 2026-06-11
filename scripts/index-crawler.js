// ========== SNH48 Live Enhancer - 批量索引与爬取模块 ==========
// 从 background.js 拆分：速率限制、页面抓取、批量索引、状态持久化等

var SNH48_BG = self.SNH48_BG || (self.SNH48_BG = {});

// 全局请求速率限制器
const RATE_LIMIT_WINDOW = 1000; // 1秒窗口
// 保守限速：每秒最多 5 个请求，远低于常见反爬阈值（通常 10-20/s），
// 避免触发 48.cn 的频率限制或 IP 封禁
const RATE_LIMIT_MAX = 5; // 每秒最多5个请求
SNH48_BG.requestTimestamps = [];

function checkRateLimit() {
  const now = Date.now();
  SNH48_BG.requestTimestamps = SNH48_BG.requestTimestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
  if (SNH48_BG.requestTimestamps.length >= RATE_LIMIT_MAX) {
    return false;
  }
  SNH48_BG.requestTimestamps.push(now);
  return true;
}

async function waitForRateLimit() {
  while (!checkRateLimit()) {
    await new Promise(r => setTimeout(r, 200));
  }
}

// 辅助函数：延迟
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// 批量抓取状态（直接挂在 SNH48_BG 上，确保跨模块引用一致）
SNH48_BG.indexingState = {
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
  rateLimited: 0,      // [P1-2.4.2] 被速率限制次数
  parseFailed: 0,      // [P1-1.4.4] HTML解析失败计数
  startTime: null,
  lastTitle: "",
  phase: "idle"     // idle | preparing | indexing | done
};

// [P0-1.4.1] Session storage key for persisting indexing state across SW restarts
const STORAGE_KEY_INDEXING_SESSION = "snh48_indexing_state_session";

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

// [FIX 4.1] 缓存 id → club 映射（直接挂在 SNH48_BG 上，确保跨模块引用一致）
SNH48_BG.idToClubCache = {};
let cacheLoaded = false;

async function loadIdClubCache() {
  if (cacheLoaded) return;
  try {
    const data = await chrome.storage.local.get("snh48_id_club_cache");
    if (data.snh48_id_club_cache) {
      SNH48_BG.idToClubCache = data.snh48_id_club_cache;
    }
  } catch (e) {
    console.warn("加载 id-club 缓存失败:", e);
  }
  cacheLoaded = true;
}

async function saveIdClubCache() {
  try {
    await chrome.storage.local.set({ snh48_id_club_cache: SNH48_BG.idToClubCache });
  } catch (e) {
    console.warn("保存 id-club 缓存失败:", e);
  }
}

// [FIX 4.1] 从 ID 构造 URL（多策略 + [NEW] 多 club 回退）
function buildUrlFromId(id, knownClub) {
  if (knownClub && ALL_CLUBS.includes(Number(knownClub))) {
    return `https://live.48.cn/Index/invideo/club/${knownClub}/id/${id}`;
  }
  const cachedClub = SNH48_BG.idToClubCache[id];
  if (cachedClub && ALL_CLUBS.includes(Number(cachedClub))) {
    return `https://live.48.cn/Index/invideo/club/${cachedClub}/id/${id}`;
  }
  return `https://live.48.cn/Index/invideo/club/1/id/${id}`;
}

// [FIX H1] 多 club 回退：对给定 ID，逐个 club 尝试直到成功
async function tryFetchWithClubFallback(id, preferredClub) {
  // [FIX H1] 优先使用相邻 ID 的 club 缓存（±50 范围内）
  let adjClub = null;
  if (!preferredClub && SNH48_BG.idToClubCache[id] === undefined) {
    for (let offset = 1; offset <= 50; offset++) {
      const clubDown = SNH48_BG.idToClubCache[id - offset];
      if (clubDown && ALL_CLUBS.includes(Number(clubDown))) { adjClub = Number(clubDown); break; }
      const clubUp = SNH48_BG.idToClubCache[id + offset];
      if (clubUp && ALL_CLUBS.includes(Number(clubUp))) { adjClub = Number(clubUp); break; }
    }
  }

  const clubsToTry = [];
  const addClub = (c) => { const n = Number(c); if (!clubsToTry.includes(n)) clubsToTry.push(n); };

  if (adjClub) addClub(adjClub);
  if (preferredClub) addClub(preferredClub);
  const cached = SNH48_BG.idToClubCache[id];
  if (cached) addClub(cached);
  ALL_CLUBS.forEach(c => addClub(c));

  for (const club of clubsToTry) {
    const url = `https://live.48.cn/Index/invideo/club/${club}/id/${id}`;
    const result = await parsePerformancePageWithRetry(url);
    if (result.status === "ok") {
      if (!SNH48_BG.idToClubCache[id] || SNH48_BG.idToClubCache[id] !== String(club)) {
        SNH48_BG.idToClubCache[id] = String(club);
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

// 解析公演页面
async function parsePerformancePage(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const html = await response.text();
    if (html.length < 500) return null;

    // 页面可能跳到登录页或错误页，关键词检测
    // [FIX] 放宽检测：title1/title2/video/h1 任一存在即为有效公演页
    const hasTitle1 = html.indexOf("title1") !== -1;
    const hasTitle2 = html.indexOf("title2") !== -1;
    const hasVideo = html.indexOf("<video") !== -1 || html.indexOf("videoplay") !== -1;
    const hasH1 = /<h[12][^>]*>[\s\S]*?<\/h[12]>/i.test(html);
    if (!hasTitle1 && !hasTitle2 && !hasVideo && !hasH1) return null;

    const parsed = SNH48_BG.parseHtmlSimple(html, url);

    return {
      url: url,
      title: parsed.title,
      subtitle: parsed.subtitle,
      date: parsed.date,
      team: parsed.team,
      performers: parsed.performers,
      parseStatus: parsed.parseStatus,
      indexedAt: Date.now()
    };
  } catch (err) {
    console.error("解析公演页面失败:", url, err);
    return null;
  }
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
    // [P1-2.4.2] 检测 HTTP 429 速率限制
    if (response.status === 429) {
      console.warn("[SNH48] 收到 429 Too Many Requests 响应，等待 5 秒后重试");
      await delay(5000);
      SNH48_BG.indexingState.rateLimited = (SNH48_BG.indexingState.rateLimited || 0) + 1;
      return { status: "rate_limited", data: null, httpStatus: 429 };
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
    const parsed = SNH48_BG.parseHtmlSimple(html, url);
    if (!parsed.title) {
      // [P1-1.4.4] 解析失败时返回 parse_failed 状态，而非笼统的 no_data
      if (parsed.parseStatus === 'parse_failed') {
        return { status: "parse_failed", data: null, parseDiagnosis: parsed.parseDiagnosis };
      }
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

// [FIX 5.2]
async function parsePerformancePageWithRetry(url, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await parsePerformancePageWithStatus(url);
      // [P1-2.4.2] 429 速率限制：自动重试（已在内层等待 5 秒）
      if (result.status === "rate_limited" && attempt < maxRetries) {
        SNH48_BG.indexingState.retryCount++;
        continue;
      }
      if (result.status === "network_error" && attempt < maxRetries) {
        SNH48_BG.indexingState.retryCount++;
        await delay(1000 * (attempt + 1));
        continue;
      }
      return result;
    } catch (err) {
      if (attempt >= maxRetries) {
        return { status: "network_error", data: null, error: err.message };
      }
      SNH48_BG.indexingState.retryCount++;
      await delay(1000 * (attempt + 1));
    }
  }
  return { status: "network_error", data: null, error: "max retries" };
}

// 开始批量索引（不阻塞，立即返回）
// [P0-2.3.2] mode: "full" (default) = 清空后重建, "incremental" = 仅补充缺失
function startRangeIndex(startId, endId, mode) {
  if (SNH48_BG.indexingState.running) return { success: false, error: "已有任务进行中" };

  if (!Number.isFinite(Number(startId)) || !Number.isFinite(Number(endId))) {
    return { success: false, error: "ID必须是数字" };
  }

  const s = Number(startId), e = Number(endId);
  if (s > e) return { success: false, error: "起始ID必须小于结束ID" };
  if (e - s > 50000) return { success: false, error: "单次范围不能超过50000" };

  const effectiveMode = (mode === "incremental") ? "incremental" : "full";

  SNH48_BG.indexingState = {
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
    parseFailed: 0,    // [P1-1.4.4] HTML解析失败计数
    startTime: Date.now(),
    lastTitle: "",
    phase: "preparing", // [FIX 4.1] preparing / listing / indexing
    mode: effectiveMode  // [P0-2.3.2] 记录索引模式
  };

  if (effectiveMode === "full") {
    // [FIX] 全量模式不再清空所有索引数据，因为批量索引可能只覆盖某个团的范围，
    // 清空会导致其他团的数据丢失。改为依赖 mergeToIndex 的去重逻辑：
    // 已存在的 URL 会被更新，新 URL 会被追加。
    // 仅清空 id-club 缓存（让全量索引重新发现每个 ID 的正确 club）
    SNH48_BG.idToClubCache = {};
    SNH48_BG.setIndexDirty(true);
    SNH48_BG.scheduleFlush();
  }
  // [P0-2.3.2] 增量模式：保留现有数据，runRangeIndex 中会跳过已索引的 URL

  // [P0-1.4.1] 开始索引时持久化状态
  persistIndexingState();
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

// [FIX 5.2] 执行批量索引（移除问题重重的 listing 阶段，直接索引）
// [OPT] 小批量并发抓取 + 优化 flush 策略
// [P0-2.3.2] 支持增量模式：跳过已索引的 URL
async function runRangeIndex() {
  await loadIdClubCache();
  const start = SNH48_BG.indexingState.startId;
  const end = SNH48_BG.indexingState.endId;
  const total = end - start + 1;
  const mode = SNH48_BG.indexingState.mode || "full";

  SNH48_BG.indexingState.phase = "indexing";
  SNH48_BG.indexingState.currentId = start - 1; // 首个 ID 前

  // [P0-2.3.2] 增量模式：构建已索引 URL 集合，用于跳过
  const existingUrls = new Set();
  if (mode === "incremental") {
    for (const [url] of SNH48_BG.perfUrlMap) {
      existingUrls.add(url);
    }
  }

  // [OPT] 并发参数
  // 并发数 3：在索引速度和服务器压力间取得平衡，3 个并发请求可保持
  // 合理吞吐量，同时不会对 48.cn 服务器造成明显负担
  const BATCH_SIZE = 3; // 每批并发数（避免过多请求触发反爬）
  const BATCH_FLUSH_INTERVAL = 30; // 每N个ID强制落盘一次

  for (let id = start; id <= end; id += BATCH_SIZE) {
    if (!SNH48_BG.indexingState.running) break;

    // [OPT] 小批量并发抓取
    const batchIds = [];
    for (let b = 0; b < BATCH_SIZE && (id + b) <= end; b++) {
      batchIds.push(id + b);
    }

    const batchResults = await Promise.all(batchIds.map(async (bid) => {
      if (!SNH48_BG.indexingState.running) return { id: bid, result: { status: "skipped" } };

      // [P0-2.3.2] 增量模式：跳过已索引的 URL
      if (mode === "incremental") {
        const url = buildUrlFromId(bid);
        if (existingUrls.has(url)) {
          SNH48_BG.indexingState.skipped++;
          return { id: bid, result: { status: "skipped_existing" } };
        }
      }

      const url = buildUrlFromId(bid);
      // [P1-2.4.2] 请求前等待速率限制
      await waitForRateLimit();
      let result = await parsePerformancePageWithRetry(url);

      // 如果默认 URL 返回 not_found，尝试其他 club
      if (result.status === "not_found" || result.status === "no_data") {
        const fallback = await tryFetchWithClubFallback(bid, 1);
        result = fallback.result;
      }

      return { id: bid, result };
    }));

    // 处理批量结果
    for (const { id: bid, result } of batchResults) {
      SNH48_BG.indexingState.currentId = bid;

      switch (result.status) {
        case "ok":
          await SNH48_BG.mergeToIndex(result.data);
          SNH48_BG.indexingState.success++;
          SNH48_BG.indexingState.lastTitle = result.data.title;
          break;
        case "not_found":
          SNH48_BG.indexingState.notFound = (SNH48_BG.indexingState.notFound || 0) + 1;
          SNH48_BG.indexingState.lastTitle = "[404]";
          break;
        case "network_error":
          SNH48_BG.indexingState.networkError = (SNH48_BG.indexingState.networkError || 0) + 1;
          SNH48_BG.indexingState.failed++;
          SNH48_BG.indexingState.lastTitle = "[网络错误]";
          break;
        case "server_error":
          SNH48_BG.indexingState.failed++;
          SNH48_BG.indexingState.lastTitle = `[${result.httpStatus || "?"}]`;
          break;
        case "rate_limited":
          // [P1-2.4.2] 429 速率限制（计数已在 parsePerformancePageWithStatus 中递增）
          SNH48_BG.indexingState.failed++;
          SNH48_BG.indexingState.lastTitle = "[429限速]";
          break;
        case "parse_failed":
          // [P1-1.4.4] HTML解析失败（结构变化导致正则不匹配）
          SNH48_BG.indexingState.parseFailed = (SNH48_BG.indexingState.parseFailed || 0) + 1;
          SNH48_BG.indexingState.failed++;
          SNH48_BG.indexingState.lastTitle = "[解析失败]";
          break;
        case "no_data":
        case "invalid":
        case "skipped":
          SNH48_BG.indexingState.skipped++;
          SNH48_BG.indexingState.lastTitle = "";
          break;
        case "skipped_existing":
          // [P0-2.3.2] 已在 map 中计数，此处仅更新标题
          SNH48_BG.indexingState.lastTitle = "[已存在]";
          break;
        default:
          SNH48_BG.indexingState.skipped++;
          SNH48_BG.indexingState.lastTitle = "";
      }
    }

    // [FIX 5.2] 每 10 个 ID 广播一次进度（降低通信频率）
    const lastId = batchIds[batchIds.length - 1];
    if ((lastId - start) % 10 < BATCH_SIZE || lastId === end) {
      broadcastProgress(SNH48_MSG.INDEXING_PROGRESS, { ...SNH48_BG.indexingState });
    }

    // [FIX H7] 自适应延迟：成功/404 用短延迟，出错用长延迟
    // 200ms 正常延迟：每批间隔 200ms，折合约 15 请求/分钟，不会触发限速
    // 500ms 错误延迟：网络或服务器异常时给服务端恢复时间，避免雪崩
    const hasError = batchResults.some(r => r.result.status === "network_error" || r.result.status === "server_error");
    await delay(hasError ? 500 : 200);

    // [OPT] 每 BATCH_FLUSH_INTERVAL 个 ID 强制落盘一次
    if ((lastId - start) % BATCH_FLUSH_INTERVAL < BATCH_SIZE && SNH48_BG.isIndexDirty()) {
      await SNH48_BG.flushIndexNowAsync();
    }

    // [P0-1.4.1] 每批处理后持久化状态，防止 SW 被杀后丢失进度
    await persistIndexingState();
  }

  SNH48_BG.indexingState.running = false;
  SNH48_BG.indexingState.phase = "done";
  await SNH48_BG.flushIndexNowAsync();
  // [P0-1.4.1] 索引完成，清除持久化状态
  await persistIndexingState();
  broadcastProgress(SNH48_MSG.INDEXING_COMPLETE, { ...SNH48_BG.indexingState });
}

// 停止索引
async function stopRangeIndex() {
  SNH48_BG.indexingState.running = false;
  SNH48_BG.flushIndexNow(); // [FIX 4.7] 停止时也 flush
  // [P0-1.4.1] 停止时清除持久化状态
  await persistIndexingState();
  broadcastProgress(SNH48_MSG.INDEXING_COMPLETE, { ...SNH48_BG.indexingState });
  return { success: true };
}

// [P0-1.4.1] 持久化 indexingState 到 chrome.storage.session（SW 重启后可恢复）
async function persistIndexingState() {
  try {
    if (SNH48_BG.indexingState.running) {
      // 索引进行中：保存完整状态
      await chrome.storage.session.set({ [STORAGE_KEY_INDEXING_SESSION]: { ...SNH48_BG.indexingState } });
    } else {
      // 索引已完成/停止：清除持久化状态
      await chrome.storage.session.remove(STORAGE_KEY_INDEXING_SESSION);
    }
  } catch (e) {
    console.warn("[SNH48] persistIndexingState 失败:", e);
  }
}

// [P0-1.4.1] 从 chrome.storage.session 恢复 indexingState，若发现中断任务则自动恢复
async function restoreIndexingState() {
  try {
    const data = await chrome.storage.session.get(STORAGE_KEY_INDEXING_SESSION);
    const saved = data[STORAGE_KEY_INDEXING_SESSION];
    if (!saved || !saved.running) {
      // 无中断任务，清除残留状态（如有）
      await chrome.storage.session.remove(STORAGE_KEY_INDEXING_SESSION);
      return;
    }

    console.log("[SNH48] 检测到中断的索引任务，准备恢复:", JSON.stringify(saved));

    // 从 currentId + 1 恢复（currentId 是最后已处理的 ID）
    const resumeStartId = (saved.currentId != null) ? saved.currentId + 1 : saved.startId;
    if (resumeStartId > saved.endId) {
      // 已处理完毕，无需恢复
      console.log("[SNH48] 中断任务已处理完毕，无需恢复");
      await chrome.storage.session.remove(STORAGE_KEY_INDEXING_SESSION);
      return;
    }

    // 恢复状态，从 resumeStartId 继续索引
    SNH48_BG.indexingState = {
      running: true,
      startId: resumeStartId,
      endId: saved.endId,
      currentId: resumeStartId - 1,
      success: saved.success || 0,
      failed: saved.failed || 0,
      skipped: saved.skipped || 0,
      notFound: saved.notFound || 0,
      networkError: saved.networkError || 0,
      retryCount: saved.retryCount || 0,
      rateLimited: saved.rateLimited || 0,
      parseFailed: saved.parseFailed || 0,
      startTime: saved.startTime || Date.now(),
      lastTitle: saved.lastTitle || "",
      phase: "indexing"
    };

    console.log(`[SNH48] 恢复索引任务: ID ${resumeStartId} ~ ${saved.endId}`);
    // 启动恢复的索引任务
    runRangeIndex();
  } catch (e) {
    console.warn("[SNH48] restoreIndexingState 失败:", e);
  }
}

// 简单日志
function log(msg) { /* 生产版：已禁用 */ }

// 导出
SNH48_BG.startRangeIndex = startRangeIndex;
SNH48_BG.stopRangeIndex = stopRangeIndex;
SNH48_BG.getIndexingState = () => SNH48_BG.indexingState;
SNH48_BG.restoreIndexingState = restoreIndexingState;
SNH48_BG.parsePerformancePage = parsePerformancePage;
SNH48_BG.parsePerformancePageWithStatus = parsePerformancePageWithStatus;
SNH48_BG.parsePerformancePageWithRetry = parsePerformancePageWithRetry;
SNH48_BG.buildUrlFromId = buildUrlFromId;
SNH48_BG.broadcastProgress = broadcastProgress;
