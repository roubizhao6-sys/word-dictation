// Cloudflare Worker URL for OCR. The page is hosted on GitHub Pages and
// cannot call /api/ocr. After `npx wrangler deploy`, replace YOUR_SUBDOMAIN
// with the workers.dev host Wrangler prints.
//
// Example: https://word-dictation-ocr.<account>.workers.dev
//
// The Worker allows https://roubizhao6-sys.github.io by default
// (OCR_ALLOWED_ORIGINS in wrangler.jsonc). Origins do not include a path.
window.OCR_API_URL = "https://word-dictation-ocr.roubizhao6.workers.dev";
