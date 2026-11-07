# Public résumé chat worker

A narrow, anonymous public-chat endpoint using the OpenAI Responses API. This replaces the raw Gemini proxy. It does not provide a private résumé generator, file access, tools, or an arbitrary OpenAI proxy.

**This is a code-only migration. Chat is disabled by default. No key, public résumé context, limiter resources, or deployment is supplied by this change.** The existing Gemini frontend is incompatible with the new contract; switch the client and worker together after review.

## Browser contract

`POST /chat` with `Content-Type: application/json` and this body:

```json
{"messages":[{"role":"user","text":"What experience is described on the résumé?"}]}
```

- 1–12 messages, only `user` or `assistant` roles, ending with a user message.
- Exactly `role` and `text` on each message. No extra top-level fields.
- At most 2,000 JavaScript string characters per message, 8,000 total, and 32 KiB actual JSON bytes.
- No model selection, system prompts, provider payloads, response IDs, tools, files, images, or URLs to fetch.
- The only production origin is `https://zekenaulty.github.io`. Missing origins, `null`, other sites, and localhost are rejected. Only `/chat` is routed; queries and legacy `/` requests are rejected.

Success is `{ "text": "…", "incomplete": false, "truncated": false }`. Text is capped at 2,000 characters. Display an explicit partial-answer notice when either flag is true. Do not silently present a partial answer as complete. The client should keep older history locally, send a bounded recent window, and explain when older context is omitted.

Failures are `{ "error": { "code": "…", "message": "…" } }`. Messages are safe to display:

- 400 `invalid_request`; 403 `origin_not_allowed`; 404 `not_found`; 405 `method_not_allowed`.
- 408 `request_timeout`; 413 `request_too_large`; 415 `unsupported_media_type`.
- 429 `rate_limited`, with exposed `Retry-After: 60`.
- 502 `reply_unavailable` when no usable visible answer is available.
- 503 `chat_disabled`, `chat_unavailable`, or `upstream_unavailable`.
- 504 `upstream_timeout`.

Use a client timeout of at least 75 seconds. Never automatically retry a paid request. A timed-out or disconnected request may already have incurred provider costs; aborting is not a billing guarantee. Do not interpret a blank or failed response as an instruction to call Gemini or another endpoint.

## Operator settings

Keep `PUBLIC_CHAT_ENABLED` set to the string `"false"` until configuration and review are complete. Set it to `"true"` only for an authorized rollout. It is also the stop switch if public usage becomes unwanted.

Required settings, configured server-side by the operator:

- `OPENAI_API_KEY`: the approved existing key, stored as a Cloudflare Worker secret. Never put it in source, a public build, a `VITE_*` variable, a browser token, or a logged request. This change neither reads nor installs a key.
- `PUBLIC_RESUME_CONTEXT`: a curated plain-text summary containing only facts approved for public answers, at most **4,500 UTF-8 bytes**. No applications, private contact details, correspondence, unpublished projects, private job targets, or generated private résumé drafts. Cloudflare variables have a 5 KB limit. A larger reviewed corpus would require a separately approved bundled asset or data binding, not unbounded visitor-supplied context.
- `CHAT_CLIENT_LIMITER` and `CHAT_AGGREGATE_LIMITER`: both Cloudflare Rate Limiting bindings are mandatory. A missing, broken, or malformed binding fails closed before OpenAI is called. There is no in-memory fallback.

The public context is not confidential simply because it lives server-side: model answers can reveal any fact placed there. The model's topic instructions are guidance, not an authorization or privacy boundary. Keep private material out of this worker entirely.

Two optional settings have safe defaults and hard ceilings:

- `CHAT_MAX_OUTPUT_TOKENS`: default `"4096"`, allowed range 512–8192. This includes reasoning and visible output. With high reasoning, a cap can be reached before useful text is generated. Partial text is returned with a flag; no text produces a clear error. Tune only after a separately authorized representative live check.
- `CHAT_UPSTREAM_TIMEOUT_MS`: default `"55000"`, allowed range 1000–60000. The deadline covers fetching and reading the response. The incoming request body has its own 10-second deadline.

The model is server-owned `gpt-6.1-sol` with `reasoning.effort: "high"`, low verbosity, `store: false`, and no tools or temperature override. Model access for the chosen account remains unverified. `store: false` is not a promise of zero provider retention; review the account's data controls before launch.

### Proposed limiter configuration, not provisioned

Add this `ratelimits` array to the reviewed Wrangler configuration only after selecting two unused namespace IDs for the account. The numbers below are examples, not verified account identifiers. Suggested initial thresholds are 6 requests/minute per client network and 20/minute across the public route at each location; adjust for real visitor traffic.

```json
"ratelimits": [
  {
    "name": "CHAT_CLIENT_LIMITER",
    "namespace_id": "6101001",
    "simple": { "limit": 6, "period": 60 }
  },
  {
    "name": "CHAT_AGGREGATE_LIMITER",
    "namespace_id": "6101002",
    "simple": { "limit": 20, "period": 60 }
  }
]
```

The client limiter uses Cloudflare's edge-supplied `CF-Connecting-IP`, grouping IPv6 addresses by /64 and hashing the daily key. It does not trust `X-Forwarded-For` or a visitor-chosen ID. These keys are pseudonymous, not anonymous. Shared/mobile networks can share a quota; rotateable networks and bots can evade a per-client limit. Do not reuse this trust assumption behind a server where clients can control the IP header.

**These are abuse controls, not authentication or a hard spending cap.** A script can copy the allowed Origin. A secret embedded in public JavaScript would not help. Cloudflare's binding counts are approximate and local to each Cloudflare location; the aggregate binding is not a worldwide quota. Prompt injection can also defeat topic guidance. Per-call input/output ceilings limit individual request size, not total spend under distributed abuse. If a strict global budget is required, keep chat disabled until a separately approved coordinated quota mechanism exists. No paid infrastructure is provisioned here.

## Verification and rollout

Run `npm test` with Node 22+ and `node --check src/index.js`. The tests use dummy credentials, mocked OpenAI responses, and mocked limiter bindings; they make no network or paid API calls. They cover the request contract, failed configuration, spoofable browser-origin boundary, per-client/aggregate denial, IPv6 grouping, byte limits, provider-error redaction, partial answers, and cancellation. No external packages are needed for these tests.

Before an authorized production switch:

1. Review the public-only context and configure the two limiters. Confirm the current Cloudflare plan supports the bindings without an unapproved plan change.
2. Securely bind the approved key. Do not grant new persistent access or create another key implicitly.
3. Perform a Wrangler local/dry-run validation and approved staging check, including actual binding behavior and model access. These are not established by the mocked tests.
4. Configure the frontend's full HTTPS `/chat` URL, preserve useful disabled/error notices, and deploy the matching client and worker only with approval. The historic worker name can remain `gemini-proxy` to avoid changing its hostname.
5. Enable public chat deliberately and inspect aggregate status/usage without logging prompts, raw IPs, keys, or provider response bodies. This application adds no request logging, but platform observability settings still need review.
6. To stop spend through this route, set `PUBLIC_CHAT_ENABLED` to `"false"`. Preserve the static résumé site. Do not restore the old unrestricted Gemini proxy as a silent fallback.

Private résumé generation belongs in a separate authenticated service or local workflow. Do not add its route, data, service token, or credentials to this public worker or its frontend. CORS and anonymous rate limits do not protect private features.

## Verified references

- [OpenAI GPT-6.1 Sol model](https://developers.openai.com/api/docs/models/gpt-6.1-sol): model ID and supported high reasoning.
- [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning): token caps include reasoning; incomplete replies can contain no visible text.
- [OpenAI text generation](https://developers.openai.com/api/docs/guides/text): Responses output contains multiple typed items; extract assistant text rather than returning the raw body.
- [Cloudflare rate-limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/): configuration and approximate per-location behavior.
- [Cloudflare Worker limits](https://developers.cloudflare.com/workers/platform/limits/): environment-variable size.
