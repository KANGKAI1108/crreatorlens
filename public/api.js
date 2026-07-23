/**
 * CreatorLens · API 请求封装（第五阶段修复版）
 * 唯一数据源：后端 Worker，无任何本地模拟数据
 *
 * 【第五阶段修复】
 * - 修复 response.json() 单次读取，缓存解析结果复用
 * - 打印完整后端返回原始数据到控制台（生产环境可关闭）
 * - 增加数据合法性标记 _isDataValid
 * - 优化 AbortController 生命周期管理
 * - 指数退避智能重试（仅超时/502/503/429）
 * - 分层超时控制（基础15s / AI分析30s）
 * - 网络自检模块（页面初始化 ping Worker）
 * - 6类错误分类（CORS/DNS/额度/密钥/断网/超时）
 * - 请求幂等防护（相同链接10秒内读取缓存）
 */
(function () {
  'use strict';

  /* 【第五阶段修复】 生产环境标记：设为 false 可开启调试日志 */
  const PROD = false;

  /* 【第五阶段修复】 日志工具：生产环境仅输出 error */
  const Log = {
    info()  { if (!PROD) console.log.apply(console, arguments); },
    warn()  { if (!PROD) console.warn.apply(console, arguments); },
    error() { console.error.apply(console, arguments); },
    debug() { if (!PROD) console.debug.apply(console, arguments); }
  };

  const API_CONFIG = {
    BASE_URL: 'https://webcreatorlens.kang61398.workers.dev',
    TIMEOUT: 15000,        // 基础超时 15 秒
    AI_TIMEOUT: 30000,     // AI 分析扩展超时 30 秒
    MAX_RETRY: 2,          // 最大重试次数
    RETRY_DELAYS: [1000, 3000], // 指数退避间隔 1s、3s
    CACHE_TTL: 10000,      // 请求幂等缓存 10 秒
    HEARTBEAT_TIMEOUT: 8000  // 心跳检测 8 秒无响应判定预加载失败
  };

  /* 请求缓存（幂等防护） */
  const _cache = new Map();

  /* 当前活跃的 AbortController（用于页面切换/重复点击时销毁） */
  let _activeController = null;

  /* 【第五阶段修复】 获取/创建 AbortController，确保旧请求被销毁 */
  function _getController() {
    if (_activeController) {
      try { _activeController.abort(); } catch (e) {}
    }
    _activeController = new AbortController();
    return _activeController;
  }

  /* 销毁当前请求控制器 */
  function abortActive() {
    if (_activeController) {
      try { _activeController.abort(); } catch (e) {}
      _activeController = null;
    }
  }

  /* 延迟函数 */
  function _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /* 判断是否可重试的错误 */
  function _isRetryable(status, errorName) {
    // 仅对超时、502/503/429 临时服务错误重试
    if (status === 502 || status === 503 || status === 429) return true;
    if (errorName === 'TIMEOUT' || errorName === 'AbortError') return true;
    return false;
  }

  /* 6 类错误分类 */
  function _classifyError(error) {
    const msg = (error && error.message) || '';
    const name = (error && error.name) || '';

    if (name === 'AbortError') {
      return { type: 'TIMEOUT', message: '请求超时，请重新尝试。' };
    }
    if (msg.includes('Failed to fetch')) {
      // 浏览器无法发起请求：可能是 CORS、DNS、网络断开
      if (navigator && !navigator.onLine) {
        return { type: 'OFFLINE', message: '网络已断开，请检查网络连接后重试。' };
      }
      return { type: 'CORS_OR_DNS', message: '网络请求失败：可能是跨域(CORS)被拦截或DNS解析失败，请稍后重试。' };
    }
    if (msg.includes('NetworkError')) {
      return { type: 'CORS', message: '跨域错误：浏览器拦截了请求，请检查后端CORS配置。' };
    }
    if (msg.includes('CORS')) {
      return { type: 'CORS', message: '跨域错误：' + msg };
    }
    return { type: 'NETWORK', message: '网络异常：' + (msg || '未知错误') };
  }

  /* 【第五阶段修复】 数据合法性校验函数 */
  function _validateResponseData(data) {
    // 检查 data 是否存在
    if (!data || typeof data !== 'object') {
      return { valid: false, reason: 'NO_DATA', message: '后端返回数据为空。' };
    }

    const sourceData = data?.sourceData || {};
    const aiResult = data?.aiResult || {};

    // 检测是否为 fallback 模式（Gemini 调用失败）
    if (aiResult?.isFallback === true) {
      return { valid: false, reason: 'GEMINI_FALLBACK', message: 'Gemini调用失败，无有效分析结果。' };
    }

    // 检测是否为模拟数据
    if (sourceData?.isMock === true) {
      return { valid: false, reason: 'MOCK_DATA', message: '检测到模拟数据，已拒绝展示。' };
    }

    // 【第五阶段修复】 深度校验：检查 AI 分析文本是否有实质内容
    const hasAiContent = 
      (typeof aiResult?.score === 'number' && aiResult.score > 0) ||
      (typeof aiResult?.summary === 'string' && aiResult.summary.trim().length > 0) ||
      (typeof aiResult?.fullText === 'string' && aiResult.fullText.trim().length > 0);

    // 检查频道基础数据是否有内容
    const hasSourceData = 
      (sourceData?.channelName && sourceData.channelName !== '—') ||
      (sourceData?.subscriberCount && sourceData.subscriberCount !== '—') ||
      (sourceData?.viewCount && sourceData.viewCount !== '—');

    // 如果既没有 AI 内容也没有频道数据，判定为无效
    if (!hasAiContent && !hasSourceData) {
      return { valid: false, reason: 'EMPTY_CONTENT', message: '分析结果为空，请稍后重试。' };
    }

    return { valid: true, reason: 'OK', message: '' };
  }

  /* 【第五阶段修复】 单次请求（不含重试逻辑） */
  async function _singleRequest(youtubeUrl, timeoutMs) {
    const controller = _getController();
    const timeoutId = setTimeout(() => {
      try { controller.abort(); } catch (e) {}
    }, timeoutMs);

    // 心跳检测：8秒无响应判定预加载失败
    const heartbeatId = setTimeout(() => {
      Log.warn('[CreatorLens API] 心跳检测：8秒无响应');
    }, API_CONFIG.HEARTBEAT_TIMEOUT);

    try {
      const response = await fetch(API_CONFIG.BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtubeUrl: youtubeUrl }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      clearTimeout(heartbeatId);

      Log.info('[CreatorLens API] HTTP状态:', response.status, response.statusText);

      // 【第五阶段修复】 response body 仅读取一次，使用 clone 备份
      let parsed = null;
      let rawText = '';

      try {
        // 先读取原始文本，用于调试
        rawText = await response.text();
        parsed = JSON.parse(rawText);
        
        // 【第五阶段修复】 打印完整后端返回原始数据到控制台
        Log.debug('[CreatorLens API] 后端返回原始数据:', parsed);
        Log.debug('[CreatorLens API] 后端返回原始JSON:', rawText.substring(0, 2000));
      } catch (e) {
        Log.error('[CreatorLens API] JSON 解析失败:', e.message);
        return {
          success: false,
          error: 'PARSE_ERROR',
          message: '返回格式异常：' + (rawText || '').substring(0, 100),
          _retryable: false
        };
      }

      // HTTP 异常（非 200）
      if (!response.ok) {
        const errMsg = (parsed && parsed.msg) ? parsed.msg : ('服务器错误（HTTP ' + response.status + '）');
        Log.error('[CreatorLens API] HTTP ' + response.status + ':', parsed);
        return {
          success: false,
          error: 'HTTP_' + response.status,
          status: response.status,
          message: errMsg,
          _retryable: _isRetryable(response.status, null)
        };
      }

      // 【第五阶段修复】 业务成功时，先校验数据有效性
      if (parsed && parsed.code === 200 && parsed.data) {
        const validation = _validateResponseData(parsed.data);
        
        if (!validation.valid) {
          // 数据无效：返回成功但标记数据问题
          return {
            success: true,
            data: parsed.data,
            _isDataValid: false,
            _invalidReason: validation.reason,
            _invalidMessage: validation.message
          };
        }

        Log.info('[CreatorLens API] 请求成功，数据有效');
        return {
          success: true,
          data: {
            sourceData: parsed.data.sourceData || {},
            aiResult: parsed.data.aiResult || {}
          },
          _isDataValid: true
        };
      }

      // 业务错误（code 非 200）
      // 429 额度耗尽 / 403 密钥异常 特殊处理
      if (parsed && parsed.code === 429) {
        return {
          success: false,
          error: 'QUOTA_EXCEEDED',
          message: parsed.msg || 'AI分析额度已耗尽，请明日再试或升级付费版。',
          _retryable: false
        };
      }
      if (parsed && parsed.code === 403) {
        return {
          success: false,
          error: 'KEY_ERROR',
          message: parsed.msg || '后端API密钥异常，请联系管理员。',
          _retryable: false
        };
      }

      Log.error('[CreatorLens API] 业务错误 code:', parsed && parsed.code, 'msg:', parsed && parsed.msg);
      return {
        success: false,
        error: 'API_ERROR',
        message: (parsed && parsed.msg) || '分析失败，请稍后重试。',
        _retryable: false
      };

    } catch (error) {
      clearTimeout(timeoutId);
      clearTimeout(heartbeatId);

      // 如果是 abort 导致的，不要记录为错误
      if (error && error.name === 'AbortError') {
        Log.info('[CreatorLens API] 请求被取消（Abort）');
        return {
          success: false,
          error: 'ABORTED',
          message: '请求已取消。',
          _retryable: false
        };
      }

      const classified = _classifyError(error);
      Log.error('[CreatorLens API] ' + classified.type + ':', error);

      return {
        success: false,
        error: classified.type,
        message: classified.message,
        _retryable: _isRetryable(0, error.name)
      };
    }
  }

  /**
   * 频道分析接口封装
   * @param {string} youtubeUrl - YouTube 频道/视频完整链接
   * @param {Object} opts - { isAI: boolean } 是否为AI分析请求（使用30秒长超时）
   * @returns {Promise<Object>} - { success, data, error, message, _isDataValid }
   */
  async function getChannelAnalysis(youtubeUrl, opts) {
    opts = opts || {};

    if (!youtubeUrl || typeof youtubeUrl !== 'string') {
      return { success: false, error: 'INVALID_PARAM', message: '请输入有效的 YouTube 链接。' };
    }

    const url = youtubeUrl.trim();
    if (!url) {
      return { success: false, error: 'EMPTY_URL', message: '链接不能为空。' };
    }

    // 请求幂等防护：相同链接10秒内读取缓存
    const cacheKey = url;
    const cached = _cache.get(cacheKey);
    if (cached && (Date.now() - cached.ts < API_CONFIG.CACHE_TTL)) {
      Log.info('[CreatorLens API] 命中缓存，跳过重复请求');
      return cached.result;
    }

    // 分层超时：AI分析用30秒，普通查询用15秒
    const timeoutMs = opts.isAI ? API_CONFIG.AI_TIMEOUT : API_CONFIG.TIMEOUT;

    Log.info('[CreatorLens API] 请求发起:', url);

    // 指数退避重试
    let lastResult = null;
    for (let attempt = 0; attempt <= API_CONFIG.MAX_RETRY; attempt++) {
      if (attempt > 0) {
        const delayMs = API_CONFIG.RETRY_DELAYS[attempt - 1] || 3000;
        Log.info('[CreatorLens API] 第' + attempt + '次重试，延迟' + delayMs + 'ms');
        await _delay(delayMs);
      }

      lastResult = await _singleRequest(url, timeoutMs);

      // 成功且有有效数据，缓存并返回
      if (lastResult.success && lastResult._isDataValid) {
        _cache.set(cacheKey, { ts: Date.now(), result: lastResult });
        return lastResult;
      }

      // 【第五阶段修复】 成功但数据无效，不重试，直接返回
      if (lastResult.success && !lastResult._isDataValid) {
        Log.warn('[CreatorLens API] 数据无效:', lastResult._invalidReason, lastResult._invalidMessage);
        return lastResult;
      }

      // 不可重试的错误直接返回
      if (!lastResult._retryable) {
        return lastResult;
      }

      // 最后一次重试仍然失败
      if (attempt === API_CONFIG.MAX_RETRY) {
        Log.error('[CreatorLens API] 重试' + API_CONFIG.MAX_RETRY + '次后仍失败');
        return lastResult;
      }
    }

    return lastResult || { success: false, error: 'UNKNOWN', message: '未知错误' };
  }

  /* 网络自检模块：页面初始化 ping Worker */
  async function healthCheck() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(API_CONFIG.BASE_URL, {
        method: 'OPTIONS',
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      return { reachable: true, status: response.status };
    } catch (e) {
      Log.warn('[CreatorLens API] 健康检查失败:', e.message);
      return { reachable: false, error: e.message };
    }
  }

  /* 兼容原有 request 调用 */
  async function request(panelType, inputs) {
    const firstInput = inputs && inputs[0];
    const youtubeUrl = firstInput ? firstInput.value : '';
    return getChannelAnalysis(youtubeUrl, { isAI: true });
  }

  /* 清除请求缓存 */
  function clearCache() {
    _cache.clear();
  }

  window.CreatorLensAPI = {
    getChannelAnalysis,
    request,
    healthCheck,
    abortActive,
    clearCache,
    API_CONFIG
  };

})();