// ========== SNH48 Live Enhancer - Content Script ==========
// 版本: 2.0.0
// 改进：
//   - 移除弹幕相关功能（网页未真正启用弹幕）
//   - 快捷键提示默认折叠
//   - 暗黑模式改为精确元素控制
//   - 真实实现成员搜索（在直播/回放页使用 .imglist，在列表页使用 .listname）
//   - 网页嵌入搜索入口（顶部导航栏增加搜索按钮）

(function () {
  "use strict";

  var LOG_PREFIX = "[SNH48-Enhancer]";

  function log() { /* 生产版：已禁用 */ }

  function warn() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift(LOG_PREFIX);
    console.warn.apply(console, args);
  }

  function error() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift(LOG_PREFIX);
    console.error.apply(console, args);
  }

  // ====================================================================
  // [FIX] Extension context 失效保护
  // 当用户在 chrome://extensions/ 刷新插件时，旧 content script 仍在页面上，
  // 但 extension context 已失效，所有 chrome.runtime.* / chrome.storage.* 调用都会抛错。
  // ====================================================================
  var _extensionDead = false;        // 是否已失效
  var _extTimers = [];               // 所有 setTimeout/setInterval 句柄，失效时统一清理

  // 包一层定时器，便于失效时统一清理
  function _extSetTimeout(fn, ms) {
    var h = setTimeout(function () {
      var idx = _extTimers.indexOf(h);
      if (idx >= 0) _extTimers.splice(idx, 1);
      if (_extensionDead) return;
      try { fn(); } catch (e) {}
    }, ms);
    _extTimers.push(h);
    return h;
  }
  function _extSetInterval(fn, ms) {
    var h = setInterval(function () {
      if (_extensionDead) {
        clearInterval(h);
        var idx = _extTimers.indexOf(h);
        if (idx >= 0) _extTimers.splice(idx, 1);
        return;
      }
      try { fn(); } catch (e) {}
    }, ms);
    _extTimers.push(h);
    return h;
  }
  function _extClearTimer(h) {
    if (h == null) return;
    clearTimeout(h);
    clearInterval(h);
    var idx = _extTimers.indexOf(h);
    if (idx >= 0) _extTimers.splice(idx, 1);
  }

  // 核心：检测 extension context 是否还活着
  // 通过 chrome.runtime.id 访问后检查。如果 id 为 undefined 或抛错，说明已失效
  function isExtensionContextAlive() {
    if (_extensionDead) return false;
    try {
      // chrome.runtime.id 在 context 失效后仍可能存在，但 sendMessage 会抛同步错
      // 用一个真正会失败的方法检测：访问 chrome.runtime.getManifest() 或 sendMessage
      // 更直接：若 chrome.runtime 不存在或 sendMessage 抛同步异常，则已死
      if (!chrome || !chrome.runtime) {
        _extensionDead = true;
        return false;
      }
      return true;
    } catch (e) {
      _extensionDead = true;
      return false;
    }
  }

  // 对 sendMessage / storage.set 的安全包装
  function safeSendMessage(msg, callback) {
    if (!isExtensionContextAlive()) return false;
    try {
      chrome.runtime.sendMessage(msg, function (res) {
        if (chrome.runtime.lastError) {
          // "Extension context invalidated." 或消息通道已关闭
          if (chrome.runtime.lastError.message && chrome.runtime.lastError.message.indexOf("context invalidated") !== -1) {
            _extensionDead = true;
            // 清理所有定时器
            _extTimers.slice().forEach(function (h) { _extClearTimer(h); });
            _extTimers = [];
          }
          return;
        }
        if (callback) { try { callback(res); } catch (e) {} }
      });
      return true;
    } catch (e) {
      // 同步抛错：Extension context invalidated
      _extensionDead = true;
      _extTimers.slice().forEach(function (h) { _extClearTimer(h); });
      _extTimers = [];
      return false;
    }
  }

  function safeStorageSet(data, callback) {
    if (!isExtensionContextAlive()) return false;
    try {
      chrome.storage.local.set(data, function () {
        if (chrome.runtime.lastError) {
          if (chrome.runtime.lastError.message && chrome.runtime.lastError.message.indexOf("context invalidated") !== -1) {
            _extensionDead = true;
            _extTimers.slice().forEach(function (h) { _extClearTimer(h); });
            _extTimers = [];
          }
          return;
        }
        if (callback) { try { callback(); } catch (e) {} }
      });
      return true;
    } catch (e) {
      _extensionDead = true;
      _extTimers.slice().forEach(function (h) { _extClearTimer(h); });
      _extTimers = [];
      return false;
    }
  }

  // ---- 配置 ----
  var DEFAULT_CONFIG = {
    darkMode: false,
    videoShortcuts: true,
    shortcutPanelCollapsed: true, // 快捷键面板默认折叠
    quickNav: true,
    memberIndex: true, // 成员-公演反向索引（被动建立）
    embeddedSearch: true, // 网页顶部嵌入搜索入口
    autoPiP: false,
    screenshotEnabled: true,
    hideHeader: false, // 隐藏头部以获得更大播放区
    reminderEnabled: false,
    reminderMinutesBefore: 15,
  };

  var config = Object.assign({}, DEFAULT_CONFIG);

  function loadConfig() {
    return new Promise(function (resolve) {
      if (!isExtensionContextAlive()) { resolve(config); return; }
      try {
        chrome.storage.sync.get("snh48_config", function (data) {
          if (chrome.runtime.lastError) {
            resolve(config);
            return;
          }
          if (data.snh48_config) {
            config = Object.assign({}, DEFAULT_CONFIG, data.snh48_config);
          }
          log("配置已加载:", config);
          resolve(config);
        });
      } catch (e) {
        resolve(config);
      }
    });
  }

  function saveConfig() {
    if (!isExtensionContextAlive()) return;
    try {
      chrome.storage.sync.set({ snh48_config: config }, function () {
        if (chrome.runtime.lastError) return;
      });
    } catch (e) {
      error("saveConfig 异常:", e);
    }
  }

  // ---- Toast 通知 ----
  function showToast(message, duration) {
    duration = duration || 1800;
    try {
      var toast = document.querySelector(".snh48-toast");
      if (!toast) {
        toast = document.createElement("div");
        toast.className = "snh48-toast";
        document.body.appendChild(toast);
      }
      toast.textContent = message;
      toast.classList.remove("show");
      void toast.offsetWidth; // 强制重排
      toast.classList.add("show");
      clearTimeout(toast._hideTimer);
      toast._hideTimer = setTimeout(function () {
        toast.classList.remove("show");
      }, duration);
    } catch (e) {
      error("showToast 异常:", e);
    }
  }

  // ---- 暗黑模式（v4 最小侵入版）----
  // 核心原则：
  //   1. 只对 style 属性中真实含有"白色/亮色/黑字"的元素进行清理
  //   2. 视频/播放器/iframe 区域保持原样 —— 递归跳过其所有后代
  //   3. 本插件 snh48- 前缀的自定义元素跳过
  var _darkModeObserver = null;

  // 判断元素/祖先是否为"视频/播放器/媒体容器"，是则整支跳过
  // 精确 token 匹配：只对类名完整 token 识别，不做部分子串匹配，避免 player 字样误伤
  function _isInMediaZone(el) {
    var cur = el;
    var depth = 0;
    // 精确识别的类 token 集合
    var MEDIA_CLASS_TOKENS = {
      "videoplay": 1,
      "xt-player": 1,
      "video-play": 1,
      "xt-video": 1,
      "video-box": 1,
      "video-wrap": 1,
      "playback": 1
    };
    // 精确识别的 id token 集合
    var MEDIA_ID_TOKENS = {
      "videoplay": 1,
      "xt-player": 1,
      "xt-video": 1,
      "video-box": 1,
      "player": 1,
      "video": 1
    };
    while (cur && cur.nodeType === 1 && depth < 20) {
      var tag = (cur.tagName || "").toUpperCase();
      if (tag === "VIDEO" || tag === "IFRAME" || tag === "CANVAS" || tag === "PICTURE") return true;
      var id = (cur.id || "").toLowerCase();
      var cls = typeof cur.className === "string" ? cur.className : "";
      // token 拆分（兼容空格/多个类）
      var idTokens = id.split(/[\s_-]+/);
      var clsTokens = cls.toLowerCase().split(/\s+/);
      // id 精确 token 检查
      if (id) {
        // 先按完整 id 名检查
        if (MEDIA_ID_TOKENS[id]) return true;
        // 再按 token 检查（如 "xt-player-xxx" 的 id）
        for (var m = 0; m < idTokens.length; m++) {
          if (MEDIA_ID_TOKENS[idTokens[m]]) return true;
        }
      }
      // className 精确 token 检查（对 class="xt-player wrapper" 这种形式）
      for (var n = 0; n < clsTokens.length; n++) {
        var t = clsTokens[n];
        if (!t) continue;
        if (MEDIA_CLASS_TOKENS[t]) return true;
      }
      cur = cur.parentNode;
      depth++;
    }
    return false;
  }

  function _isOwnUI(el) {
    if (!el) return false;
    var id = el.id || "";
    var cls = typeof el.className === "string" ? el.className : "";
    if (id.indexOf("snh48-") !== -1) return true;
    if (cls.indexOf("snh48-") !== -1) return true;
    return false;
  }

  // 判断 style 字符串是否包含典型的"亮色/白色/浅灰"背景值
  function _hasBrightBg(styleText) {
    if (!styleText) return false;
    var s = styleText.toLowerCase().replace(/\s+/g, "");
    var m = s.match(/background(?:-color)?:([^;}]+)/);
    if (!m) return false;
    var val = m[1];
    // 关键字
    if (val.indexOf("white") !== -1) return true;
    if (val.indexOf("whitesmoke") !== -1) return true;
    if (val.indexOf("lightgray") !== -1 || val.indexOf("lightgrey") !== -1) return true;
    if (val.indexOf("gainsboro") !== -1) return true;
    if (val.indexOf("silver") !== -1) return true;
    // 16 进制颜色（支持 3 / 6 / 8 位）
    var hexMatch = val.match(/#([0-9a-f]{3,8})/);
    if (hexMatch) {
      var hx = hexMatch[1];
      if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
      if (hx.length >= 6) {
        var r = parseInt(hx.substr(0, 2), 16);
        var g = parseInt(hx.substr(2, 2), 16);
        var b = parseInt(hx.substr(4, 2), 16);
        if (r >= 220 && g >= 220 && b >= 220) return true;
        if (r >= 200 && g >= 200 && b >= 200 &&
            Math.abs(r - g) < 40 && Math.abs(g - b) < 40 && Math.abs(r - b) < 40) return true;
      }
    }
    // rgb / rgba 形式
    var rgbMatch = val.match(/rgba?\((\d{1,3}),(\d{1,3}),(\d{1,3})/);
    if (rgbMatch) {
      var r2 = parseInt(rgbMatch[1], 10);
      var g2 = parseInt(rgbMatch[2], 10);
      var b2 = parseInt(rgbMatch[3], 10);
      if (r2 >= 220 && g2 >= 220 && b2 >= 220) return true;
      if (r2 >= 200 && g2 >= 200 && b2 >= 200 &&
          Math.abs(r2 - g2) < 40 && Math.abs(g2 - b2) < 40 && Math.abs(r2 - b2) < 40) return true;
    }
    return false;
  }

  // 判断 style 字符串是否包含典型的"深色文字"值（在暗色背景下不可见）
  function _hasDarkText(styleText) {
    if (!styleText) return false;
    var s = styleText.toLowerCase().replace(/\s+/g, "");
    var m = s.match(/color:([^;}]+)/);
    if (!m) return false;
    var val = m[1];
    if (val.indexOf("black") !== -1) return true;
    var hexMatch = val.match(/#([0-9a-f]{3,8})/);
    if (hexMatch) {
      var hx = hexMatch[1];
      if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
      if (hx.length >= 6) {
        var r = parseInt(hx.substr(0, 2), 16);
        var g = parseInt(hx.substr(2, 2), 16);
        var b = parseInt(hx.substr(4, 2), 16);
        if (r <= 120 && g <= 120 && b <= 120) return true;
        if (r <= 60 && g <= 60 && b <= 60) return true;
      }
    }
    var rgbMatch2 = val.match(/rgba?\((\d{1,3}),(\d{1,3}),(\d{1,3})/);
    if (rgbMatch2) {
      var r2 = parseInt(rgbMatch2[1], 10);
      var g2 = parseInt(rgbMatch2[2], 10);
      var b2 = parseInt(rgbMatch2[3], 10);
      if (r2 <= 120 && g2 <= 120 && b2 <= 120) return true;
      if (r2 <= 60 && g2 <= 60 && b2 <= 60) return true;
    }
    return false;
  }

  // 判断 style 字符串是否包含"中等灰色"文字（在暗背景下可见但不够强）
  function _hasDimText(styleText) {
    if (!styleText) return false;
    var s = styleText.toLowerCase().replace(/\s+/g, "");
    var m = s.match(/color:([^;}]+)/);
    if (!m) return false;
    var val = m[1];
    var hexMatch = val.match(/#([0-9a-f]{3,8})/);
    if (hexMatch) {
      var hx = hexMatch[1];
      if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
      if (hx.length >= 6) {
        var r = parseInt(hx.substr(0, 2), 16);
        var g = parseInt(hx.substr(2, 2), 16);
        var b = parseInt(hx.substr(4, 2), 16);
        if (r >= 100 && r <= 160 && g >= 100 && g <= 160 && b >= 100 && b <= 160 &&
            Math.abs(r - g) < 30 && Math.abs(g - b) < 30 && Math.abs(r - b) < 30) return true;
      }
    }
    var rgbMatch = val.match(/rgba?\((\d{1,3}),(\d{1,3}),(\d{1,3})/);
    if (rgbMatch) {
      var r2 = parseInt(rgbMatch[1], 10);
      var g2 = parseInt(rgbMatch[2], 10);
      var b2 = parseInt(rgbMatch[3], 10);
      if (r2 >= 100 && r2 <= 160 && g2 >= 100 && g2 <= 160 && b2 >= 100 && b2 <= 160 &&
          Math.abs(r2 - g2) < 30 && Math.abs(g2 - b2) < 30 && Math.abs(r2 - b2) < 30) return true;
    }
    return false;
  }

  // 收集 root 下所有元素节点，跳过不可见/媒体节点
  function _collectElements(root) {
    var result = [];
    if (!root || root.nodeType !== 1) return result;
    var tag = (root.tagName || "").toUpperCase();
    if (tag !== "SCRIPT" && tag !== "STYLE" && tag !== "META" && tag !== "NOSCRIPT" && tag !== "LINK") {
      result.push(root);
    }
    try {
      var all = root.getElementsByTagName("*");
      for (var i = 0; i < all.length; i++) {
        if (all[i].nodeType !== 1) continue;
        var t = (all[i].tagName || "").toUpperCase();
        if (t === "SCRIPT" || t === "STYLE" || t === "META" || t === "NOSCRIPT" || t === "LINK" || t === "BR" || t === "HR") continue;
        result.push(all[i]);
      }
    } catch (e) {}
    return result;
  }

  // 对 root 的元素进行"暗色模式样式清理"
  // 只在元素的 style 属性含亮色背景 / 深字时才修改；
  // 跳过视频/播放器/图像等媒体节点及其祖先。
  function _cleanInlineStyles(root) {
    if (!root || !document.documentElement.classList.contains("snh48-dark")) return;
    var nodes = _collectElements(root);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el || !el.getAttribute) continue;
      var tag = (el.tagName || "").toUpperCase();
      if (tag === "VIDEO" || tag === "IFRAME" || tag === "CANVAS" || tag === "SVG" || tag === "IMG" || tag === "PICTURE") continue;
      if (_isOwnUI(el)) continue;
      if (_isInMediaZone(el)) continue;

      var styleText = el.getAttribute("style");
      if (!styleText) continue;

      try {
        if (_hasBrightBg(styleText)) {
          el.style.setProperty("background-color", "var(--snh48-bg-card)", "important");
        }
        if (_hasDarkText(styleText)) {
          el.style.setProperty("color", "var(--snh48-text)", "important");
        } else if (_hasDimText(styleText)) {
          el.style.setProperty("color", "var(--snh48-text-dim)", "important");
        }
      } catch (e) {}
    }
  }

  function applyDarkMode(enabled) {
    log("暗黑模式:", enabled ? "开启" : "关闭");
    if (enabled) {
      document.documentElement.classList.add("snh48-dark");
      // 清理已存在元素的内联样式
      _cleanInlineStyles(document.body || document.documentElement);
      // 启动 MutationObserver 监听新加入/变化的元素
      if (!_darkModeObserver && typeof MutationObserver !== "undefined") {
        try {
          _darkModeObserver = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
              var m = mutations[i];
              if (m.type === "childList" && m.addedNodes && m.addedNodes.length > 0) {
                for (var j = 0; j < m.addedNodes.length; j++) {
                  var node = m.addedNodes[j];
                  if (node.nodeType === 1) _cleanInlineStyles(node);
                }
              }
              // style 属性变化时也重新检查该元素
              if (m.type === "attributes" && m.attributeName === "style" && m.target && m.target.nodeType === 1) {
                _cleanInlineStyles(m.target);
              }
            }
          });
          _darkModeObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["style"],
            characterData: false
          });
        } catch (e) {
          error("MutationObserver 初始化失败:", e);
        }
      }
    } else {
      document.documentElement.classList.remove("snh48-dark");
      if (_darkModeObserver) {
        try {
          _darkModeObserver.disconnect();
        } catch (e) {}
        _darkModeObserver = null;
      }
    }
  }

  // ---- 工具：等待元素出现 ----
  function waitForElement(selector, callback, timeout) {
    timeout = timeout || 15000;
    var startTime = Date.now();
    var check = setInterval(function () {
      var el = document.querySelector(selector);
      if (el) {
        clearInterval(check);
        callback(el);
      } else if (Date.now() - startTime > timeout) {
        clearInterval(check);
        log("等待元素超时:", selector);
      }
    }, 200);
  }

  // ============================================================
  // 2.5 成员-公演反向索引（被动建立）
  // ============================================================
  // 数据结构：
  //   memberIndex = {
  //     "成员名": [
  //       { title: "公演标题", url: "...", ts: 1234567890, group: "SNH48" }
  //     ]
  //   }
  // 存储于 chrome.storage.local（配额 5MB），按 LRU 淘汰

  var MEMBER_INDEX_KEY = "snh48_member_index";
  var MEMBER_INDEX_MAX_ENTRIES = 50000; // [OPT] 索引最多保留的 (成员, 公演) 条目（原5000，提升10倍）
  var MEMBER_INDEX_MAX_PER_MEMBER = 200; // [OPT] 单个成员最多保留的公演数（原50，提升4倍）
  var memberIndex = {};
  var memberIndexSaveTimer = null;
  var memberIndexStats = { members: 0, performances: 0 };

  function loadMemberIndex() {
    return new Promise(function (resolve) {
      if (!isExtensionContextAlive()) { resolve(); return; }
      try {
        chrome.storage.local.get(MEMBER_INDEX_KEY, function (data) {
          if (chrome.runtime.lastError) {
            memberIndex = {};
            resolve();
            return;
          }
          memberIndex = data[MEMBER_INDEX_KEY] || {};
          updateMemberIndexStats();
          log("成员索引已加载:", memberIndexStats);
          resolve();
        });
      } catch (e) {
        memberIndex = {};
        resolve();
      }
    });
  }

  // [FIX 4.8] 立即保存（页面卸载前调用）
  function saveMemberIndexNow() {
    if (!isExtensionContextAlive()) return;
    if (memberIndexSaveTimer) {
      _extClearTimer(memberIndexSaveTimer);
      memberIndexSaveTimer = null;
    }
    try {
      var json = JSON.stringify(memberIndex);
      if (json.length > 4 * 1024 * 1024) {
        pruneMemberIndex(true);
      }
      safeStorageSet({ [MEMBER_INDEX_KEY]: memberIndex }, function () {});
    } catch (e) {
      // 静默忽略（context 失效等情况不需要打扰用户）
    }
  }

  // [FIX 4.8] 缩短节流到 800ms + 注册 pagehide/beforeunload 兜底
  function saveMemberIndex() {
    if (!isExtensionContextAlive()) return;
    if (memberIndexSaveTimer) {
      _extClearTimer(memberIndexSaveTimer);
    }
    memberIndexSaveTimer = _extSetTimeout(function () {
      memberIndexSaveTimer = null;
      saveMemberIndexNow();
    }, 800);
  }

  // [FIX 4.8] 注册卸载前兜底（仅注册一次）
  if (typeof window !== "undefined" && !window._snh48_persist_registered) {
    window._snh48_persist_registered = true;
    var persistHandler = function () {
      try { saveMemberIndexNow(); } catch (e) { /* ignore */ }
    };
    window.addEventListener("pagehide", persistHandler);
    window.addEventListener("beforeunload", persistHandler);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") persistHandler();
    });
  }

  function updateMemberIndexStats() {
    var total = 0;
    var members = Object.keys(memberIndex).length;
    Object.keys(memberIndex).forEach(function (k) {
      total += memberIndex[k].length;
    });
    memberIndexStats.members = members;
    memberIndexStats.performances = total;
  }

  // LRU 裁剪
  function pruneMemberIndex(aggressive) {
    var totalEntries = 0;
    Object.keys(memberIndex).forEach(function (k) {
      totalEntries += memberIndex[k].length;
    });

    if (!aggressive && totalEntries <= MEMBER_INDEX_MAX_ENTRIES) return;

    // 把所有条目摊平，按 ts 升序排序
    var all = [];
    Object.keys(memberIndex).forEach(function (name) {
      memberIndex[name].forEach(function (entry) {
        all.push({ name: name, entry: entry });
      });
    });
    all.sort(function (a, b) { return a.entry.ts - b.entry.ts; });

    // 保留后 80% / 100%
    var keepCount = aggressive ? MEMBER_INDEX_MAX_ENTRIES : Math.floor(MEMBER_INDEX_MAX_ENTRIES * 0.8);
    var toRemove = all.length - keepCount;
    if (toRemove <= 0) return;

    for (var i = 0; i < toRemove; i++) {
      var item = all[i];
      var arr = memberIndex[item.name];
      var idx = arr.indexOf(item.entry);
      if (idx !== -1) arr.splice(idx, 1);
      if (arr.length === 0) delete memberIndex[item.name];
    }
    updateMemberIndexStats();
    log("索引已裁剪:", memberIndexStats);
  }

  // 解析当前页面，建立成员-公演映射
  function indexCurrentPagePerformers() {
    if (!config.memberIndex) return;

    var imglist = document.querySelector(".imglist");
    if (!imglist) return; // 仅在公演页建立索引

    // 1. 先做本地索引
    var titleEl =
      document.querySelector(".titles h1") ||
      document.querySelector(".titles .title1") ||
      document.querySelector("h1") ||
      document.querySelector(".v-text h2");
    var title = titleEl ? titleEl.textContent.trim() : document.title;
    var group = guessGroupFromUrl();
    var url = location.href;
    var ts = Date.now();
    var changed = false;
    var names = [];

    imglist.querySelectorAll(".imgbox .name").forEach(function (el) {
      var name = el.textContent.trim();
      if (!name) return;
      names.push(name);
      if (!memberIndex[name]) memberIndex[name] = [];

      var exists = memberIndex[name].some(function (e) { return e.url === url; });
      if (exists) return;

      memberIndex[name].push({ title: title, url: url, ts: ts, group: group });
      if (memberIndex[name].length > MEMBER_INDEX_MAX_PER_MEMBER) {
        memberIndex[name].sort(function (a, b) { return a.ts - b.ts; });
        memberIndex[name].splice(0, memberIndex[name].length - MEMBER_INDEX_MAX_PER_MEMBER);
      }
      changed = true;
    });

    if (changed) {
      updateMemberIndexStats();
      saveMemberIndex();
      log("本地成员索引已更新:", title, "→", names.length, "人 (总计:", memberIndexStats, ")");
    }

    // 2. 同时发送到 background.js 进行网络索引
    safeSendMessage({ type: "INDEX_CURRENT_PAGE", url: url }, function (resp) {
      if (resp && resp.success) log("当前公演已成功同步到后台索引!");
    });
  }

  function guessGroupFromUrl() {
    var m = location.pathname.match(/\/club\/(\d+)/);
    if (!m) return "";
    var map = { "1": "SNH48", "2": "BEJ48", "3": "GNZ48", "4": "SHY48", "5": "CKG48", "6": "CGT48" };
    return map[m[1]] || "";
  }

  // 清空索引
  function clearMemberIndex() {
    memberIndex = {};
    updateMemberIndexStats();
    if (!isExtensionContextAlive()) return;
    try {
      chrome.storage.local.remove(MEMBER_INDEX_KEY, function () {
        log("成员索引已清空");
      });
    } catch (e) {}
  }

  // ============================================================
  // 1. 网页嵌入搜索入口（顶部导航栏增加搜索框）
  // ============================================================
  function injectEmbeddedSearch() {
    if (!config.embeddedSearch) return;
    if (document.querySelector(".snh48-embedded-search")) return;

    log("注入顶部搜索入口");

    // 等待 .headright 出现
    waitForElement(".headright", function (headright) {
      try {
        var searchBox = document.createElement("div");
        searchBox.className = "snh48-embedded-search";
        searchBox.innerHTML =
          '<div class="snh48-search-input-wrap">' +
            '<input type="text" class="snh48-embedded-search-input" placeholder="搜索公演/成员 (Ctrl+K)">' +
            '<span class="snh48-search-shortcut">Ctrl+K</span>' +
          '</div>' +
          '<div class="snh48-search-results"></div>';

        // 插入到 headright 之前
        if (headright.parentNode) {
          headright.parentNode.insertBefore(searchBox, headright);
        } else {
          headright.appendChild(searchBox);
        }

        var input = searchBox.querySelector(".snh48-embedded-search-input");
        var resultsEl = searchBox.querySelector(".snh48-search-results");
        var currentData = null; // 当前渲染的数据 {groups, flatItems}
        var currentIndex = -1;  // 当前选中项在 flatItems 中的索引
        var activeFilter = "all"; // 类型过滤：'all' 或某 type

        function closeResults() {
          resultsEl.classList.remove("active");
          resultsEl.innerHTML = "";
          currentData = null;
          currentIndex = -1;
        }

        // 拉平数据用于键盘导航
        function flatten(data) {
          if (!data) return [];
          var result = [];
          data.groups.forEach(function (g) {
            g.items.forEach(function (it) { result.push({ group: g, item: it }); });
          });
          return result;
        }

        // 切换过滤
        function applyFilter(filterType) {
          activeFilter = filterType;
          if (!currentData) return;
          // 重新过滤 groups
          if (filterType === "all") {
            currentData.filteredGroups = currentData.groups.slice();
          } else {
            currentData.filteredGroups = currentData.groups
              .filter(function (g) { return g.type === filterType; });
          }
          currentIndex = -1; // 重置高亮
          render();
        }

        // 渲染整个结果面板
        function render() {
          resultsEl.innerHTML = "";
          if (!currentData) return;
          var groups = currentData.filteredGroups;

          // 1. 类型过滤 chips（仅当有数据时）
          renderFilterChips();

          if (groups.length === 0) {
            renderEmpty();
            resultsEl.classList.add("active");
            return;
          }

          var anyVisible = false;
          groups.forEach(function (g) {
            if (renderGroup(g)) anyVisible = true;
          });

          if (anyVisible) {
            resultsEl.classList.add("active");
            updateActive();
          } else {
            renderEmpty();
            resultsEl.classList.add("active");
          }
        }

        // 渲染类型过滤 chips
        function renderFilterChips() {
          if (!currentData) return;
          var chipBar = document.createElement("div");
          chipBar.className = "snh48-search-chips";

          var totalAll = currentData.groups.reduce(function (s, g) { return s + g.items.length; }, 0);
          var chips = [
            { type: "all", icon: "🔍", label: "全部", count: totalAll },
          ];
          currentData.groups.forEach(function (g) {
            chips.push({ type: g.type, icon: g.icon, label: g.label, count: g.items.length });
          });

          chips.forEach(function (c) {
            var chip = document.createElement("span");
            chip.className = "snh48-search-chip" + (activeFilter === c.type ? " active" : "");
            chip.innerHTML = c.icon + ' ' + c.label + ' <em>' + c.count + '</em>';
            chip.addEventListener("click", function (e) {
              e.stopPropagation();
              applyFilter(c.type);
            });
            chipBar.appendChild(chip);
          });
          resultsEl.appendChild(chipBar);
        }

        // 渲染一个分组
        function renderGroup(group) {
          if (!group.items || group.items.length === 0) return false;
          var wrapper = document.createElement("div");
          wrapper.className = "snh48-search-group";
          wrapper.dataset.groupType = group.type;

          // 分组头
          var header = document.createElement("div");
          header.className = "snh48-search-group-header";
          header.innerHTML =
            '<span class="snh48-search-group-icon">' + group.icon + '</span>' +
            '<span class="snh48-search-group-label">' + group.label + '</span>' +
            '<span class="snh48-search-group-count">' + group.items.length + '</span>';
          wrapper.appendChild(header);

          // 每组最多展示 5 条
          var PER_GROUP_LIMIT = 5;
          var visible = group.items.slice(0, PER_GROUP_LIMIT);
          var hidden = group.items.length - visible.length;

          visible.forEach(function (item) {
            wrapper.appendChild(buildItemEl(group, item));
          });

          if (hidden > 0) {
            var more = document.createElement("div");
            more.className = "snh48-search-more";
            more.textContent = "查看全部 " + group.items.length + " 条 →";
            more.addEventListener("click", function (e) {
              e.stopPropagation();
              // 展开该组：临时关闭"每组限制"
              group.items.forEach(function (item) {
                if (visible.indexOf(item) === -1) {
                  wrapper.appendChild(buildItemEl(group, item));
                }
              });
              more.remove();
            });
            wrapper.appendChild(more);
          }

          resultsEl.appendChild(wrapper);
          return true;
        }

        // 构造单条结果 DOM
        function buildItemEl(group, item) {
          var div = document.createElement("div");
          div.className = "snh48-search-result-item";

          // 兼容两种数据结构
          var types = item.types || [group.type];
          var badges = types.map(function (t) {
            var found = null;
            currentData.groups.forEach(function (g) { if (g.type === t) found = g; });
            var icon = found ? found.icon : group.icon;
            var extraCls = (t === "成员参演") ? " snh48-type-member-perf" : "";
            return '<span class="snh48-search-type' + extraCls + '">' + icon + ' ' + t + '</span>';
          }).join("");

          var name = item.name || item.title || "";

          div.innerHTML =
            badges +
            '<span class="snh48-search-name">' + highlight(name, currentData.query) + '</span>' +
            '<span class="snh48-search-meta">' + (item.meta || "") + '</span>';

          div.addEventListener("click", function (e) {
            e.stopPropagation();
            try { 
              if (item.action) item.action();
              else if (item.url) window.open(item.url, "_blank");
            } catch (err) { warn("action 执行失败:", err); }
            closeResults();
            input.value = "";
          });
          return div;
        }

        // 空状态 + 推荐
        function renderEmpty() {
          var empty = document.createElement("div");
          empty.className = "snh48-search-empty";

          if (currentData.query) {
            empty.innerHTML = '<div class="snh48-search-empty-title">未找到匹配 "' + escapeHtml(currentData.query) + '"</div>' +
              '<div class="snh48-search-empty-hint">试试搜索公演名、成员名或团名</div>';

            // 推荐：成员索引中的热门成员（按 ts 倒序）
            var suggestions = getTopMemberSuggestions(5);
            if (suggestions.length > 0) {
              var sugWrap = document.createElement("div");
              sugWrap.className = "snh48-search-suggestions";
              sugWrap.innerHTML = '<div class="snh48-search-suggestions-label">试试已收录的成员：</div>';
              suggestions.forEach(function (s) {
                var tag = document.createElement("span");
                tag.className = "snh48-search-suggestion-tag";
                tag.textContent = s.name + " (" + s.count + ")";
                tag.addEventListener("click", function (e) {
                  e.stopPropagation();
                  input.value = s.name;
                  input.focus();
                  performSearch(s.name);
                });
                sugWrap.appendChild(tag);
              });
              empty.appendChild(sugWrap);
            }
          } else {
            empty.innerHTML = '<div class="snh48-search-empty-title">输入关键词开始搜索</div>' +
              '<div class="snh48-search-empty-hint">支持搜索公演名、成员名、团名</div>';
          }
          resultsEl.appendChild(empty);
        }

        // 从成员索引中取热门成员（按收录的公演数量排序）
        function getTopMemberSuggestions(limit) {
          var arr = Object.keys(memberIndex).map(function (name) {
            return { name: name, count: memberIndex[name].length };
          });
          arr.sort(function (a, b) { return b.count - a.count; });
          return arr.slice(0, limit);
        }

        // 高亮匹配文本
        function highlight(text, query) {
          if (!query) return escapeHtml(text);
          var idx = text.toLowerCase().indexOf(query.toLowerCase());
          if (idx === -1) return escapeHtml(text);
          return escapeHtml(text.substring(0, idx)) +
            "<b>" + escapeHtml(text.substring(idx, idx + query.length)) + "</b>" +
            escapeHtml(text.substring(idx + query.length));
        }

        function escapeHtml(s) {
          return String(s).replace(/[<>&"]/g, function (c) {
            return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c];
          });
        }

        // 刷新当前结果（保持过滤）
        // [FIX 4.5] 搜索请求 token，用于忽略过期结果
        var searchToken = 0;

        async function performSearch(query) {
          if (!query) {
            closeResults();
            return;
          }

          // 1. 本地搜索（同步）
          var localData = collectAllSearchable(query);
          currentData = localData;
          currentData.query = query;
          applyFilterAndRender(query);

          // 2. 后台搜索（异步）[FIX 4.5 修复竞态 + FIX 4.4 合并]
          const myToken = ++searchToken;
          safeSendMessage({ type: "SEARCH_INDEX", query: query }, function (indexResults) {
              if (myToken !== searchToken) return; // 过期结果，忽略
              if (chrome.runtime.lastError) {
                warn("后台搜索消息失败:", chrome.runtime.lastError);
                return;
              }
              if (!indexResults || indexResults.length === 0) {
                log("后台搜索 [" + query + "]: 无结果");
                return;
              }
              if (!currentData) return;

              log("后台搜索 [" + query + "]: 返回 " + indexResults.length + " 条结果，当前类型分组数=" + currentData.groups.length);

              // 把后台索引结果合并到「成员参演」分组
              var memberPerfGroup = currentData.groups.find(g => g.type === "成员参演");
              var newCount = 0;
              if (memberPerfGroup) {
                var existingUrls = new Set(memberPerfGroup.items.map(it => it.url));
                indexResults.forEach(r => {
                  if (!existingUrls.has(r.url)) {
                    r.action = function () { window.open(r.url, "_blank"); };
                    memberPerfGroup.items.push(r);
                    newCount++;
                  }
                });
              } else {
                indexResults.forEach(r => r.action = function () { window.open(r.url, "_blank"); });
                currentData.groups.unshift({
                  type: "成员参演",
                  icon: "⭐",
                  label: "成员参演",
                  items: indexResults
                });
                newCount = indexResults.length;
              }
              if (newCount > 0) applyFilterAndRender(query);
            });
        }

        function applyFilterAndRender(query) {
          currentData.query = query;
          if (activeFilter === "all") {
            currentData.filteredGroups = currentData.groups.slice();
          } else {
            currentData.filteredGroups = currentData.groups.filter(function (g) { return g.type === activeFilter; });
            if (currentData.filteredGroups.length === 0 && currentData.groups.length > 0) {
              activeFilter = "all";
              currentData.filteredGroups = currentData.groups.slice();
            }
          }
          currentIndex = -1;
          render();
        }

        function updateActive() {
          var items = resultsEl.querySelectorAll(".snh48-search-result-item");
          items.forEach(function (it) { it.classList.remove("active"); });
          var flat = flatten(currentData ? { groups: currentData.filteredGroups } : null);
          if (currentIndex >= 0 && flat[currentIndex]) {
            var visibleItems = resultsEl.querySelectorAll(".snh48-search-result-item");
            if (visibleItems[currentIndex]) {
              visibleItems[currentIndex].classList.add("active");
              visibleItems[currentIndex].scrollIntoView({ block: "nearest" });
            }
          }
        }

        // [OPT] 搜索防抖：减少频繁搜索请求
        var searchDebounceTimer = null;
        input.addEventListener("input", function () {
          var val = input.value.trim();
          clearTimeout(searchDebounceTimer);
          if (!val) {
            closeResults();
            return;
          }
          searchDebounceTimer = _extSetTimeout(function () {
            performSearch(val);
          }, 150);
        });

        input.addEventListener("focus", function () {
          if (input.value.trim()) performSearch(input.value.trim());
        });

        input.addEventListener("keydown", function (e) {
          var flat = flatten(currentData ? { groups: currentData.filteredGroups } : null);
          if (flat.length === 0) return;

          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (currentIndex < flat.length - 1) {
              currentIndex++;
              updateActive();
            }
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (currentIndex > 0) {
              currentIndex--;
              updateActive();
            }
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (currentIndex >= 0 && flat[currentIndex]) {
              try { flat[currentIndex].item.action(); } catch (err) { warn("action 失败:", err); }
              closeResults();
              input.value = "";
            }
          } else if (e.key === "Escape") {
            closeResults();
            input.blur();
          }
        });

        // 点击外部关闭
        document.addEventListener("click", function (e) {
          if (!searchBox.contains(e.target)) closeResults();
        });

        log("顶部搜索入口已注入");
      } catch (e) {
        error("注入搜索入口失败:", e);
      }
    });
  }

  // 收集所有可搜索项（返回分组结构 + URL 去重）
  function collectAllSearchable(query) {
    var q = query.toLowerCase();
    // key → 已合并的搜索项（用于去重）
    var dedupMap = Object.create(null);
    var order = []; // 保持首次出现顺序

    function addItem(item) {
      // 构造去重 key：URL 优先，否则用 name + type
      var key = item.url || (item.type + "::" + item.name);
      if (dedupMap[key]) {
        // 已存在：累加额外类型徽章
        if (dedupMap[key].types.indexOf(item.type) === -1) {
          dedupMap[key].types.push(item.type);
        }
        return;
      }
      item.types = [item.type];
      dedupMap[key] = item;
      order.push(key);
    }

    // 1. 视频列表 (.videolist > .videos)
    document.querySelectorAll(".videolist .videos").forEach(function (li) {
      var a = li.querySelector("a");
      var h4 = li.querySelector("h4");
      var p = li.querySelector("p");
      if (!a) return;
      var name = (h4 ? h4.textContent : "").trim();
      var meta = (p ? p.textContent : "").trim();
      if (name.toLowerCase().includes(q)) {
        addItem({
          type: "公演",
          typeIcon: "📺",
          name: name,
          meta: meta,
          url: a.href,
          action: function () { window.open(a.href, "_blank"); },
        });
      }
    });

    // 2. 即将开始列表 (.starts)
    document.querySelectorAll(".starts").forEach(function (li) {
      var p = li.querySelector("p");
      var time = li.querySelector(".starttime");
      if (!p) return;
      var name = p.textContent.trim();
      var meta = time ? time.textContent.trim() : "";
      if (name.toLowerCase().includes(q)) {
        addItem({
          type: "即将开始",
          typeIcon: "⏰",
          name: name,
          meta: meta,
          url: "scroll::" + name,
          action: function () {
            li.scrollIntoView({ behavior: "smooth", block: "center" });
            li.style.outline = "2px solid #839cff";
            setTimeout(function () { li.style.outline = ""; }, 3000);
          },
        });
      }
    });

    // 3. 直播中项目 (.watchcontent)
    document.querySelectorAll(".watchcontent").forEach(function (wc) {
      var h2 = wc.querySelector(".v-text h2");
      var p = wc.querySelector(".v-text p");
      if (!h2) return;
      var name = h2.textContent.trim();
      var meta = p ? p.textContent.trim() : "";
      if (name.toLowerCase().includes(q)) {
        var btn = wc.querySelector(".startbtn");
        var url = btn && btn.tagName === "A" ? btn.href : "";
        addItem({
          type: "正在直播",
          typeIcon: "🔴",
          name: name,
          meta: meta,
          url: url,
          action: function () {
            if (btn) {
              if (btn.tagName === "A") window.open(btn.href, "_blank");
              else btn.click();
            } else {
              wc.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          },
        });
      }
    });

    // 4. 直播/回放页 - 参演成员 (.imglist .imgbox)
    document.querySelectorAll(".imglist .imgbox").forEach(function (box) {
      var nameEl = box.querySelector(".name");
      if (!nameEl) return;
      var name = nameEl.textContent.trim();
      if (name.toLowerCase().includes(q)) {
        addItem({
          type: "参演成员",
          typeIcon: "👥",
          name: name,
          meta: "本页公演",
          url: "scroll::" + name,
          action: function () {
            box.scrollIntoView({ behavior: "smooth", block: "center" });
            box.style.outline = "2px solid #839cff";
            box.style.borderRadius = "8px";
            setTimeout(function () { box.style.outline = ""; }, 3000);
          },
        });
      }
    });

    // 5. 直播/回放页 - 成员人气榜 (.memberlist .listname)
    document.querySelectorAll(".memberlist li").forEach(function (li) {
      var nameEl = li.querySelector(".listname");
      if (!nameEl) return;
      var name = nameEl.textContent.trim();
      if (name.toLowerCase().includes(q)) {
        addItem({
          type: "成员",
          typeIcon: "👤",
          name: name,
          meta: "成员人气榜",
          url: "scroll::" + name,
          action: function () {
            li.scrollIntoView({ behavior: "smooth", block: "center" });
            li.style.outline = "2px solid #839cff";
            setTimeout(function () { li.style.outline = ""; }, 3000);
          },
        });
      }
    });

    // 6. 成员-公演反向索引
    if (config.memberIndex) {
      var memberHits = searchMemberIndex(query);
      memberHits.forEach(function (hit) {
        addItem({
          type: "成员参演",
          typeIcon: "⭐",
          name: hit.title,
          meta: hit.member + (hit.group ? " · " + hit.group : "") + " · " + formatRelativeTime(hit.ts),
          url: hit.url,
          isMemberPerf: true,
          action: function () { window.open(hit.url, "_blank"); },
        });
      });
    }

    var flat = order.map(function (k) { return dedupMap[k]; });

    // 按类型分组
    var groupOrder = [
      { type: "成员参演", icon: "⭐", label: "成员参演" },
      { type: "公演", icon: "📺", label: "公演" },
      { type: "正在直播", icon: "🔴", label: "正在直播" },
      { type: "即将开始", icon: "⏰", label: "即将开始" },
      { type: "参演成员", icon: "👥", label: "参演成员" },
      { type: "成员", icon: "👤", label: "成员" },
    ];
    var groups = [];
    groupOrder.forEach(function (g) {
      var items = flat.filter(function (it) { return it.types.indexOf(g.type) !== -1; });
      if (items.length > 0) {
        groups.push({ type: g.type, icon: g.icon, label: g.label, items: items });
      }
    });

    // 智能排序：当 query 在成员索引中时，"成员参演"组置顶（已在 groupOrder 中实现）

    return {
      query: query,
      groups: groups,
      totalCount: flat.length,
      isEmpty: flat.length === 0,
    };
  }

  // 在成员索引中搜索匹配的公演
  function searchMemberIndex(query) {
    var q = query.toLowerCase().trim();
    if (!q || Object.keys(memberIndex).length === 0) return [];

    // 构建小写名 → 原名的映射（用于不区分大小写查找）
    var nameMap = {};
    Object.keys(memberIndex).forEach(function (k) {
      nameMap[k.toLowerCase()] = k;
    });

    var results = [];
    // 1. 精确匹配成员名（不区分大小写）→ 该成员的所有公演
    var exactName = nameMap[q];
    if (exactName) {
      memberIndex[exactName].forEach(function (entry) {
        results.push({
          member: exactName,
          title: entry.title,
          url: entry.url,
          ts: entry.ts,
          group: entry.group,
        });
      });
    }
    // 2. 模糊匹配成员名 → 取前 3 个匹配成员，每个最多 5 个公演
    var fuzzyNames = Object.keys(nameMap)
      .filter(function (n) { return n !== q && n.includes(q); })
      .slice(0, 3)
      .map(function (low) { return nameMap[low]; });
    fuzzyNames.forEach(function (name) {
      memberIndex[name]
        .slice()
        .sort(function (a, b) { return b.ts - a.ts; })
        .slice(0, 5)
        .forEach(function (entry) {
          results.push({
            member: name,
            title: entry.title,
            url: entry.url,
            ts: entry.ts,
            group: entry.group,
          });
        });
    });

    // 按时间倒序
    results.sort(function (a, b) { return b.ts - a.ts; });
    // 限制总条数
    return results.slice(0, 15);
  }

  function formatRelativeTime(ts) {
    var diff = Date.now() - ts;
    var day = 24 * 60 * 60 * 1000;
    if (diff < day) return "今天";
    if (diff < 2 * day) return "昨天";
    if (diff < 7 * day) return Math.floor(diff / day) + "天前";
    if (diff < 30 * day) return Math.floor(diff / (7 * day)) + "周前";
    return Math.floor(diff / (30 * day)) + "月前";
  }

  // 全局快捷键 Ctrl+K / Cmd+K 打开顶部搜索
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      var input = document.querySelector(".snh48-embedded-search-input");
      if (input) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    }
  });

  // ============================================================
  // 2. 视频增强
  // ============================================================
  function setupVideoShortcuts() {
    if (!config.videoShortcuts) {
      log("视频快捷键已禁用");
      return;
    }
    log("视频快捷键已启用");

    // [FIX] 使用捕获阶段监听 keydown，优先于网站播放器的事件处理
    // 网站播放器可能在冒泡阶段 stopPropagation()，导致空格键等无法到达 document
    document.addEventListener("keydown", function (e) {
      // 输入框中不触发
      var tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;

      // [FIX] 更健壮地查找 video 元素：直接查找 + Shadow DOM 查找
      var video = document.querySelector("video");
      if (!video) {
        // 尝试在 Shadow DOM 中查找
        var allEls = document.querySelectorAll("*");
        for (var i = 0; i < allEls.length; i++) {
          if (allEls[i].shadowRoot) {
            var shadowVideo = allEls[i].shadowRoot.querySelector("video");
            if (shadowVideo) { video = shadowVideo; break; }
          }
        }
      }
      if (!video && !["F2", "F1"].includes(e.key)) return;

      switch (e.key) {
        case " ":
          if (video) {
            e.preventDefault();
            e.stopPropagation(); // [FIX] 阻止事件继续传播到播放器，避免双重触发
            if (video.paused) {
              video.play().catch(function() {});
              showToast("▶ 播放");
            } else {
              video.pause();
              showToast("⏸ 暂停");
            }
          }
          break;
        case "ArrowLeft":
          if (video) {
            e.preventDefault();
            video.currentTime = Math.max(0, video.currentTime - 5);
            showToast("⏪ -5s");
          }
          break;
        case "ArrowRight":
          if (video) {
            e.preventDefault();
            video.currentTime = Math.min(video.duration || 1e10, video.currentTime + 5);
            showToast("⏩ +5s");
          }
          break;
        case "ArrowUp":
          if (video) {
            e.preventDefault();
            video.volume = Math.min(1, video.volume + 0.1);
            showToast("🔊 " + Math.round(video.volume * 100) + "%");
          }
          break;
        case "ArrowDown":
          if (video) {
            e.preventDefault();
            video.volume = Math.max(0, video.volume - 0.1);
            showToast("🔉 " + Math.round(video.volume * 100) + "%");
          }
          break;
        case "f":
        case "F":
          e.preventDefault();
          toggleFullScreen();
          break;
        case "m":
        case "M":
          if (video) {
            e.preventDefault();
            video.muted = !video.muted;
            showToast(video.muted ? "🔇 已静音" : "🔊 取消静音");
          }
          break;
        case "p":
        case "P":
          if (video) {
            e.preventDefault();
            togglePictureInPicture();
          }
          break;
        case "s":
        case "S":
          if (e.ctrlKey || e.metaKey) return;
          if (config.screenshotEnabled) {
            e.preventDefault();
            takeScreenshot();
          }
          break;
        case "[":
          if (video) {
            e.preventDefault();
            changePlaybackRate(-0.25);
          }
          break;
        case "]":
          if (video) {
            e.preventDefault();
            changePlaybackRate(0.25);
          }
          break;
        case "0":
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7":
        case "8":
        case "9":
          if (video && video.duration) {
            e.preventDefault();
            var percent = parseInt(e.key) / 10;
            video.currentTime = video.duration * percent;
            showToast("⏱ 跳到 " + (percent * 100) + "%");
          }
          break;
      }
    }, true); // [FIX] capture: true — 在捕获阶段处理，优先于网站播放器
  }

  function toggleFullScreen() {
    var player = document.querySelector(".videoplay") || document.querySelector("video");
    if (!player) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      (player.requestFullscreen || player.webkitRequestFullscreen).call(player)
        .catch(function (e) {
          warn("全屏请求失败:", e);
          showToast("全屏不可用");
        });
    }
  }

  function togglePictureInPicture() {
    var video = document.querySelector("video");
    if (!video) return;
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture();
      showToast("退出画中画");
    } else {
      video.requestPictureInPicture()
        .then(function () {
          showToast("📺 画中画已开启");
        })
        .catch(function (e) {
          warn("画中画失败:", e);
          showToast("画中画不可用");
        });
    }
  }

  function changePlaybackRate(delta) {
    var video = document.querySelector("video");
    if (!video) return;
    var newRate = Math.max(0.25, Math.min(4, (video.playbackRate || 1) + delta));
    video.playbackRate = newRate;
    showToast("⚡ " + newRate + "x");
  }

  function takeScreenshot() {
    var video = document.querySelector("video");
    if (!video) {
      showToast("未找到视频");
      return;
    }
    log("正在截图...");

    try {
      // 闪光
      var flash = document.createElement("div");
      flash.className = "snh48-screenshot-flash";
      document.body.appendChild(flash);
      requestAnimationFrame(function () {
        flash.classList.add("active");
      });
      setTimeout(function () {
        flash.classList.remove("active");
        setTimeout(function () { flash.remove(); }, 200);
      }, 120);

      // 截图
      var canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0);

      canvas.toBlob(function (blob) {
        if (!blob) {
          error("截图 blob 生成失败");
          showToast("截图失败");
          return;
        }
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        var d = new Date();
        var ts =
          d.getFullYear() +
          ("0" + (d.getMonth() + 1)).slice(-2) +
          ("0" + d.getDate()).slice(-2) + "_" +
          ("0" + d.getHours()).slice(-2) +
          ("0" + d.getMinutes()).slice(-2) +
          ("0" + d.getSeconds()).slice(-2);
        a.download = "SNH48_" + ts + ".png";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast("📸 截图已保存");
      }, "image/png");
    } catch (e) {
      error("截图异常:", e);
      showToast("截图失败");
    }
  }

  // ============================================================
  // 4. 快捷导航（分团切换）
  // ============================================================
  function createQuickNav() {
    if (!config.quickNav) return;
    if (document.querySelector(".snh48-quick-nav")) return;

    log("创建快捷导航");

    var groups = [
      { name: "首页", url: "https://live.48.cn/", pattern: /^https:\/\/live\.48\.cn\/?(\?.*)?$/ },
      { name: "SNH48", url: "https://live.48.cn/Index/main/club/1", pattern: /\/club\/1/ },
      { name: "BEJ48", url: "https://live.48.cn/Index/main/club/2", pattern: /\/club\/2/ },
      { name: "GNZ48", url: "https://live.48.cn/Index/main/club/3", pattern: /\/club\/3/ },
      { name: "CKG48", url: "https://live.48.cn/Index/main/club/5", pattern: /\/club\/5/ },
      { name: "CGT48", url: "https://live.48.cn/Index/main/club/6", pattern: /\/club\/6/ },
    ];

    var nav = document.createElement("div");
    nav.className = "snh48-quick-nav";

    var currentUrl = window.location.href;
    groups.forEach(function (g) {
      var item = document.createElement("a");
      item.className = "snh48-nav-item";
      item.href = g.url;
      item.textContent = g.name;
      if (g.pattern.test(currentUrl)) item.classList.add("active");
      nav.appendChild(item);
    });

    document.body.appendChild(nav);

    var hideTimer = null;
    function showNav() {
      nav.classList.remove("hidden");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () {
        nav.classList.add("hidden");
      }, 4000);
    }
    document.addEventListener("mousemove", showNav);
    showNav();
  }

  // ============================================================
  // 5. 公演提醒
  // ============================================================
  function setupReminder() {
    if (!config.reminderEnabled) return;

    log("公演提醒已启用");

    function checkReminders() {
      try {
        var now = new Date();
        var items = document.querySelectorAll(".starts");
        items.forEach(function (item) {
          var timeEl = item.querySelector(".starttime");
          var nameEl = item.querySelector("p");
          if (!timeEl || !nameEl) return;

          var timeText = timeEl.textContent.trim();
          var name = nameEl.textContent.trim();
          var match = timeText.match(/(\d+)日\s*(\d+):(\d+)/);
          if (!match) return;

          var day = parseInt(match[1]);
          var hour = parseInt(match[2]);
          var minute = parseInt(match[3]);
          var perfDate = new Date(now.getFullYear(), now.getMonth(), day, hour, minute);
          if (perfDate < now) perfDate.setMonth(perfDate.getMonth() + 1);

          var diff = perfDate - now;
          var minutesLeft = Math.floor(diff / 60000);
          if (minutesLeft > 0 && minutesLeft <= config.reminderMinutesBefore) {
            showReminder(name, minutesLeft, timeText);
          }
        });
      } catch (e) {
        error("checkReminders 异常:", e);
      }
    }

    function showReminder(name, minutesLeft, timeText) {
      var popupId = "snh48-reminder";
      if (document.getElementById(popupId)) return;

      var popup = document.createElement("div");
      popup.id = popupId;
      popup.className = "snh48-reminder-popup";
      popup.innerHTML =
        '<div class="snh48-reminder-header">' +
          '<span>🔔 公演即将开始</span>' +
          '<span class="snh48-reminder-close">&times;</span>' +
        '</div>' +
        '<div class="snh48-reminder-body">' +
          '<div class="snh48-reminder-title">' + name + '</div>' +
          '<div class="snh48-reminder-time">⏰ ' + minutesLeft + ' 分钟后开始 · ' + timeText + '</div>' +
        '</div>';

      popup.querySelector(".snh48-reminder-close").addEventListener("click", function () {
        popup.remove();
      });

      document.body.appendChild(popup);

      try {
        if (Notification.permission === "granted") {
          new Notification("SNH48 公演提醒", {
            body: name + " " + minutesLeft + " 分钟后开始",
          });
        }
      } catch (e) {
        warn("通知异常:", e);
      }

      setTimeout(function () { if (popup.parentNode) popup.remove(); }, 15000);
    }

    if (Notification.permission === "default") {
      try { Notification.requestPermission(); } catch (e) { /* ignore */ }
    }

    setInterval(checkReminders, 60000);
    checkReminders();
  }

  // ============================================================
  // 6. 浮动控制面板
  // ============================================================
  function createFloatPanel() {
    if (document.querySelector(".snh48-float-panel")) return;

    log("创建浮动控制面板");

    var panel = document.createElement("div");
    panel.className = "snh48-float-panel collapsed";
    panel.innerHTML =
      // 顶部拖动条 + 标题
      '<div class="snh48-panel-header" id="snh48-panel-drag">' +
        '<span class="snh48-drag-handle" title="拖动">⋮⋮</span>' +
        '<span class="snh48-title">⚙️ Enhancer</span>' +
        '<span class="snh48-toggle" id="snh48-panel-toggle" title="展开/折叠">▸</span>' +
      '</div>' +
      // 主体
      '<div class="snh48-panel-body">' +
        // 外观
        '<div class="snh48-section">' +
          '<div class="snh48-section-title">外观</div>' +
          '<div class="snh48-switch-row">' +
            '<label>暗黑模式</label>' +
            '<label class="snh48-switch"><input type="checkbox" id="snh48-dark-mode" ' + (config.darkMode ? "checked" : "") + '><span class="slider"></span></label>' +
          '</div>' +
          '<div class="snh48-switch-row">' +
            '<label>隐藏头部</label>' +
            '<label class="snh48-switch"><input type="checkbox" id="snh48-hide-header" ' + (config.hideHeader ? "checked" : "") + '><span class="slider"></span></label>' +
          '</div>' +
        '</div>' +
        // 视频
        '<div class="snh48-section">' +
          '<div class="snh48-section-title">视频</div>' +
          '<div class="snh48-switch-row">' +
            '<label>键盘快捷键</label>' +
            '<label class="snh48-switch"><input type="checkbox" id="snh48-video-shortcuts" ' + (config.videoShortcuts ? "checked" : "") + '><span class="slider"></span></label>' +
          '</div>' +
          '<div class="snh48-switch-row">' +
            '<label>截图功能</label>' +
            '<label class="snh48-switch"><input type="checkbox" id="snh48-screenshot" ' + (config.screenshotEnabled ? "checked" : "") + '><span class="slider"></span></label>' +
          '</div>' +
          '<div class="snh48-shortcut-toggle" id="snh48-show-shortcuts">⌨️ 快捷键</div>' +
          '<div class="snh48-shortcut-list-wrap" id="snh48-shortcut-list" style="display:none">' +
            '<div class="snh48-shortcut-grid">' +
              '<div class="snh48-shortcut"><kbd>Space</kbd> 播放/暂停</div>' +
              '<div class="snh48-shortcut"><kbd>←</kbd><kbd>→</kbd> ±5秒</div>' +
              '<div class="snh48-shortcut"><kbd>F</kbd> 全屏</div>' +
              '<div class="snh48-shortcut"><kbd>P</kbd> 画中画</div>' +
              '<div class="snh48-shortcut"><kbd>S</kbd> 截图</div>' +
              '<div class="snh48-shortcut"><kbd>M</kbd> 静音</div>' +
              '<div class="snh48-shortcut"><kbd>0-9</kbd> 跳进度</div>' +
              '<div class="snh48-shortcut"><kbd>Ctrl+K</kbd> 搜索</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        // 功能
        '<div class="snh48-section">' +
          '<div class="snh48-section-title">功能</div>' +
          '<div class="snh48-switch-row">' +
            '<label>顶部搜索入口</label>' +
            '<label class="snh48-switch"><input type="checkbox" id="snh48-embedded-search" ' + (config.embeddedSearch ? "checked" : "") + '><span class="slider"></span></label>' +
          '</div>' +
          '<div class="snh48-switch-row">' +
            '<label>成员参演索引</label>' +
            '<label class="snh48-switch"><input type="checkbox" id="snh48-member-index" ' + (config.memberIndex ? "checked" : "") + '><span class="slider"></span></label>' +
          '</div>' +
          '<div class="snh48-member-index-info" id="snh48-member-index-info">已索引: 加载中...</div>' +
          '<div class="snh48-member-index-actions">' +
            '<button type="button" class="snh48-mini-btn" id="snh48-clear-index">清空本地</button>' +
            '<button type="button" class="snh48-mini-btn" id="snh48-clear-full-index">清空全部</button>' +
          '</div>' +
          '<div class="snh48-switch-row">' +
            '<label>快捷导航</label>' +
            '<label class="snh48-switch"><input type="checkbox" id="snh48-quick-nav" ' + (config.quickNav ? "checked" : "") + '><span class="slider"></span></label>' +
          '</div>' +
          '<div class="snh48-switch-row">' +
            '<label>公演提醒</label>' +
            '<label class="snh48-switch"><input type="checkbox" id="snh48-reminder" ' + (config.reminderEnabled ? "checked" : "") + '><span class="slider"></span></label>' +
          '</div>' +
        '</div>' +
        // 批量索引
        '<div class="snh48-section">' +
          '<div class="snh48-section-title">批量索引</div>' +
          '<div class="snh48-indexing-controls">' +
            '<div class="snh48-indexing-inputs">' +
              '<div class="snh48-indexing-input-wrap">' +
                '<span>起始ID</span>' +
                '<input type="number" id="snh48-idx-start-id" placeholder="1000" />' +
              '</div>' +
              '<div class="snh48-indexing-input-wrap">' +
                '<span>结束ID</span>' +
                '<input type="number" id="snh48-idx-end-id" placeholder="2000" />' +
              '</div>' +
            '</div>' +
            '<div class="snh48-indexing-buttons">' +
              '<button id="snh48-idx-start-btn" class="snh48-indexing-btn snh48-indexing-start">开始索引</button>' +
              '<button id="snh48-idx-stop-btn" class="snh48-indexing-btn snh48-indexing-stop" disabled>停止</button>' +
            '</div>' +
            '<div class="snh48-indexing-progress">' +
              '<div id="snh48-progress-bar" class="snh48-progress-bar"><div class="snh48-progress-fill"></div></div>' +
              '<div id="snh48-progress-text" class="snh48-progress-text">等待操作...</div>' +
              '<div id="snh48-progress-detail" class="snh48-progress-detail"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(panel);

    // 折叠/展开
    var toggle = panel.querySelector("#snh48-panel-toggle");
    toggle.addEventListener("click", function (e) {
      e.stopPropagation();
      panel.classList.toggle("collapsed");
      toggle.textContent = panel.classList.contains("collapsed") ? "▸" : "▾";
    });

    // 拖动
    var drag = panel.querySelector("#snh48-panel-drag");
    var isDragging = false;
    var startX, startY, startLeft, startTop;

    function loadPosition() {
      try {
        var saved = JSON.parse(localStorage.getItem("snh48_panel_pos") || "null");
        if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
          panel.style.left = saved.left + "px";
          panel.style.top = saved.top + "px";
          panel.style.right = "auto";
          panel.style.bottom = "auto";
        }
      } catch (e) {}
    }
    loadPosition();

    drag.addEventListener("mousedown", function (e) {
      if (e.target.closest(".snh48-toggle")) return; // 不在折叠按钮上启动拖动
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      var rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      panel.style.left = startLeft + "px";
      panel.style.top = startTop + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    document.addEventListener("mousemove", function (e) {
      if (!isDragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      var newLeft = Math.max(0, Math.min(window.innerWidth - 60, startLeft + dx));
      var newTop = Math.max(0, Math.min(window.innerHeight - 40, startTop + dy));
      panel.style.left = newLeft + "px";
      panel.style.top = newTop + "px";
    });

    document.addEventListener("mouseup", function () {
      if (!isDragging) return;
      isDragging = false;
      document.body.style.userSelect = "";
      try {
        var rect = panel.getBoundingClientRect();
        localStorage.setItem("snh48_panel_pos", JSON.stringify({ left: rect.left, top: rect.top }));
      } catch (e) {}
    });

    // 折叠状态下，点击面板自身也能展开
    panel.addEventListener("click", function (e) {
      if (panel.classList.contains("collapsed") && !isDragging && e.target === panel) {
        panel.classList.remove("collapsed");
        toggle.textContent = "▾";
      }
    });

    // 快捷键列表展开
    var showShortcutsBtn = panel.querySelector("#snh48-show-shortcuts");
    var shortcutList = panel.querySelector("#snh48-shortcut-list");

    showShortcutsBtn.addEventListener("click", function () {
      var isVisible = shortcutList.style.display !== "none";
      shortcutList.style.display = isVisible ? "none" : "block";
    });

    // 通用开关绑定
    function bindSwitch(id, callback) {
      var el = panel.querySelector("#" + id);
      if (!el) {
        error("未找到开关:", id);
        return;
      }
      el.addEventListener("change", function (e) {
        callback(e.target.checked);
        saveConfig();
      });
    }

    bindSwitch("snh48-dark-mode", function (v) {
      config.darkMode = v;
      applyDarkMode(v);
      showToast(v ? "🌙 暗黑模式" : "☀️ 浅色模式");
    });

    bindSwitch("snh48-hide-header", function (v) {
      config.hideHeader = v;
      document.body.classList.toggle("snh48-hide-header", v);
      showToast(v ? "头部已隐藏" : "头部已显示");
    });

    bindSwitch("snh48-video-shortcuts", function (v) {
      config.videoShortcuts = v;
      showToast("快捷键已" + (v ? "启用" : "禁用"));
    });

    bindSwitch("snh48-screenshot", function (v) {
      config.screenshotEnabled = v;
      showToast("截图已" + (v ? "启用" : "禁用"));
    });

    bindSwitch("snh48-embedded-search", function (v) {
      config.embeddedSearch = v;
      var box = document.querySelector(".snh48-embedded-search");
      if (box) box.style.display = v ? "" : "none";
      if (v && !box) injectEmbeddedSearch();
      showToast("顶部搜索已" + (v ? "启用" : "禁用"));
    });

    bindSwitch("snh48-member-index", function (v) {
      config.memberIndex = v;
      showToast("成员参演索引已" + (v ? "启用" : "禁用"));
    });

    // 清空本地索引按钮
    var clearBtn = panel.querySelector("#snh48-clear-index");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        if (confirm("确定要清空所有本地索引吗？此操作不会影响后台索引。")) {
          clearMemberIndex();
          showToast("本地成员索引已清空");
          updateIndexInfo();
        }
      });
    }

    // [FIX 4.9] 清空后台索引按钮（HTML 中已有 #snh48-clear-full-index，不再动态创建）
    var clearFullBtn = panel.querySelector("#snh48-clear-full-index");
    if (clearFullBtn) {
      clearFullBtn.addEventListener("click", function () {
        if (confirm("确定要清空后台索引吗？此操作不可恢复。")) {
          safeSendMessage({ type: "CLEAR_FULL_INDEX" }, function () {
            showToast("后台索引已清空");
            updateIndexInfo();
          });
        }
      });
    }

    function updateIndexInfo() {
      var infoEl = panel.querySelector("#snh48-member-index-info");
      if (!infoEl) return;

      var members = Object.keys(memberIndex).length;
      var perfs = memberIndexStats.performances;
      var baseText = "本地: " + members + " 位 / " + perfs + " 条 ";

      // 获取后台索引统计
      safeSendMessage({ type: "GET_INDEX_STATS" }, function (stats) {
        if (stats === undefined || stats === null) {
          infoEl.textContent = baseText + " | 后台: 查询失败 (Service Worker 未响应或已重启，请刷新页面)";
          return;
        }
        var lastUp = stats.lastUpdated ? " | 同步: " + new Date(stats.lastUpdated).toLocaleTimeString() : "";
        // [OPT] 显示包含归档数据的完整统计
        var totalCount = stats.totalPerformanceCount || stats.performanceCount;
        var archivedInfo = stats.archivedCount > 0 ? " (含归档 " + stats.archivedCount + " 场)" : "";
        infoEl.textContent = baseText + " | 后台: " + totalCount + " 场 / " + stats.memberCount + " 人" + archivedInfo + lastUp;
        if (totalCount === 0) {
          infoEl.textContent += " (未建立索引，请先批量索引)";
        }
        log("后台索引状态: " + totalCount + " 场公演, " + stats.memberCount + " 位成员" + (stats.indexingState && stats.indexingState.running ? ", [索引进度中]" : ""));
      });
    }
    updateIndexInfo();
    // 索引更新时刷新
    var origSave = saveMemberIndex;
    saveMemberIndex = function () {
      origSave();
      _extSetTimeout(updateIndexInfo, 1600);
    };

    bindSwitch("snh48-quick-nav", function (v) {
      config.quickNav = v;
      var nav = document.querySelector(".snh48-quick-nav");
      if (nav) nav.style.display = v ? "" : "none";
      showToast("快捷导航已" + (v ? "启用" : "禁用"));
    });

    bindSwitch("snh48-reminder", function (v) {
      config.reminderEnabled = v;
      if (v && Notification.permission === "default") {
        try { Notification.requestPermission(); } catch (e) {}
      }
      showToast("公演提醒已" + (v ? "启用" : "禁用"));
    });

    // 批量索引按钮事件
    var startBtn = panel.querySelector("#snh48-idx-start-btn");
    var stopBtn = panel.querySelector("#snh48-idx-stop-btn");
    var startInput = panel.querySelector("#snh48-idx-start-id");
    var endInput = panel.querySelector("#snh48-idx-end-id");
    var progressFill = panel.querySelector("#snh48-progress-bar .snh48-progress-fill");
    var progressText = panel.querySelector("#snh48-progress-text");
    var progressDetail = panel.querySelector("#snh48-progress-detail");

    function formatETA(ms) {
      if (ms < 1000) return "即将完成";
      var s = Math.floor(ms / 1000);
      if (s < 60) return s + "秒";
      var m = Math.floor(s / 60);
      s = s % 60;
      if (m < 60) return m + "分" + s + "秒";
      var h = Math.floor(m / 60);
      m = m % 60;
      return h + "时" + m + "分";
    }

    function updateProgressUI(state) {
      if (!state) {
        progressFill.style.width = "0%";
        progressText.textContent = "等待操作...";
        progressDetail.textContent = "";
        return;
      }
      if (state.running) {
        var total = (state.endId - state.startId + 1);
        var done = (state.currentId - state.startId + 1);
        var pct = Math.min(100, Math.round(100 * done / total));
        progressFill.style.width = pct + "%";

        // 计算速度和ETA
        var elapsed = Date.now() - (state.startTime || Date.now());
        var speed = done > 0 ? (elapsed / done) : 0; // ms/item
        var remaining = (total - done) * speed;
        var etaText = remaining > 0 ? " | 剩余 " + formatETA(remaining) : "";
        var speedText = speed > 0 ? (1000 / speed).toFixed(1) + " 页/秒" : "";

        var phaseTag = "";
        if (state.phase === "listing") phaseTag = "[获取列表映射] ";
        else if (state.phase === "preparing") phaseTag = "[准备中] ";

        progressText.textContent = phaseTag + "ID " + state.currentId + "/" + state.endId + " (" + pct + "%)";
        progressDetail.textContent =
          "成功 " + state.success + " | 跳过 " + (state.skipped || 0) +
          " | 404 " + (state.notFound || 0) +
          " | 失败 " + state.failed +
          " | " + speedText + etaText;
      } else if (state.startId) {
        var elapsed2 = Date.now() - (state.startTime || Date.now());
        progressFill.style.width = "100%";
        progressText.textContent = "完成！共 " + (state.endId - state.startId + 1) + " 页，耗时 " + formatETA(elapsed2);
        progressDetail.textContent =
          "成功 " + state.success + " | 跳过 " + (state.skipped || 0) +
          " | 404 " + (state.notFound || 0) + " | 失败 " + state.failed;
      } else {
        // [FIX 5.3] 初始/空闲状态
        progressFill.style.width = "0%";
        progressText.textContent = "等待操作...";
        progressDetail.textContent = "";
      }
    }

    startBtn.addEventListener("click", function () {
      var s = parseInt(startInput.value);
      var e = parseInt(endInput.value);
      if (!s || !e || s > e) {
        showToast("请输入有效的起止ID！");
        return;
      }
      if (e - s > 5000) {
        if (!confirm("范围较大（" + (e - s + 1) + "页），预计耗时较长，确认开始？")) return;
      }
      safeSendMessage({ type: "START_RANGE_INDEX", startId: s, endId: e }, function (res) {
        if (res && res.success) {
          startBtn.disabled = true;
          stopBtn.disabled = false;
          startInput.disabled = true;
          endInput.disabled = true;
          showToast("开始索引 ID " + s + " ~ " + e);
          // 立即启动轮询
          startProgressPoll();
        } else if (res === undefined || res === null) {
          showToast("插件上下文已失效，请刷新页面");
        } else {
          showToast((res && res.error) || "索引启动失败！");
        }
      });
    });

    stopBtn.addEventListener("click", function () {
      safeSendMessage({ type: "STOP_RANGE_INDEX" }, function () {
        showToast("正在停止索引...");
      });
    });

    // 轮询进度（作为消息通道的补充，确保不丢进度）
    // [FIX H8] 设置 _indexingUI 回调桥接，让模块级消息监听器调用 createFloatPanel 内的函数
    _indexingUI.onProgress = updateProgressUI;
    _indexingUI.onComplete = function (payload) {
      updateProgressUI(payload);
      startBtn.disabled = false;
      stopBtn.disabled = true;
      startInput.disabled = false;
      endInput.disabled = false;
      updateIndexInfo();
      if (payload && payload.success > 0) {
        showToast("索引完成！新增 " + payload.success + " 场公演");
      }
    };
    _indexingUI.onShowStatus = function () {
      panel.classList.remove("collapsed");
    };

    var progressPollTimer = null;
    function startProgressPoll() {
      if (progressPollTimer) return;
      if (!isExtensionContextAlive()) return;
      progressPollTimer = _extSetInterval(function () {
        safeSendMessage({ type: "GET_INDEXING_STATE" }, function (state) {
          if (state) {
            updateProgressUI(state);
            if (!state.running) {
              _extClearTimer(progressPollTimer);
              progressPollTimer = null;
              startBtn.disabled = false;
              stopBtn.disabled = true;
              startInput.disabled = false;
              endInput.disabled = false;
            }
          }
        });
      }, 2000);
    }

    // 初始化：获取当前状态
    safeSendMessage({ type: "GET_INDEXING_STATE" }, function (state) {
        if (state && state.running) {
          startBtn.disabled = true;
          stopBtn.disabled = false;
          startInput.disabled = true;
          endInput.disabled = true;
          updateProgressUI(state);
          startProgressPoll();
        }
      });
  }

  // ---- 隐藏头部 ----
  function applyHideHeader() {
    if (config.hideHeader) {
      document.body.classList.add("snh48-hide-header");
    }
  }

  // ---- 消息监听 ----
  // [FIX H8] 合并两个 onMessage 监听器为一个，在模块顶层注册
  // createFloatPanel 中不再注册额外监听器，而是通过 _indexingUI 回调桥接
  var _indexingUI = {
    onProgress: null,    // function(state)  - 由 createFloatPanel 设置
    onComplete: null,    // function(state)  - 由 createFloatPanel 设置
    onShowStatus: null,  // function()       - 由 createFloatPanel 设置
  };

  try {
    if (!isExtensionContextAlive()) return;
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (msg.type === "CONFIG_UPDATED") {
        config = Object.assign({}, DEFAULT_CONFIG, msg.config);
        applyDarkMode(config.darkMode);
        applyHideHeader();
        sendResponse({ success: true });
      }
      if (msg.type === "GET_CONFIG") sendResponse(config);

      // [FIX H8] 索引进度消息统一在此处理
      if (msg.type === "INDEXING_PROGRESS" && _indexingUI.onProgress) {
        _indexingUI.onProgress(msg.payload);
      }
      if (msg.type === "INDEXING_COMPLETE" && _indexingUI.onComplete) {
        _indexingUI.onComplete(msg.payload);
      }
      if (msg.type === "SHOW_INDEXING_STATUS" && _indexingUI.onShowStatus) {
        _indexingUI.onShowStatus();
      }
      return true;
    });
  } catch (e) {
    error("消息监听器注册失败:", e);
  }

  // ---- 初始化 ----
  async function init() {
    log("初始化开始, URL:", window.location.href);
    await loadConfig();
    await loadMemberIndex();

    function go() {
      log("DOM ready, body:", !!document.body);
      // 暗黑模式尽早应用
      applyDarkMode(config.darkMode);
      applyHideHeader();

      // 等待 body
      function waitBody(cb) {
        if (document.body) cb();
        else setTimeout(function () { waitBody(cb); }, 100);
      }

      waitBody(function () {
        // [OPT] 减少初始化延迟（800→300），使用 requestAnimationFrame 优化首帧渲染
        requestAnimationFrame(function () {
          setTimeout(function () {
            try {
              injectEmbeddedSearch();
              createFloatPanel();
              setupVideoShortcuts();
              createQuickNav();
              setupReminder();
              // 公演页：建立成员-公演反向索引
              indexCurrentPagePerformers();
              log("所有功能初始化完成");
            } catch (e) {
              error("初始化异常:", e);
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
