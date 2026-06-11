// ========== SNH48 Live Enhancer - Dark Mode ==========
(function () {
  "use strict";

  var SNH48 = window.SNH48 || (window.SNH48 = {});
  const log = SNH48.log;
  const error = SNH48.error;
  const _extSetTimeout = SNH48._extSetTimeout;
  const _extClearTimer = SNH48._extClearTimer;

  let _darkModeObserver = null;
  let _darkModeProcessed = typeof WeakSet !== "undefined" ? new WeakSet() : null;
  let _darkModeDebounceTimer = null;
  let _darkModePendingNodes = [];

  const _isInMediaZone = (el) => {
    let cur = el;
    let depth = 0;
    const MEDIA_CLASS_TOKENS = {
      "videoplay": 1,
      "xt-player": 1,
      "video-play": 1,
      "xt-video": 1,
      "video-box": 1,
      "video-wrap": 1,
      "playback": 1
    };
    const MEDIA_ID_TOKENS = {
      "videoplay": 1,
      "xt-player": 1,
      "xt-video": 1,
      "video-box": 1,
      "player": 1,
      "video": 1
    };
    while (cur && cur.nodeType === 1 && depth < 20) {
      const tag = (cur.tagName || "").toUpperCase();
      if (tag === "VIDEO" || tag === "IFRAME" || tag === "CANVAS" || tag === "PICTURE") return true;
      const id = (cur.id || "").toLowerCase();
      const cls = typeof cur.className === "string" ? cur.className : "";
      const idTokens = id.split(/[\s_-]+/);
      const clsTokens = cls.toLowerCase().split(/\s+/);
      if (id) {
        if (MEDIA_ID_TOKENS[id]) return true;
        for (let m = 0; m < idTokens.length; m++) {
          if (MEDIA_ID_TOKENS[idTokens[m]]) return true;
        }
      }
      for (let n = 0; n < clsTokens.length; n++) {
        const t = clsTokens[n];
        if (!t) continue;
        if (MEDIA_CLASS_TOKENS[t]) return true;
      }
      cur = cur.parentNode;
      depth++;
    }
    return false;
  };

  const _isOwnUI = (el) => {
    if (!el) return false;
    const id = el.id || "";
    const cls = typeof el.className === "string" ? el.className : "";
    if (id.indexOf("snh48-") !== -1) return true;
    if (cls.indexOf("snh48-") !== -1) return true;
    return false;
  };

  const NAMED_BRIGHT_BG = { "white": 1, "whitesmoke": 1, "lightgray": 1, "lightgrey": 1, "gainsboro": 1, "silver": 1 };
  const NAMED_DARK_TEXT = { "black": 1 };

  const parseColorFromStyle = (styleText, property) => {
    if (!styleText) return null;
    const s = styleText.toLowerCase().replace(/\s+/g, "");
    const propPattern = property === "background"
      ? /background(?:-color)?:([^;}]+)/
      : /color:([^;}]+)/;
    const m = s.match(propPattern);
    if (!m) return null;
    const val = m[1];

    if (property === "background") {
      for (const name in NAMED_BRIGHT_BG) {
        if (val.indexOf(name) !== -1) return { r: 255, g: 255, b: 255 };
      }
    } else {
      for (const name2 in NAMED_DARK_TEXT) {
        if (val.indexOf(name2) !== -1) return { r: 0, g: 0, b: 0 };
      }
    }

    const hexMatch = val.match(/#([0-9a-f]{3,8})/);
    if (hexMatch) {
      let hx = hexMatch[1];
      if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
      if (hx.length >= 6) {
        return {
          r: parseInt(hx.substr(0, 2), 16),
          g: parseInt(hx.substr(2, 2), 16),
          b: parseInt(hx.substr(4, 2), 16)
        };
      }
    }

    const rgbMatch = val.match(/rgba?\((\d{1,3}),(\d{1,3}),(\d{1,3})/);
    if (rgbMatch) {
      return {
        r: parseInt(rgbMatch[1], 10),
        g: parseInt(rgbMatch[2], 10),
        b: parseInt(rgbMatch[3], 10)
      };
    }

    return null;
  };

  const classifyColor = (r, g, b) => {
    // 阈值 220：站点浅色背景 RGB 通常在 230-255 区间，220 留出余量覆盖
    // 偏暗的浅色（如 #dcdcdc），同时避免误判中灰色为浅色背景
    if (r >= 220 && g >= 220 && b >= 220) return "bright";
    // 低方差浅色：RGB 均≥200 且三通道差值<40，捕获非纯白浅色背景
    // （如 #c8c8d0），低方差说明是单色系设计用色而非内容色
    if (r >= 200 && g >= 200 && b >= 200 &&
        Math.abs(r - g) < 40 && Math.abs(g - b) < 40 && Math.abs(r - b) < 40) return "bright";
    // 深色判定分两档：≤60 为纯黑系（如 #333），≤120 为深灰系
    // 站点深色文字通常在 0-80 范围，120 留出余量覆盖深灰文字
    if (r <= 60 && g <= 60 && b <= 60) return "dark";
    if (r <= 120 && g <= 120 && b <= 120) return "dark";
    // 100-160 中灰区间 + 低方差（三通道差<30）识别"暗淡"文字
    // 这类中灰文字在暗黑模式下对比度不足需要提亮；低方差确保
    // 只捕获单色系灰色，避免误判有色彩倾向的装饰色
    if (r >= 100 && r <= 160 && g >= 100 && g <= 160 && b >= 100 && b <= 160 &&
        Math.abs(r - g) < 30 && Math.abs(g - b) < 30 && Math.abs(r - b) < 30) return "dim";
    return "normal";
  };

  const _hasBrightBg = (styleText) => {
    const c = parseColorFromStyle(styleText, "background");
    if (!c) return false;
    return classifyColor(c.r, c.g, c.b) === "bright";
  };

  const _hasDarkText = (styleText) => {
    const c = parseColorFromStyle(styleText, "color");
    if (!c) return false;
    return classifyColor(c.r, c.g, c.b) === "dark";
  };

  const _hasDimText = (styleText) => {
    const c = parseColorFromStyle(styleText, "color");
    if (!c) return false;
    return classifyColor(c.r, c.g, c.b) === "dim";
  };

  const _collectElements = (root) => {
    const result = [];
    if (!root || root.nodeType !== 1) return result;
    const tag = (root.tagName || "").toUpperCase();
    if (tag !== "SCRIPT" && tag !== "STYLE" && tag !== "META" && tag !== "NOSCRIPT" && tag !== "LINK") {
      result.push(root);
    }
    try {
      const all = root.getElementsByTagName("*");
      for (let i = 0; i < all.length; i++) {
        if (all[i].nodeType !== 1) continue;
        const t = (all[i].tagName || "").toUpperCase();
        if (t === "SCRIPT" || t === "STYLE" || t === "META" || t === "NOSCRIPT" || t === "LINK" || t === "BR" || t === "HR") continue;
        result.push(all[i]);
      }
    } catch (e) {}
    return result;
  };

  const _cleanInlineStyles = (root) => {
    if (!root || !document.documentElement.classList.contains("snh48-dark")) return;
    const nodes = _collectElements(root);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!el || !el.getAttribute) continue;
      const tag = (el.tagName || "").toUpperCase();
      if (tag === "VIDEO" || tag === "IFRAME" || tag === "CANVAS" || tag === "SVG" || tag === "IMG" || tag === "PICTURE") continue;
      if (_isOwnUI(el)) continue;
      if (_isInMediaZone(el)) continue;

      const styleText = el.getAttribute("style");
      if (!styleText) continue;

      if (_darkModeProcessed && _darkModeProcessed.has(el)) continue;

      try {
        let changed = false;
        if (_hasBrightBg(styleText)) {
          el.style.setProperty("background-color", "var(--snh48-bg-card)", "important");
          changed = true;
        }
        if (_hasDarkText(styleText)) {
          el.style.setProperty("color", "var(--snh48-text)", "important");
          changed = true;
        } else if (_hasDimText(styleText)) {
          el.style.setProperty("color", "var(--snh48-text-dim)", "important");
          changed = true;
        }
        if (_darkModeProcessed && changed) {
          _darkModeProcessed.add(el);
        }
      } catch (e) {}
    }
  };

  const applyDarkMode = (enabled) => {
    log("暗黑模式:", enabled ? "开启" : "关闭");
    if (enabled) {
      document.documentElement.classList.add("snh48-dark");
      _cleanInlineStyles(document.body || document.documentElement);
      if (!_darkModeObserver && typeof MutationObserver !== "undefined") {
        try {
          _darkModeObserver = new MutationObserver((mutations) => {
            for (let i = 0; i < mutations.length; i++) {
              const m = mutations[i];
              if (m.type === "childList" && m.addedNodes && m.addedNodes.length > 0) {
                for (let j = 0; j < m.addedNodes.length; j++) {
                  const node = m.addedNodes[j];
                  if (node.nodeType === 1) _darkModePendingNodes.push(node);
                }
              }
              if (m.type === "attributes" && m.attributeName === "style" && m.target && m.target.nodeType === 1) {
                if (_darkModeProcessed && _darkModeProcessed.has(m.target)) {
                  _darkModeProcessed.delete(m.target);
                }
                _darkModePendingNodes.push(m.target);
              }
            }
            if (_darkModeDebounceTimer) clearTimeout(_darkModeDebounceTimer);
            _darkModeDebounceTimer = _extSetTimeout(() => {
              _darkModeDebounceTimer = null;
              const nodes = _darkModePendingNodes;
              _darkModePendingNodes = [];
              for (let k = 0; k < nodes.length; k++) {
                _cleanInlineStyles(nodes[k]);
              }
            }, 50);
          });
          const observeTarget = document.body || document.documentElement;
          _darkModeObserver.observe(observeTarget, {
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
      _darkModeProcessed = typeof WeakSet !== "undefined" ? new WeakSet() : null;
      _darkModePendingNodes = [];
      if (_darkModeDebounceTimer) {
        _extClearTimer(_darkModeDebounceTimer);
        _darkModeDebounceTimer = null;
      }
    }
  };

  SNH48.applyDarkMode = applyDarkMode;
})();
