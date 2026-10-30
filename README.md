# 单词听写 · 智能听写模式

689 个手写笔记本单词的听写练习站：听音写词、逐字母智能批改、错词本、艾宾浩斯复习、美音/英音双发音。

- 🎧 听写 / 听选释义 / 看词选义 / 看义写词 / 智能混合 / 随身听
- ✍️ 提交后左上角显示刚答词的判分：红色=拼错，深色=拼对
- 📕 错词自动收录（记录错误拼写），连续答对两次移出
- 🧠 艾宾浩斯：5min → 30min → 12h → 1d → 2d → 4d → 7d → 15d → 30d
- 🔊 单词表全部 689 词：**每个词下面列出多种中文意思**（按词性分组）+ CET4/CET6/考研/IELTS/TOEFL 标签，点一下即发音，可美音/英音切换、连播
- 📷 拍照或上传手写单词本，裁剪后由服务端 OCR 识别英文和可选中文，确认后保存
- 💾 进度、收藏、自建生词保存在浏览器本机；个人词本使用 IndexedDB，可导出/导入备份

## 在线访问

**https://roubizhao6-sys.github.io/word-dictation/**

手机、平板、电脑用浏览器打开即可，无需安装。学习进度保存在各自设备浏览器中。

也可直接打开 `index.html` 离线使用。


## OCR 词本导入

“生词本 → 拍照导入”支持：

- 手机拍照或从相册/文件上传
- 拖动裁剪框选择识别区域
- 服务端 Google Cloud Vision OCR
- 英文单词和中文释义结果逐条编辑、确认
- 保存到本机 IndexedDB，并直接参与听写、听选、看词选义、错词本和艾宾浩斯复习
- 发音继续使用原有美音/英音录音；自建词没有录音时自动回退到系统英语语音

页面继续放在 GitHub Pages（`https://roubizhao6-sys.github.io/word-dictation/`）。OCR 接口是独立的 Cloudflare Worker（`src/index.js`），不再使用 Vercel。

浏览器来源（Origin，不含路径）默认允许 `https://roubizhao6-sys.github.io`。这个默认值写在 `wrangler.jsonc` 的 `OCR_ALLOWED_ORIGINS`。需要多个来源时用英文逗号分隔，例如 `https://roubizhao6-sys.github.io,http://localhost:8080`。未设置该变量时，Worker 仍回退到 `https://roubizhao6-sys.github.io`。若设置了变量，则以变量为准，不再自动追加默认来源。与 Worker 自身域名相同的请求也允许。

### 部署 Worker

```bash
npm install
npx wrangler login
npx wrangler secret put GOOGLE_VISION_API_KEY
npx wrangler deploy
```

`wrangler secret put` 会提示输入，不要把密钥写在命令参数、`wrangler.jsonc`、`config.js` 或 git 里。也可以从本机环境变量管道传入，避免出现在 shell 历史中：

```bash
printf '%s' "$GOOGLE_VISION_API_KEY" | npx wrangler secret put GOOGLE_VISION_API_KEY
```

允许的跨域来源已经有默认值。只有要改掉 `wrangler.jsonc` 里的列表时，才覆盖：

```bash
npx wrangler secret put OCR_ALLOWED_ORIGINS
```

提示时输入逗号分隔的来源，例如 `https://roubizhao6-sys.github.io`。同名 secret 会覆盖配置文件里的 var。本地开发把密钥放在 `.dev.vars`（从 `.dev.vars.example` 复制），该文件已被 git 忽略。

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

部署成功后，Wrangler 会打印 `*.workers.dev` 地址。把该地址填进 `config.js`：

```javascript
window.OCR_API_URL = "https://word-dictation-ocr.<你的子域>.workers.dev";
```

然后把 `config.js` 提交并推到 GitHub Pages。`YOUR_SUBDOMAIN` 占位符不会被当作真实地址。

Google Cloud 侧需要：

1. 创建或选择项目
2. 启用 Cloud Vision API
3. 启用结算
4. 创建 API Key，并限制为 Cloud Vision API
5. 用 `npx wrangler secret put GOOGLE_VISION_API_KEY` 写入 Worker，不要写进前端

不要把真实密钥写进 `index.html`、`config.js`、README，或提交 `.env` / `.dev.vars`。生产环境建议在 Google Cloud 中限制该 Key 只能调用 Vision API。Worker 按客户端 IP 做每分钟 10 次的隔离区内限流（与原先的无服务器实例内限流相同，不是全局限额），并拒绝超过约 3.8 MB 的请求和超过约 2.7 MB 的图片。

### 手动测试

1. 确认 `config.js` 的 `OCR_API_URL` 已是部署后的 Worker 地址，并用 GitHub Pages 打开站点
2. 进入“生词本”
3. 点“拍照导入”，上传一张手写英文单词页面
4. 拖动裁剪框并点“识别选中区域”
5. 检查识别结果，修改错误单词或中文释义，取消不需要的行
6. 点“确认保存”
7. 刷新页面，确认单词仍在 IndexedDB 中
8. 点“练习本单”，验证听写、发音、错词和复习流程
9. 在未配置 Key 的环境点「识别」，页面应显示「OCR 服务尚未配置」，并可以改为手动添加。不要出现密钥或 `GOOGLE_VISION_API_KEY` 字样。Worker 返回同样这句中文（需要重新部署后线上接口才会换成这句；页面也会把旧的带变量名的 503 转成这句话）

手机上建议再看一遍：首页先选练习方式再点某一页；听写时顶部「返回 / 练习方式」一直在；拼写后点「提交」；生词本可改自建词，点「练习本单」后「再练一遍」仍是这一份词，不会变成全部词库。

本仓库的自动测试：

```bash
npm test
```
