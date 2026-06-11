// ========== SNH48 Live Enhancer - Shared Utilities ==========
(function () {
  "use strict";

  const LOG_PREFIX = "[SNH48-Enhancer]";

  // Log levels: 0=none, 1=error, 2=warn, 3=info, 4=debug
  const LOG_LEVELS = { NONE: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4 };
  let _logLevel = LOG_LEVELS.ERROR; // Production default: errors only

  // Check for debug mode in URL
  try {
    if (window.location && window.location.search && window.location.search.includes("snh48_debug=1")) {
      _logLevel = LOG_LEVELS.DEBUG;
    }
  } catch (e) {}

  // Check for log level in chrome.storage.sync
  try {
    if (chrome && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get("snh48_log_level", (result) => {
        if (result && result.snh48_log_level !== undefined) {
          _logLevel = typeof result.snh48_log_level === "string"
            ? (LOG_LEVELS[result.snh48_log_level.toUpperCase()] || LOG_LEVELS.ERROR)
            : result.snh48_log_level;
        }
      });
    }
  } catch (e) {}

  function setLogLevel(level) {
    _logLevel = typeof level === "string"
      ? (LOG_LEVELS[level.toUpperCase()] || LOG_LEVELS.ERROR)
      : level;
  }

  const log = (...args) => {
    if (_logLevel >= LOG_LEVELS.DEBUG) {
      console.log(LOG_PREFIX, ...args);
    }
  };

  const warn = (...args) => {
    if (_logLevel >= LOG_LEVELS.WARN) {
      console.warn(LOG_PREFIX, ...args);
    }
  };

  const error = (...args) => {
    if (_logLevel >= LOG_LEVELS.ERROR) {
      console.error(LOG_PREFIX, ...args);
    }
  };

  const info = (...args) => {
    if (_logLevel >= LOG_LEVELS.INFO) {
      console.info(LOG_PREFIX, ...args);
    }
  };

  // ====================================================================
  // [FIX] Extension context 失效保护
  // ====================================================================
  let _extensionDead = false;
  let _extTimers = [];

  const _extSetTimeout = (fn, ms) => {
    const h = setTimeout(() => {
      const idx = _extTimers.indexOf(h);
      if (idx >= 0) _extTimers.splice(idx, 1);
      if (_extensionDead) return;
      try { fn(); } catch (e) {}
    }, ms);
    _extTimers.push(h);
    return h;
  };
  const _extSetInterval = (fn, ms) => {
    const h = setInterval(() => {
      if (_extensionDead) {
        clearInterval(h);
        const idx = _extTimers.indexOf(h);
        if (idx >= 0) _extTimers.splice(idx, 1);
        return;
      }
      try { fn(); } catch (e) {}
    }, ms);
    _extTimers.push(h);
    return h;
  };
  const _extClearTimer = (h) => {
    if (h == null) return;
    clearTimeout(h);
    clearInterval(h);
    const idx = _extTimers.indexOf(h);
    if (idx >= 0) _extTimers.splice(idx, 1);
  };

  const isExtensionContextAlive = () => {
    if (_extensionDead) return false;
    try {
      if (!chrome || !chrome.runtime) {
        _extensionDead = true;
        return false;
      }
      return true;
    } catch (e) {
      _extensionDead = true;
      return false;
    }
  };

  const handleContextInvalidated = () => {
    _extensionDead = true;
    // Clear all pending timers
    _extTimers.forEach(h => { try { clearTimeout(h); } catch (e) {} try { clearInterval(h); } catch (e) {} });
    _extTimers = [];
  };

  const safeSendMessage = (msg, callback) => {
    if (!isExtensionContextAlive()) return false;
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          if (chrome.runtime.lastError.message && chrome.runtime.lastError.message.indexOf("context invalidated") !== -1) {
            handleContextInvalidated();
          }
          return;
        }
        if (callback) { try { callback(res); } catch (e) {} }
      });
      return true;
    } catch (e) {
      handleContextInvalidated();
      return false;
    }
  };

  const safeStorageSet = (data, callback) => {
    if (!isExtensionContextAlive()) return false;
    try {
      chrome.storage.local.set(data, () => {
        if (chrome.runtime.lastError) {
          if (chrome.runtime.lastError.message && chrome.runtime.lastError.message.indexOf("context invalidated") !== -1) {
            handleContextInvalidated();
          }
          return;
        }
        if (callback) { try { callback(); } catch (e) {} }
      });
      return true;
    } catch (e) {
      handleContextInvalidated();
      return false;
    }
  };

  // ---- 等待元素出现 ----
  const waitForElement = (selector, callback, timeout) => {
    timeout = timeout || 15000;
    const startTime = Date.now();
    const check = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearInterval(check);
        callback(el);
      } else if (Date.now() - startTime > timeout) {
        clearInterval(check);
        log("等待元素超时:", selector);
      }
    }, 200);
  };

  // ---- Toast 通知（队列系统） ----
  const _toastQueue = [];
  let _toastActive = false;

  const showToast = (message, duration) => {
    duration = duration || 2500;
    _toastQueue.push({ msg: message, duration });
    if (!_toastActive) {
      _processToastQueue();
    }
  };

  const _processToastQueue = () => {
    if (_toastQueue.length === 0) {
      _toastActive = false;
      return;
    }
    _toastActive = true;
    const { msg, duration } = _toastQueue.shift();

    try {
      let toast = document.querySelector(".snh48-toast");
      if (!toast) {
        toast = document.createElement("div");
        toast.className = "snh48-toast";
        document.body.appendChild(toast);
      }

      toast.textContent = msg;
      toast.classList.add("snh48-toast-show");
      toast.classList.remove("snh48-toast-hide");

      _extSetTimeout(() => {
        toast.classList.add("snh48-toast-hide");
        toast.classList.remove("snh48-toast-show");
        _extSetTimeout(() => {
          _processToastQueue();
        }, 300); // Wait for fade-out animation
      }, duration);
    } catch (e) {
      error("showToast 异常:", e);
      _toastActive = false;
      _processToastQueue(); // 继续处理队列中的下一条
    }
  };

  // ---- 滚动到元素并高亮 ----
  const scrollToAndHighlight = (el, duration) => {
    duration = duration || 2000;
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.style.outline = "2px solid #ff6b35";
      el.style.outlineOffset = "2px";
      _extSetTimeout(() => {
        try { el.style.outline = ""; el.style.outlineOffset = ""; } catch (e) {}
      }, duration);
    } catch (e) {}
  };

  // ---- HTML 转义 ----
  const escapeHtml = (s) => {
    return String(s).replace(/[<>&"]/g, (c) => {
      return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c];
    });
  };

  // ---- DOM 元素创建辅助 ----
  const el = (tag, attrs, children) => {
    const e = document.createElement(tag);
    if (attrs) {
      Object.entries(attrs).forEach(([key, val]) => {
        if (key === "className") e.className = val;
        else if (key === "textContent") e.textContent = val;
        else if (key === "dataset") Object.assign(e.dataset, val);
        else if (key.startsWith("on")) e.addEventListener(key.slice(2).toLowerCase(), val);
        else e.setAttribute(key, val);
      });
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach((child) => {
        if (typeof child === "string") e.appendChild(document.createTextNode(child));
        else if (child) e.appendChild(child);
      });
    }
    return e;
  };

  // ---- 自定义确认对话框（替代 confirm()，匹配暗黑主题） ----
  const showConfirm = (message) => {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "snh48-confirm-overlay";

      const dialog = document.createElement("div");
      dialog.className = "snh48-confirm-dialog";

      const msgEl = document.createElement("div");
      msgEl.className = "snh48-confirm-message";
      msgEl.textContent = message;

      const btnRow = document.createElement("div");
      btnRow.className = "snh48-confirm-buttons";

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "snh48-confirm-btn snh48-confirm-cancel";
      cancelBtn.textContent = "取消";

      const okBtn = document.createElement("button");
      okBtn.className = "snh48-confirm-btn snh48-confirm-ok";
      okBtn.textContent = "确认";

      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(okBtn);
      dialog.appendChild(msgEl);
      dialog.appendChild(btnRow);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      const cleanup = () => {
        overlay.remove();
      };

      cancelBtn.addEventListener("click", () => { cleanup(); resolve(false); });
      okBtn.addEventListener("click", () => { cleanup(); resolve(true); });
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) { cleanup(); resolve(false); }
      });

      // Focus the cancel button by default (safer)
      cancelBtn.focus();
    });
  };

  // ---- 导出到全局命名空间 ----
  var SNH48 = window.SNH48 || (window.SNH48 = {});
  SNH48.log = log;
  SNH48.warn = warn;
  SNH48.error = error;
  SNH48.info = info;
  SNH48.setLogLevel = setLogLevel;
  SNH48.isExtensionContextAlive = isExtensionContextAlive;
  SNH48.safeSendMessage = safeSendMessage;
  SNH48.safeStorageSet = safeStorageSet;
  SNH48._extSetTimeout = _extSetTimeout;
  SNH48._extSetInterval = _extSetInterval;
  SNH48._extClearTimer = _extClearTimer;
  SNH48.waitForElement = waitForElement;
  SNH48.showToast = showToast;
  SNH48.scrollToAndHighlight = scrollToAndHighlight;
  SNH48.escapeHtml = escapeHtml;
  SNH48.el = el;
  SNH48.showConfirm = showConfirm;
})();
