// ========== SNH48 Live Enhancer - Float Control Panel ==========
(function () {
  "use strict";

  var SNH48 = window.SNH48 || (window.SNH48 = {});
  const log = SNH48.log;
  const error = SNH48.error;
  const showToast = SNH48.showToast;
  const isExtensionContextAlive = SNH48.isExtensionContextAlive;
  const safeSendMessage = SNH48.safeSendMessage;
  const _extSetTimeout = SNH48._extSetTimeout;
  const _extSetInterval = SNH48._extSetInterval;
  const _extClearTimer = SNH48._extClearTimer;

  // _indexingUI 回调桥接，由 createFloatPanel 内部设置
  const _indexingUI = {
    onProgress: null,
    onComplete: null,
    onShowStatus: null,
  };

  // 索引请求去重：同一 URL 在 60 秒内不重复索引
  const _recentIndexRequests = {};
  function shouldIndexPage(url) {
    const now = Date.now();
    if (_recentIndexRequests[url] && now - _recentIndexRequests[url] < 60000) {
      return false;
    }
    _recentIndexRequests[url] = now;
    return true;
  }

  const createFloatPanel = () => {
    if (document.querySelector(".snh48-float-panel")) return;

    log("创建浮动控制面板");

    let config = SNH48.config;
    const DEFAULT_CONFIG = SNH48.DEFAULT_CONFIG;

    const panel = document.createElement("div");
    panel.className = "snh48-float-panel collapsed";
    panel.innerHTML =
      '<div class="snh48-panel-header" id="snh48-panel-drag">' +
        '<span class="snh48-drag-handle" title="拖动">⋮⋮</span>' +
        '<span class="snh48-title">⚙️ Enhancer</span>' +
        '<button class="snh48-calendar-btn" id="snh48-calendar-btn" title="公演日历">📅</button>' +
        '<span class="snh48-toggle" id="snh48-panel-toggle" title="展开/折叠">▸</span>' +
      '</div>' +
      '<div class="snh48-panel-body">' +
        '<div class="snh48-section">' +
          '<div class="snh48-section-title">外观</div>' +
          '<div class="snh48-switch-row">' +
            '<label>暗黑模式</label>' +
            '<label class="snh48-switch"><input type="checkbox" id="snh48-dark-mode" data-key="darkMode" ' + (config.darkMode ? "checked" : "") + '><span class="slider"></span></label>' +
          '</div>' +
          '<div class="snh48-switch-row">' +
            '<label>隐藏头部</label>' +
            '<label class="snh48-switch"><input type="checkbox" id="snh48-hide-header" data-key="hideHeader" ' + (config.hideHeader ? "checked" : "") + '><span class="slider"></span></label>' +
          '</div>' +
        '</div>' +
        '<div class="snh48-section">' +
          '<div class="snh48-section-title">视频</div>' +
          '<div class="snh48-switch-row">' +
            '<label>键盘快捷键</label>' +
            '<label class="snh48-switch"><input type="checkbox" id="snh48-video-shortcuts" data-key="videoShortcuts" ' + (config.videoShortcuts ? "checked" : "") + '><span class="slider"></span></label>' +
          '</div>' +
          '<div class="snh48-switch-row">' +
            '<label>截图功能</label>' +
            '<label class="snh48-switch"><input type="checkbox" id="snh48-screenshot" data-key="screenshotEnabled" ' + (config.screenshotEnabled ? "checked" : "") + '><span class="slider"></span></label>' +
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
        '<div class="snh48-section">' +
          '<div class="snh48-section-title">功能</div>' +
          '<div class="snh48-switch-row">' +
            '<label>顶部搜索入口</label>' +
            '<label class="snh48-switch"><input type="checkbox" id="snh48-embedded-search" data-key="embeddedSearch" ' + (config.embeddedSearch ? "checked" : "") + '><span class="slider"></span></label>' +
          '</div>' +
          '<div class="snh48-switch-row">' +
            '<label>成员参演索引</label>' +
            '<label class="snh48-switch"><input type="checkbox" id="snh48-member-index" data-key="memberIndex" ' + (config.memberIndex ? "checked" : "") + '><span class="slider"></span></label>' +
          '</div>' +
          '<div class="snh48-member-index-info" id="snh48-member-index-info">已索引: 加载中...</div>' +
          '<div class="snh48-member-index-actions">' +
            '<button type="button" class="snh48-mini-btn" id="snh48-clear-index">清空本地</button>' +
            '<button type="button" class="snh48-mini-btn" id="snh48-clear-full-index">清空全部</button>' +
          '</div>' +
          '<div class="snh48-switch-row">' +
            '<label>快捷导航</label>' +
            '<label class="snh48-switch"><input type="checkbox" id="snh48-quick-nav" data-key="quickNav" ' + (config.quickNav ? "checked" : "") + '><span class="slider"></span></label>' +
          '</div>' +
          '<div class="snh48-switch-row">' +
            '<label>公演提醒</label>' +
            '<label class="snh48-switch"><input type="checkbox" id="snh48-reminder" data-key="reminderEnabled" ' + (config.reminderEnabled ? "checked" : "") + '><span class="slider"></span></label>' +
          '</div>' +
        '</div>' +
        '<div class="snh48-section" id="snh48-shortcut-settings-section" style="display:none;">' +
          '<div class="snh48-section-title" style="cursor:pointer;">快捷键设置 ▾</div>' +
          '<div class="snh48-shortcut-list">' +
          '</div>' +
          '<button class="snh48-mini-btn" id="snh48-reset-shortcuts">恢复默认</button>' +
        '</div>' +
        '<div class="snh48-section">' +
          '<div class="snh48-section-title">数据管理</div>' +
          '<div class="snh48-data-mgmt-btns">' +
            '<button type="button" class="snh48-mini-btn" id="snh48-export-config">导出配置</button>' +
            '<button type="button" class="snh48-mini-btn" id="snh48-import-config">导入配置</button>' +
          '</div>' +
          '<input type="file" id="snh48-import-config-file" accept=".json" style="display:none">' +
        '</div>' +
        '<div class="snh48-section">' +
          '<div class="snh48-section-title">最近观看</div>' +
          '<div class="snh48-recent-list" id="snh48-recent-list"></div>' +
        '</div>' +
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
            '<div class="snh48-indexing-mode-row">' +
              '<span class="snh48-indexing-mode-label">模式</span>' +
              '<select id="snh48-idx-mode" class="snh48-indexing-mode-select">' +
                '<option value="full">全量重建</option>' +
                '<option value="incremental">增量补充</option>' +
              '</select>' +
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

    // Calendar button
    const calendarBtn = document.getElementById("snh48-calendar-btn");
    if (calendarBtn) {
      calendarBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        SNH48.createCalendarView();
      });
    }

    // 标签页可见性管理：隐藏标签页中自动隐藏面板，恢复时自动显示（除非手动关闭过）
    if (typeof document !== "undefined" && document.visibilityState !== undefined) {
      document.addEventListener("visibilitychange", () => {
        const visPanel = document.getElementById("snh48-float-panel");
        if (!visPanel) return;
        if (document.hidden) {
          visPanel.setAttribute("data-hidden-by-tab", "true");
          visPanel.style.display = "none";
        } else {
          if (visPanel.getAttribute("data-hidden-by-tab") === "true") {
            visPanel.removeAttribute("data-hidden-by-tab");
            if (!visPanel.getAttribute("data-manually-closed")) {
              visPanel.style.display = "";
            }
          }
        }
      });
    }

    // 折叠/展开
    const toggle = panel.querySelector("#snh48-panel-toggle");
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.classList.toggle("collapsed");
      toggle.textContent = panel.classList.contains("collapsed") ? "▸" : "▾";
      // 标记手动关闭状态，防止标签页恢复时自动显示
      if (panel.classList.contains("collapsed")) {
        panel.setAttribute("data-manually-closed", "true");
      } else {
        panel.removeAttribute("data-manually-closed");
      }
    });

    // 拖动
    const drag = panel.querySelector("#snh48-panel-drag");
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const loadPosition = () => {
      if (!isExtensionContextAlive()) return;
      try {
        chrome.storage.local.get("snh48_panel_position", (data) => {
          if (chrome.runtime.lastError) return;
          if (data.snh48_panel_position) {
            const pos = data.snh48_panel_position;
            if (pos.left !== undefined) panel.style.left = pos.left + "px";
            if (pos.top !== undefined) panel.style.top = pos.top + "px";
            panel.style.right = "auto";
            panel.style.bottom = "auto";
          }
        });
      } catch (e) {}
    };
    loadPosition();

    drag.addEventListener("mousedown", (e) => {
      if (e.target.closest(".snh48-toggle")) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      panel.style.left = startLeft + "px";
      panel.style.top = startTop + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newLeft = Math.max(0, Math.min(window.innerWidth - 60, startLeft + dx));
      const newTop = Math.max(0, Math.min(window.innerHeight - 40, startTop + dy));
      panel.style.left = newLeft + "px";
      panel.style.top = newTop + "px";
    });

    document.addEventListener("mouseup", () => {
      if (!isDragging) return;
      isDragging = false;
      document.body.style.userSelect = "";
      try {
        const rect = panel.getBoundingClientRect();
        safeStorageSet({
          snh48_panel_position: {
            left: parseInt(panel.style.left),
            top: parseInt(panel.style.top)
          }
        });
      } catch (e) {}
    });

    panel.addEventListener("click", (e) => {
      if (panel.classList.contains("collapsed") && !isDragging && e.target === panel) {
        panel.classList.remove("collapsed");
        toggle.textContent = "▾";
      }
    });

    // 快捷键列表展开
    const showShortcutsBtn = panel.querySelector("#snh48-show-shortcuts");
    const shortcutList = panel.querySelector("#snh48-shortcut-list");

    showShortcutsBtn.addEventListener("click", () => {
      const isVisible = shortcutList.style.display !== "none";
      shortcutList.style.display = isVisible ? "none" : "block";
    });

    // 通用开关绑定
    const bindSwitch = (id, callback) => {
      const el = panel.querySelector("#" + id);
      if (!el) {
        error("未找到开关:", id);
        return;
      }
      el.addEventListener("change", (e) => {
        callback(e.target.checked);
        SNH48.saveConfig();
      });
    };

    bindSwitch("snh48-dark-mode", (v) => {
      config.darkMode = v;
      SNH48.applyDarkMode(v);
      showToast(v ? "🌙 暗黑模式" : "☀️ 浅色模式");
    });

    bindSwitch("snh48-hide-header", (v) => {
      config.hideHeader = v;
      document.body.classList.toggle("snh48-hide-header", v);
      showToast(v ? "头部已隐藏" : "头部已显示");
    });

    bindSwitch("snh48-video-shortcuts", (v) => {
      config.videoShortcuts = v;
      showToast("快捷键已" + (v ? "启用" : "禁用"));
    });

    bindSwitch("snh48-screenshot", (v) => {
      config.screenshotEnabled = v;
      showToast("截图已" + (v ? "启用" : "禁用"));
    });

    bindSwitch("snh48-embedded-search", (v) => {
      config.embeddedSearch = v;
      const box = document.querySelector(".snh48-embedded-search");
      if (box) box.style.display = v ? "" : "none";
      if (v && !box) SNH48.injectEmbeddedSearch();
      showToast("顶部搜索已" + (v ? "启用" : "禁用"));
    });

    bindSwitch("snh48-member-index", (v) => {
      config.memberIndex = v;
      showToast("成员参演索引已" + (v ? "启用" : "禁用"));
    });

    // ---- 快捷键设置 ----
    const shortcutSection = document.getElementById("snh48-shortcut-settings-section");
    const shortcutTitle = shortcutSection?.querySelector(".snh48-section-title");
    const shortcutSettingsList = shortcutSection?.querySelector(".snh48-shortcut-list");

    if (shortcutTitle && shortcutSettingsList) {
      shortcutTitle.addEventListener("click", () => {
        const isHidden = shortcutSettingsList.style.display === "none";
        shortcutSettingsList.style.display = isHidden ? "block" : "none";
        shortcutTitle.textContent = isHidden ? "快捷键设置 ▴" : "快捷键设置 ▾";
      });
      shortcutSettingsList.style.display = "none";

      const ACTION_LABELS = {
        speedUp: "加速播放",
        speedDown: "减速播放",
        speedReset: "重置速度",
        screenshot: "截图",
        pip: "画中画",
        fullscreen: "全屏",
        volumeUp: "音量+",
        volumeDown: "音量-",
        mute: "静音",
        seekForward: "快进5秒",
        seekBackward: "快退5秒"
      };

      const escapeHtml = (str) => {
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
      };

      function renderShortcutList() {
        const bindings = SNH48.config.shortcutBindings || SNH48_DEFAULT_CONFIG.shortcutBindings;
        shortcutSettingsList.innerHTML = Object.entries(ACTION_LABELS).map(([action, label]) => {
          const key = bindings[action] || "";
          return '<div class="snh48-shortcut-row">' +
            '<span class="snh48-shortcut-label">' + label + '</span>' +
            '<input class="snh48-shortcut-input" data-action="' + action + '" value="' + escapeHtml(key) + '" readonly>' +
          '</div>';
        }).join("");

        shortcutSettingsList.querySelectorAll(".snh48-shortcut-input").forEach(input => {
          input.addEventListener("focus", () => {
            input.value = "按下新按键...";
            input.classList.add("snh48-shortcut-listening");
          });
          input.addEventListener("keydown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const action = input.dataset.action;
            const key = e.key;
            input.value = key;
            input.classList.remove("snh48-shortcut-listening");
            input.blur();
            if (!SNH48.config.shortcutBindings) SNH48.config.shortcutBindings = {};
            SNH48.config.shortcutBindings[action] = key;
            SNH48.saveConfig();
            showToast("快捷键已更新: " + ACTION_LABELS[action] + " → " + key);
          });
          input.addEventListener("blur", () => {
            input.classList.remove("snh48-shortcut-listening");
            const bindings = SNH48.config.shortcutBindings || SNH48_DEFAULT_CONFIG.shortcutBindings;
            input.value = bindings[input.dataset.action] || "";
          });
        });
      }

      renderShortcutList();

      const resetBtn = document.getElementById("snh48-reset-shortcuts");
      if (resetBtn) {
        resetBtn.addEventListener("click", () => {
          SNH48.config.shortcutBindings = Object.assign({}, SNH48_DEFAULT_CONFIG.shortcutBindings);
          SNH48.saveConfig();
          renderShortcutList();
          showToast("快捷键已恢复默认");
        });
      }
    }

    // 清空本地索引按钮
    const clearBtn = panel.querySelector("#snh48-clear-index");
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        if (await SNH48.showConfirm("确定要清空所有本地索引吗？此操作不会影响后台索引。")) {
          SNH48.clearMemberIndex();
          showToast("本地成员索引已清空");
          updateIndexInfo();
        }
      });
    }

    const clearFullBtn = panel.querySelector("#snh48-clear-full-index");
    if (clearFullBtn) {
      clearFullBtn.addEventListener("click", async () => {
        if (await SNH48.showConfirm("确定要清空后台索引吗？此操作不可恢复。")) {
          safeSendMessage({ type: SNH48_MSG.CLEAR_FULL_INDEX }, () => {
            showToast("后台索引已清空");
            updateIndexInfo();
          });
        }
      });
    }

    const updateIndexInfo = () => {
      const infoEl = panel.querySelector("#snh48-member-index-info");
      if (!infoEl) return;

      const memberIndex = SNH48.memberIndex;
      const memberIndexStats = SNH48.memberIndexStats;
      const members = Object.keys(memberIndex).length;
      const perfs = memberIndexStats.performances;
      const baseText = "本地: " + members + " 位 / " + perfs + " 条 ";

      safeSendMessage({ type: SNH48_MSG.GET_INDEX_STATS }, (stats) => {
        if (stats === undefined || stats === null) {
          infoEl.textContent = baseText + " | 后台: 查询失败 (Service Worker 未响应或已重启，请刷新页面)";
          return;
        }
        const lastUp = stats.lastUpdated ? " | 同步: " + new Date(stats.lastUpdated).toLocaleTimeString() : "";
        const totalCount = stats.totalPerformanceCount || stats.performanceCount;
        const archivedInfo = stats.archivedCount > 0 ? " (含归档 " + stats.archivedCount + " 场)" : "";
        infoEl.textContent = baseText + " | 后台: " + totalCount + " 场 / " + stats.memberCount + " 人" + archivedInfo + lastUp;
        if (totalCount === 0) {
          infoEl.textContent += " (未建立索引，请先批量索引)";
        }
        log("后台索引状态: " + totalCount + " 场公演, " + stats.memberCount + " 位成员" + (stats.indexingState && stats.indexingState.running ? ", [索引进度中]" : ""));
      });
    };
    updateIndexInfo();
    // 索引更新时刷新
    const origSave = SNH48.saveMemberIndex;
    SNH48.saveMemberIndex = () => {
      origSave();
      _extSetTimeout(updateIndexInfo, 1600);
    };

    // ---- 最近观看 ----
    const renderRecentWatched = () => {
      const recentEl = panel.querySelector("#snh48-recent-list");
      if (!recentEl) return;
      recentEl.innerHTML = "";

      const recent = SNH48.getRecentWatched ? SNH48.getRecentWatched(8) : [];
      if (!recent || recent.length === 0) {
        const tip = SNH48.el("div", { className: "snh48-empty-tip", textContent: "暂无观看记录" });
        recentEl.appendChild(tip);
        return;
      }

      recent.forEach((r) => {
        const a = SNH48.el("a", { className: "snh48-recent-item", href: r.url, target: "_blank" }, [
          SNH48.el("span", { className: "snh48-recent-title", textContent: r.title || r.url }),
          SNH48.el("span", { className: "snh48-recent-time", textContent: SNH48.formatRelativeTime ? SNH48.formatRelativeTime(r.ts) : "" }),
        ]);
        recentEl.appendChild(a);
      });
    };
    renderRecentWatched();

    // 观看历史更新时刷新最近观看列表
    const origRecordVisit = SNH48.recordVisit;
    if (origRecordVisit) {
      SNH48.recordVisit = (url, title) => {
        origRecordVisit(url, title);
        _extSetTimeout(renderRecentWatched, 500);
      };
    }

    bindSwitch("snh48-quick-nav", (v) => {
      config.quickNav = v;
      const nav = document.querySelector(".snh48-quick-nav");
      if (nav) nav.style.display = v ? "" : "none";
      showToast("快捷导航已" + (v ? "启用" : "禁用"));
    });

    bindSwitch("snh48-reminder", (v) => {
      config.reminderEnabled = v;
      if (v && Notification.permission === "default") {
        try { Notification.requestPermission(); } catch (e) {}
      }
      showToast("公演提醒已" + (v ? "启用" : "禁用"));
    });

    // ---- 数据管理：导出/导入配置 ----
    const exportConfigBtn = panel.querySelector("#snh48-export-config");
    const importConfigBtn = panel.querySelector("#snh48-import-config");
    const importConfigFile = panel.querySelector("#snh48-import-config-file");

    if (exportConfigBtn) {
      exportConfigBtn.addEventListener("click", () => {
        if (!isExtensionContextAlive()) { showToast("插件上下文已失效"); return; }
        try {
          chrome.storage.sync.get("snh48_config", (data) => {
            if (chrome.runtime.lastError) { showToast("读取配置失败"); return; }
            const cfg = data.snh48_config || {};
            const exportData = {
              version: "3.0.0",
              type: "snh48-enhancer-config",
              config: cfg,
              exportedAt: new Date().toISOString()
            };
            const json = JSON.stringify(exportData, null, 2);
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "snh48-enhancer-config.json";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast("配置已导出");
          });
        } catch (e) {
          showToast("导出失败");
        }
      });
    }

    if (importConfigBtn && importConfigFile) {
      importConfigBtn.addEventListener("click", () => {
        importConfigFile.value = "";
        importConfigFile.click();
      });

      importConfigFile.addEventListener("change", () => {
        const file = importConfigFile.files && importConfigFile.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const data = JSON.parse(e.target.result);
            if (!data || data.type !== "snh48-enhancer-config" || typeof data.config !== "object" || !data.config) {
              showToast("无效的配置文件");
              return;
            }
            const KNOWN_KEYS = ["darkMode", "hideHeader", "videoShortcuts", "screenshotEnabled",
              "embeddedSearch", "memberIndex", "quickNav", "reminderEnabled",
              "shortcutPanelCollapsed", "autoPiP", "reminderMinutesBefore", "shortcutBindings"];
            const hasKnownKey = KNOWN_KEYS.some((k) => k in data.config);
            if (!hasKnownKey) {
              showToast("无效的配置文件");
              return;
            }

            if (!isExtensionContextAlive()) { showToast("插件上下文已失效"); return; }
            config = Object.assign({}, DEFAULT_CONFIG, config, data.config);
            SNH48.config = config;
            chrome.storage.sync.set({ snh48_config: config }, () => {
              if (chrome.runtime.lastError) {
                showToast("导入保存失败");
                return;
              }
              SNH48.applyDarkMode(config.darkMode);
              SNH48.applyHideHeader();
              const darkEl = panel.querySelector("#snh48-dark-mode");
              if (darkEl) darkEl.checked = !!config.darkMode;
              const hideEl = panel.querySelector("#snh48-hide-header");
              if (hideEl) hideEl.checked = !!config.hideHeader;
              const videoEl = panel.querySelector("#snh48-video-shortcuts");
              if (videoEl) videoEl.checked = !!config.videoShortcuts;
              const screenshotEl = panel.querySelector("#snh48-screenshot");
              if (screenshotEl) screenshotEl.checked = !!config.screenshotEnabled;
              const searchEl = panel.querySelector("#snh48-embedded-search");
              if (searchEl) searchEl.checked = !!config.embeddedSearch;
              const memberIdxEl = panel.querySelector("#snh48-member-index");
              if (memberIdxEl) memberIdxEl.checked = !!config.memberIndex;
              const navEl = panel.querySelector("#snh48-quick-nav");
              if (navEl) navEl.checked = !!config.quickNav;
              const reminderEl = panel.querySelector("#snh48-reminder");
              if (reminderEl) reminderEl.checked = !!config.reminderEnabled;

              showToast("配置导入成功");
            });
          } catch (err) {
            showToast("导入失败：无效的 JSON");
          }
        };
        reader.readAsText(file);
      });
    }

    // 批量索引按钮事件
    const startBtn = panel.querySelector("#snh48-idx-start-btn");
    const stopBtn = panel.querySelector("#snh48-idx-stop-btn");
    const startInput = panel.querySelector("#snh48-idx-start-id");
    const endInput = panel.querySelector("#snh48-idx-end-id");
    const progressFill = panel.querySelector("#snh48-progress-bar .snh48-progress-fill");
    const progressText = panel.querySelector("#snh48-progress-text");
    const progressDetail = panel.querySelector("#snh48-progress-detail");

    const formatETA = (ms) => {
      if (ms < 1000) return "即将完成";
      let s = Math.floor(ms / 1000);
      if (s < 60) return s + "秒";
      let m = Math.floor(s / 60);
      s = s % 60;
      if (m < 60) return m + "分" + s + "秒";
      const h = Math.floor(m / 60);
      m = m % 60;
      return h + "时" + m + "分";
    };

    const updateProgressUI = (state) => {
      if (!state) {
        progressFill.style.width = "0%";
        progressText.textContent = "等待操作...";
        progressDetail.textContent = "";
        return;
      }
      if (state.running) {
        const total = (state.endId - state.startId + 1);
        const done = (state.currentId - state.startId + 1);
        const pct = Math.min(100, Math.round(100 * done / total));
        progressFill.style.width = pct + "%";

        const elapsed = Date.now() - (state.startTime || Date.now());
        const speed = done > 0 ? (elapsed / done) : 0;
        const remaining = (total - done) * speed;
        const etaText = remaining > 0 ? " | 剩余 " + formatETA(remaining) : "";
        const speedText = speed > 0 ? (1000 / speed).toFixed(1) + " 页/秒" : "";

        let phaseTag = "";
        if (state.phase === "listing") phaseTag = "[获取列表映射] ";
        else if (state.phase === "preparing") phaseTag = "[准备中] ";

        progressText.textContent = phaseTag + "ID " + state.currentId + "/" + state.endId + " (" + pct + "%)";
        progressDetail.textContent =
          "成功 " + state.success + " | 跳过 " + (state.skipped || 0) +
          " | 404 " + (state.notFound || 0) +
          " | 失败 " + state.failed +
          " | " + speedText + etaText;
      } else if (state.startId) {
        const elapsed2 = Date.now() - (state.startTime || Date.now());
        progressFill.style.width = "100%";
        progressText.textContent = "完成！共 " + (state.endId - state.startId + 1) + " 页，耗时 " + formatETA(elapsed2);
        progressDetail.textContent =
          "成功 " + state.success + " | 跳过 " + (state.skipped || 0) +
          " | 404 " + (state.notFound || 0) + " | 失败 " + state.failed;
      } else {
        progressFill.style.width = "0%";
        progressText.textContent = "等待操作...";
        progressDetail.textContent = "";
      }
    };

    startBtn.addEventListener("click", async () => {
      const s = parseInt(startInput.value);
      const e = parseInt(endInput.value);
      const modeSelect = panel.querySelector("#snh48-idx-mode");
      const mode = modeSelect ? modeSelect.value : "full";
      if (!s || !e || s > e) {
        showToast("请输入有效的起止ID！");
        return;
      }
      if (e - s > 5000) {
        if (!await SNH48.showConfirm("范围较大（" + (e - s + 1) + "页），预计耗时较长，确认开始？")) return;
      }
      safeSendMessage({ type: SNH48_MSG.START_RANGE_INDEX, startId: s, endId: e, mode }, (res) => {
        if (res && res.success) {
          startBtn.disabled = true;
          stopBtn.disabled = false;
          startInput.disabled = true;
          endInput.disabled = true;
          if (modeSelect) modeSelect.disabled = true;
          showToast("开始索引 ID " + s + " ~ " + e + (mode === "incremental" ? " (增量)" : " (全量)"));
          startProgressPoll();
        } else if (res === undefined || res === null) {
          showToast("插件上下文已失效，请刷新页面");
        } else {
          showToast((res && res.error) || "索引启动失败！");
        }
      });
    });

    stopBtn.addEventListener("click", () => {
      safeSendMessage({ type: SNH48_MSG.STOP_RANGE_INDEX }, () => {
        showToast("正在停止索引...");
      });
    });

    _indexingUI.onProgress = updateProgressUI;
    _indexingUI.onComplete = (payload) => {
      updateProgressUI(payload);
      startBtn.disabled = false;
      stopBtn.disabled = true;
      startInput.disabled = false;
      endInput.disabled = false;
      const modeSelect = panel.querySelector("#snh48-idx-mode");
      if (modeSelect) modeSelect.disabled = false;
      updateIndexInfo();
      if (payload && payload.success > 0) {
        showToast("索引完成！新增 " + payload.success + " 场公演");
      }
    };
    _indexingUI.onShowStatus = () => {
      panel.classList.remove("collapsed");
    };

    let progressPollTimer = null;
    // [P1-3.1] 统一状态刷新：合并 indexingState 和 indexStats
    function refreshState() {
      if (!isExtensionContextAlive()) return;
      safeSendMessage({ type: SNH48_MSG.GET_STATE, keys: ["indexingState", "indexStats"] }, (state) => {
        if (!state) return;
        if (state.indexingState) updateIndexingUI(state.indexingState);
        if (state.indexStats) updateStatsDisplay(state.indexStats);
      });
    }

    function updateIndexingUI(state) {
      updateProgressUI(state);
      if (!state.running) {
        _extClearTimer(progressPollTimer);
        progressPollTimer = null;
        startBtn.disabled = false;
        stopBtn.disabled = true;
        startInput.disabled = false;
        endInput.disabled = false;
        const ms = panel.querySelector("#snh48-idx-mode");
        if (ms) ms.disabled = false;
      }
    }

    function updateStatsDisplay(stats) {
      const infoEl = panel.querySelector("#snh48-member-index-info");
      if (!infoEl || !stats) return;
      const memberIndex = SNH48.memberIndex;
      const memberIndexStats = SNH48.memberIndexStats;
      const members = Object.keys(memberIndex).length;
      const perfs = memberIndexStats.performances;
      const baseText = "本地: " + members + " 位 / " + perfs + " 条 ";
      const totalCount = stats.totalPerformanceCount || stats.performanceCount;
      const archivedInfo = stats.archivedCount > 0 ? " (含归档 " + stats.archivedCount + " 场)" : "";
      const lastUp = stats.lastUpdated ? " | 同步: " + new Date(stats.lastUpdated).toLocaleTimeString() : "";
      infoEl.textContent = baseText + " | 后台: " + totalCount + " 场 / " + stats.memberCount + " 人" + archivedInfo + lastUp;
    }

    const startProgressPoll = () => {
      if (progressPollTimer) return;
      if (!isExtensionContextAlive()) return;
      progressPollTimer = _extSetInterval(() => {
        refreshState();
      }, 2000);
    };

    // [P1-3.1] 使用统一状态获取初始索引进度
    safeSendMessage({ type: SNH48_MSG.GET_STATE, keys: ["indexingState"] }, (state) => {
        if (state && state.indexingState && state.indexingState.running) {
          startBtn.disabled = true;
          stopBtn.disabled = false;
          startInput.disabled = true;
          endInput.disabled = true;
          updateProgressUI(state.indexingState);
          startProgressPoll();
        }
      });
  };

  // ---- 消息监听 ----
  try {
    if (isExtensionContextAlive()) {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        let config = SNH48.config;
        const DEFAULT_CONFIG = SNH48.DEFAULT_CONFIG;
        if (msg.type === SNH48_MSG.CONFIG_UPDATED) {
          config = Object.assign({}, DEFAULT_CONFIG, msg.config);
          SNH48.config = config;
          SNH48.applyDarkMode(config.darkMode);
          SNH48.applyHideHeader();
          sendResponse({ success: true });
        }
        if (msg.type === SNH48_MSG.GET_CONFIG) sendResponse(config);

        if (msg.type === SNH48_MSG.INDEXING_PROGRESS && _indexingUI.onProgress) {
          _indexingUI.onProgress(msg.payload);
        }
        if (msg.type === SNH48_MSG.INDEXING_COMPLETE && _indexingUI.onComplete) {
          _indexingUI.onComplete(msg.payload);
        }
        if (msg.type === SNH48_MSG.SHOW_INDEXING_STATUS && _indexingUI.onShowStatus) {
          _indexingUI.onShowStatus();
        }
        return true;
      });
    }
  } catch (e) {
    error("消息监听器注册失败:", e);
  }

  SNH48.createFloatPanel = createFloatPanel;
  SNH48.shouldIndexPage = shouldIndexPage;
})();
