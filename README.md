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

## 空白词库

同一仓库、同一 GitHub Pages 站点下还有一份**没有内置单词**的页面，听写模式、生词本、拍照导入和发音都在，打开后词表是空的：

**https://roubizhao6-sys.github.io/word-dictation/empty/**

主站根目录的 `index.html`、`words.json`、`words.csv` 仍是全部 689 词，不要改成空数组。空白页的词库是 `empty/index.html` 里的 `const WORDS = [];`，另外 `empty/words.json` 为 `[]`、`empty/words.csv` 只留表头（页面不读取这两个文件，真正生效的是 `WORDS`）。

两套页面都从 `main` 分支根目录发布。合并到 `main` 后 GitHub Pages 会自动更新，没有单独的部署命令。

空白页用自己的本机存储（`dictation_blank_v1`、`word_dictation_blank_db`），不会读到主站的进度和生词。OCR 地址仍只写在仓库根目录的 `config.js`，空白页用 `../config.js` 引用它。GitHub Pages 上的主站和空白页来源都是 `https://roubizhao6-sys.github.io`（不含路径），共用这一条即可。国内站点 `tingxieyou.cn` 和 `http://120.77.70.33` 写在同一条 `OCR_ALLOWED_ORIGINS` 里。

主站 `index.html` 的界面有改动时，在仓库根目录重新生成空白页再提交：

```bash
python3 scripts/build-empty-site.py
```

不要把 689 词复制进 `empty/`。


## OCR 词本导入

“生词本 → 拍照导入”支持：

- 手机拍照或从相册/文件上传
- 拖动裁剪框选择识别区域
- 服务端百度手写文字识别（中英文单词本照片）
- 英文单词和中文释义结果逐条编辑、确认
- 保存到本机 IndexedDB，并直接参与听写、听选、看词选义、错词本和艾宾浩斯复习
- 发音继续使用原有美音/英音录音；自建词没有录音时自动回退到系统英语语音

页面继续放在 GitHub Pages（`https://roubizhao6-sys.github.io/word-dictation/`）。OCR 接口是独立的 Cloudflare Worker（`src/index.js`），不再使用 Vercel。

浏览器来源（Origin，不含路径）写在 `wrangler.jsonc` 的 `OCR_ALLOWED_ORIGINS`：`https://roubizhao6-sys.github.io`、`http://120.77.70.33`、`http://tingxieyou.cn`、`https://tingxieyou.cn`、`http://www.tingxieyou.cn`、`https://www.tingxieyou.cn`。需要增减时改这一条逗号分隔列表。未设置该变量时，Worker 仍回退到 `https://roubizhao6-sys.github.io`。若设置了变量，则以变量为准，不再自动追加默认来源。与 Worker 自身域名相同的请求也允许。

识别走百度「手写文字识别」：`https://aip.baidubce.com/rest/2.0/ocr/v1/handwriting`。单词本是手写中文和英文，这个接口比通用高精度版（`accurate_basic`，面向印刷体）合适。请求里英文按整词输出（`eng_granularity=word`），并检测照片朝向。接口默认会把英文拆成字母，那样后面的单词解析会失败。

### 部署 Worker

先在百度智能云文字识别里创建应用，勾选「手写文字识别」，拿到 API Key 和 Secret Key。然后：

```bash
npm install
npx wrangler login
npx wrangler secret put BAIDU_OCR_API_KEY
npx wrangler secret put BAIDU_OCR_SECRET_KEY
npx wrangler deploy
```

`wrangler secret put` 会提示输入，不要把密钥写在命令参数、`wrangler.jsonc`、`config.js` 或 git 里。也可以从本机环境变量管道传入，避免出现在 shell 历史中：

```bash
printf '%s' "$BAIDU_OCR_API_KEY" | npx wrangler secret put BAIDU_OCR_API_KEY
printf '%s' "$BAIDU_OCR_SECRET_KEY" | npx wrangler secret put BAIDU_OCR_SECRET_KEY
```

Worker 用这两个密钥换 `access_token`，并在内存里缓存到过期前（百度返回的 `expires_in`，通常约 30 天，提前几分钟刷新）。不要把 API Key、Secret Key 或 access_token 写进前端。

允许的跨域来源已经写在 `wrangler.jsonc`。只有要改掉这份列表时，才覆盖：

```bash
npx wrangler secret put OCR_ALLOWED_ORIGINS
```

提示时输入逗号分隔的来源。同名 secret 会覆盖配置文件里的 var。本地开发把密钥放在 `.dev.vars`（从 `.dev.vars.example` 复制），该文件已被 git 忽略。

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

部署成功后，Wrangler 会打印 `*.workers.dev` 地址。把该地址填进 `config.js`：

```javascript
window.OCR_API_URL = "https://word-dictation-ocr.<你的子域>.workers.dev";
```

然后把 `config.js` 提交并推到 GitHub Pages。`YOUR_SUBDOMAIN` 占位符不会被当作真实地址。线上地址已是 `https://word-dictation-ocr.roubizhao6.workers.dev`。换密钥后需要重新部署 Worker，这次代码变更本身不会自动发布。

百度侧需要：

1. 登录百度智能云，打开文字识别
2. 创建应用，勾选「手写文字识别」（只开通通用文字识别不够）
3. 复制该应用的 API Key 和 Secret Key
4. 用上面的 `wrangler secret put` 写入 Worker，不要写进前端

不要把真实密钥写进 `index.html`、`config.js`、README，或提交 `.env` / `.dev.vars`。Worker 按客户端 IP 做每分钟 10 次的隔离区内限流（与原先的无服务器实例内限流相同，不是全局限额），并拒绝超过约 3.8 MB 的请求和超过约 2.7 MB 的图片。页面裁剪后上传的是 JPEG。百度手写接口接受 JPEG、PNG、BMP。

### 手动测试

1. 确认 `config.js` 的 `OCR_API_URL` 已是部署后的 Worker 地址，并用 GitHub Pages 打开站点
2. 进入“生词本”
3. 点“拍照导入”，上传一张手写英文单词页面
4. 拖动裁剪框并点“识别选中区域”
5. 检查识别结果，修改错误单词或中文释义，取消不需要的行
6. 点“确认保存”
7. 刷新页面，确认单词仍在 IndexedDB 中
8. 点“练习本单”，验证听写、发音、错词和复习流程
9. 在未配置 API Key / Secret Key 的环境点「识别」，页面应显示「OCR 服务尚未配置」，并可以改为手动添加。不要出现密钥、`BAIDU_OCR_API_KEY` 或 `BAIDU_OCR_SECRET_KEY`。Worker 在两个密钥缺一或都未设置时返回同样这句中文。上游失败时返回中文说明，不回传百度的英文错误原文。

手机上建议再看一遍：首页先选练习方式再点某一页；听写时顶部「返回 / 练习方式」一直在；拼写后点「提交」；生词本可改自建词，点「练习本单」后「再练一遍」仍是这一份词，不会变成全部词库。

本仓库的自动测试：

```bash
npm test
```

其中会检查主站仍是 689 词，且 `empty/` 与 `scripts/build-empty-site.py` 一致。
