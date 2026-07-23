/**
 * CreatorLens · API 请求封装（v3 纯本地版）
 * 唯一数据源：Cloudflare Worker YouTube 爬取
 *
 * 【v3 核心变更】
 * - 不再依赖任何 AI 大模型 API
 * - 收到 Worker 原始数据后，由前端 localAnalysis.js 完成全部分析
 * - 简化错误分类（仅区分网络错误和爬取失败）
 */
(function () {
  'use strict';

  const PROD = false;
  const Log = {
    info()  { if (!PROD) console.log.apply(console, arguments); },
    warn()  { if (!PROD) console.warn.apply(console, arguments); },
    error() { console.error.apply(console, arguments); },
  };

  const API_CONFIG = {
    BASE_URL: 'https://webcreatorlens.kang61398.workers.dev',
    TIMEOUT: 15000,
    CACHE_TTL: 10000,
  };

  const _cache = new Map();
  let _activeController = null;

  function _getController() {
    if (_activeController) {
      try { _activeController.abort(); } catch (e) {}
    }
    _activeController = new AbortController();
    return _activeController;
  }

  function abortActive() {
    if (_activeController) {
      try { _activeController.abort(); } catch (e) {}
      _activeController = null;
    }
  }

  function _classifyError(error) {
    const msg = (error && error.message) || '';
    const name = (error && error.name) || '';
    if (name === 'AbortError') {
      return { type: 'TIMEOUT', message: '请求超时，请重新尝试。' };
    }
    if (msg.includes('Failed to fetch')) {
      if (navigator && !navigator.onLine) {
        return { type: 'OFFLINE', message: '网络已断开，请检查网络连接后重试。' };
      }
      return { type: 'NETWORK', message: '网络请求失败，请检查网络后重试。' };
    }
    return { type: 'NETWORK', message: '网络异常：' + (msg || '未知错误') };
  }

  /**
   * YouTube 原始数据获取（v3 纯本地版）
   * @param {string} youtubeUrl
   * @returns {Promise<Object>} - { success, sourceData, error, message }
   */
  async function getChannelAnalysis(youtubeUrl) {
    if (!youtubeUrl || typeof youtubeUrl !== 'string') {
      return { success: false, error: 'INVALID_PARAM', message: '请输入有效的 YouTube 链接。' };
    }

    const url = youtubeUrl.trim();
    if (!url) {
      return { success: false, error: 'EMPTY_URL', message: '链接不能为空。' };
    }

    // 请求幂等
    const cached = _cache.get(url);
    if (cached && (Date.now() - cached.ts < API_CONFIG.CACHE_TTL)) {
      Log.info('[CreatorLens API] 命中缓存');
      return cached.result;
    }

    const controller = _getController();
    const timeoutId = setTimeout(() => {
      try { controller.abort(); } catch (e) {}
    }, API_CONFIG.TIMEOUT);

    try {
      Log.info('[CreatorLens API] 请求 YouTube 爬取:', url);

      const response = await fetch(API_CONFIG.BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtubeUrl: url }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      Log.info('[CreatorLens API] HTTP状态:', response.status);

      let parsed = null;
      let rawText = '';
      try {
        rawText = await response.text();
        parsed = JSON.parse(rawText);
        Log.debug('[CreatorLens API] 后端原始数据:', parsed);
      } catch (e) {
        Log.error('[CreatorLens API] JSON 解析失败:', e);
        return {
          success: false,
          error: 'PARSE_ERROR',
          message: '返回格式异常：' + (rawText || '').substring(0, 100),
        };
      }

      if (!response.ok) {
        return {
          success: false,
          error: 'HTTP_' + response.status,
          message: (parsed && parsed.msg) || ('服务器错误（HTTP ' + response.status + '）'),
        };
      }

      if (parsed && parsed.code === 200 && parsed.sourceData) {
        Log.info('[CreatorLens API] 成功获取 YouTube 原始数据');
        const result = {
          success: true,
          sourceData: parsed.sourceData,
        };
        _cache.set(url, { ts: Date.now(), result });
        return result;
      }

      if (parsed && parsed.code === 400) {
        return { success: false, error: 'BAD_REQUEST', message: parsed.msg || '请求参数错误' };
      }

      if (parsed && parsed.code === 502) {
        return { success: false, error: 'FETCH_FAILED', message: parsed.msg || 'YouTube 爬取失败' };
      }

      return {
        success: false,
        error: 'API_ERROR',
        message: (parsed && parsed.msg) || '未知错误',
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error && error.name === 'AbortError') {
        return { success: false, error: 'ABORTED', message: '请求已取消。' };
      }
      const classified = _classifyError(error);
      Log.error('[CreatorLens API]', classified.type, error);
      return { success: false, error: classified.type, message: classified.message };
    }
  }

  async function healthCheck() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(API_CONFIG.BASE_URL + '/health', { signal: controller.signal });
      clearTimeout(timeoutId);
      return { reachable: response.ok, status: response.status };
    } catch (e) {
      return { reachable: false, error: e.message };
    }
  }

  async function request(panelType, inputs) {
    const firstInput = inputs && inputs[0];
    const youtubeUrl = firstInput ? firstInput.value : '';
    return getChannelAnalysis(youtubeUrl);
  }

  function clearCache() {
    _cache.clear();
  }

  window.CreatorLensAPI = {
    getChannelAnalysis,
    request,
    healthCheck,
    abortActive,
    clearCache,
    API_CONFIG,
  };

})();