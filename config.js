// Cloudflare Worker URL for OCR. The page is hosted on GitHub Pages and
// cannot call /api/ocr. After `npx wrangler deploy`, replace YOUR_SUBDOMAIN
// with the workers.dev host Wrangler prints.
//
// Example placeholder (the page treats it as not configured):
// https://YOUR_SUBDOMAIN.workers.dev
// Example: https://word-dictation-ocr.<account>.workers.dev
//
// Allowed browser origins are OCR_ALLOWED_ORIGINS in wrangler.jsonc:
// https://roubizhao6-sys.github.io, tingxieyou.cn, and http://120.77.70.33.
// Origins omit the path.
window.OCR_API_URL = "https://word-dictation-ocr.roubizhao6.workers.dev";
