/**
 * CreatorLens Worker — Cloudflare Workers 后端
 * 【版本】 第二版：Google AI Studio 免费 Gemini Flash
 * 【域名】 generativelanguage.googleapis.com
 * 【鉴权】 API_KEY（从环境变量 GEMINI_API_KEY 读取）
 *
 * 【功能】
 * - YouTube 频道/视频数据抓取
 * - Google Gemini Flash AI 分析
 * - URL 缓存（10 分钟，KV 存储）
 * - 限流识别（额度超限 vs 数据解析失败）
 *
 * 【部署】
 * wrangler deploy
 * 环境变量：GEMINI_API_KEY = 你的 AI Studio API Key
 * KV 命名空间：CREATORLENS_CACHE
 */

/* ==========================================================================
   【配置】 AI Studio 接口参数
   ========================================================================== */

const AI_CONFIG = {
  // 【第二版修改】 AI Studio 免费接口域名（非 Vertex）
  BASE_URL: 'https://generativelanguage.googleapis.com',
  MODEL: 'gemini-1.5-flash',  // 免费 Flash 模型
  MAX_OUTPUT_TOKENS: 2048,
  TEMPERATURE: 0.7,
  MAX_CONTENT_LENGTH: 100000,  // YouTube 页面内容上限
};

const CACHE_CONFIG = {
  TTL_SECONDS: 600,  // 【第二版新增】 10 分钟缓存
  KEY_PREFIX: 'cl_cache:',
};

const RATE_LIMIT = {
  MAX_REQUESTS_PER_MINUTE: 15,  // AI Studio 免费版每分钟 15 次
  COOLDOWN_SECONDS: 10,        // 限流后建议等待 10 秒
};

/* ==========================================================================
   【Worker 入口】
   ========================================================================== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return handleCors();
    }

    // 健康检查
    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', version: '2.0-ai-studio' });
    }

    // 主接口：POST /
    if (request.method === 'POST' && url.pathname === '/') {
      return handleAnalysis(request, env, ctx);
    }

    return jsonResponse({ error: 'Not Found' }, 404);
  },
};

/* ==========================================================================
   【CORS 处理】
   ========================================================================== */

function handleCors() {
  return new Response('', {
    status: 204,
    headers: corsHeaders(),
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

/* ==========================================================================
   【统一 JSON 响应】
   ========================================================================== */

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json',
    },
  });
}

/* ==========================================================================
   【主处理函数】 频道分析
   ========================================================================== */

async function handleAnalysis(request, env, ctx) {
  try {
    // 1. 解析请求体
    const body = await request.json();
    const youtubeUrl = body?.youtubeUrl?.trim();

    if (!youtubeUrl) {
      return jsonResponse({ code: 400, msg: '缺少 youtubeUrl 参数', data: null });
    }

    // 2. 验证 URL 合法性
    if (!isValidYouTubeUrl(youtubeUrl)) {
      return jsonResponse({ code: 400, msg: '无效的 YouTube 链接', data: null });
    }

    // 3. 生成缓存 Key（基于 URL hash）
    const cacheKey = CACHE_CONFIG.KEY_PREFIX + hashUrl(youtubeUrl);

    // 4. 【第二版新增】 检查缓存
    if (env.CREATORLENS_CACHE) {
      const cached = await env.CREATORLENS_CACHE.get(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          // 检查缓存是否过期
          if (Date.now() - parsed.ts < CACHE_CONFIG.TTL_SECONDS * 1000) {
            console.log('[Cache] 命中缓存:', youtubeUrl);
            return jsonResponse({
              code: 200,
              msg: 'success (cached)',
              data: parsed.result,
            });
          }
        } catch (e) {
          // 缓存损坏，继续请求
        }
      }
    }

    // 5. 获取 YouTube 页面内容
    console.log('[Worker] 抓取 YouTube 内容:', youtubeUrl);
    const pageContent = await fetchYouTubePage(youtubeUrl);

    if (!pageContent || !pageContent.channelName) {
      return jsonResponse({
        code: 502,
        msg: 'YouTube 页面抓取失败，请检查链接是否有效',
        data: null,
      });
    }

    // 6. 构建 AI Prompt
    const prompt = buildPrompt(youtubeUrl, pageContent);

    // 7. 调用 Google AI Studio
    console.log('[Worker] 调用 AI Studio:', AI_CONFIG.MODEL);
    const aiResult = await callAIStudio(env, prompt);

    // 8. 【第二版新增】 检查 AI 返回内容有效性
    const aiValidation = validateAIResult(aiResult);

    if (!aiValidation.valid) {
      // 区分「额度超限」和「数据解析失败」
      if (aiValidation.type === 'RATE_LIMITED') {
        return jsonResponse({
          code: 429,
          msg: '调用频次过高，请10秒后重试',
          data: {
            sourceData: pageContent,
            aiResult: {
              isFallback: true,
              score: 0,
              summary: 'AI 分析服务限流，请稍后重试。',
              fullText: '',
              rateLimited: true,
            },
          },
        });
      }

      if (aiValidation.type === 'QUOTA_EXCEEDED') {
        return jsonResponse({
          code: 429,
          msg: 'AI 分析额度已耗尽，请明日再试或升级付费版',
          data: {
            sourceData: pageContent,
            aiResult: {
              isFallback: true,
              score: 0,
              summary: 'AI 额度已耗尽。',
              fullText: '',
              quotaExceeded: true,
            },
          },
        });
      }

      // 数据解析失败
      return jsonResponse({
        code: 500,
        msg: 'AI 返回内容解析失败',
        data: {
          sourceData: pageContent,
          aiResult: {
            isFallback: true,
            score: 0,
            summary: 'AI 分析结果为空，请稍后重试。',
            fullText: '',
            parseFailed: true,
          },
        },
      });
    }

    // 9. 组装最终结果
    const result = {
      sourceData: pageContent,
      aiResult: {
        score: aiResult.score,
        summary: aiResult.summary,
        fullText: aiResult.fullText,
        isFallback: false,
      },
    };

    // 10. 【第二版新增】 写入缓存
    if (env.CREATORLENS_CACHE) {
      ctx.waitUntil(
        env.CREATORLENS_CACHE.put(
          cacheKey,
          JSON.stringify({ ts: Date.now(), result }),
          { expirationTtl: CACHE_CONFIG.TTL_SECONDS }
        )
      );
    }

    console.log('[Worker] 分析完成:', youtubeUrl);
    return jsonResponse({ code: 200, msg: 'success', data: result });
  } catch (error) {
    console.error('[Worker] 处理异常:', error);
    return jsonResponse({
      code: 500,
      msg: '服务器内部错误',
      data: null,
    });
  }
}

/* ==========================================================================
   【AI Studio 调用】
   ========================================================================== */

async function callAIStudio(env, prompt) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY 未配置');
  }

  const url = `${AI_CONFIG.BASE_URL}/v1beta/models/${AI_CONFIG.MODEL}:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: [{
      parts: [{ text: prompt }],
    }],
    generationConfig: {
      maxOutputTokens: AI_CONFIG.MAX_OUTPUT_TOKENS,
      temperature: AI_CONFIG.TEMPERATURE,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  // 【第二版新增】 处理 HTTP 状态码
  if (response.status === 429) {
    // 限流
    return { rawText: '', _rateLimited: true, _quotaExceeded: false };
  }

  if (response.status === 403) {
    // 额度耗尽（403 表示超出配额）
    return { rawText: '', _rateLimited: false, _quotaExceeded: true };
  }

  if (!response.ok) {
    const errText = await response.text();
    console.error('[AI Studio] HTTP', response.status, errText);
    throw new Error('AI Studio 请求失败: HTTP ' + response.status);
  }

  const data = await response.json();

  // 【第二版新增】 响应结构解析（AI Studio 格式）
  const rawText = extractTextFromResponse(data);

  return {
    rawText,
    _rateLimited: false,
    _quotaExceeded: false,
  };
}

/* ==========================================================================
   【AI 响应解析】
   ========================================================================== */

function extractTextFromResponse(data) {
  try {
    // AI Studio 标准响应格式
    // candidates[0].content.parts[0].text
    const candidates = data?.candidates;
    if (candidates && candidates.length > 0) {
      const content = candidates[0]?.content;
      const parts = content?.parts;
      if (parts && parts.length > 0) {
        return parts.map(p => p.text || '').join('');
      }
    }
    return '';
  } catch (e) {
    console.error('[AI Studio] 响应解析失败:', e);
    return '';
  }
}

/* ==========================================================================
   【AI 结果校验】 —— 区分限流和解析失败
   ========================================================================== */

function validateAIResult(aiResult) {
  // 1. 检查 HTTP 限流标记
  if (aiResult._rateLimited) {
    return { valid: false, type: 'RATE_LIMITED' };
  }

  // 2. 检查额度耗尽标记
  if (aiResult._quotaExceeded) {
    return { valid: false, type: 'QUOTA_EXCEEDED' };
  }

  // 3. 解析 AI 返回文本
  const rawText = aiResult.rawText || '';

  // 【第二版新增】 检查是否为空内容
  if (!rawText || rawText.trim().length < 10) {
    return { valid: false, type: 'PARSE_FAILED' };
  }

  // 4. 从 AI 文本中提取结构化数据
  const parsed = parseAIResponse(rawText);

  // 5. 检查提取结果
  if (!parsed || parsed.score === 0 && !parsed.summary) {
    return { valid: false, type: 'PARSE_FAILED' };
  }

  return {
    valid: true,
    type: 'OK',
    score: parsed.score,
    summary: parsed.summary,
    fullText: rawText,
  };
}

/* ==========================================================================
   【AI 文本解析】 —— 提取 score / summary
   ========================================================================== */

function parseAIResponse(rawText) {
  try {
    // 尝试解析 JSON 格式
    // AI Flash 通常返回 JSON 或 Markdown
    const jsonMatch = rawText.match(/```json\s*([\s\S]*?)\s*```/);
    let jsonStr = '';

    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    } else {
      // 直接尝试匹配 JSON 对象
      const braceMatch = rawText.match(/\{[\s\S]*?\}/);
      if (braceMatch) {
        jsonStr = braceMatch[0];
      }
    }

    if (jsonStr) {
      const parsed = JSON.parse(jsonStr);
      return {
        score: typeof parsed.score === 'number' ? parsed.score : 0,
        summary: parsed.summary || parsed.conclusion || '',
        fullText: rawText,
      };
    }

    // 回退：从纯文本中提取分数和摘要
    const scoreMatch = rawText.match(/评分[：:]\s*(\d+)/) || rawText.match(/score[：:]\s*(\d+)/i);
    const summaryMatch = rawText.match(/(?:摘要|总结|结论)[：:]\s*([^\n]+)/);

    return {
      score: scoreMatch ? parseInt(scoreMatch[1]) : 0,
      summary: summaryMatch ? summaryMatch[1] : '',
      fullText: rawText,
    };
  } catch (e) {
    console.error('[AI 解析] 失败:', e);
    return { score: 0, summary: '', fullText: rawText };
  }
}

/* ==========================================================================
   【YouTube 页面抓取】
   ========================================================================== */

async function fetchYouTubePage(youtubeUrl) {
  // 使用 YouTube 公开 API 或第三方服务获取页面内容
  try {
    // 方案一：使用 YouTube oEmbed（无需 API Key）
    const videoId = extractVideoId(youtubeUrl);
    const channelName = extractChannelName(youtubeUrl);

    // 如果是视频链接，获取视频信息
    if (videoId) {
      const oembedUrl = `https://www.youtube.com/oembed?url=https%3A//www.youtube.com/watch%3Fv%3D${videoId}&format=json`;
      const resp = await fetch(oembedUrl);
      if (resp.ok) {
        const data = await resp.json();
        return {
          channelName: data.author_name || '未知频道',
          videoTitle: data.title || '',
          videoId: videoId,
          subscriberCount: null,
          viewCount: null,
          rawTitle: data.title || '',
        };
      }
    }

    // 如果是频道链接
    if (channelName) {
      return {
        channelName: channelName,
        videoTitle: '',
        videoId: null,
        subscriberCount: null,
        viewCount: null,
        rawTitle: '',
      };
    }

    return null;
  } catch (e) {
    console.error('[YouTube] 抓取失败:', e);
    return null;
  }
}

/* ==========================================================================
   【工具函数】
   ========================================================================== */

function isValidYouTubeUrl(url) {
  const patterns = [
    /youtube\.com\/@/,
    /youtube\.com\/watch\?v=/,
    /youtu\.be\//,
    /youtube\.com\/channel\//,
    /youtube\.com\/c\//,
    /youtube\.com\/user\//,
  ];
  return patterns.some(p => p.test(url));
}

function extractVideoId(url) {
  // youtu.be/VIDEO_ID
  let match = url.match(/youtu\.be\/([^?&/]+)/);
  if (match) return match[1];

  // youtube.com/watch?v=VIDEO_ID
  match = url.match(/youtube\.com\/watch\?v=([^&]+)/);
  if (match) return match[1];

  return null;
}

function extractChannelName(url) {
  // youtube.com/@channelname
  const match = url.match(/youtube\.com\/@([^?/]+)/);
  if (match) return decodeURIComponent(match[1]);

  return null;
}

function hashUrl(url) {
  // 简单的 URL hash（DJB2 算法）
  let hash = 5381;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) + hash) + url.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

/* ==========================================================================
   【AI Prompt 构建】
   ========================================================================== */

function buildPrompt(youtubeUrl, pageContent) {
  const channelInfo = pageContent?.channelName || '未知';
  const videoTitle = pageContent?.videoTitle || '';

  return `你是一个专业的 YouTube 内容创作者分析助手。请分析以下 YouTube 频道/视频，并返回结构化的 JSON 数据。

分析维度：
1. 频道/视频评分（0-100 分）
2. 简短摘要（50 字以内）

输出格式（严格 JSON）：
\`\`\`json
{
  "score": 数字,
  "summary": "摘要文本"
}
\`\`\`

目标链接：${youtubeUrl}
频道名称：${channelInfo}
视频标题：${videoTitle}

请直接返回 JSON，不要添加其他说明。`;
}