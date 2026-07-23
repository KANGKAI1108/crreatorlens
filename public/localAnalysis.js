/**
 * CreatorLens · 本地分析引擎（v3 纯离线版）
 * 100% 前端 JS 运算，零外部 AI 依赖
 *
 * 包含 6 个分析模块：
 * - module1: 流量层级判断（冷启动/小爆款/大爆款）
 * - module2: 更新节奏分析（日更/周更/断更）
 * - module3: 受众定位分析（创业/财经/剪辑/带货等）
 * - module4: 爆款共性提取（关键词/时长/标题特征）
 * - module5: 增长诊断（起号/稳定/下滑）
 * - module6: 优化建议生成（预设文案模板）
 *
 * 输入：Worker 爬取的 YouTube 原始 sourceData
 * 输出：完整本地分析报告 { report, sections, score, suggestions }
 */

(function () {
  'use strict';

  /* =========================================================
     【模块1】 流量层级判断
     划分冷启动 / 小爆款 / 大爆款 / 现象级
     ========================================================= */
  const module1 = {
    /* 【可调整阈值】 根据数据情况自行调整 */
    THRESHOLDS: {
      // 单视频播放量阈值（实际根据订阅数动态调整）
      COLD: 1000,        // < 1k 冷启动
      SMALL_HIT: 10000,  // 1w-10w 小爆款
      BIG_HIT: 100000,   // 10w-100w 大爆款
      VIRAL: 1000000,    // > 100w 现象级
    },

    judge(viewCount, subscriberCount) {
      const v = viewCount || 0;
      const sub = subscriberCount || 0;

      // 动态阈值：基于订阅数调整
      // 冷启动阈值 = 订阅数的 5%，最高 1k
      const coldThresh = Math.max(500, Math.min(1000, sub * 0.05));
      // 小爆款阈值 = 订阅数的 50%，最高 1w
      const smallThresh = Math.max(2000, Math.min(10000, sub * 0.5));
      // 大爆款阈值 = 订阅数的 5 倍，最高 10w
      const bigThresh = Math.max(10000, Math.min(100000, sub * 5));

      if (v < coldThresh) {
        return { level: 'cold', label: '冷启动', score: 20, desc: '视频播放量低于账号基准值，内容/标签/封面需要优化。' };
      }
      if (v < smallThresh) {
        return { level: 'small', label: '小爆款', score: 55, desc: '已超过账号平均水平，可作为参考模板。' };
      }
      if (v < bigThresh) {
        return { level: 'big', label: '大爆款', score: 80, desc: '播放量远超账号基准，是值得深度复盘的内容。' };
      }
      return { level: 'viral', label: '现象级', score: 95, desc: '突破账号圈层的爆款，可作为整套方法论的核心案例。' };
    },

    summarize(videos) {
      if (!videos || videos.length === 0) return { distribution: {}, top: null, bottom: null };
      const levels = { cold: 0, small: 0, big: 0, viral: 0 };
      let top = videos[0], bottom = videos[0];
      videos.forEach(v => {
        const lv = this.judge(v.viewCount, 0);
        levels[lv.level]++;
        if (v.viewCount > (top?.viewCount || 0)) top = v;
        if (v.viewCount < (bottom?.viewCount || Infinity)) bottom = v;
      });
      return { distribution: levels, top, bottom };
    }
  };

  /* =========================================================
     【模块2】 更新节奏分析
     计算平均更新间隔，判断日更/周更/月更/断更
     ========================================================= */
  const module2 = {
    judgeCadence(videos) {
      if (!videos || videos.length < 2) {
        return { cadence: 'unknown', label: '样本不足', avgIntervalDays: 0, desc: '需要至少 2 条视频数据才能判断更新节奏。' };
      }

      // 按时间倒序排序（最新在前）
      const sorted = [...videos].sort((a, b) =>
        new Date(b.publishedAt) - new Date(a.publishedAt)
      );

      // 计算相邻视频间隔（天）
      const intervals = [];
      for (let i = 0; i < sorted.length - 1; i++) {
        const diff = (new Date(sorted[i].publishedAt) - new Date(sorted[i + 1].publishedAt)) / (1000 * 60 * 60 * 24);
        if (diff > 0) intervals.push(diff);
      }

      if (intervals.length === 0) {
        return { cadence: 'unknown', label: '样本异常', avgIntervalDays: 0, desc: '发布时间数据异常。' };
      }

      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;

      let cadence, label, desc;
      if (avg <= 1.5) {
        cadence = 'daily'; label = '日更'; desc = '保持日更，活跃度高，算法推荐量级稳定。';
      } else if (avg <= 4) {
        cadence = 'frequent'; label = '高更频'; desc = '每周 2-3 更，节奏紧凑，账号处于成长活跃期。';
      } else if (avg <= 9) {
        cadence = 'weekly'; label = '周更'; desc = '每周 1 更，标准商业化节奏，建议保持稳定。';
      } else if (avg <= 21) {
        cadence = 'biweekly'; label = '双周更'; desc = '每两周 1 更，节奏偏慢，需要观察是否影响推荐权重。';
      } else if (avg <= 45) {
        cadence = 'monthly'; label = '月更'; desc = '每月 1 更，节奏缓慢，建议提高更新频率。';
      } else {
        cadence = 'stagnant'; label = '疑似断更'; desc = '平均更新间隔超过 45 天，账号活跃度严重不足。';
      }

      return { cadence, label, avgIntervalDays: Math.round(avg * 10) / 10, desc, intervals };
    }
  };

  /* =========================================================
     【模块3】 受众定位分析
     从简介/标签/标题关键词匹配赛道
     ========================================================= */
  const module3 = {
    /* 【可扩展】 自定义赛道关键词库 */
    CATEGORIES: [
      { name: '创业 / 商业', keywords: ['创业', '商业', 'startup', 'business', 'entrepreneur', '创始人', '融资', 'vc', '投资', '副业', '网赚', '小生意'] },
      { name: '财经 / 投资', keywords: ['财经', '投资', '股票', '基金', '金融', 'finance', 'invest', 'stock', 'crypto', '比特币', '美股', '港股', 'a股', '理财'] },
      { name: '科技 / 数码', keywords: ['科技', '数码', '手机', 'iphone', 'android', 'tech', 'review', '评测', '开箱', 'apple', '华为', '小米', '三星', 'mac', 'pc'] },
      { name: '剪辑 / 后期', keywords: ['剪辑', '后期', 'premiere', 'final cut', '达芬奇', '剪映', 'davinci', 'video editing', 'editing', '调色', '转场', '字幕'] },
      { name: '带货 / 电商', keywords: ['带货', '电商', '好物', '推荐', 'shop', 'taobao', '淘宝', 'shopify', 'amazon', '亚马逊', '直播带货', '测评', '开箱'] },
      { name: 'AI / 编程', keywords: ['ai', 'gpt', 'chatgpt', 'claude', '人工智能', '机器学习', '编程', '代码', 'developer', 'programming', 'python', 'javascript', 'rust', 'github', 'open source'] },
      { name: '健身 / 健康', keywords: ['健身', '减肥', '增肌', 'workout', 'fitness', 'gym', '肌肉', '塑形', '瑜伽', '跑步', 'diet', 'diet', '减脂', '健康'] },
      { name: '美食 / 料理', keywords: ['美食', '料理', '食谱', 'recipe', 'cooking', 'food', '餐厅', '探店', '小吃', '烘焙', '甜点', '咖啡', 'tea'] },
      { name: '游戏 / 电竞', keywords: ['游戏', '电竞', 'gaming', 'gameplay', '攻略', '实况', '解说', 'lol', 'csgo', '原神', '王者', 'fps', 'moba'] },
      { name: '教育 / 学习', keywords: ['教育', '学习', '英语', '考试', 'study', 'education', 'tutorial', '教程', '课程', '考研', '雅思', '托福', '口语'] },
      { name: '情感 / 心理', keywords: ['情感', '心理', '恋爱', 'relationship', 'psychology', '情绪', '抑郁', '焦虑', '人际', '两性', '婚姻', '分手'] },
      { name: '旅行 / 户外', keywords: ['旅行', '旅游', 'travel', 'vlog', '户外', 'outdoor', '露营', '自驾', 'hiking', '摄影', '摄影教程', '风景'] },
      { name: '搞笑 / 娱乐', keywords: ['搞笑', '娱乐', 'funny', 'comedy', '段子', '整蛊', '挑战', '恶作剧', 'meme', '鬼畜', '综艺'] },
      { name: '汽车 / 机车', keywords: ['汽车', 'car', '电动车', 'tesla', '特斯拉', '比亚迪', '机车', '摩托车', 'motorcycle', '改装', 'racing'] },
    ],

    detect(channelName, description, tags, videos) {
      // 合并所有可分析文本
      const corpus = [
        channelName || '',
        description || '',
        (tags || []).join(' '),
        (videos || []).map(v => v.title || '').join(' '),
        (videos || []).map(v => v.description || '').join(' '),
      ].join(' ').toLowerCase();

      const scores = [];
      this.CATEGORIES.forEach(cat => {
        let hits = 0;
        const matchedKeywords = [];
        cat.keywords.forEach(kw => {
          const re = new RegExp(kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
          const m = corpus.match(re);
          if (m) {
            hits += m.length;
            matchedKeywords.push(kw);
          }
        });
        if (hits > 0) {
          scores.push({ name: cat.name, hits, matchedKeywords });
        }
      });

      scores.sort((a, b) => b.hits - a.hits);

      return {
        primary: scores[0] || { name: '未识别', hits: 0, matchedKeywords: [] },
        secondary: scores[1] || null,
        allMatches: scores.slice(0, 5),
        totalKeywordsHit: scores.length,
      };
    }
  };

  /* =========================================================
     【模块4】 爆款共性提取
     统计高播放视频共用关键词、时长区间、标题特征
     ========================================================= */
  const module4 = {
    /* 爆款阈值：播放量超过频道平均 1.5 倍视为爆款 */
    HIT_RATIO: 1.5,

    analyze(videos) {
      if (!videos || videos.length < 3) {
        return { hits: [], avgViews: 0, topWords: [], durationRange: null, commonPatterns: [] };
      }

      const avgViews = videos.reduce((sum, v) => sum + (v.viewCount || 0), 0) / videos.length;
      const hitThreshold = avgViews * this.HIT_RATIO;

      const hits = videos.filter(v => (v.viewCount || 0) >= hitThreshold);
      const nonHits = videos.filter(v => (v.viewCount || 0) < hitThreshold);

      // 标题关键词频次统计
      const wordFreq = {};
      const stopWords = new Set(['的', '了', '是', '我', '你', '他', '她', '它', '在', '和', '与', '或', '一个', '一种', '如何', '怎么', '什么', '为什么', 'the', 'a', 'an', 'is', 'are', 'how', 'what', 'why', 'to', 'in', 'on']);
      hits.forEach(v => {
        const title = (v.title || '').toLowerCase();
        // 按空格和中文标点分词
        const words = title.split(/[\s,.!?;。！？；，、]+/).filter(w => w.length >= 2 && !stopWords.has(w));
        words.forEach(w => {
          wordFreq[w] = (wordFreq[w] || 0) + 1;
        });
      });

      const topWords = Object.entries(wordFreq)
        .filter(([_, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([word, count]) => ({ word, count }));

      // 时长区间
      const durations = hits.map(v => v.durationSec || 0).filter(d => d > 0);
      let durationRange = null;
      if (durations.length > 0) {
        const min = Math.min(...durations);
        const max = Math.max(...durations);
        const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
        durationRange = {
          minSec: min, maxSec: max, avgSec: Math.round(avg),
          minLabel: formatDuration(min),
          maxLabel: formatDuration(max),
          avgLabel: formatDuration(avg),
        };
      }

      // 标题模式（数字/问号/感叹号）
      const patterns = [];
      const numPattern = hits.filter(v => /\d+/.test(v.title || '')).length;
      const qPattern = hits.filter(v => /[?？]/.test(v.title || '')).length;
      const exclPattern = hits.filter(v => /[!！]/.test(v.title || '')).length;
      if (numPattern > 0) patterns.push(`数字标题: ${numPattern}/${hits.length} 条爆款使用数字`);
      if (qPattern > 0) patterns.push(`疑问句式: ${qPattern}/${hits.length} 条爆款用问号`);
      if (exclPattern > 0) patterns.push(`感叹强调: ${exclPattern}/${hits.length} 条爆款用感叹号`);

      return {
        hits,
        nonHits,
        avgViews: Math.round(avgViews),
        hitThreshold: Math.round(hitThreshold),
        topWords,
        durationRange,
        commonPatterns: patterns,
        hitRatio: hits.length / videos.length,
      };
    }
  };

  /* =========================================================
     【模块5】 增长诊断
     对比新老视频流量，判断账号处于起号/稳定/下滑阶段
     ========================================================= */
  const module5 = {
    diagnose(videos) {
      if (!videos || videos.length < 4) {
        return { stage: 'unknown', label: '样本不足', desc: '需要至少 4 条视频数据才能诊断账号阶段。', trend: 0 };
      }

      // 按发布时间排序（最新在前）
      const sorted = [...videos].sort((a, b) =>
        new Date(b.publishedAt) - new Date(a.publishedAt)
      );

      // 拆分新旧两半
      const half = Math.floor(sorted.length / 2);
      const recent = sorted.slice(0, half);
      const earlier = sorted.slice(half);

      const recentAvg = recent.reduce((s, v) => s + (v.viewCount || 0), 0) / recent.length;
      const earlierAvg = earlier.reduce((s, v) => s + (v.viewCount || 0), 0) / earlier.length;

      const changeRatio = earlierAvg > 0 ? (recentAvg - earlierAvg) / earlierAvg : 0;
      const trend = Math.round(changeRatio * 100);

      let stage, label, desc, score;
      if (changeRatio >= 0.5) {
        stage = 'rising'; label = '起号上升期';
        desc = `近期视频播放量较前期增长 ${Math.abs(trend)}%，账号处于明显上升通道，建议保持当前内容方向。`;
        score = 90;
      } else if (changeRatio >= 0.1) {
        stage = 'growing'; label = '稳定成长';
        desc = `近期视频播放量较前期增长 ${trend}%，账号稳定成长，可尝试小幅度测试新选题。`;
        score = 75;
      } else if (changeRatio >= -0.15) {
        stage = 'stable'; label = '平台期';
        desc = `近期视频播放量与前期基本持平（${trend >= 0 ? '+' : ''}${trend}%），账号进入平台期，需要内容突破。`;
        score = 55;
      } else if (changeRatio >= -0.4) {
        stage = 'declining'; label = '轻微下滑';
        desc = `近期视频播放量较前期下降 ${Math.abs(trend)}%，账号出现下滑迹象，需要审视内容策略。`;
        score = 35;
      } else {
        stage = 'fading'; label = '严重下滑';
        desc = `近期视频播放量较前期暴跌 ${Math.abs(trend)}%，账号严重下滑，需要大刀阔斧改革内容方向。`;
        score = 15;
      }

      return { stage, label, desc, trend, recentAvg: Math.round(recentAvg), earlierAvg: Math.round(earlierAvg), score };
    }
  };

  /* =========================================================
     【模块6】 优化建议生成
     基于本地规则输出可落地内容调整方案
     全部预设文案模板，数据匹配后自动填充
     ========================================================= */
  const module6 = {
    /* 【文案模板库】 可自行扩充 */
    TEMPLATES: {
      cadence_daily: '建议继续保持日更节奏，活跃的更新频率有助于算法持续推荐。可用批量剪辑工具提升产能。',
      cadence_weekly: '保持周更节奏稳定，订阅者对每周更新已形成预期，建议固定发布日（如每周三/六）。',
      cadence_monthly: '当前更新频率过低，建议至少提升至双周更。可将长内容拆分为系列，提升更新密度。',
      cadence_stagnant: '⚠️ 更新节奏过慢，建议立即恢复更新。算法对长时间不活跃的账号会降低推荐权重。',
      rising: '📈 账号处于上升期，建议：\n1. 保持当前内容方向和更新节奏\n2. 及时回复评论，提升互动率\n3. 整理爆款方法论，复制成功经验',
      stable: '➡️ 账号进入平台期，建议：\n1. 分析近期数据，找出播放量最高的内容类型\n2. 尝试新选题/新形式打破瓶颈\n3. 优化标题、封面、缩略图',
      declining: '📉 账号出现下滑，建议：\n1. 复盘下滑前后的内容变化，识别问题\n2. 重新研究目标受众需求\n3. 考虑账号定位是否需要调整',
      low_engagement: '💡 互动率偏低，建议在视频中：\n1. 前 5 秒设置互动钩子（提问/悬念）\n2. 结尾引导点赞/评论/订阅\n3. 及时回复评论提升账号活跃度',
      high_engagement: '👍 互动率优秀，建议保持：\n1. 持续输出引发讨论的内容\n2. 提炼高赞评论作为新选题灵感',
      duration_too_long: '⏱️ 视频时长偏长（>20分钟），建议：\n1. 检查中段留存数据，识别流失点\n2. 拆分长内容为系列\n3. 或精简内容密度',
      duration_too_short: '⏱️ 视频时长偏短（<3分钟），建议：\n1. 增加内容深度，提升完播率\n2. 但需注意短时长也适合涨粉，看账号定位',
      duration_sweet: '⏱️ 视频时长集中在 {avgLabel}，建议保持这个区间。',
      keywords_advice: '🔑 爆款视频高频词：{keywords}，可在新选题中复用。',
      tags_advice: '🏷️ 建议补充以下标签：{tags}',
      category_match: '🎯 频道定位为【{category}】，建议：\n1. 持续深耕该赛道\n2. 参考同赛道头部账号的爆款选题\n3. 形成自己独特的内容风格',
    },

    generate(ctx) {
      const suggestions = [];

      // 1. 更新节奏建议
      const c = ctx.cadence;
      if (c.cadence === 'daily' || c.cadence === 'frequent') {
        suggestions.push(this.TEMPLATES.cadence_daily);
      } else if (c.cadence === 'weekly' || c.cadence === 'biweekly') {
        suggestions.push(this.TEMPLATES.cadence_weekly);
      } else if (c.cadence === 'monthly') {
        suggestions.push(this.TEMPLATES.cadence_monthly);
      } else if (c.cadence === 'stagnant') {
        suggestions.push(this.TEMPLATES.cadence_stagnant);
      }

      // 2. 增长阶段建议
      const g = ctx.growth;
      suggestions.push(this.TEMPLATES[g.stage] || this.TEMPLATES.stable);

      // 3. 时长建议
      const d = ctx.duration;
      if (d) {
        if (d.avgSec > 1200) {
          suggestions.push(this.TEMPLATES.duration_too_long);
        } else if (d.avgSec < 180) {
          suggestions.push(this.TEMPLATES.duration_too_short);
        } else {
          suggestions.push(this.TEMPLATES.duration_sweet.replace('{avgLabel}', d.avgLabel));
        }
      }

      // 4. 爆款关键词建议
      if (ctx.topWords && ctx.topWords.length > 0) {
        const words = ctx.topWords.slice(0, 5).map(w => w.word).join('、');
        suggestions.push(this.TEMPLATES.keywords_advice.replace('{keywords}', words));
      }

      // 5. 受众定位建议
      if (ctx.category && ctx.category !== '未识别') {
        suggestions.push(this.TEMPLATES.category_match.replace('{category}', ctx.category));
      }

      // 6. 互动率建议
      if (ctx.engagementRate !== null && ctx.engagementRate !== undefined) {
        if (ctx.engagementRate < 0.02) {
          suggestions.push(this.TEMPLATES.low_engagement);
        } else if (ctx.engagementRate >= 0.05) {
          suggestions.push(this.TEMPLATES.high_engagement);
        }
      }

      return suggestions;
    }
  };

  /* =========================================================
     工具函数
     ========================================================= */

  function formatDuration(sec) {
    if (!sec || sec <= 0) return '0秒';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}小时${m}分`;
    if (m > 0) return `${m}分${s > 0 ? s + '秒' : ''}`;
    return `${s}秒`;
  }

  function formatNumber(num) {
    if (!num || num <= 0) return '0';
    if (num >= 100000000) return (num / 100000000).toFixed(1) + '亿';
    if (num >= 10000) return (num / 10000).toFixed(1) + '万';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return num.toString();
  }

  /* =========================================================
     主入口：analyze(sourceData)
     接收 YouTube 原始数据，输出完整本地分析报告
     ========================================================= */
  function analyze(sourceData) {
    if (!sourceData) {
      return { error: 'NO_DATA', message: '无 YouTube 原始数据，无法进行本地分析。' };
    }

    // 提取视频数组
    const videos = sourceData.videos || [];
    const videoCount = sourceData.videoCount || videos.length;
    const subscriberCount = sourceData.subscriberCount || 0;
    const viewCount = sourceData.viewCount || 0;

    // 模块1: 流量层级
    const flowDist = module1.summarize(videos);

    // 模块2: 更新节奏
    const cadence = module2.judgeCadence(videos);

    // 模块3: 受众定位
    const audience = module3.detect(
      sourceData.channelName,
      sourceData.description,
      videos.flatMap(v => v.tags || []),
      videos
    );

    // 模块4: 爆款共性
    const hits = module4.analyze(videos);

    // 模块5: 增长诊断
    const growth = module5.diagnose(videos);

    // 计算综合互动率
    let totalEngagement = 0;
    let countWithEngagement = 0;
    videos.forEach(v => {
      if (v.viewCount > 0 && (v.likeCount > 0 || v.commentCount > 0)) {
        const rate = (v.likeCount + v.commentCount * 3) / v.viewCount;
        totalEngagement += rate;
        countWithEngagement++;
      }
    });
    const engagementRate = countWithEngagement > 0 ? totalEngagement / countWithEngagement : null;

    // 计算综合评分（加权）
    const weights = {
      growth: 0.35,        // 增长阶段权重最高
      flow: 0.25,          // 流量层级
      cadence: 0.15,       // 更新节奏
      category: 0.15,      // 定位清晰度
      engagement: 0.10,    // 互动率
    };

    const cadenceScore = {
      'daily': 95, 'frequent': 85, 'weekly': 75, 'biweekly': 55,
      'monthly': 35, 'stagnant': 15, 'unknown': 50,
    }[cadence.cadence] || 50;

    const categoryScore = audience.primary.hits >= 3 ? 90 : (audience.primary.hits >= 1 ? 70 : 50);
    const flowScore = flowDist.top ? module1.judge(flowDist.top.viewCount, subscriberCount).score : 50;
    const engagementScore = engagementRate !== null
      ? Math.min(100, Math.round(engagementRate * 1000))
      : 50;

    const totalScore = Math.round(
      growth.score * weights.growth +
      flowScore * weights.flow +
      cadenceScore * weights.cadence +
      categoryScore * weights.category +
      engagementScore * weights.engagement
    );

    // 模块6: 优化建议
    const suggestions = module6.generate({
      cadence, growth, duration: hits.durationRange, topWords: hits.topWords,
      category: audience.primary.name, engagementRate,
    });

    return {
      /* 基础信息 */
      channelName: sourceData.channelName || '未知频道',
      channelHandle: sourceData.channelHandle || '',
      description: (sourceData.description || '').substring(0, 200),
      subscriberCount, viewCount, videoCount,
      fetchedAt: sourceData.fetchedAt,

      /* 评分 */
      score: totalScore,
      scoreBreakdown: {
        growth: growth.score,
        flow: flowScore,
        cadence: cadenceScore,
        category: categoryScore,
        engagement: engagementScore,
      },

      /* 各模块结果 */
      flow: flowDist,
      cadence,
      audience,
      hits,
      growth,
      engagementRate: engagementRate ? Math.round(engagementRate * 10000) / 100 : null,

      /* 优化建议 */
      suggestions,

      /* 元信息 */
      meta: {
        analyzedAt: new Date().toISOString(),
        engine: 'local',
        version: '3.0',
        videosAnalyzed: videos.length,
      },
    };
  }

  /* 暴露到全局 */
  window.CreatorLensLocal = {
    analyze,
    modules: { module1, module2, module3, module4, module5, module6 },
    format: { formatDuration, formatNumber },
  };

})();