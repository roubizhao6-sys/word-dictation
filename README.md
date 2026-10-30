# 单词听写 · 智能听写模式

689 个手写笔记本单词的听写练习站：听音写词、逐字母智能批改、错词本、艾宾浩斯复习、美音/英音双发音。

- 📷 拍照或上传手写英文词页，服务端 OCR 后确认入库，个人词本保存在本机 IndexedDB
- 🎧 听写 / 听选释义 / 看词选义 / 看义写词 / 智能混合 / 随身听
- ✍️ 提交后左上角显示刚答词的判分：红色=拼错，深色=拼对
- 📕 错词自动收录（记录错误拼写），连续答对两次移出
- 🧠 艾宾浩斯：5min → 30min → 12h → 1d → 2d → 4d → 7d → 15d → 30d
- 🔊 单词表全部 689 词：**每个词下面列出多种中文意思**（按词性分组）+ CET4/CET6/考研/IELTS/TOEFL 标签，点一下即发音，可美音/英音切换、连播
- 💾 进度、收藏、自建生词保存在浏览器本机，可导出/导入备份

## 在线访问

**https://roubizhao6-sys.github.io/word-dictation/**

手机、平板、电脑用浏览器打开即可，无需安装。学习进度保存在各自设备浏览器中。

也可直接打开 `index.html` 离线使用。

## 拍照词本（Cloudflare Workers）

OCR 由 `worker/ocr.js` 代理到 Google Cloud Vision，浏览器只拿到识别结果，`GOOGLE_VISION_API_KEY` 不会出现在前端或 Git 中。

1. 在 Google Cloud 启用 **Cloud Vision API**，创建 API Key，并限制为仅可调用 Cloud Vision API。
2. 安装并登录 Wrangler：`npx wrangler login`。
3. 写入 Worker Secret：`npx wrangler secret put GOOGLE_VISION_API_KEY`，粘贴密钥。
4. 部署：`npx wrangler deploy`。
5. 复制部署输出的 Worker 地址，在 `index.html` 中设置：

```html
<meta name="ocr-api" content="https://word-dictation-ocr.你的子域.workers.dev/ocr">
```

提交并推送后，GitHub Pages 会跨域调用该 Worker。`wrangler.toml` 的 `ALLOWED_ORIGINS` 已允许 `https://roubizhao6-sys.github.io`；换成自定义域名时同步修改。

本地联调：

```bash
cp .dev.vars.example .dev.vars
npx wrangler dev
```

`.dev.vars` 已被 `.gitignore` 忽略，禁止提交真实密钥。
