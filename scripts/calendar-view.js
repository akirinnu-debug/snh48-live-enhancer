// ========== SNH48 Live Enhancer - Calendar View ==========
(function () {
  "use strict";

  var SNH48 = window.SNH48 || (window.SNH48 = {});
  var log = SNH48.log;
  var error = SNH48.error;
  var safeSendMessage = SNH48.safeSendMessage;
  var escapeHtml = SNH48.escapeHtml;
  var showToast = SNH48.showToast;

  var calendarOverlay = null;
  var currentYear = null;
  var currentMonth = null;
  var currentGroupFilter = "all";
  var indexData = [];

  // Team 分组映射表（同时处理压缩 URL 和完整 URL）
  var GROUPS = {
    "snh48": "SNH48",
    "gnz48": "GNZ48",
    "bej48": "BEJ48",
    "ckg48": "CKG48",
    "cgt48": "CGT48",
    "shy48": "SHY48"
  };

  // 压缩 URL 前缀 → club 映射（club ID 与实际团体对应关系来自网站 HTML）
  var COMPRESSED_GROUP_MAP = {
    "/c/1/": "snh48",
    "/c/2/": "bej48",
    "/c/3/": "gnz48",
    "/c/4/": "shy48",
    "/c/5/": "ckg48",
    "/c/6/": "cgt48",
    "/p/1/": "snh48",
    "/p/2/": "bej48",
    "/p/3/": "gnz48",
    "/p/4/": "shy48",
    "/p/5/": "ckg48",
    "/p/6/": "cgt48"
  };

  function createCalendarView() {
    if (calendarOverlay) {
      calendarOverlay.style.display =
        calendarOverlay.style.display === "none" ? "" : "none";
      if (calendarOverlay.style.display !== "none") {
        renderCalendar();
      }
      return;
    }

    // 创建遮罩层
    calendarOverlay = document.createElement("div");
    calendarOverlay.id = "snh48-calendar-overlay";
    calendarOverlay.className = "snh48-calendar-overlay";

    var container = document.createElement("div");
    container.className = "snh48-calendar-container";

    // 标题栏
    var header = document.createElement("div");
    header.className = "snh48-calendar-header";

    var prevBtn = document.createElement("button");
    prevBtn.className = "snh48-calendar-nav-btn";
    prevBtn.textContent = "\u25C0";
    prevBtn.addEventListener("click", function () { navigateMonth(-1); });

    var titleSpan = document.createElement("span");
    titleSpan.className = "snh48-calendar-title";
    titleSpan.id = "snh48-calendar-title";

    var nextBtn = document.createElement("button");
    nextBtn.className = "snh48-calendar-nav-btn";
    nextBtn.textContent = "\u25B6";
    nextBtn.addEventListener("click", function () { navigateMonth(1); });

    var closeBtn = document.createElement("button");
    closeBtn.className = "snh48-calendar-close-btn";
    closeBtn.textContent = "\u2715";
    closeBtn.addEventListener("click", function () {
      calendarOverlay.style.display = "none";
    });

    // 快速跳转按钮
    var todayBtn = document.createElement("button");
    todayBtn.className = "snh48-calendar-btn";
    todayBtn.textContent = "今天";
    todayBtn.style.marginLeft = "10px";
    todayBtn.addEventListener("click", function () {
      var now = new Date();
      currentYear = now.getFullYear();
      currentMonth = now.getMonth();
      renderCalendar();
    });

    header.appendChild(prevBtn);
    header.appendChild(titleSpan);
    header.appendChild(nextBtn);
    header.appendChild(todayBtn);
    header.appendChild(closeBtn);

    // 分组筛选栏
    var filterRow = document.createElement("div");
    filterRow.className = "snh48-calendar-filter";
    filterRow.id = "snh48-calendar-filter";

    // 日历网格
    var grid = document.createElement("div");
    grid.className = "snh48-calendar-grid";
    grid.id = "snh48-calendar-grid";

    // 详情面板
    var detail = document.createElement("div");
    detail.className = "snh48-calendar-detail";
    detail.id = "snh48-calendar-detail";
    detail.style.display = "none";

    // 底部提示
    var footer = document.createElement("div");
    footer.className = "snh48-calendar-footer";
    footer.style.marginTop = "12px";
    footer.style.fontSize = "12px";
    footer.style.color = "rgba(255,255,255,0.5)";
    footer.style.textAlign = "center";
    footer.id = "snh48-calendar-footer";

    container.appendChild(header);
    container.appendChild(filterRow);
    container.appendChild(grid);
    container.appendChild(detail);
    container.appendChild(footer);
    calendarOverlay.appendChild(container);

    document.body.appendChild(calendarOverlay);

    // 点击遮罩空白处关闭
    calendarOverlay.addEventListener("click", function (e) {
      if (e.target === calendarOverlay) {
        calendarOverlay.style.display = "none";
      }
    });

    // ESC 键关闭
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && calendarOverlay.style.display !== "none") {
        calendarOverlay.style.display = "none";
      }
    });

    // 初次渲染
    renderCalendar();
  }

  function navigateMonth(delta) {
    currentMonth += delta;
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    renderCalendar();
  }

  function renderCalendar() {
    var now = new Date();
    if (currentYear === null) {
      currentYear = now.getFullYear();
      currentMonth = now.getMonth();
    }

    // 更新标题
    var titleEl = document.getElementById("snh48-calendar-title");
    if (titleEl) {
      titleEl.textContent = currentYear + "\u5E74" + (currentMonth + 1) + "\u6708";
    }

    // 获取索引数据
    safeSendMessage(
      { type: SNH48_MSG.GET_ALL_PERFORMANCES },
      function (results) {
        indexData = Array.isArray(results) ? results : [];
        renderFilter();
        renderGrid();
        renderFooter();
      }
    );
  }

  function renderFooter() {
    var footer = document.getElementById("snh48-calendar-footer");
    if (!footer) return;
    var totalWithDate = indexData.length;
    footer.textContent =
      "共 " + totalWithDate + " 条带日期的公演索引" +
      (totalWithDate === 0 ? "，请先运行批量索引" : "");
  }

  function renderFilter() {
    var filterEl = document.getElementById("snh48-calendar-filter");
    if (!filterEl) return;
    filterEl.innerHTML = "";

    // 从数据中提取分组信息
    var groups = new Set();
    for (var i = 0; i < indexData.length; i++) {
      var g = guessGroup(indexData[i].url, indexData[i].team);
      if (g) groups.add(g);
    }

    // "全部" 按钮
    var allBtn = document.createElement("button");
    allBtn.className = "snh48-calendar-filter-btn" +
      (currentGroupFilter === "all" ? " active" : "");
    allBtn.textContent = "\u5168\u90E8";
    allBtn.addEventListener("click", function () {
      currentGroupFilter = "all";
      renderFilter();
      renderGrid();
    });
    filterEl.appendChild(allBtn);

    // 各分组按钮
    groups.forEach(function (group) {
      var btn = document.createElement("button");
      btn.className = "snh48-calendar-filter-btn" +
        (currentGroupFilter === group ? " active" : "");
      btn.textContent = GROUPS[group] || group;
      btn.addEventListener("click", function () {
        currentGroupFilter = group;
        renderFilter();
        renderGrid();
      });
      filterEl.appendChild(btn);
    });
  }

  // 根据 URL 或 team 字段推断分组
  function guessGroup(url, team) {
    if (team) {
      var teamLow = team.toLowerCase();
      if (teamLow.indexOf("snh") >= 0) return "snh48";
      if (teamLow.indexOf("gnz") >= 0) return "gnz48";
      if (teamLow.indexOf("bej") >= 0) return "bej48";
      if (teamLow.indexOf("ckg") >= 0) return "ckg48";
      if (teamLow.indexOf("cgt") >= 0) return "cgt48";
    }
    if (!url) return null;

    // 处理压缩 URL 格式
    for (var prefix in COMPRESSED_GROUP_MAP) {
      if (COMPRESSED_GROUP_MAP.hasOwnProperty(prefix) && url.indexOf(prefix) === 0) {
        return COMPRESSED_GROUP_MAP[prefix];
      }
    }

    // 处理完整 URL 格式
    if (url.indexOf("/club/1/") >= 0) return "snh48";
    if (url.indexOf("/club/2/") >= 0) return "bej48";
    if (url.indexOf("/club/3/") >= 0) return "gnz48";
    if (url.indexOf("/club/4/") >= 0) return "shy48";
    if (url.indexOf("/club/5/") >= 0) return "ckg48";
    if (url.indexOf("/club/6/") >= 0) return "cgt48";

    return null;
  }

  function renderGrid() {
    var gridEl = document.getElementById("snh48-calendar-grid");
    if (!gridEl) return;
    gridEl.innerHTML = "";

    // 按分组过滤
    var filtered = indexData;
    if (currentGroupFilter !== "all") {
      filtered = [];
      for (var i = 0; i < indexData.length; i++) {
        if (guessGroup(indexData[i].url, indexData[i].team) === currentGroupFilter) {
          filtered.push(indexData[i]);
        }
      }
    }

    // 构建日期映射
    var dateMap = {};
    for (var j = 0; j < filtered.length; j++) {
      var item = filtered[j];
      if (!item.date) continue;
      if (!dateMap[item.date]) dateMap[item.date] = [];
      dateMap[item.date].push(item);
    }

    // 星期表头
    var dayNames = ["\u65E5", "\u4E00", "\u4E8C", "\u4E09", "\u56DB", "\u4E94", "\u516D"];
    for (var k = 0; k < dayNames.length; k++) {
      var dayHeader = document.createElement("div");
      dayHeader.className = "snh48-calendar-day-header";
      dayHeader.textContent = dayNames[k];
      gridEl.appendChild(dayHeader);
    }

    // 计算网格
    var firstDay = new Date(currentYear, currentMonth, 1).getDay();
    var daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    var today = new Date();
    var todayStr = today.getFullYear() + "-" +
      String(today.getMonth() + 1).padStart(2, "0") + "-" +
      String(today.getDate()).padStart(2, "0");

    // 第一行空白单元格
    for (var e = 0; e < firstDay; e++) {
      var emptyCell = document.createElement("div");
      emptyCell.className = "snh48-calendar-day empty";
      gridEl.appendChild(emptyCell);
    }

    // 日期单元格
    for (var d = 1; d <= daysInMonth; d++) {
      var dateStr = currentYear + "-" +
        String(currentMonth + 1).padStart(2, "0") + "-" +
        String(d).padStart(2, "0");
      var dayEl = document.createElement("div");
      dayEl.className = "snh48-calendar-day";

      if (dateStr === todayStr) dayEl.classList.add("today");

      var dayNum = document.createElement("span");
      dayNum.className = "snh48-calendar-day-num";
      dayNum.textContent = d;
      dayEl.appendChild(dayNum);

      var perfs = dateMap[dateStr];
      if (perfs && perfs.length > 0) {
        var dot = document.createElement("span");
        dot.className = "snh48-calendar-dot";
        dot.textContent = perfs.length;
        dayEl.appendChild(dot);
        dayEl.classList.add("has-perf");
        (function (date, perfsOnDay) {
          dayEl.addEventListener("click", function () {
            showDayDetail(date, perfsOnDay);
          });
        })(dateStr, perfs);
      }

      gridEl.appendChild(dayEl);
    }
  }

  function showDayDetail(dateStr, perfs) {
    var detailEl = document.getElementById("snh48-calendar-detail");
    if (!detailEl) return;
    detailEl.style.display = "";
    detailEl.innerHTML = "";

    var title = document.createElement("div");
    title.className = "snh48-calendar-detail-title";
    title.textContent = dateStr + " \u516C\u6F14（" + perfs.length + "\u573A）";
    detailEl.appendChild(title);

    for (var i = 0; i < perfs.length; i++) {
      var perf = perfs[i];
      var item = document.createElement("a");
      item.className = "snh48-calendar-detail-item";
      item.href = perf.url;
      item.target = "_blank";

      var name = document.createElement("span");
      name.className = "snh48-calendar-detail-name";
      name.textContent = perf.title || "\u672A\u77E5\u516C\u6F14";
      item.appendChild(name);

      // 附加信息：Team + 参演成员
      var metaParts = [];
      if (perf.team) metaParts.push(perf.team);
      if (perf.performers && perf.performers.length > 0) {
        var perfText = perf.performers.slice(0, 5).join(", ");
        if (perf.performers.length > 5)
          perfText += "... (" + perf.performers.length + "\u4EBA)";
        metaParts.push(perfText);
      }
      if (metaParts.length > 0) {
        var meta = document.createElement("span");
        meta.className = "snh48-calendar-detail-meta";
        meta.textContent = metaParts.join(" | ");
        item.appendChild(meta);
      }

      detailEl.appendChild(item);
    }
  }

  SNH48.createCalendarView = createCalendarView;
})();
