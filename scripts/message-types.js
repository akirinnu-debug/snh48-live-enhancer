/**
 * SNH48 Live Enhancer - 消息协议注册表
 *
 * 本文件定义了扩展内所有组件间通信的消息类型常量。
 * 每个消息类型包含以下信息：
 *   - 常量名与值
 *   - 发送方 → 接收方
 *   - 请求格式 (Request)
 *   - 响应格式 (Response)
 *   - 说明
 *
 * 通信模式：
 *   - 请求-响应：content/popup 发送消息，background 处理并通过 sendResponse 回调返回
 *   - 广播通知：background 向所有 content tabs 广播状态变更
 *   - 单向通知：popup 向活跃 content tab 发送配置变更
 */

var SNH48_MSG = {

  // ===== 索引操作 =====

  /**
   * 索引当前页面
   * @sender content (member-index.js)
   * @receiver background
   * @request { type: INDEX_CURRENT_PAGE, url: string }
   * @response { success: boolean, data?: object, error?: string }
   * @description Content script 请求 background 解析并索引当前公演页面
   */
  INDEX_CURRENT_PAGE: "INDEX_CURRENT_PAGE",

  /**
   * 范围索引
   * @sender content / popup
   * @receiver background
   * @request { type: START_RANGE_INDEX, startId: number, endId: number, mode?: "full"|"incremental" }
   * @response { success: boolean, error?: string }
   * @description 请求 background 对指定 ID 范围内的公演页面执行批量索引，mode 可选 "full"（全量）或 "incremental"（增量）
   */
  START_RANGE_INDEX: "START_RANGE_INDEX",

  /**
   * 停止范围索引
   * @sender content / popup
   * @receiver background
   * @request { type: STOP_RANGE_INDEX }
   * @response { success: boolean }
   * @description 请求 background 中止正在进行的范围索引任务
   */
  STOP_RANGE_INDEX: "STOP_RANGE_INDEX",

  /**
   * 清除全部索引
   * @sender content / popup
   * @receiver background
   * @request { type: CLEAR_FULL_INDEX }
   * @response { success: boolean }
   * @description 请求 background 清除 IndexedDB 中的全部索引数据
   */
  CLEAR_FULL_INDEX: "CLEAR_FULL_INDEX",

  // ===== 搜索操作 =====

  /**
   * 搜索索引
   * @sender content
   * @receiver background
   * @request { type: SEARCH_INDEX, query: string }
   * @response Array<{ type: string, typeIcon: string, title: string, url: string, meta: object, isMemberPerf: boolean }>
   * @description Content script 请求 background 在索引中搜索匹配 query 的公演/成员记录
   */
  SEARCH_INDEX: "SEARCH_INDEX",

  // ===== 索引状态 =====

  /**
   * 获取索引统计
   * @sender content / popup
   * @receiver background
   * @request { type: GET_INDEX_STATS }
   * @response { performanceCount: number, memberCount: number, totalPerformanceCount: number, archivedCount: number, lastUpdated: string, schemaVersion: number, indexingState: object }
   * @description 获取当前索引的统计信息，包括公演数、成员数、归档数、最后更新时间等
   */
  GET_INDEX_STATS: "GET_INDEX_STATS",

  /**
   * 获取索引状态
   * @sender content / popup
   * @receiver background
   * @request { type: GET_INDEXING_STATE }
   * @response indexingState object
   * @description 获取当前索引任务的运行状态对象，包含进度、阶段等信息
   */
  GET_INDEXING_STATE: "GET_INDEXING_STATE",

  /**
   * 获取 Schema 版本状态
   * @sender content / popup
   * @receiver background
   * @request { type: GET_SCHEMA_STATUS }
   * @response { currentVersion: number, storedVersion: number, outdated: boolean }
   * @description 检查索引 Schema 版本是否与当前代码版本一致，outdated 为 true 时需要重建索引
   */
  GET_SCHEMA_STATUS: "GET_SCHEMA_STATUS",

  /**
   * 获取全部公演索引（用于日历视图）
   * @sender content
   * @receiver background
   * @request { type: GET_ALL_PERFORMANCES }
   * @response Array<{ url: string, title: string, date: string, performers: string[], team: string, indexedAt: number }>
   * @description 返回索引中所有公演的完整数据，包括公演日期字段，供日历视图按月分组显示
   */
  GET_ALL_PERFORMANCES: "GET_ALL_PERFORMANCES",

  /**
   * 获取统一状态快照
   * @sender content / popup
   * @receiver background
   * @request { type: GET_STATE, keys?: string[] }
   * @response { config?, indexingState?, indexStats?, schemaStatus? }
   * @description 获取扩展的统一状态快照，keys 指定需要的字段
   */
  GET_STATE: "GET_STATE",

  // ===== 配置管理 =====

  /**
   * 配置已更新
   * @sender popup
   * @receiver content
   * @request { type: CONFIG_UPDATED, config: object }
   * @response { success: boolean }
   * @description Popup 将用户修改后的配置对象推送至活跃的 content tab，使其即时生效
   */
  CONFIG_UPDATED: "CONFIG_UPDATED",

  /**
   * 获取当前配置
   * @sender content / popup
   * @receiver background
   * @request { type: GET_CONFIG }
   * @response config object
   * @description 请求 background 返回当前完整的扩展配置对象
   */
  GET_CONFIG: "GET_CONFIG",

  // ===== 广播通知 =====

  /**
   * 索引进度通知
   * @sender background
   * @receiver content (all tabs)
   * @request { type: INDEXING_PROGRESS, payload: indexingState }
   * @response 无（广播通知）
   * @description Background 在范围索引进行中向所有 content tabs 广播当前进度状态
   */
  INDEXING_PROGRESS: "INDEXING_PROGRESS",

  /**
   * 索引完成通知
   * @sender background
   * @receiver content (all tabs)
   * @request { type: INDEXING_COMPLETE, payload: indexingState }
   * @response 无（广播通知）
   * @description Background 在范围索引任务完成后向所有 content tabs 广播最终状态
   */
  INDEXING_COMPLETE: "INDEXING_COMPLETE",

  /**
   * 显示索引状态
   * @sender background
   * @receiver content (all tabs)
   * @request { type: SHOW_INDEXING_STATUS, payload: object }
   * @response 无（广播通知）
   * @description Background 请求 content tabs 显示索引状态 UI 提示（如 toast 通知）
   */
  SHOW_INDEXING_STATUS: "SHOW_INDEXING_STATUS"
};

/**
 * 验证消息对象是否包含必需字段
 * @param {object} msg - 消息对象
 * @param {string[]} requiredFields - 必需字段名数组
 * @returns {boolean} 是否验证通过
 */
var SNH48_MSG_VALIDATE = function (msg, requiredFields) {
  if (!msg || !msg.type) return false;
  for (var i = 0; i < requiredFields.length; i++) {
    if (!(requiredFields[i] in msg)) {
      console.warn("[SNH48-Enhancer] 消息验证失败: 缺少字段 '" + requiredFields[i] + "'", msg);
      return false;
    }
  }
  return true;
};
