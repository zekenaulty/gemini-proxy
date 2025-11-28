# Gemini Proxy Worker

Plain-JavaScript Cloudflare Worker that proxies requests to Google Gemini. It enforces POST-only, handles CORS for your allowed origins, and forwards the request body as-is to Gemini.

## Endpoints
- `POST /` → Proxies to Gemini `generateContent` using the configured model.
- `OPTIONS /` → CORS preflight response.

## Configuration
Set a secret for your Gemini key:
```bash
npx wrangler secret put GEMINI_API_KEY
```

Origins allowed (edit in `src/index.js` if needed):
- `https://zekenaulty.github.io`
- `http://localhost:4173`
- `http://127.0.0.1:4173`

## Development
```bash
npm install
npx wrangler dev
# test with curl or Invoke-RestMethod against http://127.0.0.1:8787
```

## Deploy
```bash
npx wrangler deploy
```
