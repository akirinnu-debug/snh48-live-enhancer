// ========== SNH48 Live Enhancer - Embedded Search ==========
(function () {
  "use strict";

  var SNH48 = window.SNH48 || (window.SNH48 = {});
  const log = SNH48.log;
  const warn = SNH48.warn;
  const error = SNH48.error;
  const safeSendMessage = SNH48.safeSendMessage;
  const _extSetTimeout = SNH48._extSetTimeout;
  const waitForElement = SNH48.waitForElement;

  const MAX_QUERY_LENGTH = 100;
  const MAX_SEARCH_RATE = 5; // max searches per second
  let searchTimestamps = []; // for rate limiting

  const SEARCH_CACHE_SIZE = 20;
  const _searchCache = new Map(); // query → { results, timestamp }

  function getCachedResults(query) {
    const normalized = query.toLowerCase().trim();
    if (_searchCache.has(normalized)) {
      const cached = _searchCache.get(normalized);
      // Cache entries expire after 5 minutes
      if (Date.now() - cached.timestamp < 5 * 60 * 1000) {
        return cached.results;
      }
      _searchCache.delete(normalized);
    }
    return null;
  }

  function setCachedResults(query, results) {
    const normalized = query.toLowerCase().trim();
    // LRU eviction
    if (_searchCache.size >= SEARCH_CACHE_SIZE) {
      // Delete the oldest entry
      const firstKey = _searchCache.keys().next().value;
      _searchCache.delete(firstKey);
    }
    _searchCache.set(normalized, { results, timestamp: Date.now() });
  }

  function clearSearchCache() {
    _searchCache.clear();
  }

  const sanitizeSearchQuery = (query) => {
    if (!query || typeof query !== "string") return "";
    // Trim and limit length
    let q = query.trim().substring(0, MAX_QUERY_LENGTH);
    // Remove control characters
    q = q.replace(/[\x00-\x1F\x7F]/g, "");
    return q;
  };

  const checkSearchRate = () => {
    const now = Date.now();
    // Remove timestamps older than 1 second
    searchTimestamps = searchTimestamps.filter((t) => now - t < 1000);
    if (searchTimestamps.length >= MAX_SEARCH_RATE) return false;
    searchTimestamps.push(now);
    return true;
  };

  const collectAllSearchable = (query) => {
    const config = SNH48.config;
    const q = query.toLowerCase();
    const dedupMap = Object.create(null);
    const order = [];

    const addItem = (item) => {
      const key = item.url || (item.type + "::" + item.name);
      if (dedupMap[key]) {
        if (dedupMap[key].types.indexOf(item.type) === -1) {
          dedupMap[key].types.push(item.type);
        }
        return;
      }
      item.types = [item.type];
      dedupMap[key] = item;
      order.push(key);
    };

    // 1. 视频列表 (.videolist > .videos)
    document.querySelectorAll(".videolist .videos").forEach((li) => {
      const a = li.querySelector("a");
      const h4 = li.querySelector("h4");
      const p = li.querySelector("p");
      if (!a) return;
      const name = (h4 ? h4.textContent : "").trim();
      const meta = (p ? p.textContent : "").trim();
      if (name.toLowerCase().includes(q)) {
        addItem({
          type: "公演",
          typeIcon: "📺",
          name,
          meta,
          url: a.href,
          action: () => { window.open(a.href, "_blank"); },
        });
      }
    });

    // 2. 即将开始列表 (.starts)
    document.querySelectorAll(".starts").forEach((li) => {
      const p = li.querySelector("p");
      const time = li.querySelector(".starttime");
      if (!p) return;
      const name = p.textContent.trim();
      const meta = time ? time.textContent.trim() : "";
      if (name.toLowerCase().includes(q)) {
        addItem({
          type: "即将开始",
          typeIcon: "⏰",
          name,
          meta,
          url: "scroll::" + name,
          action: () => {
            SNH48.scrollToAndHighlight(li, 3000);
          },
        });
      }
    });

    // 3. 直播中项目 (.watchcontent)
    document.querySelectorAll(".watchcontent").forEach((wc) => {
      const h2 = wc.querySelector(".v-text h2");
      const p = wc.querySelector(".v-text p");
      if (!h2) return;
      const name = h2.textContent.trim();
      const meta = p ? p.textContent.trim() : "";
      if (name.toLowerCase().includes(q)) {
        const btn = wc.querySelector(".startbtn");
        const url = btn && btn.tagName === "A" ? btn.href : "";
        addItem({
          type: "正在直播",
          typeIcon: "🔴",
          name,
          meta,
          url,
          action: () => {
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
    document.querySelectorAll(".imglist .imgbox").forEach((box) => {
      const nameEl = box.querySelector(".name");
      if (!nameEl) return;
      const name = nameEl.textContent.trim();
      if (name.toLowerCase().includes(q)) {
        addItem({
          type: "参演成员",
          typeIcon: "👥",
          name,
          meta: "本页公演",
          url: "scroll::" + name,
          action: () => {
            SNH48.scrollToAndHighlight(box, 3000);
          },
        });
      }
    });

    // 5. 直播/回放页 - 成员人气榜 (.memberlist .listname)
    document.querySelectorAll(".memberlist li").forEach((li) => {
      const nameEl = li.querySelector(".listname");
      if (!nameEl) return;
      const name = nameEl.textContent.trim();
      if (name.toLowerCase().includes(q)) {
        addItem({
          type: "成员",
          typeIcon: "👤",
          name,
          meta: "成员人气榜",
          url: "scroll::" + name,
          action: () => {
            SNH48.scrollToAndHighlight(li, 3000);
          },
        });
      }
    });

    // 6. 成员-公演反向索引
    if (config.memberIndex) {
      const memberHits = SNH48.searchMemberIndex(query);
      memberHits.forEach((hit) => {
        addItem({
          type: "成员参演",
          typeIcon: "⭐",
          name: hit.title,
          meta: hit.member + (hit.group ? " · " + hit.group : "") + " · " + SNH48.formatRelativeTime(hit.ts),
          url: hit.url,
          isMemberPerf: true,
          indexedAt: hit.ts || 0,
          performers: hit.member ? [hit.member] : [],
          action: () => { window.open(hit.url, "_blank"); },
        });
      });
    }

    const flat = order.map((k) => dedupMap[k]);

    const groupOrder = [
      { type: "成员参演", icon: "⭐", label: "成员参演" },
      { type: "公演", icon: "📺", label: "公演" },
      { type: "正在直播", icon: "🔴", label: "正在直播" },
      { type: "即将开始", icon: "⏰", label: "即将开始" },
      { type: "参演成员", icon: "👥", label: "参演成员" },
      { type: "成员", icon: "👤", label: "成员" },
    ];
    const groups = [];
    groupOrder.forEach((g) => {
      const items = flat.filter((it) => it.types.indexOf(g.type) !== -1);
      if (items.length > 0) {
        groups.push({ type: g.type, icon: g.icon, label: g.label, items });
      }
    });

    return {
      query,
      groups,
      totalCount: flat.length,
      isEmpty: flat.length === 0,
    };
  };

  const injectEmbeddedSearch = () => {
    const config = SNH48.config;
    if (!config.embeddedSearch) return;
    if (document.querySelector(".snh48-embedded-search")) return;

    log("注入顶部搜索入口");

    waitForElement(".headright", (headright) => {
      try {
        const searchBox = document.createElement("div");
        searchBox.className = "snh48-embedded-search";
        searchBox.innerHTML =
          '<div class="snh48-search-input-wrap">' +
            '<input type="text" class="snh48-embedded-search-input" placeholder="搜索公演/成员 (Ctrl+K)" maxlength="100">' +
            '<span class="snh48-search-shortcut">Ctrl+K</span>' +
          '</div>' +
          '<div class="snh48-search-results"></div>';

        if (headright.parentNode) {
          headright.parentNode.insertBefore(searchBox, headright);
        } else {
          headright.appendChild(searchBox);
        }

        const input = searchBox.querySelector(".snh48-embedded-search-input");
        const resultsEl = searchBox.querySelector(".snh48-search-results");
        let currentData = null;
        let currentIndex = -1;
        let activeFilter = "all";
        let _lastSearchResults = null;
        let _lastFilterType = null;
        let _lastFilterChips = null;

        const closeResults = () => {
          resultsEl.classList.remove("active");
          resultsEl.innerHTML = "";
          currentData = null;
          currentIndex = -1;
          _lastSearchResults = null;
          _lastFilterType = null;
          _lastFilterChips = null;
          clearSearchCache();
        };

        const flatten = (data) => {
          if (!data) return [];
          const result = [];
          data.groups.forEach((g) => {
            g.items.forEach((it) => { result.push({ group: g, item: it }); });
          });
          return result;
        };

        const applyFilter = (filterType) => {
          activeFilter = filterType;
          if (!currentData) return;
          if (filterType === "all") {
            currentData.filteredGroups = currentData.groups.slice();
          } else {
            currentData.filteredGroups = currentData.groups
              .filter((g) => g.type === filterType);
          }
          currentIndex = -1;
          render();
        };

        const renderSearchResults = (results, filterType) => {
          // If filter changed or this is a completely new search, do full render
          if (_lastFilterType !== filterType || !_lastSearchResults) {
            resultsEl.innerHTML = "";
            results.forEach(group => renderGroup(group));
            _lastSearchResults = results;
            _lastFilterType = filterType;
            return;
          }

          // Simple diff: compare result count and URLs
          const oldUrls = new Set();
          const newUrls = new Set();

          // Extract URLs from old and new results
          if (_lastSearchResults) {
            _lastSearchResults.forEach(group => {
              (group.items || []).forEach(item => oldUrls.add(item.url));
            });
          }
          results.forEach(group => {
            (group.items || []).forEach(item => newUrls.add(item.url));
          });

          // If the URL sets are identical, no need to re-render
          let same = oldUrls.size === newUrls.size;
          if (same) {
            for (const url of newUrls) {
              if (!oldUrls.has(url)) { same = false; break; }
            }
          }

          if (same && _lastSearchResults.length === results.length) {
            // Results are the same, skip re-render
            _lastSearchResults = results;
            return;
          }

          // Results changed - do full render (simple approach)
          // For a more sophisticated diff, we'd compare group by group,
          // but full render is still much better than before since we skip when identical
          resultsEl.innerHTML = "";
          results.forEach(group => renderGroup(group));
          _lastSearchResults = results;
          _lastFilterType = filterType;
        };

        const render = () => {
          resultsEl.innerHTML = "";
          if (!currentData) return;
          const groups = currentData.filteredGroups;

          renderFilterChips();

          if (groups.length === 0) {
            renderEmpty();
            resultsEl.classList.add("active");
            return;
          }

          renderSearchResults(groups, activeFilter);

          // Check if any groups were actually rendered
          const anyVisible = resultsEl.querySelector(".snh48-search-group") !== null;

          if (anyVisible) {
            resultsEl.classList.add("active");
            updateActive();
          } else {
            renderEmpty();
            resultsEl.classList.add("active");
          }
        };

        const renderFilterChips = () => {
          if (!currentData) return;
          const el = SNH48.el;

          const availableFilters = currentData.groups.map(g => g.type);
          const filterKey = availableFilters.sort().join(",");
          const filterChanged = _lastFilterChips !== filterKey;

          const chipBar = el("div", { className: "snh48-search-chips" });

          const totalAll = currentData.groups.reduce((s, g) => s + g.items.length, 0);
          const chips = [
            { type: "all", icon: "🔍", label: "全部", count: totalAll },
          ];
          currentData.groups.forEach((g) => {
            chips.push({ type: g.type, icon: g.icon, label: g.label, count: g.items.length });
          });

          // Helper to build chip content as DOM nodes
          const buildChipContent = (c) => [c.icon + " " + c.label + " ", el("em", { textContent: c.count })];

          // If filter types haven't changed, only update active state and counts
          if (!filterChanged) {
            const existingChips = resultsEl.querySelectorAll(".snh48-search-chip");
            if (existingChips.length === chips.length) {
              existingChips.forEach((chipEl, i) => {
                const c = chips[i];
                chipEl.className = "snh48-search-chip" + (activeFilter === c.type ? " active" : "");
                chipEl.textContent = "";
                buildChipContent(c).forEach((node) => {
                  if (typeof node === "string") chipEl.appendChild(document.createTextNode(node));
                  else chipEl.appendChild(node);
                });
              });
              _lastFilterChips = filterKey;
              return;
            }
          }

          chips.forEach((c) => {
            const chip = el("span", { className: "snh48-search-chip" + (activeFilter === c.type ? " active" : ""), onClick: (e) => {
              e.stopPropagation();
              applyFilter(c.type);
            }}, buildChipContent(c));
            chipBar.appendChild(chip);
          });
          resultsEl.appendChild(chipBar);
          _lastFilterChips = filterKey;
        };

        const renderGroup = (group) => {
          if (!group.items || group.items.length === 0) return false;
          const el = SNH48.el;
          const wrapper = el("div", { className: "snh48-search-group", dataset: { groupType: group.type } });

          const header = el("div", { className: "snh48-search-group-header", onClick: (e) => {
            e.stopPropagation();
            wrapper.classList.toggle("snh48-search-group-collapsed");
          }}, [
            el("span", { className: "snh48-search-group-icon", textContent: group.icon }),
            el("span", { className: "snh48-search-group-label", textContent: group.label }),
            el("span", { className: "snh48-search-group-count", textContent: group.items.length }),
          ]);
          wrapper.appendChild(header);

          const PER_GROUP_LIMIT = 5;
          const visible = group.items.slice(0, PER_GROUP_LIMIT);
          const hidden = group.items.length - visible.length;

          visible.forEach((item) => {
            wrapper.appendChild(buildItemEl(group, item));
          });

          if (hidden > 0) {
            const more = document.createElement("div");
            more.className = "snh48-search-more";
            more.textContent = "查看全部 " + group.items.length + " 条 →";
            more.addEventListener("click", (e) => {
              e.stopPropagation();
              group.items.forEach((item) => {
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
        };

        const highlightNodes = (text, query) => {
          if (!query) return [document.createTextNode(text)];
          const idx = text.toLowerCase().indexOf(query.toLowerCase());
          if (idx === -1) return [document.createTextNode(text)];
          const nodes = [];
          if (idx > 0) nodes.push(document.createTextNode(text.substring(0, idx)));
          const b = document.createElement("b");
          b.textContent = text.substring(idx, idx + query.length);
          nodes.push(b);
          if (idx + query.length < text.length) {
            nodes.push(document.createTextNode(text.substring(idx + query.length)));
          }
          return nodes;
        };

        const buildItemEl = (group, item) => {
          const el = SNH48.el;
          const types = item.types || [group.type];
          const badgeNodes = types.map((t) => {
            let found = null;
            currentData.groups.forEach((g) => { if (g.type === t) found = g; });
            const icon = found ? found.icon : group.icon;
            const extraCls = (t === "成员参演") ? " snh48-type-member-perf" : "";
            return el("span", { className: "snh48-search-type" + extraCls }, [icon + " " + t]);
          });

          const name = item.name || item.title || "";

          const div = el("div", { className: "snh48-search-result-item" }, [
            ...badgeNodes,
            el("span", { className: "snh48-search-name" }, highlightNodes(name, currentData.query)),
            el("span", { className: "snh48-search-meta", textContent: item.meta || "" }),
          ]);

          div.addEventListener("click", (e) => {
            e.stopPropagation();
            try {
              if (item.action) item.action();
              else if (item.url) window.open(item.url, "_blank");
            } catch (err) { warn("action 执行失败:", err); }
            closeResults();
            input.value = "";
          });
          return div;
        };

        const renderEmpty = () => {
          const el = SNH48.el;
          const empty = el("div", { className: "snh48-search-empty" });

          if (currentData.query) {
            empty.appendChild(el("div", { className: "snh48-search-empty-title" },
              ['未找到匹配 "', currentData.query, '"']));
            empty.appendChild(el("div", { className: "snh48-search-empty-hint", textContent: "试试搜索公演名、成员名或团名" }));

            const suggestions = getTopMemberSuggestions(5);
            if (suggestions.length > 0) {
              const sugWrap = el("div", { className: "snh48-search-suggestions" }, [
                el("div", { className: "snh48-search-suggestions-label", textContent: "试试已收录的成员：" }),
              ]);
              suggestions.forEach((s) => {
                const tag = el("span", { className: "snh48-search-suggestion-tag", textContent: s.name + " (" + s.count + ")" });
                tag.addEventListener("click", (e) => {
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
            empty.appendChild(el("div", { className: "snh48-search-empty-title", textContent: "输入关键词开始搜索" }));
            empty.appendChild(el("div", { className: "snh48-search-empty-hint", textContent: "支持搜索公演名、成员名、团名" }));
          }
          resultsEl.appendChild(empty);
        };

        const getTopMemberSuggestions = (limit) => {
          const memberIndex = SNH48.memberIndex;
          const arr = Object.keys(memberIndex).map((name) => {
            return { name, count: memberIndex[name].length };
          });
          arr.sort((a, b) => b.count - a.count);
          return arr.slice(0, limit);
        };

        let searchToken = 0;

        const performSearch = async (query) => {
          query = sanitizeSearchQuery(query);
          if (!query) {
            closeResults();
            return;
          }

          // Check cache first
          const cached = getCachedResults(query);
          if (cached) {
            log("搜索缓存命中 [" + query + "]");
            currentData = cached;
            currentData.query = query;
            applyFilterAndRender(query);
            return;
          }

          const localData = collectAllSearchable(query);
          currentData = localData;
          currentData.query = query;
          applyFilterAndRender(query);

          const myToken = ++searchToken;
          safeSendMessage({ type: SNH48_MSG.SEARCH_INDEX, query }, (indexResults) => {
              if (myToken !== searchToken) return;
              if (chrome.runtime.lastError) {
                warn("后台搜索消息失败:", chrome.runtime.lastError);
                return;
              }
              if (!indexResults || indexResults.length === 0) {
                log("后台搜索 [" + query + "]: 无结果");
                // Cache local-only results
                setCachedResults(query, currentData);
                return;
              }
              if (!currentData) return;

              log("后台搜索 [" + query + "]: 返回 " + indexResults.length + " 条结果，当前类型分组数=" + currentData.groups.length);

              const memberPerfGroup = currentData.groups.find(g => g.type === "成员参演");
              let newCount = 0;
              if (memberPerfGroup) {
                // Build a URL → item map for smart merge
                const existingMap = Object.create(null);
                memberPerfGroup.items.forEach((it) => {
                  existingMap[it.url] = it;
                });
                indexResults.forEach((r) => {
                  r.action = () => { window.open(r.url, "_blank"); };
                  const existing = existingMap[r.url];
                  if (!existing) {
                    // New URL — add directly
                    memberPerfGroup.items.push(r);
                    existingMap[r.url] = r;
                    newCount++;
                  } else {
                    // Duplicate URL — merge by preferring more recent indexedAt
                    const existingTs = existing.indexedAt || existing.ts || 0;
                    const newTs = r.indexedAt || r.ts || 0;
                    if (newTs > existingTs) {
                      // New data is more recent — replace, but merge performers from both
                      let mergedItem = Object.assign({}, r);
                      if (existing.performers && r.performers) {
                        const memberSet = new Set([].concat(existing.performers, r.performers));
                        mergedItem.performers = Array.from(memberSet);
                      } else if (existing.performers) {
                        mergedItem.performers = existing.performers;
                      }
                      // Keep the longer title
                      const existingName = existing.name || existing.title || "";
                      const newName = mergedItem.name || mergedItem.title || "";
                      if (existingName.length > newName.length) {
                        mergedItem.name = existingName;
                        mergedItem.title = existingName;
                      }
                      // Replace in items array
                      const idx = memberPerfGroup.items.indexOf(existing);
                      if (idx >= 0) memberPerfGroup.items[idx] = mergedItem;
                      existingMap[r.url] = mergedItem;
                    } else {
                      // Existing is more recent — keep it, but merge performers from new source
                      if (r.performers && existing.performers) {
                        const memberSet2 = new Set([].concat(existing.performers, r.performers));
                        existing.performers = Array.from(memberSet2);
                      } else if (r.performers) {
                        existing.performers = r.performers;
                      }
                      // Keep the longer title on existing
                      const existingName2 = existing.name || existing.title || "";
                      const newName2 = r.name || r.title || "";
                      if (newName2.length > existingName2.length) {
                        existing.name = newName2;
                        existing.title = newName2;
                      }
                    }
                  }
                });
              } else {
                indexResults.forEach(r => r.action = () => { window.open(r.url, "_blank"); });
                currentData.groups.unshift({
                  type: "成员参演",
                  icon: "⭐",
                  label: "成员参演",
                  items: indexResults
                });
                newCount = indexResults.length;
              }
              // Cache merged results
              setCachedResults(query, currentData);
              if (newCount > 0) applyFilterAndRender(query);
            });
        };

        const applyFilterAndRender = (query) => {
          currentData.query = query;
          if (activeFilter === "all") {
            currentData.filteredGroups = currentData.groups.slice();
          } else {
            currentData.filteredGroups = currentData.groups.filter((g) => g.type === activeFilter);
            if (currentData.filteredGroups.length === 0 && currentData.groups.length > 0) {
              activeFilter = "all";
              currentData.filteredGroups = currentData.groups.slice();
            }
          }
          currentIndex = -1;
          render();
        };

        const rebuildFlatItems = () => {
          const items = [];
          const groupEls = resultsEl.querySelectorAll('.snh48-search-group');
          groupEls.forEach((groupEl) => {
            const groupName = groupEl.querySelector('.snh48-search-group-header');
            if (groupName) {
              items.push({ type: 'group', el: groupName });
            }
            const isCollapsed = groupEl.classList.contains('snh48-search-group-collapsed');
            if (!isCollapsed) {
              const childEls = groupEl.querySelectorAll('.snh48-search-result-item');
              childEls.forEach((childEl) => {
                items.push({ type: 'item', el: childEl });
              });
            }
          });
          return items;
        };

        const updateActive = () => {
          const flatItems = rebuildFlatItems();
          flatItems.forEach((entry) => { entry.el.classList.remove("active"); });
          currentIndex = Math.max(0, Math.min(currentIndex, flatItems.length - 1));
          if (currentIndex >= 0 && flatItems[currentIndex]) {
            flatItems[currentIndex].el.classList.add("active");
            flatItems[currentIndex].el.scrollIntoView({ block: "nearest" });
          }
        };

        let searchDebounceTimer = null;
        input.addEventListener("input", () => {
          const val = sanitizeSearchQuery(input.value);
          clearTimeout(searchDebounceTimer);
          if (!val) {
            closeResults();
            return;
          }
          if (!checkSearchRate()) {
            return;
          }
          searchDebounceTimer = _extSetTimeout(() => {
            performSearch(val);
          }, 150);
        });

        input.addEventListener("focus", () => {
          if (sanitizeSearchQuery(input.value)) performSearch(sanitizeSearchQuery(input.value));
        });

        input.addEventListener("keydown", (e) => {
          let flatItems = rebuildFlatItems();
          if (flatItems.length === 0) return;

          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (currentIndex < flatItems.length - 1) {
              currentIndex++;
            }
            currentIndex = Math.max(0, Math.min(currentIndex, flatItems.length - 1));
            updateActive();
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (currentIndex > 0) {
              currentIndex--;
            }
            currentIndex = Math.max(0, Math.min(currentIndex, flatItems.length - 1));
            updateActive();
          } else if (e.key === "Home") {
            e.preventDefault();
            currentIndex = 0;
            updateActive();
          } else if (e.key === "End") {
            e.preventDefault();
            currentIndex = flatItems.length - 1;
            updateActive();
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (currentIndex >= 0 && flatItems[currentIndex]) {
              const entry = flatItems[currentIndex];
              if (entry.type === 'group') {
                const groupEl = entry.el.closest('.snh48-search-group');
                if (groupEl) {
                  groupEl.classList.toggle('snh48-search-group-collapsed');
                  flatItems = rebuildFlatItems();
                  currentIndex = Math.max(0, Math.min(currentIndex, flatItems.length - 1));
                  updateActive();
                }
              } else {
                entry.el.click();
              }
            }
          } else if (e.key === "Escape") {
            closeResults();
            input.blur();
          }
        });

        document.addEventListener("click", (e) => {
          if (!searchBox.contains(e.target)) closeResults();
        });

        log("顶部搜索入口已注入");
      } catch (e) {
        error("注入搜索入口失败:", e);
      }
    });
  };

  // 配置变更时清除搜索缓存
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === SNH48_MSG.CONFIG_UPDATED) {
      clearSearchCache();
    }
  });

  // 全局快捷键 Ctrl+K / Cmd+K 打开顶部搜索
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      const input = document.querySelector(".snh48-embedded-search-input");
      if (input) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    }
  });

  SNH48.injectEmbeddedSearch = injectEmbeddedSearch;
})();
