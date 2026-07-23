# CreatorLens 部署说明

## Vercel 一键部署

### 方法一：CLI 部署

```bash
# 1. 安装 Vercel CLI（如未安装）
npm i -g vercel

# 2. 进入项目目录
cd creatorlens-web

# 3. 部署到 Vercel
vercel --prod
```

### 方法二：Git 仓库关联部署

1. 将项目推送到 GitHub/GitLab 仓库
2. 登录 [vercel.com](https://vercel.com) → New Project
3. 导入仓库，框架预设选择 **Other**
4. 构建命令留空（纯静态项目无需构建）
5. 输出目录填 `.`（当前目录）
6. 点击 Deploy

### 部署配置说明

| 配置项 | 值 |
|---|---|
| 框架预设 | Other |
| 构建命令 | （留空） |
| 输出目录 | `.` |
| 安装命令 | （留空） |

### vercel.json 已配置

- SPA 单页路由重定向：所有路由 → `index.html`，刷新不 404
- 静态资源缓存：CSS/JS/图片 1 年长期缓存
- HTML 文件不缓存：确保版本更新即时生效
- 安全头：X-Content-Type-Options、X-Frame-Options、Referrer-Policy

## 本地开发

```bash
# 启动本地服务
python3 -m http.server 8080

# 浏览器访问
http://localhost:8080
```

## 项目结构

```
├── index.html      # 主页面
├── styles.css      # 全部样式
├── api.js          # API 请求封装
├── app.js          # 前端交互逻辑
├── 404.html        # 404 兜底页面
├── vercel.json     # Vercel 部署配置
├── package.json    # 项目元信息
└── deploy.md       # 本文档
```

## 后端接口

- 地址：`https://webcreatorlens.kang61398.workers.dev`
- 方法：POST
- 入参：`{ "youtubeUrl": "YouTube链接" }`
- 返回：`{ "code": 200, "data": { "sourceData": {...}, "aiResult": {...} } }`
