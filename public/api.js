/**
 * CreatorLens · API 请求封装（第四阶段稳定优化版）
 * 唯一数据源：后端 Worker，无任何本地模拟数据
 *
 * 【第四阶段稳定优化】
 * - response.json() 单次读取，缓存解析结果复用
 * - 指数退避智能重试（仅超时/502/503/429）
 * - 分层超时控制（基础15s / AI分析30s）
 * - 网络自检模块（页面初始化 ping Worker）
 * - 6类错误分类（CORS/DNS/额度/密钥/断网/超时）
 * - 请求幂等防护（相同链接10秒内读取缓存）
 * - AbortController 全生命周期管理
 * - 生产环境仅保留 error 级日志
 */
(function () {
  'use strict';

  /* 【第四阶段稳定优化】 生产环境标记 */
  const PROD = true;

  /* 【第四阶段稳定优化】 日志工具：生产环境仅输出 error */
  const Log = {
    info()  { if (!PROD) console.log.apply(console, arguments); },
    warn()  { if (!PROD) console.warn.apply(console, arguments); },
    error() { console.error.apply(console, arguments); }
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

  /* 【第四阶段稳定优化】 请求缓存（幂等防护） */
  const _cache = new Map();

  /* 【第四阶段稳定优化】 当前活跃的 AbortController（用于页面切换/重复点击时销毁） */
  let _activeController = null;

  /* 【第四阶段稳定优化】 获取/创建 AbortController */
  function _getController() {
    if (_activeController) {
      _activeController.abort();
    }
    _activeController = new AbortController();
    return _activeController;
  }

  /* 【第四阶段稳定优化】 销毁当前请求控制器 */
  function abortActive() {
    if (_activeController) {
      _activeController.abort();
      _activeController = null;
    }
  }

  /* 【第四阶段稳定优化】 延迟函数 */
  function _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /* 【第四阶段稳定优化】 判断是否可重试的错误 */
  function _isRetryable(status, errorName) {
    // 仅对超时、502/503/429 临时服务错误重试
    if (status === 502 || status === 503 || status === 429) return true;
    if (errorName === 'TIMEOUT' || errorName === 'AbortError') return true;
    return false;
  }

  /* 【第四阶段稳定优化】 6 类错误分类 */
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

  /* 【第四阶段稳定优化】 单次请求（不含重试逻辑） */
  async function _singleRequest(youtubeUrl, timeoutMs) {
    const controller = _getController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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

      // 【第四阶段稳定优化】 response body 仅读取一次，缓存结果
      const responseClone = response.clone();
      let parsed = null;
      let parseError = null;

      try {
        parsed = await response.json();
      } catch (e) {
        // JSON 解析失败，尝试从 clone 读取 text
        parseError = e;
        try {
          const text = await responseClone.text();
          parsed = { code: 500, msg: '返回格式异常: ' + text.substring(0, 200) };
        } catch (e2) {
          parsed = { code: 500, msg: '返回数据无法解析' };
        }
      }

      // HTTP 异常
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

      // 业务成功
      if (parsed && parsed.code === 200 && parsed.data) {
        Log.info('[CreatorLens API] 请求成功');
        return {
          success: true,
          data: {
            sourceData: parsed.data.sourceData || {},
            aiResult: parsed.data.aiResult || {}
          }
        };
      }

      // 业务错误（code 400/500）
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
   * @returns {Promise<Object>} - { success, data, error, message }
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

    // 【第四阶段稳定优化】 请求幂等防护：相同链接10秒内读取缓存
    const cacheKey = url;
    const cached = _cache.get(cacheKey);
    if (cached && (Date.now() - cached.ts < API_CONFIG.CACHE_TTL)) {
      Log.info('[CreatorLens API] 命中缓存，跳过重复请求');
      return cached.result;
    }

    // 【第四阶段稳定优化】 分层超时：AI分析用30秒，普通查询用15秒
    const timeoutMs = opts.isAI ? API_CONFIG.AI_TIMEOUT : API_CONFIG.TIMEOUT;

    Log.info('[CreatorLens API] 请求发起:', url);

    // 【第四阶段稳定优化】 指数退避重试
    let lastResult = null;
    for (let attempt = 0; attempt <= API_CONFIG.MAX_RETRY; attempt++) {
      if (attempt > 0) {
        const delayMs = API_CONFIG.RETRY_DELAYS[attempt - 1] || 3000;
        Log.info('[CreatorLens API] 第' + attempt + '次重试，延迟' + delayMs + 'ms');
        await _delay(delayMs);
      }

      lastResult = await _singleRequest(url, timeoutMs);

      if (lastResult.success) {
        // 缓存成功结果
        _cache.set(cacheKey, { ts: Date.now(), result: lastResult });
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

  /* 【第四阶段稳定优化】 网络自检模块：页面初始化 ping Worker */
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

  /* 【第四阶段稳定优化】 兼容原有 request 调用 */
  async function request(panelType, inputs) {
    const firstInput = inputs && inputs[0];
    const youtubeUrl = firstInput ? firstInput.value : '';
    return getChannelAnalysis(youtubeUrl, { isAI: true });
  }

  /* 【第四阶段稳定优化】 清除请求缓存 */
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
