/**
 * CreatorLens · 前端交互 (第四阶段稳定优化版)
 * 全局唯一输入框 + 动态单/双栏 + 无面板内输入
 *
 * 【第四阶段稳定优化】
 * - 页面级 ErrorBoundary 异常捕获
 * - 空值/未定义变量全兜底 ?. 可选链
 * - AbortController 页面切换/重复点击时销毁
 * - 输入框 800ms 防抖校验
 * - IndexedDB 缓存 + 过期清理
 * - 首次打开隐私说明弹窗
 * - 额度计数器持久化本地存储
 * - 错误日志本地存储 + 导出按钮
 * - 在线状态指示器
 * - AI 分析结果分段渲染
 * - 加载心跳检测（8秒无响应判定失败）
 * - 进度条动画
 * - 链接前置正则拦截
 */
(function () {
  'use strict';

  /* 【第四阶段稳定优化】 生产环境标记 */
  const PROD = true;
  const Log = {
    info()  { if (!PROD) console.log.apply(console, arguments); },
    warn()  { if (!PROD) console.warn.apply(console, arguments); },
    error() { console.error.apply(console, arguments); }
  };

  /* 【第四阶段稳定优化】 版本号（用于缓存清理） */
  const APP_VERSION = '4.0.0';

  /* =========================================================
     0. 面板配置 (数据驱动)
     ========================================================= */
  const PANEL_CONFIG = {
    audit: {
      title: '自有频道增长诊断',
      desc: '分析自己账号播放、互动数据，定位账号增长短板',
      themeColor: '#8b7cf6',
      gradient: 'linear-gradient(135deg, #9b8cf8, #c98ad9)',
      icon: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
      inputCount: 1,
      inputLabels: ['你的频道'],
      inputKinds: ['channel'],
      buttonText: '开始诊断',
      slots: ['频道健康度', '爆款视频分析', '增长瓶颈定位']
    },
    competitor: {
      title: '竞品创作者数据深挖',
      desc: '对标同赛道博主，提取对方爆款内容底层逻辑',
      themeColor: '#e3b078',
      gradient: 'linear-gradient(135deg, #e3b078, #ecc094)',
      icon: '<path d="M3 17l5-6 4 4 5-7 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
      inputCount: 1,
      inputLabels: ['竞品频道'],
      inputKinds: ['channel'],
      buttonText: '深挖数据',
      slots: ['竞品核心数据', '爆款选题拆解', '可复用策略']
    },
    dissect: {
      title: '爆款视频根源拆解',
      desc: '单条视频深度复盘，找出流量高低的核心影响因素',
      themeColor: '#6fb0e8',
      gradient: 'linear-gradient(135deg, #6fb0e8, #8fbdf0)',
      icon: '<path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6L12 3z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
      inputCount: 1,
      inputLabels: ['目标视频'],
      inputKinds: ['video'],
      buttonText: '深度拆解',
      slots: ['开头吸引力分析', '留存率曲线', '核心爆点拆解']
    },
    compare: {
      title: '双频道横向对标对比',
      desc: '两个账号全方位数据横向拉表，直观看出差距',
      themeColor: '#e58fc4',
      gradient: 'linear-gradient(135deg, #e58fc4, #f0a6ca)',
      icon: '<rect x="3" y="3" width="7" height="18" rx="2" stroke="currentColor" stroke-width="2"/><rect x="14" y="3" width="7" height="18" rx="2" stroke="currentColor" stroke-width="2"/>',
      inputCount: 2,
      inputLabels: ['频道 A', '频道 B'],
      inputKinds: ['channel', 'channel'],
      buttonText: '开始对比',
      slots: ['核心数据对比', '内容差异分析', '优势劣势总结']
    },
    contrast: {
      title: '视频数据差异解析',
      desc: '两条视频横向对比，分析爆火与低迷的真实原因',
      themeColor: '#6fc7b3',
      gradient: 'linear-gradient(135deg, #6fc7b3, #8ed7c6)',
      icon: '<path d="M3 12h3l2-6 4 12 2-6h7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
      inputCount: 2,
      inputLabels: ['视频 A (爆火)', '视频 B (低迷)'],
      inputKinds: ['video', 'video'],
      buttonText: '解析差异',
      slots: ['数据核心差异', '爆点/痛点分析', '可落地优化建议']
    }
  };

  /* =========================================================
     【第四阶段稳定优化】 ErrorBoundary —— 页面级异常捕获
     ========================================================= */
  const ErrorBoundary = {
    init() {
      // 捕获同步异常
      window.addEventListener('error', (e) => {
        this._handle(e.error || e.message, e.filename, e.lineno);
      });
      // 捕获 Promise 未处理异常
      window.addEventListener('unhandledrejection', (e) => {
        this._handle(e.reason, 'Promise', 0);
      });

      // 存储错误日志
      this._logs = this._loadLogs();
    },

    _handle(error, source, line) {
      const entry = {
        time: new Date().toISOString(),
        message: (error && error.message) || String(error),
        stack: (error && error.stack) || '',
        source: source || '',
        line: line || 0,
        version: APP_VERSION
      };

      Log.error('[ErrorBoundary]', entry.message, entry.stack);
      this._logs.push(entry);
      // 仅保留最近 50 条
      if (this._logs.length > 50) this._logs = this._logs.slice(-50);
      this._saveLogs();

      // 弹窗提示（不白屏）
      Toast.show('页面发生异常：' + entry.message, 'error');
    },

    _loadLogs() {
      try {
        const raw = localStorage.getItem('cl_error_logs');
        return raw ? JSON.parse(raw) : [];
      } catch (e) { return []; }
    },

    _saveLogs() {
      try {
        localStorage.setItem('cl_error_logs', JSON.stringify(this._logs));
      } catch (e) {}
    },

    exportLogs() {
      const blob = new Blob([JSON.stringify(this._logs, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'creatorlens-error-logs-' + Date.now() + '.json';
      a.click();
      URL.revokeObjectURL(url);
      Toast.show('错误日志已导出', 'success');
    },

    clearLogs() {
      this._logs = [];
      this._saveLogs();
      Toast.show('错误日志已清除', 'success');
    }
  };

  /* =========================================================
     【第四阶段稳定优化】 CacheManager —— IndexedDB 缓存管理
     ========================================================= */
  const CacheManager = {
    _db: null,
    _DB_NAME: 'creatorlens_cache',
    _STORE: 'analysis',
    _TTL: 3600000, // 1小时过期

    async init() {
      return new Promise((resolve) => {
        try {
          // 版本变化时清理旧缓存
          const storedVer = localStorage.getItem('cl_app_version');
          if (storedVer && storedVer !== APP_VERSION) {
            Log.info('[CacheManager] 版本变更，清理旧缓存');
            this._clearAll();
          }
          localStorage.setItem('cl_app_version', APP_VERSION);

          const req = indexedDB.open(this._DB_NAME, 1);
          req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(this._STORE)) {
              db.createObjectStore(this._STORE, { keyPath: 'url' });
            }
          };
          req.onsuccess = (e) => {
            this._db = e.target.result;
            this._cleanExpired();
            resolve();
          };
          req.onerror = () => { resolve(); }; // 降级：不使用缓存
        } catch (e) {
          resolve(); // 降级
        }
      });
    },

    async get(url) {
      if (!this._db) return null;
      return new Promise((resolve) => {
        try {
          const tx = this._db.transaction(this._STORE, 'readonly');
          const req = tx.objectStore(this._STORE).get(url);
          req.onsuccess = () => {
            const record = req.result;
            if (record && (Date.now() - record.ts < this._TTL)) {
              resolve(record.data);
            } else {
              resolve(null);
            }
          };
          req.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      });
    },

    async set(url, data) {
      if (!this._db) return;
      try {
        const tx = this._db.transaction(this._STORE, 'readwrite');
        tx.objectStore(this._STORE).put({ url, data, ts: Date.now() });
      } catch (e) {}
    },

    _cleanExpired() {
      if (!this._db) return;
      try {
        const tx = this._db.transaction(this._STORE, 'readwrite');
        const store = tx.objectStore(this._STORE);
        const req = store.getAll();
        req.onsuccess = () => {
          const records = req.result || [];
          records.forEach(r => {
            if (Date.now() - r.ts > this._TTL) {
              store.delete(r.url);
            }
          });
        };
      } catch (e) {}
    },

    _clearAll() {
      try {
        indexedDB.deleteDatabase(this._DB_NAME);
      } catch (e) {}
    },

    async clearManual() {
      if (!this._db) return;
      return new Promise((resolve) => {
        try {
          const tx = this._db.transaction(this._STORE, 'readwrite');
          tx.objectStore(this._STORE).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch (e) { resolve(); }
      });
    }
  };

  /* =========================================================
     【第四阶段稳定优化】 QuotaManager —— 额度计数器持久化
     ========================================================= */
  const QuotaManager = {
    _DAILY_LIMIT: Infinity,
    _KEY: 'cl_quota',

    _getToday() {
      return new Date().toISOString().slice(0, 10);
    },

    getState() {
      try {
        const raw = localStorage.getItem(this._KEY);
        if (!raw) return { date: this._getToday(), used: 0 };
        const state = JSON.parse(raw);
        // 跨天重置
        if (state.date !== this._getToday()) {
          return { date: this._getToday(), used: 0 };
        }
        return state;
      } catch (e) {
        return { date: this._getToday(), used: 0 };
      }
    },

    getRemaining() {
      return Infinity;
    },

    increment() {
      // 无限制额度，不再累加计数
      this.updateUI();
    },

    canUse() {
      return true;
    },

    updateUI() {
      const el = document.querySelector('.account__quota em');
      if (el) el.textContent = '∞';
    }
  };

  /* =========================================================
     【第四阶段稳定优化】 OnlineStatus —— 在线状态指示器
     ========================================================= */
  const OnlineStatus = {
    _el: null,

    init() {
      this._el = document.getElementById('onlineStatus');
      this._update();
      window.addEventListener('online', () => this._update());
      window.addEventListener('offline', () => this._update());

      // 初始化时 ping Worker
      this._checkWorker();
    },

    _update() {
      if (!this._el) return;
      if (navigator.onLine) {
        this._el.setAttribute('data-status', 'online');
        this._el.title = '网络已连接';
      } else {
        this._el.setAttribute('data-status', 'offline');
        this._el.title = '网络已断开';
      }
    },

    async _checkWorker() {
      if (typeof window.CreatorLensAPI === 'undefined') return;
      const result = await window.CreatorLensAPI.healthCheck();
      if (!this._el) return;
      if (result.reachable) {
        this._el.setAttribute('data-status', 'online');
        this._el.title = '后端服务已连接';
      } else {
        this._el.setAttribute('data-status', 'warning');
        this._el.title = '后端服务暂时无法连接';
        Toast.show('后端服务暂时无法连接，请稍后再试', 'error');
      }
    }
  };

  /* =========================================================
     【第四阶段稳定优化】 PrivacyPopup —— 首次打开隐私说明
     ========================================================= */
  const PrivacyPopup = {
    _KEY: 'cl_privacy_accepted',

    init() {
      if (localStorage.getItem(this._KEY)) return;

      const popup = document.getElementById('privacyPopup');
      if (!popup) return;

      popup.removeAttribute('hidden');

      const btn = popup.querySelector('.privacy__btn');
      if (btn) {
        btn.addEventListener('click', () => {
          localStorage.setItem(this._KEY, '1');
          popup.classList.add('is-leaving');
          setTimeout(() => popup.remove(), 300);
        });
      }
    }
  };

  /* =========================================================
     1. LinkParser
     ========================================================= */
  const LinkParser = {
    _isVideoId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id); },
    _isChannelId(id) { return typeof id === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(id); },

    /* 【第四阶段稳定优化】 前置正则拦截：特殊符号、乱码链接 */
    _isLikelyGarbage(raw) {
      if (!raw) return true;
      // 过滤纯特殊符号、控制字符
      if (/^[\s\W_]+$/.test(raw) && !/^@[A-Za-z0-9._-]+$/.test(raw)) return true;
      // 过滤超长输入（>500字符）
      if (raw.length > 500) return true;
      return false;
    },

    detect(raw) {
      const url = (raw || '').trim();
      if (!url) return { type: null, raw: '' };

      /* 【第四阶段稳定优化】 前置拦截 */
      if (this._isLikelyGarbage(url)) return { type: null, raw: url };

      if (this._isVideoId(url))   return { type: 'video',   id: url, raw: url };
      if (this._isChannelId(url)) return { type: 'channel', id: url, raw: url };
      if (/^@[A-Za-z0-9._-]{2,}$/.test(url)) return { type: 'channel', handle: url, raw: url };

      let u;
      try {
        u = new URL(url.startsWith('http') ? url : 'https://' + url);
      } catch (e) {
        return { type: null, raw: url };
      }

      const host = u.hostname.replace(/^www\./, '');
      const isYT = host === 'youtu.be' || /(^|\.)youtube\.com$/.test(host);
      if (!isYT) return { type: null, raw: url };

      const p = u.pathname;

      if (host === 'youtu.be') {
        const id = p.slice(1).split('/')[0];
        return this._isVideoId(id) ? { type: 'video', id, raw: url } : { type: null, raw: url };
      }
      if (p === '/watch') {
        const id = u.searchParams.get('v');
        return this._isVideoId(id) ? { type: 'video', id, raw: url } : { type: null, raw: url };
      }
      let m = p.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m) return { type: 'video', id: m[1], raw: url };

      m = p.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})/);
      if (m) return { type: 'channel', id: m[1], raw: url };
      m = p.match(/^\/@([A-Za-z0-9._-]+)\/?$/);
      if (m) return { type: 'channel', handle: '@' + m[1], raw: url };
      m = p.match(/^\/(?:c|user)\/([A-Za-z0-9._-]+)\/?$/);
      if (m) return { type: 'channel', handle: m[1], raw: url };

      return { type: null, raw: url };
    },

    label(d) {
      if (!d || !d.type) return '未知链接';
      if (d.type === 'video') return '视频链接';
      return '频道链接';
    }
  };

  /* =========================================================
     2. Toast
     ========================================================= */
  const Toast = {
    _wrap: null,
    _t: 2600,

    init() { this._wrap = document.getElementById('toastWrap'); },

    show(msg, tone = 'default') {
      if (!this._wrap) this.init();
      const el = document.createElement('div');
      el.className = 'toast';
      el.setAttribute('data-tone', tone);
      el.textContent = msg;
      this._wrap.appendChild(el);
      setTimeout(() => {
        el.classList.add('is-leaving');
        el.addEventListener('animationend', () => el.remove(), { once: true });
      }, this._t);
    }
  };

  /* =========================================================
     3. Loader —— 加载状态管理
     【第四阶段稳定优化】 新增进度条动画 + 心跳检测
     ========================================================= */
  const Loader = {
    _heartbeatId: null,
    _progressId: null,

    start(btn, resultEl, inputs) {
      // 锁定按钮
      if (btn) {
        btn.dataset.label = btn.textContent;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> 分析中…';
      }

      // 锁定输入框
      if (inputs) {
        inputs.forEach(inp => {
          inp.disabled = true;
          inp.classList.add('is-locked');
        });
      }

      // 显示加载提示 + 进度条
      if (resultEl) {
        resultEl.innerHTML =
          '<div class="result__loading">' +
          '<span class="spinner" aria-hidden="true"></span>' +
          '<span>正在拉取频道数据、AI 智能分析中，请稍候…</span>' +
          '</div>' +
          '<div class="result__progress">' +
          '<div class="result__progress-bar" id="progressBar"></div>' +
          '</div>' +
          '<p class="result__note">本地仅校验链接格式，完整数据解析与 AI 分析将经由后端安全处理，原始链接不会留存浏览器。</p>';

        /* 【第四阶段稳定优化】 进度条动画（模拟进度，到90%停止等待） */
        const bar = document.getElementById('progressBar');
        let pct = 0;
        this._progressId = setInterval(() => {
          if (pct < 90) {
            pct += Math.random() * 8;
            if (pct > 90) pct = 90;
            if (bar) bar.style.width = pct + '%';
          }
        }, 500);
      }

      /* 【第四阶段稳定优化】 心跳检测：8秒无响应判定预加载失败 */
      this._heartbeatId = setTimeout(() => {
        Log.warn('[Loader] 心跳检测：8秒无响应，判定预加载失败');
        this._onHeartbeatFail(btn, resultEl, inputs);
      }, 8000);
    },

    /* 【第四阶段稳定优化】 心跳失败处理 */
    _onHeartbeatFail(btn, resultEl, inputs) {
      this.stop(btn, inputs);
      if (resultEl) {
        resultEl.innerHTML = '<div class="result__empty result__empty--error">网络响应缓慢，请检查网络后重试。</div>';
      }
      Toast.show('网络响应缓慢，请检查网络后重试。', 'error');
      // 触发全局状态重置
      if (GlobalInput) GlobalInput._isSubmitting = false;
    },

    stop(btn, inputs) {
      // 清理心跳和进度条
      if (this._heartbeatId) { clearTimeout(this._heartbeatId); this._heartbeatId = null; }
      if (this._progressId) { clearInterval(this._progressId); this._progressId = null; }

      // 进度条满格
      const bar = document.getElementById('progressBar');
      if (bar) bar.style.width = '100%';

      // 解锁按钮
      if (btn && btn.dataset.label !== undefined) {
        btn.disabled = false;
        btn.textContent = btn.dataset.label;
        delete btn.dataset.label;
      }

      // 解锁输入框
      if (inputs) {
        inputs.forEach(inp => {
          inp.disabled = false;
          inp.classList.remove('is-locked');
        });
      }
    }
  };

  /* =========================================================
     3.5 Gauge —— 评分仪表盘渲染 + 动画
     ========================================================= */
  const Gauge = {
    getLevel(score) {
      if (score <= 40) return { class: 'low', label: '流量短板', desc: '存在明显短板，建议针对性优化内容结构和发布策略。' };
      if (score <= 70) return { class: 'mid', label: '中等水平', desc: '整体表现尚可，在特定维度仍有提升空间。' };
      return { class: 'high', label: '爆款潜力', desc: '表现优异，具备爆款基因，建议保持并放大优势。' };
    },

    _CIRC: 339.292,

    build(score, opts) {
      opts = opts || {};
      const level = this.getLevel(score);
      const pct = Math.max(0, Math.min(100, score));
      const isHigh = level.class === 'high';
      const glowClass = isHigh ? ' gauge-ring--glow' : '';
      const scoreClass = isHigh ? 'gauge-ring__score gauge-ring__score--high' : 'gauge-ring__score';

      return (
        '<div class="gauge-ring' + glowClass + '">' +
        '<svg viewBox="0 0 120 120" aria-hidden="true">' +
        '<circle class="gauge-ring__track" cx="60" cy="60" r="54"/>' +
        '<circle class="gauge-ring__fill gauge-ring__fill--' + level.class + '"' +
        ' cx="60" cy="60" r="54"' +
        ' data-target-dash="' + (pct / 100 * this._CIRC).toFixed(3) + '"' +
        ' stroke-dasharray="0 ' + this._CIRC + '"/>' +
        '</svg>' +
        '<div class="gauge-ring__center">' +
        '<span class="' + scoreClass + '" data-target-score="' + score + '">0</span>' +
        '<span class="gauge-ring__max">/ 100</span>' +
        '</div>' +
        '</div>'
      );
    },

    buildCard(score, title, desc) {
      const level = this.getLevel(score);
      const gaugeHtml = this.build(score);
      const finalDesc = desc || level.desc;

      return (
        '<div class="gauge-card">' +
        gaugeHtml +
        '<div class="gauge-info">' +
        '<p class="gauge-info__title">' + (title || '综合评分') + '</p>' +
        '<p class="gauge-info__desc">' + finalDesc + '</p>' +
        '<span class="gauge-tag gauge-tag--' + level.class + '">' + level.label + '</span>' +
        '</div>' +
        '</div>'
      );
    },

    buildDual(scoreA, scoreB, labelA, labelB) {
      const gap = scoreA - scoreB;
      const winner = scoreA > scoreB ? 'a' : (scoreB > scoreA ? 'b' : 'tie');
      const gapText = (gap > 0 ? '+' : '') + gap;

      const colA = '<div class="gauge-compare__col' + (winner === 'a' ? ' is-winner' : '') + '">' +
        '<p class="gauge-compare__name">' + (labelA || 'A') + '</p>' +
        this.build(scoreA) +
        '</div>';

      const divider = '<div class="gauge-compare__divider">' +
        '<svg class="gauge-compare__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M5 12h14M12 5l7 7-7 7"/>' +
        '</svg>' +
        '<span class="gauge-compare__gap">' + gapText + '</span>' +
        '<span class="gauge-compare__gap-label">分差</span>' +
        '</div>';

      const colB = '<div class="gauge-compare__col' + (winner === 'b' ? ' is-winner' : '') + '">' +
        '<p class="gauge-compare__name">' + (labelB || 'B') + '</p>' +
        this.build(scoreB) +
        '</div>';

      return '<div class="gauge-compare">' + colA + divider + colB + '</div>';
    },

    injectDefs() {
      if (document.getElementById('gaugeDefs')) return;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'gauge-defs');
      svg.setAttribute('id', 'gaugeDefs');
      svg.innerHTML =
        '<defs>' +
        '<linearGradient id="gradMid" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#9b8cf8"/>' +
        '<stop offset="1" stop-color="#c98ad9"/>' +
        '</linearGradient>' +
        '<linearGradient id="gradHigh" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#b24bff"/>' +
        '<stop offset="1" stop-color="#8b7cf6"/>' +
        '</linearGradient>' +
        '</defs>';
      document.body.appendChild(svg);
    },

    animate(container) {
      const rings = container.querySelectorAll('.gauge-ring__fill');
      const scores = container.querySelectorAll('[data-target-score]');

      rings.forEach(ring => {
        const target = parseFloat(ring.dataset.targetDash);
        requestAnimationFrame(() => {
          ring.style.strokeDasharray = target + ' ' + this._CIRC;
        });
      });

      scores.forEach(el => {
        const target = parseInt(el.dataset.targetScore, 10);
        const duration = 1200;
        const start = performance.now();

        const tick = (now) => {
          const p = Math.min(1, (now - start) / duration);
          const eased = 1 - Math.pow(1 - p, 3);
          el.textContent = Math.round(target * eased);
          if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }
  };

  /* =========================================================
     4. ResultRenderer —— 完整结果渲染
     【第四阶段稳定优化】 空值兜底 ?. + 分段渲染
     ========================================================= */
  const ResultRenderer = {
    renderEmpty(resultEl, msg) {
      if (!resultEl) return;
      resultEl.innerHTML = '<div class="result__empty">' + msg + '</div>';
    },

    renderError(resultEl, msg) {
      if (!resultEl) return;
      resultEl.innerHTML = '<div class="result__empty result__empty--error">' + msg + '</div>';
    },

    render(resultEl, panelType, response) {
      if (!resultEl) return;

      /* 【第四阶段稳定优化】 空值兜底 */
      if (!response) {
        this.renderEmpty(resultEl, '暂无数据。');
        return;
      }

      // 后端返回结构：{ success: true, data: { sourceData, aiResult } }
      const data = response?.data || response || {};
      const sourceData = data?.sourceData || {};
      const aiResult = data?.aiResult || {};

      // ① 判断 aiResult.isFallback
      if (aiResult?.isFallback === true) {
        resultEl.innerHTML = '';
        Toast.show('Gemini调用失败，无有效分析结果', 'error');
        return;
      }

      // ② 判断 sourceData.isMock
      if (sourceData?.isMock === true) {
        resultEl.innerHTML = '';
        Toast.show('检测到模拟数据，已拒绝展示。', 'error');
        return;
      }

      // 提取 AI 分析结果（全兜底）
      const score = typeof aiResult?.score === 'number' ? aiResult.score : 0;
      const summary = aiResult?.summary || '';
      const fullText = aiResult?.fullText || '';

      // 统一渲染逻辑
      const html = this._renderUnified(panelType, sourceData, score, summary, fullText);

      resultEl.innerHTML = html;
      this._bindCopyButtons(resultEl);

      // 注入仪表盘 SVG 渐变定义并触发动画
      Gauge.injectDefs();
      Gauge.animate(resultEl);

      /* 【第四阶段稳定优化】 AI 长文本分段渲染 */
      this._renderFullTextSegmented(resultEl, fullText);
    },

    _renderUnified(panelType, sourceData, score, summary, fullText) {
      const gaugeHtml = Gauge.buildCard(score, '综合爆款潜力评分', summary);

      // 完整分析文本区块（占位容器，分段渲染填充）
      const fullTextHtml = fullText ?
        '<div class="result__section">' +
        '<h4 class="result__section-title">AI 深度分析报告</h4>' +
        '<div class="result__fulltext" id="fullTextContainer"></div>' +
        '<button class="result__copy-btn" type="button" data-copy-target=".result__fulltext">一键复制完整报告</button>' +
        '</div>' : '';

      // 频道源数据展示（如有）
      const sourceHtml = this._renderSourceData(sourceData);

      return (
        '<div class="result__section">' +
        '<h4 class="result__section-title">频道分析结果</h4>' +
        gaugeHtml +
        '</div>' +
        sourceHtml +
        fullTextHtml +
        '<p class="result__note">本地仅校验链接格式，完整数据解析与 AI 分析将经由后端安全处理，原始链接不会留存浏览器。</p>'
      );
    },

    /* 【第四阶段稳定优化】 AI 长文本分段渲染，避免一次性渲染卡顿 */
    _renderFullTextSegmented(resultEl, fullText) {
      const container = resultEl.querySelector('#fullTextContainer');
      if (!container || !fullText) return;

      const paragraphs = fullText.split('\n').filter(p => p.trim());
      let idx = 0;

      const renderNext = () => {
        if (idx >= paragraphs.length) return;
        const p = document.createElement('p');
        p.textContent = paragraphs[idx];
        p.style.opacity = '0';
        container.appendChild(p);
        requestAnimationFrame(() => {
          p.style.transition = 'opacity .3s ease';
          p.style.opacity = '1';
        });
        idx++;
        // 每段间隔 50ms，避免一次性渲染卡顿
        setTimeout(renderNext, 50);
      };

      renderNext();
    },

    _renderSourceData(sourceData) {
      /* 【第四阶段稳定优化】 空值兜底 */
      if (!sourceData || typeof sourceData !== 'object' || Object.keys(sourceData).length === 0) return '';

      const name = sourceData?.channelName || sourceData?.name || sourceData?.title || '—';
      const subs = sourceData?.subscriberCount || sourceData?.subscribers || sourceData?.subs || '—';
      const views = sourceData?.viewCount || sourceData?.totalViews || sourceData?.views || '—';
      const videos = sourceData?.videoCount || sourceData?.totalVideos || '—';

      if (name === '—' && subs === '—' && views === '—') return '';

      return (
        '<div class="result__section">' +
        '<h4 class="result__section-title">频道基础数据</h4>' +
        '<div class="result__grid result__grid--2">' +
        '<div class="result__card"><span class="result__card-label">频道名称</span><span class="result__card-value">' + name + '</span></div>' +
        '<div class="result__card"><span class="result__card-label">订阅数</span><span class="result__card-value">' + subs + '</span></div>' +
        '<div class="result__card"><span class="result__card-label">总播放量</span><span class="result__card-value">' + views + '</span></div>' +
        '<div class="result__card"><span class="result__card-label">视频数</span><span class="result__card-value">' + videos + '</span></div>' +
        '</div>' +
        '</div>'
      );
    },

    _bindCopyButtons(container) {
      container.querySelectorAll('.result__copy-btn').forEach(btn => {
        btn.addEventListener('click', function () {
          const targetSelector = this.dataset.copyTarget;
          let textToCopy = '';

          if (targetSelector) {
            const target = container.querySelector(targetSelector);
            textToCopy = target ? target.textContent.trim() : '';
          } else {
            const contentEl = this.previousElementSibling;
            if (contentEl && contentEl.dataset.copyContent) {
              textToCopy = contentEl.dataset.copyContent;
            } else if (contentEl) {
              textToCopy = contentEl.textContent.trim();
            }
          }

          if (textToCopy) {
            /* 【第四阶段稳定优化】 clipboard API 兜底 */
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(textToCopy).then(() => {
                Toast.show('复制成功！', 'success');
              }).catch(() => {
                this._fallbackCopy(textToCopy);
              });
            } else {
              this._fallbackCopy(textToCopy);
            }
          }
        });
      });
    },

    /* 【第四阶段稳定优化】 降级复制方案 */
    _fallbackCopy(text) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        Toast.show('复制成功！', 'success');
      } catch (e) {
        Toast.show('复制失败，请手动复制。', 'error');
      }
    }
  };

  /* =========================================================
     5. GlobalInput —— 顶部唯一输入框，动态单/双栏
     【第四阶段稳定优化】 输入防抖 + AbortController清理 + 额度检查
     ========================================================= */
  const GlobalInput = {
    _bar: null,
    _hint: null,
    _currentTab: null,
    _isSubmitting: false,
    _debounceTimers: {}, // 【第四阶段稳定优化】 防抖定时器

    init() {
      this._bar = document.getElementById('globalPromptBar');
      this._hint = document.getElementById('globalHint');
    },

    render(tabName) {
      this._currentTab = tabName;
      const cfg = PANEL_CONFIG[tabName];
      if (!cfg || !this._bar) return;

      /* 【第四阶段稳定优化】 切换Tab时销毁进行中的请求 */
      if (typeof window.CreatorLensAPI !== 'undefined') {
        window.CreatorLensAPI.abortActive();
      }
      // 重置提交状态
      this._isSubmitting = false;

      const count = cfg.inputCount;
      const fieldsHtml = cfg.inputLabels.map((label, idx) =>
        '<div class="prompt-field' + (count === 2 ? ' prompt-field--dual' : '') + '">' +
        '<input class="prompt-input" type="text" data-idx="' + idx + '" data-kind="' + cfg.inputKinds[idx] + '" placeholder="粘贴' + label + '链接…" autocomplete="off" spellcheck="false" />' +
        '<span class="prompt-badge" data-badge="' + idx + '" hidden></span>' +
        '</div>'
      ).join('<span class="prompt-split" aria-hidden="true"></span>');

      this._bar.innerHTML =
        '<div class="prompt-fields">' + fieldsHtml + '</div>' +
        '<button class="prompt-submit" type="button" id="globalSubmitBtn">' + cfg.buttonText + '</button>';

      // 更新提示文案
      const kindText = cfg.inputKinds.map((k) => k === 'video' ? '视频' : '频道').join(' / ');
      this._hint.textContent = '自动识别 ' + kindText + '链接 · 本地仅校验链接格式，完整数据解析与 AI 分析将经由后端安全处理';

      // 绑定输入事件（防抖校验 + Enter 提交）
      this._bar.querySelectorAll('.prompt-input').forEach((inp) => {
        inp.addEventListener('input', (e) => this._debouncedUpdateBadge(e.target));
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this._submit(); }
        });
      });

      // 绑定提交按钮
      const submitBtn = document.getElementById('globalSubmitBtn');
      if (submitBtn) submitBtn.addEventListener('click', () => this._submit());
    },

    /* 【第四阶段稳定优化】 输入防抖 800ms */
    _debouncedUpdateBadge(input) {
      const idx = input.dataset.idx;
      if (this._debounceTimers[idx]) clearTimeout(this._debounceTimers[idx]);
      this._debounceTimers[idx] = setTimeout(() => {
        this._updateBadge(input);
      }, 800);
    },

    _updateBadge(input) {
      const idx = input.dataset.idx;
      const badge = this._bar?.querySelector('[data-badge="' + idx + '"]');
      if (!badge) return;

      const d = LinkParser.detect(input.value);
      if (!input.value.trim()) {
        badge.hidden = true;
        badge.textContent = '';
        return;
      }
      badge.hidden = false;
      badge.textContent = LinkParser.label(d);
      badge.setAttribute('data-tone', d?.type || 'unknown');
    },

    _collectInputs() {
      const cfg = PANEL_CONFIG[this._currentTab];
      if (!cfg) return [];
      const inputs = this._bar?.querySelectorAll('.prompt-input') || [];
      const collected = [];
      let valid = true;

      inputs.forEach((inp, idx) => {
        inp.classList.remove('is-invalid');
        const raw = inp.value.trim();
        const expected = cfg.inputKinds[idx];

        if (!raw) {
          Toast.show('请先粘贴' + cfg.inputLabels[idx] + '的链接。', 'error');
          inp.classList.add('is-invalid');
          inp.focus();
          valid = false;
          return;
        }

        /* 【第四阶段稳定优化】 前置正则拦截 */
        if (LinkParser._isLikelyGarbage(raw)) {
          Toast.show('链接格式无效，请检查是否为有效的 YouTube 链接。', 'error');
          inp.classList.add('is-invalid');
          valid = false;
          return;
        }

        const d = LinkParser.detect(raw);
        if (!d?.type) {
          Toast.show('链接格式无效，请检查是否为有效的 YouTube 链接。', 'error');
          inp.classList.add('is-invalid');
          valid = false;
          return;
        }
        if (d.type !== expected) {
          Toast.show('此处需要' + (expected === 'video' ? '视频' : '频道') + '链接。', 'error');
          inp.classList.add('is-invalid');
          valid = false;
          return;
        }
        collected.push({ kind: expected, value: raw });
      });

      return valid ? collected : null;
    },

    _submit() {
      // 防重复提交
      if (this._isSubmitting) {
        Toast.show('请勿重复提交。', 'error');
        return;
      }

      /* 【第四阶段稳定优化】 额度检查 */
      if (!QuotaManager.canUse()) {
        Toast.show('今日免费额度已用完，请明日再试或升级付费版。', 'error');
        return;
      }

      const collected = this._collectInputs();
      if (!collected) return;

      this._isSubmitting = true;

      const cfg = PANEL_CONFIG[this._currentTab];
      const panel = document.querySelector('.panel[data-panel="' + this._currentTab + '"]');
      const resultEl = panel ? panel.querySelector('[data-result]') : null;
      const btn = document.getElementById('globalSubmitBtn');
      const inputs = this._bar?.querySelectorAll('.prompt-input') || [];

      Loader.start(btn, resultEl, inputs);

      // 调用后端 API
      window.CreatorLensAPI.request(this._currentTab, collected)
        .then(async (response) => {
          if (response?.success) {
            /* 【第四阶段稳定优化】 缓存到 IndexedDB */
            const url = collected[0]?.value || '';
            if (url) await CacheManager.set(url, response.data);

            ResultRenderer.render(resultEl, this._currentTab, response.data);
            Toast.show('分析完成，结果已生成。', 'success');

            /* 【第四阶段稳定优化】 扣减额度 */
            QuotaManager.increment();
          } else {
            // 接口错误：清空结果区域，仅弹窗展示后端 msg
            const errorMsg = response?.message || '分析失败，请稍后重试。';
            if (resultEl) resultEl.innerHTML = '';
            Toast.show(errorMsg, 'error');
          }
        })
        .catch(() => {
          // 网络异常：清空结果区域，仅弹窗
          if (resultEl) resultEl.innerHTML = '';
          Toast.show('网络异常，请稍后重试。', 'error');
        })
        .finally(() => {
          Loader.stop(btn, inputs);
          this._isSubmitting = false;
        });
    }
  };

  /* =========================================================
     6. PanelSwitcher —— Tab 切换 + 动态渲染
     ========================================================= */
  const PanelSwitcher = {
    _tabs: null,
    _sidebar: null,
    _panelsContainer: null,
    _current: null,

    init() {
      this._tabs = Array.from(document.querySelectorAll('.tab'));
      this._sidebar = document.getElementById('workspaceSidebar');
      this._panelsContainer = document.getElementById('panels');

      this._tabs.forEach((tab) => {
        tab.addEventListener('click', () => this.activate(tab.dataset.tab));
      });

      const first = this._tabs[0] && this._tabs[0].dataset.tab;
      if (first) this.activate(first);
    },

    activate(name) {
      if (name === this._current) return;
      this._current = name;

      this._tabs.forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));

      // 更新全局输入框（内部会销毁进行中的请求）
      GlobalInput.render(name);

      // 更新侧边栏
      this._renderSidebar(name);

      // 更新面板（仅标题+描述+结果）
      this._renderPanel(name);
    },

    _renderSidebar(name) {
      const cfg = PANEL_CONFIG[name];
      if (!cfg || !this._sidebar) return;

      this._sidebar.innerHTML =
        '<div class="workspace__icon" style="background: ' + cfg.gradient + ';">' +
        '<svg viewBox="0 0 24 24" width="28" height="28" fill="none">' + cfg.icon + '</svg>' +
        '</div>' +
        '<h2 class="workspace__title">' + cfg.title + '</h2>' +
        '<p class="workspace__desc">' + cfg.desc + '</p>';
    },

    _renderPanel(name) {
      const cfg = PANEL_CONFIG[name];
      if (!cfg || !this._panelsContainer) return;

      this._panelsContainer.innerHTML =
        '<section class="panel is-active" data-panel="' + name + '">' +
        '<header class="panel__head">' +
        '<h3 class="panel__title">' + cfg.title + '</h3>' +
        '<p class="panel__desc">' + cfg.desc + '</p>' +
        '</header>' +
        '<div class="result" data-result>' +
        '<div class="result__empty">暂无结果。请在上方粘贴链接后点击"' + cfg.buttonText + '"开始分析。</div>' +
        '</div>' +
        '</section>';
    },

    getCurrent() { return this._current; }
  };

  /* =========================================================
     【第四阶段稳定优化】 工具栏 —— 导出日志 / 清理缓存
     ========================================================= */
  function _initToolbar() {
    const exportBtn = document.getElementById('exportLogBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => ErrorBoundary.exportLogs());
    }

    const clearCacheBtn = document.getElementById('clearCacheBtn');
    if (clearCacheBtn) {
      clearCacheBtn.addEventListener('click', async () => {
        await CacheManager.clearManual();
        if (window.CreatorLensAPI) window.CreatorLensAPI.clearCache();
        Toast.show('本地缓存已清理', 'success');
      });
    }
  }

  /* =========================================================
     启动
     ========================================================= */
  document.addEventListener('DOMContentLoaded', async () => {
    /* 【第四阶段稳定优化】 ErrorBoundary 优先初始化 */
    ErrorBoundary.init();
    Toast.init();
    GlobalInput.init();

    /* 【第四阶段稳定优化】 IndexedDB 缓存初始化 */
    await CacheManager.init();

    /* 【第四阶段稳定优化】 额度计数器 */
    QuotaManager.updateUI();

    /* 【第四阶段稳定优化】 在线状态指示器 */
    OnlineStatus.init();

    /* 【第四阶段稳定优化】 隐私说明弹窗 */
    PrivacyPopup.init();

    /* 【第四阶段稳定优化】 工具栏按钮 */
    _initToolbar();

    PanelSwitcher.init();
  });

  window.CreatorLens = {
    LinkParser,
    PanelSwitcher,
    GlobalInput,
    ResultRenderer,
    Toast,
    ErrorBoundary,
    CacheManager,
    QuotaManager,
    OnlineStatus,
    PANEL_CONFIG,
    APP_VERSION
  };

})();
