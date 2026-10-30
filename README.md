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

### Vercel 配置

GitHub Pages 只能托管静态页面，不能运行 `/api/ocr`。请把本仓库导入 Vercel，并将站点部署在 Vercel；静态页面和 `api/ocr.js` 会一起工作。

在 Vercel 项目设置中添加环境变量：

```text
GOOGLE_VISION_API_KEY=你的 Google Cloud Vision API Key
```

如果继续用 GitHub Pages 托管前端、只把 API 放在 Vercel，还需要把 `index.html` 中的：

```html
<meta name="ocr-endpoint" content="/api/ocr">
```

改成你的 Vercel API 地址，例如：

```html
<meta name="ocr-endpoint" content="https://your-project.vercel.app/api/ocr">
```

同时在 Vercel 添加允许的跨域来源：

```text
OCR_ALLOWED_ORIGINS=https://roubizhao6-sys.github.io
```

不要把真实密钥写进 `index.html`、JavaScript、README 或提交 `.env`。仓库只保留 `.env.example` 占位符。生产环境建议在 Google Cloud 中限制该 Key 只能调用 Vision API，并在 Vercel 侧配置 WAF/限流。

Google Cloud 侧需要：

1. 创建或选择项目
2. 启用 Cloud Vision API
3. 启用结算
4. 创建 API Key，并限制为 Cloud Vision API
5. 将 Key 填入 Vercel 的 `GOOGLE_VISION_API_KEY`

### 手动测试

1. 用 Vercel 部署预览地址打开站点
2. 进入“生词本”
3. 点“拍照导入”，上传一张手写英文单词页面
4. 拖动裁剪框并点“识别选中区域”
5. 检查识别结果，修改错误单词或中文释义，取消不需要的行
6. 点“确认保存”
7. 刷新页面，确认单词仍在 IndexedDB 中
8. 点“练习本单”，验证听写、发音、错词和复习流程
9. 在未配置 Key 的环境访问 OCR，应显示“OCR 服务尚未配置”，而不是暴露任何客户端密钥

本仓库的自动测试：

```bash
npm test
```
