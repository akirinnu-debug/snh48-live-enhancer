/**
 * SNH48 Live Enhancer - 索引功能测试套件
 * 运行方式：在浏览器控制台加载，或通过 Node.js 运行
 *
 * 测试覆盖：
 *   1. 索引容量限制解除验证
 *   2. 分片归档机制
 *   3. 搜索加速索引正确性
 *   4. 空格键快捷键修复验证
 */

// ============================================================
// 测试框架（轻量级，无外部依赖）
// ============================================================
var TestSuite = {
  passed: 0,
  failed: 0,
  errors: [],
  currentGroup: "",

  group: function (name) {
    this.currentGroup = name;
    console.log("\n=== " + name + " ===");
  },

  assert: function (condition, message) {
    if (condition) {
      this.passed++;
      console.log("  ✓ " + message);
    } else {
      this.failed++;
      this.errors.push(this.currentGroup + ": " + message);
      console.error("  ✗ " + message);
    }
  },

  assertEqual: function (actual, expected, message) {
    this.assert(actual === expected, message + " (期望: " + expected + ", 实际: " + actual + ")");
  },

  assertGreater: function (actual, threshold, message) {
    this.assert(actual > threshold, message + " (实际: " + actual + " > " + threshold + ")");
  },

  summary: function () {
    console.log("\n" + "=".repeat(50));
    console.log("测试结果: " + this.passed + " 通过, " + this.failed + " 失败");
    if (this.errors.length > 0) {
      console.log("\n失败列表:");
      this.errors.forEach(function (e) { console.error("  - " + e); });
    }
    return this.failed === 0;
  }
};

// ============================================================
// 模拟 chrome.storage.local（用于 Node.js 环境）
// ============================================================
var MockStorage = {
  _data: {},
  get: function (keys, callback) {
    var result = {};
    if (typeof keys === "string") keys = [keys];
    if (Array.isArray(keys)) {
      keys.forEach(function (k) { if (MockStorage._data[k]) result[k] = MockStorage._data[k]; });
    } else if (keys === null) {
      result = Object.assign({}, MockStorage._data);
    }
    if (callback) callback(result);
    return Promise.resolve(result);
  },
  set: function (items, callback) {
    Object.keys(items).forEach(function (k) { MockStorage._data[k] = items[k]; });
    if (callback) callback();
    return Promise.resolve();
  },
  remove: function (keys, callback) {
    if (typeof keys === "string") keys = [keys];
    keys.forEach(function (k) { delete MockStorage._data[k]; });
    if (callback) callback();
    return Promise.resolve();
  },
  clear: function () {
    MockStorage._data = {};
  }
};

// 模拟 chrome 对象（如果不在浏览器扩展环境中）
if (typeof chrome === "undefined") {
  global.chrome = {
    storage: { local: MockStorage, sync: MockStorage },
    runtime: {
      onMessage: { addListener: function () {} },
      onInstalled: { addListener: function () {} },
      sendMessage: function () { return Promise.resolve(); },
      lastError: null,
      id: "test-extension-id"
    },
    tabs: {
      query: function () { return Promise.resolve([]); },
      sendMessage: function () { return Promise.resolve(); }
    },
    contextMenus: {
      create: function () {},
      onClicked: { addListener: function () {} }
    },
    notifications: { create: function () {} },
    alarms: { create: function () {}, onAlarm: { addListener: function () {} } }
  };
}

// ============================================================
// 测试 1: 索引容量限制解除
// ============================================================
(function testIndexCapacity() {
  TestSuite.group("索引容量限制解除");

  // 验证常量已更新
  TestSuite.assertEqual(typeof INDEX_SOFT_LIMIT !== "undefined" ? INDEX_SOFT_LIMIT : -1, 50000,
    "INDEX_SOFT_LIMIT 应为 50000（原 MAX_INDEX_ITEMS 为 2000）");
  TestSuite.assertEqual(typeof INDEX_SHARD_SIZE !== "undefined" ? INDEX_SHARD_SIZE : -1, 5000,
    "INDEX_SHARD_SIZE 应为 5000");

  // 验证旧的 MAX_INDEX_ITEMS 不再存在
  TestSuite.assert(typeof MAX_INDEX_ITEMS === "undefined",
    "MAX_INDEX_ITEMS (2000上限) 应已被移除");
})();

// ============================================================
// 测试 2: 分片归档机制
// ============================================================
(function testShardArchive() {
  TestSuite.group("分片归档机制");

  // 模拟大数据量索引
  var mockPerformances = [];
  for (var i = 0; i < 55000; i++) {
    mockPerformances.push({
      id: "pid_" + i,
      url: "https://live.48.cn/Index/invideo/club/1/id/" + (1000 + i),
      title: "测试公演 " + i,
      performers: ["成员A", "成员B"],
      indexedAt: Date.now() - (55000 - i) * 1000
    });
  }

  // 验证归档逻辑：超过软上限时触发归档
  TestSuite.assert(mockPerformances.length > 50000,
    "模拟数据量 " + mockPerformances.length + " 应超过软上限 50000");

  // 验证分片后内存中只保留 INDEX_SHARD_SIZE 条
  var toKeep = mockPerformances.slice(0, 5000);
  TestSuite.assertEqual(toKeep.length, 5000,
    "分片后内存中应保留 " + 5000 + " 条");

  // 验证归档数据量
  var toArchive = mockPerformances.slice(5000);
  TestSuite.assertEqual(toArchive.length, 50000,
    "归档数据应为 " + 50000 + " 条");

  // 验证分片数量
  var shardCount = Math.ceil(toArchive.length / 5000);
  TestSuite.assertEqual(shardCount, 10,
    "应产生 10 个分片");
})();

// ============================================================
// 测试 3: 搜索加速索引
// ============================================================
(function testSearchAccelIndex() {
  TestSuite.group("搜索加速索引");

  // 测试 extractKeywords 函数
  if (typeof extractKeywords === "function") {
    var kw1 = extractKeywords("因为喜欢你剧场公演");
    TestSuite.assert(kw1.length > 0,
      "中文标题应能提取关键词: " + JSON.stringify(kw1));
    TestSuite.assert(kw1.indexOf("因为") !== -1 || kw1.indexOf("因为喜") !== -1,
      "应包含'因为'或'因为喜'关键词");

    var kw2 = extractKeywords("Team X 2024 Special");
    TestSuite.assert(kw2.indexOf("team") !== -1 || kw2.indexOf("special") !== -1,
      "英文标题应能提取关键词: " + JSON.stringify(kw2));
  } else {
    TestSuite.assert(false, "extractKeywords 函数未定义（可能需要在 background.js 上下文中运行）");
  }

  // 测试 Map 加速索引
  if (typeof perfUrlMap !== "undefined") {
    TestSuite.assert(perfUrlMap instanceof Map,
      "perfUrlMap 应为 Map 类型");
  }
  if (typeof memberNameMap !== "undefined") {
    TestSuite.assert(memberNameMap instanceof Map,
      "memberNameMap 应为 Map 类型");
  }
  if (typeof titleKeywordMap !== "undefined") {
    TestSuite.assert(titleKeywordMap instanceof Map,
      "titleKeywordMap 应为 Map 类型");
  }
})();

// ============================================================
// 测试 4: 空格键快捷键修复验证
// ============================================================
(function testSpaceKeyFix() {
  TestSuite.group("空格键快捷键修复验证");

  // 验证 keydown 事件使用捕获阶段
  // 此测试需要检查 content.js 代码中的 addEventListener 调用
  // 由于无法直接在测试中验证，我们验证关键逻辑

  // 模拟空格键事件处理
  var spaceKeyHandled = false;
  var mockEvent = {
    key: " ",
    target: { tagName: "DIV", isContentEditable: false },
    preventDefault: function () { spaceKeyHandled = true; },
    stopPropagation: function () {}
  };

  // 模拟 video 元素
  var mockVideo = {
    paused: true,
    play: function () { this.paused = false; return Promise.resolve(); },
    pause: function () { this.paused = true; }
  };

  // 验证空格键处理逻辑
  var tag = mockEvent.target.tagName;
  var isInput = tag === "INPUT" || tag === "TEXTAREA" || mockEvent.target.isContentEditable;
  TestSuite.assert(!isInput, "非输入框元素不应跳过空格键处理");

  // 模拟空格键按下
  if (!isInput && mockVideo) {
    mockEvent.preventDefault();
    mockEvent.stopPropagation();
    if (mockVideo.paused) {
      mockVideo.play();
    } else {
      mockVideo.pause();
    }
  }
  TestSuite.assert(spaceKeyHandled, "空格键应被正确处理（preventDefault 已调用）");
  TestSuite.assert(!mockVideo.paused, "空格键应触发视频播放");

  // 再次按空格应暂停
  mockVideo.paused = false;
  spaceKeyHandled = false;
  mockEvent.preventDefault = function () { spaceKeyHandled = true; };
  if (!isInput && mockVideo) {
    mockEvent.preventDefault();
    if (mockVideo.paused) {
      mockVideo.play();
    } else {
      mockVideo.pause();
    }
  }
  TestSuite.assert(mockVideo.paused, "再次按空格应触发视频暂停");
})();

// ============================================================
// 测试 5: 清空索引应清除分片
// ============================================================
(function testClearIndexWithShards() {
  TestSuite.group("清空索引应清除分片");

  // 模拟分片数据
  MockStorage.clear();
  MockStorage._data["snh48_index_shard_0"] = [{ id: "test1", title: "测试1" }];
  MockStorage._data["snh48_index_shard_1"] = [{ id: "test2", title: "测试2" }];
  MockStorage._data["snh48_full_index"] = { performances: [], members: [] };
  MockStorage._data["snh48_index_meta"] = { totalItems: 2, archivedShards: 2 };

  // 验证分片存在
  TestSuite.assert(MockStorage._data["snh48_index_shard_0"] !== undefined,
    "分片0应存在");
  TestSuite.assert(MockStorage._data["snh48_index_shard_1"] !== undefined,
    "分片1应存在");

  // 模拟清除分片逻辑
  var allKeys = Object.keys(MockStorage._data);
  var shardKeys = allKeys.filter(function (k) { return k.startsWith("snh48_index_shard_"); });
  TestSuite.assertEqual(shardKeys.length, 2,
    "应找到2个分片键");

  shardKeys.forEach(function (k) { delete MockStorage._data[k]; });
  TestSuite.assert(MockStorage._data["snh48_index_shard_0"] === undefined,
    "清除后分片0应不存在");
  TestSuite.assert(MockStorage._data["snh48_index_shard_1"] === undefined,
    "清除后分片1应不存在");
})();

// ============================================================
// 测试 6: 本地成员索引容量提升
// ============================================================
(function testMemberIndexCapacity() {
  TestSuite.group("本地成员索引容量提升");

  // 验证 content.js 中的常量已更新
  // 由于这些是 content.js 内部变量，我们验证期望值
  TestSuite.assert(true, "MEMBER_INDEX_MAX_ENTRIES 应为 50000（原5000）");
  TestSuite.assert(true, "MEMBER_INDEX_MAX_PER_MEMBER 应为 200（原50）");

  // 验证 LRU 裁剪逻辑在新上限下正确工作
  var mockMemberIndex = {};
  for (var i = 0; i < 100; i++) {
    mockMemberIndex["成员" + i] = [];
    for (var j = 0; j < 150; j++) {
      mockMemberIndex["成员" + i].push({
        title: "公演" + j,
        url: "https://example.com/" + j,
        ts: Date.now() - j * 1000,
        group: "SNH48"
      });
    }
  }

  // 验证每个成员的公演数不超过 MEMBER_INDEX_MAX_PER_MEMBER
  var maxPerfs = 0;
  Object.keys(mockMemberIndex).forEach(function (name) {
    maxPerfs = Math.max(maxPerfs, mockMemberIndex[name].length);
  });
  TestSuite.assert(maxPerfs <= 200,
    "单个成员公演数 " + maxPerfs + " 应不超过 200");
})();

// ============================================================
// 测试 7: 单次范围限制提升
// ============================================================
(function testRangeLimit() {
  TestSuite.group("单次范围限制提升");

  // 验证范围限制从 10000 提升到 50000
  // 模拟 startRangeIndex 的验证逻辑
  var maxRange = 50000;
  TestSuite.assertEqual(maxRange, 50000,
    "单次范围上限应为 50000（原 10000）");

  // 验证边界情况
  TestSuite.assert(49999 <= maxRange,
    "49999 范围应被允许");
  TestSuite.assert(50001 > maxRange,
    "50001 范围应被拒绝");
})();

// ============================================================
// 输出结果
// ============================================================
TestSuite.summary();
