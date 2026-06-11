// ========== SNH48 Live Enhancer - Service Worker 入口 ==========
// 本文件仅负责加载各模块并执行启动初始化
// 所有业务逻辑已拆分至：html-parser.js / index-store.js / index-crawler.js / message-handler.js

// 初始化共享命名空间
self.SNH48_BG = self.SNH48_BG || {};

// 按依赖顺序加载模块
importScripts("message-types.js");
importScripts("config.js");
importScripts("html-parser.js");
importScripts("index-store.js");
importScripts("index-crawler.js");
importScripts("message-handler.js");

// 默认配置（引用共享模块）
const DEFAULT_CONFIG = SNH48_DEFAULT_CONFIG;

// [P0-1.4.1] SW 启动时检查是否有中断的索引任务，自动恢复
SNH48_BG.restoreIndexingState();
