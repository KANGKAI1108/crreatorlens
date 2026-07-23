/**
 * CreatorLens Worker —— Cloudflare Workers 后端
 * 【版本】 第三版：纯数据爬取，已彻底移除所有 AI 大模型调用
 * 【数据源】 YouTube Data API v3
 * 【鉴权】 YOUTUBE_API_KEY（环境变量）
 *
 * 【核心变更 v3】
 * - 完全删除 Google Vertex / Google AI Studio / Gemini 相关代码
 * - 不再返回任何 AI 文本字段
 * - 仅返回 YouTube 原始数据：频道信息 + 近 10 条视频统计
 * - 仅保留爬取缓存（10 分钟）
 *
 * 【部署】
 * 环境变量：YOUTUBE_API_KEY = 你的 YouTube Data API v3 Key
 * KV 命名空间：CREATORLENS_CACHE
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return handleCors();
    }

    // 健康检查
    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', version: '3.0-pure-data', mode: 'local-analysis' });
    }

    // 主接口：POST /
    if (request.method === 'POST' && url.pathname === '/') {
      return handleFetch(request, env, ctx);
    }

    return jsonResponse({ error: 'Not Found' }, 404);
  },
};

/* ==========================================================================
   CORS 处理
   ========================================================================== */

function handleCors() {
  return new Response('', { status: 204, headers: corsHeaders() });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

/* ==========================================================================
   配置
   ========================================================================== */

const YOUTUBE_API = {
  BASE: 'https://www.googleapis.com/youtube/v3',
};

const CACHE_CONFIG = {
  TTL_SECONDS: 600,           // 10 分钟爬取缓存
  KEY_PREFIX: 'cl_youtube:',  // 仅缓存 YouTube 爬取结果
};

/* ==========================================================================
   主处理函数：仅做 YouTube 原始数据抓取，不做任何 AI 分析
   ========================================================================== */

async function handleFetch(request, env, ctx) {
  try {
    const body = await request.json();
    const youtubeUrl = body?.youtubeUrl?.trim();

    if (!youtubeUrl) {
      return jsonResponse({ code: 400, msg: '缺少 youtubeUrl 参数', sourceData: null });
    }

    if (!isValidYouTubeUrl(youtubeUrl)) {
      return jsonResponse({ code: 400, msg: '无效的 YouTube 链接', sourceData: null });
    }

    const apiKey = env.YOUTUBE_API_KEY;
    if (!apiKey) {
      return jsonResponse({ code: 500, msg: 'YOUTUBE_API_KEY 未配置', sourceData: null });
    }

    // 解析 URL → channelId / handle / videoId
    const parsed = parseYouTubeUrl(youtubeUrl);
    if (!parsed.type) {
      return jsonResponse({ code: 400, msg: '无法识别的 YouTube 链接', sourceData: null });
    }

    // 仅爬取缓存（不再缓存 AI 结果）
    const cacheKey = CACHE_CONFIG.KEY_PREFIX + hashUrl(youtubeUrl);
    if (env.CREATORLENS_CACHE) {
      const cached = await env.CREATORLENS_CACHE.get(cacheKey);
      if (cached) {
        try {
          const json = JSON.parse(cached);
          if (Date.now() - json.ts < CACHE_CONFIG.TTL_SECONDS * 1000) {
            console.log('[Worker] 命中 YouTube 爬取缓存');
            return jsonResponse({ code: 200, msg: 'success (cached)', sourceData: json.data });
          }
        } catch (e) {}
      }
    }

    // 调用 YouTube Data API v3
    let sourceData;
    if (parsed.type === 'video') {
      sourceData = await fetchVideoData(apiKey, parsed.id, env, ctx);
    } else {
      sourceData = await fetchChannelData(apiKey, parsed, env, ctx);
    }

    if (!sourceData) {
      return jsonResponse({ code: 502, msg: 'YouTube 爬取失败，请检查链接或 API Key', sourceData: null });
    }

    // 写入爬取缓存
    if (env.CREATORLENS_CACHE) {
      ctx.waitUntil(
        env.CREATORLENS_CACHE.put(
          cacheKey,
          JSON.stringify({ ts: Date.now(), data: sourceData }),
          { expirationTtl: CACHE_CONFIG.TTL_SECONDS }
        )
      );
    }

    return jsonResponse({ code: 200, msg: 'success', sourceData });
  } catch (error) {
    console.error('[Worker] 处理异常:', error);
    return jsonResponse({ code: 500, msg: '服务器内部错误', sourceData: null });
  }
}

/* ==========================================================================
   YouTube Data API v3 调用
   ========================================================================== */

async function fetchChannelData(apiKey, parsed, env, ctx) {
  try {
    // 1. 解析频道 ID
    let channelId = parsed.id;
    if (parsed.handle) {
      // 通过 handle 获取 channelId
      channelId = await resolveHandleToChannelId(apiKey, parsed.handle);
      if (!channelId) return null;
    }

    // 2. 拉取频道基本信息
    const channelUrl = `${YOUTUBE_API.BASE}/channels?part=snippet,statistics,brandingSettings&id=${channelId}&key=${apiKey}`;
    const channelResp = await fetch(channelUrl);
    if (!channelResp.ok) {
      console.error('[YouTube API] channels 失败:', channelResp.status);
      return null;
    }
    const channelJson = await channelResp.json();
    const channel = channelJson.items?.[0];
    if (!channel) return null;

    // 3. 拉取近 10 条视频
    const videosUrl = `${YOUTUBE_API.BASE}/search?part=id&channelId=${channelId}&maxResults=10&order=date&type=video&key=${apiKey}`;
    const videosResp = await fetch(videosUrl);
    if (!videosResp.ok) {
      console.error('[YouTube API] search 失败:', videosResp.status);
      return null;
    }
    const videosJson = await videosResp.json();
    const videoIds = (videosJson.items || []).map(v => v.id.videoId).filter(Boolean).join(',');

    // 4. 拉取视频统计数据
    let videos = [];
    if (videoIds) {
      const statsUrl = `${YOUTUBE_API.BASE}/videos?part=snippet,statistics,contentDetails&id=${videoIds}&key=${apiKey}`;
      const statsResp = await fetch(statsUrl);
      if (statsResp.ok) {
        const statsJson = await statsResp.json();
        videos = (statsJson.items || []).map(v => ({
          videoId: v.id,
          title: v.snippet?.title || '',
          publishedAt: v.snippet?.publishedAt || '',
          duration: v.contentDetails?.duration || '',         // ISO8601
          durationSec: parseISO8601Duration(v.contentDetails?.duration || ''),
          viewCount: parseInt(v.statistics?.viewCount || '0', 10),
          likeCount: parseInt(v.statistics?.likeCount || '0', 10),
          commentCount: parseInt(v.statistics?.commentCount || '0', 10),
          tags: v.snippet?.tags || [],
          description: (v.snippet?.description || '').substring(0, 500),
        }));
      }
    }

    return {
      type: 'channel',
      channelId: channelId,
      channelName: channel.snippet?.title || '',
      channelHandle: channel.snippet?.customUrl || '',
      description: channel.snippet?.description || '',
      thumbnail: channel.snippet?.thumbnails?.high?.url || channel.snippet?.thumbnails?.default?.url || '',
      publishedAt: channel.snippet?.publishedAt || '',
      country: channel.snippet?.country || '',
      subscriberCount: parseInt(channel.statistics?.subscriberCount || '0', 10),
      viewCount: parseInt(channel.statistics?.viewCount || '0', 10),
      videoCount: parseInt(channel.statistics?.videoCount || '0', 10),
      videos: videos,
      fetchedAt: Date.now(),
    };
  } catch (e) {
    console.error('[fetchChannelData] 异常:', e);
    return null;
  }
}

async function fetchVideoData(apiKey, videoId, env, ctx) {
  try {
    const url = `${YOUTUBE_API.BASE}/videos?part=snippet,statistics,contentDetails&id=${videoId}&key=${apiKey}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const json = await resp.json();
    const item = json.items?.[0];
    if (!item) return null;

    return {
      type: 'video',
      channelId: item.snippet?.channelId || '',
      channelName: item.snippet?.channelTitle || '',
      videoId: videoId,
      title: item.snippet?.title || '',
      description: (item.snippet?.description || '').substring(0, 500),
      publishedAt: item.snippet?.publishedAt || '',
      duration: item.contentDetails?.duration || '',
      durationSec: parseISO8601Duration(item.contentDetails?.duration || ''),
      viewCount: parseInt(item.statistics?.viewCount || '0', 10),
      likeCount: parseInt(item.statistics?.likeCount || '0', 10),
      commentCount: parseInt(item.statistics?.commentCount || '0', 10),
      tags: item.snippet?.tags || [],
      thumbnail: item.snippet?.thumbnails?.high?.url || '',
      fetchedAt: Date.now(),
    };
  } catch (e) {
    console.error('[fetchVideoData] 异常:', e);
    return null;
  }
}

async function resolveHandleToChannelId(apiKey, handle) {
  try {
    const cleanHandle = handle.replace(/^@/, '');
    const url = `${YOUTUBE_API.BASE}/channels?part=id&forHandle=${encodeURIComponent('@' + cleanHandle)}&key=${apiKey}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const json = await resp.json();
    return json.items?.[0]?.id || null;
  } catch (e) {
    return null;
  }
}

/* ==========================================================================
   工具函数
   ========================================================================== */

function isValidYouTubeUrl(url) {
  return /(?:youtube\.com|youtu\.be)/i.test(url);
}

function parseYouTubeUrl(url) {
  let m;

  // youtu.be/VIDEO_ID
  m = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m) return { type: 'video', id: m[1] };

  // youtube.com/watch?v=VIDEO_ID
  m = url.match(/youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/);
  if (m) return { type: 'video', id: m[1] };

  // youtube.com/channel/UC...
  m = url.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/);
  if (m) return { type: 'channel', id: m[1] };

  // youtube.com/@handle
  m = url.match(/youtube\.com\/@([A-Za-z0-9._-]+)/);
  if (m) return { type: 'channel', handle: '@' + m[1] };

  // youtube.com/c/name
  m = url.match(/youtube\.com\/c\/([A-Za-z0-9._-]+)/);
  if (m) return { type: 'channel', handle: '@' + m[1] };

  return { type: null };
}

function parseISO8601Duration(iso) {
  // PT1H2M3S → 3723
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  return h * 3600 + min * 60 + s;
}

function hashUrl(url) {
  let hash = 5381;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) + hash) + url.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}